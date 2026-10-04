import { type Socket } from 'socket.io'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import type Player from '../objects/player'
import World, { Standing } from '../objects/world'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import Redis from 'ioredis'
import { Stats } from '../objects/player'
import { captureError } from '../errors'
import Analytics from '../analytics'
import type { Account } from '../db/accounts'
import { earnedXp } from '../progress/run'
import { kitFor } from '../progress/loadouts'
import { lockedStart } from '../progress/unlocks'

type Outbox = { create: Buffer[], create_own: Buffer[], effect: Buffer[], update: Buffer[], destroy: Buffer[] }

/** Only `id`: the destroy record for an object that left a client's view. */
const ID_ONLY: ReadonlySet<string> = new Set(['id'])

export class Connection {
  socket: Socket
  player: Player | undefined
  started: boolean = false
  /**
   * This connection's guest account (decision #48): its `publicId` is the
   * player id of every run on it. Set by `Worlds` from the handshake's token,
   * or created on first play, or made up offline when the store failed
   * (`persisted: false`). The token itself is never kept here, logged or
   * reported; only what it resolved to.
   */
  account: Account | undefined
  /**
   * The handshake token's lookup, started on connect (`Worlds.onConnection`).
   * Never rejects: the account, `null` for no or an unknown token, or an
   * offline account when the store failed.
   */
  accountReady: Promise<Account | null> | undefined
  /** A start is waiting on the account (`Worlds.start`): another one meanwhile is ignored. */
  starting: boolean = false
  /** The socket disconnected: a start still waiting on the account is dropped. */
  closed: boolean = false
  /**
   * The server closed this connection to stop (`Worlds.closeAll`: a drain's
   * deadline): a run it cuts short gets its play back (decision #48 step 7).
   */
  cutOff: boolean = false
  /**
   * The party code of this connection's last start (decision #47): a friend's
   * invite link carries the inviter's, so both runs go to the same world
   * (`Worlds.choose`). Random per browser, never the player id.
   */
  party: string | undefined
  /**
   * The player this connection watches after its own player died (spectate,
   * decision #47). Its client is then sent what that player's client would
   * be: `Multiplayer.viewpoint` stands in for the dead player wherever a view
   * is tested. Cleared by `forget` (a new run, a move, a disconnect).
   */
  spectating: Player | undefined
  // Last input sequence number consumed by the simulation, and how much
  // simulated time it has been applied for. The client needs both: the sequence
  // alone leaves it unable to tell how far into that input the server has got,
  // and that gap is exactly what makes replayed prediction drift backwards.
  lastInputSeq: number = 0
  ackElapsedMs: number = 0
  /**
   * The last route the client asked for, kept separately from the player's own
   * routing state.
   *
   * They are not the same thing and comparing against the wrong one re-walks
   * finished routes: arriving clears the player's waypoints, but the client goes
   * on sending the route until it notices arrival too, and comparing that packet
   * against the now-empty player would read as a change and set off again - from
   * the end, back through the first waypoint.
   */
  lastWaypoints: Vector[] = []
  /**
   * The units, pickups and projectiles this connection's client holds: sent
   * a create and no destroy since (decision #35). The other half of each
   * object's `knownBy`. It includes the player's own object, which is never
   * dropped from it while the player lives. Bounded by what is in range, and
   * emptied when the player goes (`Multiplayer.forget`). Terrain is not in it;
   * see `layer`.
   */
  known = new Set<GameObject>()
  /**
   * The layer whose terrain (everything in `World.OBSTACLES`) this client
   * holds, and the layer it is shown on; undefined before a join and after
   * the player goes. It follows the player's tag at the player's own first
   * update after a portal (`Multiplayer.switchLayer`), which is the update
   * that carries the new tag to the client, so the old layer goes and the new
   * one arrives in the same flush as that tag. Every "can it see this" test
   * reads this, not the player's tag.
   */
  layer: number | undefined

  /**
   * What this connection is sent at the next flush. Here rather than in a
   * table keyed by socket id: the broadcast loop reaches it once per record
   * per holder, and a string-keyed lookup each time was a measurable part of
   * the tick (server-cpu-trim).
   */
  outbox: Outbox | undefined

  /**
   * The client asked for one binary frame per tick (`?frames=1` on connect),
   * and this server said yes in `hello`. Everything a flush sends then goes
   * in one engine.io message (`Multiplayer.packFrame`) instead of one
   * socket.io event per kind, each of which socket.io sends as two WebSocket
   * frames (a text placeholder and the buffer). An old client never asks and
   * gets the events as before.
   */
  framed: boolean = false

  /**
   * The standings buffer this connection was last sent, so an identical board
   * is not sent again (`Multiplayer.flushAll`). Cleared when a new player joins
   * on the connection (`attach`), so a new run always gets the board.
   */
  lastStandings: Buffer | undefined

  get id (): string {
    return this.socket?.id
  }
}

/**
 * Logs at most one line per window, and says how many it swallowed since.
 *
 * For failures that repeat for as long as their cause lasts. A dead Redis fails
 * every stats write (one per disconnect, exit and kill) and ioredis emits an
 * `error` on every reconnect attempt, which is one line every two seconds for as
 * long as it stays down. The first failure is logged in full; the rest of the
 * window is counted and reported with the next line.
 */
export class ThrottledLog {
  private _lastAt = -Infinity
  private _suppressed = 0

  constructor (
    readonly label: string,
    readonly windowMs: number,
    private readonly _now: () => number = () => Date.now(),
    private readonly _sink: (...args: unknown[]) => void = console.error
  ) {}

  report (error: unknown): void {
    const now = this._now()
    if (now - this._lastAt < this.windowMs) {
      this._suppressed++
      return
    }
    const note = this._suppressed > 0 ? ` (${this._suppressed} more in the last ${Math.round((now - this._lastAt) / 1000)}s)` : ''
    this._lastAt = now
    this._suppressed = 0
    this._sink(`${this.label}${note}:`, error)
  }
}

function sameCells (a: Vector[], b: Vector[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false
  }
  return true
}

export default class Multiplayer {
  static order = ['create', 'update', 'effect', 'destroy']
  /**
   * The interest box's half-width, in world units. Since server fog (#48) it
   * decides only who is sent an effect, what a viewpoint with no `vision`
   * sees (`viewOf`), and `hello.interest`. The client's `stillPresent` no
   * longer reads it for a robot with vision: the 500 box was tighter than
   * Periscope's leave radius, so it sizes by vision instead (`net/presence.ts`).
   * Units, pickups, projectiles and stones go by `viewOf`.
   */
  static INTEREST_RADIUS = 500

  /**
   * The current world's Multiplayer (`World.current.multiplayer`): every
   * object's create, update, destroy and effect goes through it. Assigning it
   * sets the current world's and binds it to that world (specs assign stubs).
   */
  static get Instance (): Multiplayer {
    return World.current.multiplayer as Multiplayer
  }

  static set Instance (multiplayer: Multiplayer) {
    const world = World.current
    const previous = world.multiplayer
    if (previous !== undefined && previous !== multiplayer && previous.world === world) previous.world = undefined
    world.multiplayer = multiplayer
    // A stub (a plain object) has no binding and is never checked.
    if (multiplayer instanceof Multiplayer) multiplayer.world = world
  }

  /**
   * The world this Multiplayer serves (worlds-per-process, decision #39), or
   * undefined for one no world has adopted (a stub, one built with
   * `Object.create`, or one whose world closed). While it is set, every entry
   * point that reads or writes world state checks that this world is current
   * (`checkWorld`), so a call that reached it outside `World.run` for its own
   * world throws a `WrongWorldError` instead of mixing two worlds.
   */
  world: World | undefined

  readonly tickLengthMs: number
  private readonly _connections: Connection[]
  redis: Redis
  /**
   * Called when a human's run ends on its own connection (`destroy`), with
   * the XP it earned (`earnedXp`, 0 offline). `Worlds` grants it (decision
   * #48 step 3); unset (single-world specs) nothing is granted.
   */
  runEnded: ((connection: Connection, player: Player, xp: number) => void) | undefined

  /**
   * Stats are a side channel. Nothing in the world is persisted, so a stats write
   * that takes the process down wipes every run in progress to save one counter.
   * Every stats write is fire-and-forget and must end in `.catch(logStatsFailure)`:
   * a bare `void` promise that rejects is an unhandled rejection, which ends the
   * process, and no try/catch around the tick can see it.
   *
   * Static, not per-instance, so a spec that swaps `Instance` for a stub still
   * has somewhere to report to.
   */
  static STATS_LOG = new ThrottledLog('stats write failed', 60_000)
  static REDIS_LOG = new ThrottledLog('redis', 60_000)
  /**
   * Socket handlers run on their own turn of the event loop, outside the tick's
   * try/catch in `index.ts`, so each one is caught where it is registered (see
   * `guarded`). Throttled because a broken skill throws on every press, and a
   * client can press it several times a second.
   */
  static HANDLER_LOG = new ThrottledLog('socket handler threw', 10_000)

  static logStatsFailure (error: unknown): void {
    Multiplayer.STATS_LOG.report(error)
  }

  /**
   * With `World.strict` (the server) it is nobody's until a world adopts it
   * (`new World(size, { multiplayer })`, which binds it), even if a world is
   * current: it must never replace that world's own. Otherwise (specs) it
   * becomes the current world's (`Instance`), as it always did.
   *
   * A `redis` passed in may be shared (`Worlds` passes one to every world):
   * one marked by `shareRedis` already has its error listener, and one per
   * Multiplayer would pile up a listener for every world ever opened (Node
   * warns past 10). Any other gets one here, as it always did.
   */
  constructor (tickLengthMs: number, redis?: Redis) {
    if (!World.strict) Multiplayer.Instance = this
    this.tickLengthMs = tickLengthMs
    this._connections = []

    if (redis !== undefined) {
      this.redis = redis
      // A stub from a spec gets the listener it always got; a client from
      // `connectRedis` (the one `Worlds` shares) has its own already.
      if (!Multiplayer.sharedRedis.has(redis)) this.redis.on('error', (e) => { Multiplayer.REDIS_LOG.report(e) })
      return
    }
    // Start-up does not wait for Redis: ioredis connects in the background and
    // queues commands meanwhile, so a server with Redis down still starts and
    // runs the world; only stats are lost.
    this.redis = Multiplayer.connectRedis()
  }

  /**
   * A Redis client with its error listener. Without the listener ioredis
   * prints "[ioredis] Unhandled error event" with a stack on every reconnect
   * attempt, forever, while Redis is down.
   *
   * `REDIS_URL` (Railway's Redis: password included, host on the private
   * network) wins over `REDIS_HOST`/`REDIS_PORT` (docker compose, no
   * password). `family: 0` lets the host resolve to IPv6 as well, which
   * Railway's private network may require; ioredis defaults to IPv4 only.
   */
  static connectRedis (): Redis {
    const url = process.env.REDIS_URL
    return Multiplayer.shareRedis(url !== undefined && url !== ''
      ? new Redis(url, { family: 0 })
      : new Redis(parseInt(process.env.REDIS_PORT ?? '6379'), process.env.REDIS_HOST ?? 'redis'))
  }

  /**
   * Give `redis` its one error listener and mark it shared, so no Multiplayer
   * given it adds another (`Worlds` shares one client between every world it
   * opens). Idempotent.
   */
  static shareRedis (redis: Redis): Redis {
    if (Multiplayer.sharedRedis.has(redis)) return redis
    redis.on('error', (e) => { Multiplayer.REDIS_LOG.report(e) })
    Multiplayer.sharedRedis.add(redis)
    return redis
  }

  /**
   * Redis clients that already have their listener (`shareRedis`): a
   * Multiplayer given one adds none. Weak, so it holds nothing up.
   */
  private static readonly sharedRedis = new WeakSet<Redis>()

  /**
   * Throw a `WrongWorldError` if `multiplayer`'s world is bound and not
   * current. Static and null-safe because specs call the handlers with no
   * `this` (`Multiplayer.prototype.onSkill.call(null, ...)`).
   */
  private static checkWorld (multiplayer: Multiplayer | null | undefined, where: string): void {
    const world = multiplayer?.world
    if (world !== undefined && World.peek() !== world) World.expect(world, where)
  }

  /**
   * Run a socket handler: inside `guarded`, and inside `World.run` for this
   * Multiplayer's world when it has one, so the handler's `World.X` are its
   * own world's whichever world the tick last ran.
   */
  private handle (fn: () => void): void {
    Multiplayer.guarded(() => {
      const world = this.world
      if (world === undefined) fn()
      else World.run(world, fn)
    })
  }

  /**
   * A connection this Multiplayer's world is sent to. `onConnect` makes one
   * per socket for a single world (specs); `Worlds` moves one between worlds
   * per run with `adopt` and `release`.
   */
  static connectionFor (socket: Socket): Connection {
    const connection = new Connection()
    connection.socket = socket
    connection.framed = socket.handshake?.query?.frames === '1'
    return connection
  }

  /** Take `connection` on: it is flushed with this world from now on. */
  adopt (connection: Connection): void {
    Multiplayer.checkWorld(this, 'Multiplayer.adopt')
    if (!this._connections.includes(connection)) this._connections.push(connection)
  }

  /**
   * Let `connection` go completely, for a move to another world: it leaves
   * the connection list and every object of this world that its client
   * held forgets it, so nothing of this world reaches it again. Its player,
   * if it still has a live one, is destroyed as on a disconnect.
   */
  release (connection: Connection): void {
    Multiplayer.checkWorld(this, 'Multiplayer.release')
    const i = this._connections.indexOf(connection)
    if (i >= 0) this.drop(connection, i)
    else this.forget(connection)
  }

  /** How many connections this Multiplayer flushes. */
  get connectionCount (): number {
    return this._connections.length
  }

  /**
   * `start_requested` (`parseStart`). Ignored while a run is in progress on
   * the connection. Throws what `onStart` throws.
   *
   * The player id is the connection's account's (decision #48), never the
   * start's `id`. `Worlds.start`, the only production path, always sets an
   * account first. Without one the start's `id` is used **only while
   * `World.strict` is off**, which is single-world specs joining through
   * `onConnect`; the server and every `Worlds` spec run strict, so there a
   * start without an account is ignored (fail closed).
   */
  startRequested (connection: Connection, data: unknown): void {
    if (connection.started) return
    Multiplayer.checkWorld(this, 'Multiplayer.startRequested')
    const start = Multiplayer.parseStart(data)
    if (start === undefined) return
    const playerId = connection.account !== undefined
      ? connection.account.publicId
      : (!World.strict ? start.id : undefined)
    if (playerId === undefined) return
    connection.started = true
    // Robot and finish locks (decision #48 step 5), applied once, here: a
    // robot the account's level hasn't opened plays Peep, a locked colour or
    // pattern the group's default; the join is never refused. Not in
    // `World.robotFor` / `createPlayer`, which bots join through: bots ignore
    // locks. No account (non-strict specs only) has no locks (`joinLevel`).
    const { robot, finish } = lockedStart(connection.account, start.robot, start.finish)
    // The run's skills (decision #48 step 4): the account's loadout `loadout`
    // for the robot this join really plays (a forged or locked robot plays
    // Peep, with Peep's loadout), checked against the account's level now. A
    // start without `loadout` (a client from before loadouts) is loadout 0; no
    // account (single-world specs) is the start kit.
    const kit = kitFor(connection.account, robot, 'loadout' in start ? start.loadout : 0)
    this.onStart(connection, playerId, start.name, finish, robot, kit)
  }

  onConnect (socket: Socket): void {
    const connection = Multiplayer.connectionFor(socket)

    socket.on('start_requested', (data) => {
      if (connection.started) return
      this.handle(() => { this.startRequested(connection, data) })
    })
    // Registered here rather than in onStart, so a start that fails and is
    // retried does not register them twice. Before a start they do nothing:
    // both return while `connection.player` is unset.
    //
    // Applied on arrival, not queued for the tick. Their effects leave on the
    // next flush either way, but a skill's cooldown is checked against
    // `Date.now()`, and moving the check to tick time changes which presses
    // made right at the end of a cooldown are accepted (socket-handlers-in-
    // boundary, handoff note).
    socket.on('pointer', (data) => {
      this.handle(() => { this.onPointer(connection, data) })
    })
    socket.on('skill', (data) => {
      this.handle(() => { this.onSkill(connection, data) })
    })
    // On arrival too, like `skill`: the heal or the fuse starts from the press.
    socket.on('use_item', (data) => {
      this.handle(() => { this.onUseItem(connection, data) })
    })
    this._connections.push(connection)
  }

  /**
   * The error boundary for socket input, the counterpart of the tick's in
   * `index.ts`. A throw here would otherwise reach the process and end every
   * run in progress. It is caught per event, so one bad press cannot stop the
   * next event - anyone's - from being handled.
   */
  static guarded (fn: () => void): void {
    try {
      fn()
    } catch (e) {
      // The log is throttled; Sentry gets each one (within its own budget).
      Multiplayer.HANDLER_LOG.report(e)
      captureError('handler', e)
    }
  }

  // incoming traffic ========
  /**
   * Joins the world. Not async: nothing here waits, and an `async` function
   * that throws turns into a rejected promise that `void` left unhandled,
   * which ends the process.
   *
   * If anything throws, the join is undone before the error is rethrown to
   * `guarded`: the player leaves the world and every client that was sent its
   * create is sent its destroy. Unless the final flush is what threw, nothing
   * has been emitted to the joining client (`hello` goes out just before that
   * flush), and `started` is cleared so it can ask again.
   */
  onStart (connection: Connection, playerId: string, name?: unknown, finish?: unknown, robot?: unknown, kit?: readonly number[]): void {
    Multiplayer.checkWorld(this, 'Multiplayer.onStart')
    let player: Player | undefined
    try {
      player = World.createPlayer(playerId, name, finish, robot, kit)
      this.admit(connection, player)
      let humans = 0
      let bots = 0
      let party = 0
      for (const p of World.PLAYERS) {
        if (p.destroyed || p.exited) continue
        if (p.bot !== undefined) bots++
        else {
          humans++
          if (p !== player && connection.party !== undefined && p.connection?.party === connection.party) party++
        }
      }
      Analytics.runStart({ playerId, startedAt: player.createdAt, offline: Multiplayer.isOffline(player) }, this.redis, player.archetype.key, humans, bots, party)
    } catch (e) {
      connection.started = false
      connection.player = undefined // before destroy, so no stats are written for it
      if (player !== undefined) {
        const i = World.PLAYERS.indexOf(player)
        if (i >= 0) World.removeUnitAt(World.PLAYERS as unknown as Unit[], i)
        player.destroy()
      }
      // Whatever the snapshot had marked as sent, it never was.
      this.forget(connection)
      connection.outbox = undefined
      throw e
    }
  }

  /**
   * The join snapshot (decision #35): the terrain of the player's own layer,
   * all of it, and the units, pickups, projectiles and StoneWall stones within
   * the player's enter radius (vision + 1 ring, `sendVisible`; server fog,
   * #48). It was every object on every layer, then everything inside the
   * 500-unit interest box (#35).
   */
  private admit (connection: Connection, player: Player): void {
    this.attach(connection, player)

    const out: Outbox = { create: [], create_own: [], effect: [], update: [], destroy: [] }
    connection.outbox = out

    this.sendTerrain(connection, out.create)
    this.sendVisible(connection, out.create)
    // allFieldsOwn, not allFields: the owner needs loot and maxVelocity,
    // and maxVelocity is what makes local prediction possible at all.
    out.create_own.push(player.serialiseBinary(player.allFieldsOwn))

    // Everything the client would otherwise have to assume about this server.
    // Sent after the snapshot is built, so a snapshot that throws sends nothing;
    // still before the flush, so the client gets it first, as it always has.
    connection.socket.emit('hello', {
      tick: this.tickLengthMs,
      map: World.mapSize,
      interest: Multiplayer.INTEREST_RADIUS,
      // Every layer's tag, top (01) first. The client builds its planes from
      // this and labels portals by position in it, so it never hardcodes a tag.
      layers: World.TAGS,
      // Each layer's valleys, in `layers` order: alternating free and void run
      // lengths over `Hex.mapCells(map)` (valleys.ts `encodeRuns`). About 1 KB
      // a layer. Additive: an older client ignores it and routes into the
      // void, and the server corrects it, so ship the client first.
      voids: World.TAGS.map((tag) => World.VOID_RUNS.get(tag) ?? []),
      // Each layer's walls (decision #44), the same way. Additive like voids:
      // an older client routes into a wall and is corrected.
      walls: World.TAGS.map((tag) => World.WALL_RUNS.get(tag) ?? []),
      // The run's 4 skill ids, Q W E R (decision #48 step 4): the kit the
      // server built, after checking and any fallback, never what the client
      // asked for. Slot i of it is what a `skill` press of i runs. A client
      // that finds no key here plays the legacy eight (a server before this).
      skills: [...player.skillIds],
      // Only to a client that asked: it now gets one frame per tick. Sent in
      // the same engine.io stream as that frame, so it always arrives first.
      ...(connection.framed ? { frames: Multiplayer.FRAME_VERSION } : {})
    })

    this.flush(connection, 0)
  }

  /**
   * `standings`, when given, is this tick's standings board for this
   * connection (`StandingsBoard.bufferFor`), sent under the same gate as the
   * buffered events.
   */
  flush (connection: Connection, tick: number, standings?: Buffer): void {
    const buffered = connection.outbox

    // Always drop the buffer, even for a socket that never started a run.
    // Clients connect on page load but only send `start_requested` on button
    // click, so returning early here leaked a buffer per idle visitor.
    const watching = connection.player != null || connection.spectating !== undefined
    if (watching && connection.framed) {
      connection.socket.conn.write(Multiplayer.packFrame(
        buffered, standings, tick, connection.lastInputSeq, connection.ackElapsedMs
      ))
    } else if (watching) {
      if (buffered !== undefined) {
        for (const event in buffered) {
          if (event === 'update') continue
          const records: Buffer[] = buffered[event]
          if (records.length === 0) continue
          connection.socket.emit(event, Multiplayer.packRecords(records))
        }
      }

      if (standings !== undefined) connection.socket.emit('standings', standings)

      // The update packet goes out every tick even when it carries no records.
      // Its header is the client's clock and its input acknowledgement, and
      // prediction needs both on a fixed cadence to reconcile against.
      const header = Buffer.alloc(8)
      header.writeUInt32BE(tick >>> 0)
      header.writeUInt16BE(connection.lastInputSeq, 4)
      header.writeUInt16BE(Math.min(65535, Math.round(connection.ackElapsedMs)), 6)
      connection.socket.emit(
        'update',
        Multiplayer.packRecords(buffered?.update ?? [], header)
      )
    }

    connection.outbox = undefined

    // Exiting removes the player from the world but never set `destroyed`, so the
    // connection kept pointing at it and the input handlers kept reaching it.
    const player = connection.player
    if (player != null && (player.destroyed || player.exited)) {
      connection.player = undefined
      // A death, not an extraction: watch the killer, else whoever is nearest
      // (#47). Its view replaces the dead player's from the next flush on;
      // what the client holds is kept or let go as on a layer change.
      const target = player.exited ? undefined : Multiplayer.spectateTarget(player, player.killer)
      if (target !== undefined) {
        this.unknow(connection, player)
        this.watch(connection, target)
      } else {
        this.forget(connection)
      }
      // The run is over: the client may ask for another on this socket. It
      // does, after its game-over screen, and until 2026-09-27 this stayed
      // true from the first start (since the 2026-09-02 revival), so every
      // restart without a page reload was silently ignored.
      connection.started = false
    }
  }

  /**
   * Where the player wants to go: `[uint8 count][int16 q][int16 r] * count][uint16 seq]`.
   *
   * This carried a direction before click-to-move, then a single destination
   * cell. It is a list because a route can be built up leg by leg - shift-click
   * on the client appends to it - and the server has to route the same legs the
   * client drew, or the marker on screen stops describing where the player will
   * actually walk.
   *
   * A count of zero means stop. The current client sends it only when the
   * route changes (at most once a tick); older clients send it every tick
   * whether or not it changed, which `sameCells` below makes free.
   */
  static MAX_WAYPOINTS = 16

  onPointer (connection: Connection, data): void {
    Multiplayer.checkWorld(this, 'Multiplayer.onPointer')
    if (connection.player == null || connection.player.exited || connection.player.destroyed) return

    let buf: Buffer
    if (Buffer.isBuffer(data)) buf = data
    else if (data instanceof Uint8Array || data instanceof ArrayBuffer) buf = Buffer.from(data as any)
    else return

    if (buf.length < 3) return

    const count = buf.readUInt8(0)
    if (count > Multiplayer.MAX_WAYPOINTS) return
    if (buf.length < 1 + count * 4 + 2) return

    const seq = buf.readUInt16BE(1 + count * 4)
    if (seq !== connection.lastInputSeq) {
      connection.lastInputSeq = seq
      connection.ackElapsedMs = 0
    }

    if (count === 0) {
      connection.lastWaypoints = []
      connection.player.stop()
      return
    }

    const waypoints: Vector[] = []
    for (let i = 0; i < count; i++) {
      const at = 1 + i * 4
      waypoints.push(new Vector(buf.readInt16BE(at), buf.readInt16BE(at + 2)))
    }

    // Only re-route when the client asks for something different. An older
    // client sends the packet every tick; searching on each one would put a BFS per player per
    // tick into the loop for no gain, since a standing route does not change
    // unless the terrain does - and when it does, `World.block` re-routes.
    if (sameCells(connection.lastWaypoints, waypoints)) return

    connection.lastWaypoints = waypoints
    connection.player.setWaypoints(waypoints)
  }

  onSkill (connection: Connection, data): void {
    Multiplayer.checkWorld(this, 'Multiplayer.onSkill')
    const player = connection.player
    if (player == null || player.exited || player.destroyed) return
    const press = Multiplayer.parseSkill(data)
    if (press === undefined) return
    player.tryExecuteSkill(press.slot, press.aimCell)
  }

  /**
   * Use an item: the same bytes as a skill press (`parseSkill`), where `slot`
   * is the 0-based inventory slot (key 1 is slot 0) and (q, r) the absolute
   * cell aimed at. A bare number is the slot with no aim. The medkit ignores
   * the aim; `Player.tryUseItem` validates everything else.
   */
  onUseItem (connection: Connection, data): void {
    Multiplayer.checkWorld(this, 'Multiplayer.onUseItem')
    const player = connection.player
    if (player == null || player.exited || player.destroyed) return
    const press = Multiplayer.parseSkill(data)
    if (press === undefined) return
    player.tryUseItem(press.slot, press.aimCell)
  }

  /**
   * A skill press: `[uint8 slot][int16 q][int16 r]`, big-endian like every
   * other multi-byte field on the wire, where (q, r) is the **absolute** axial
   * cell aimed at (decision #21). Absolute rather than an offset from the
   * player, because the predicting client and the server can disagree about
   * the player's cell by one, and an offset would then land a cell off.
   *
   * A bare number is the old JSON form and still accepted: the slot with no
   * aim, which fires along `facing`. Anything else - a string, an object, a
   * buffer shorter than 5 bytes - is ignored, as `pointer` ignores a short
   * packet. Longer buffers are read for their first 5 bytes, so a field can be
   * appended later without breaking this server.
   */
  static parseSkill (data: unknown): { slot: number, aimCell?: Vector } | undefined {
    if (typeof data === 'number') return { slot: data }

    let buf: Buffer
    if (Buffer.isBuffer(data)) buf = data
    else if (data instanceof Uint8Array || data instanceof ArrayBuffer) buf = Buffer.from(data as any)
    else return undefined

    if (buf.length < 5) return undefined
    return {
      slot: buf.readUInt8(0),
      aimCell: new Vector(buf.readInt16BE(1), buf.readInt16BE(3))
    }
  }

  /**
   * `start_requested` is `{ id, name, finish, robot, loadout, party }`: `id` is the
   * id an older client made for itself, which this server no longer plays
   * under (the account's is used, decision #48; `startRequested`). It is kept
   * in the result only when it has `ID_SHAPE`, for the spec-only fallback, and
   * a start is never refused for it: the client still sends it for one
   * release because an older server refuses a start without one. Then
   * the name it typed, which may be missing or empty, and the robot's finish
   * (robot-finishes, #41), `[colour, pattern]` for head, body and limbs, which
   * a client from before finishes doesn't send, and `robot`, the key of the
   * robot picked in the lobby (robot-select, #42). `name`, `finish` and
   * `robot` are passed on raw and cleaned where they are used
   * (`Player.sanitiseName`, `finishFromBytes`, `World.robotFor`), so their
   * type and content are not checked here. `finish` and `robot` are only in
   * the result when they were sent.
   *
   * Anything but an object is ignored and leaves the connection free to ask
   * again. The bare-string form (the id alone, player-names 2026-09-25) is
   * gone: the id was all it carried.
   */
  static parseStart (data: unknown): { id?: string, name?: unknown, finish?: unknown, robot?: unknown, loadout?: unknown, party?: string } | undefined {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
    const { id, name, finish, robot, loadout, party } = data as { id?: unknown, name?: unknown, finish?: unknown, robot?: unknown, loadout?: unknown, party?: unknown }
    const start: { id?: string, name?: unknown, finish?: unknown, robot?: unknown, loadout?: unknown, party?: string } = { name }
    if (typeof id === 'string' && Multiplayer.ID_SHAPE.test(id)) start.id = id
    if (finish !== undefined) start.finish = finish
    if (robot !== undefined) start.robot = robot
    // The lobby's loadout index for that robot (decision #48 step 4), raw:
    // `kitFor` checks it against the account's level.
    if (loadout !== undefined) start.loadout = loadout
    // Only a well-formed code; anything else plays as if there were none.
    if (typeof party === 'string' && Multiplayer.PARTY_SHAPE.test(party)) start.party = party
    return start
  }

  /** A party code (decision #47): lowercase letters and digits, as the client makes them. */
  static readonly PARTY_SHAPE = /^[0-9a-z]{6,12}$/

  /**
   * The shape of a player id. It becomes the Redis key `stats-${id}`, so it is
   * bounded here rather than trusted (bound-player-id, 2026-09-25).
   *
   * Since guest accounts (decision #48) the id is the account's `publicId`, 16
   * lowercase hex digits issued by the server, which this still accepts;
   * `Worlds` checks every issued id against it before playing under it, so
   * it stays the guard on Redis keys. The client's own id, described below,
   * is still sent for one release and ignored. History:
   *
   * Every shipped client makes it the same way, `genRanHex(6)` in the client's
   * lobby (`ui/lobby/lobby.ts`; `GameEnterPopup` before #42): six lowercase hex digits, one `Math.floor(random * 16)`
   * each. That has been true since 2023-08-02 (27e2c3d), under the storage key
   * `plunderland_test_address` until the revival renamed it to
   * `plunderland_player_id`, and it is what the deployed client (origin/main)
   * sends. The range 6-32 is headroom for a longer id later; the charset is
   * not widened, so a new format needs a change here.
   *
   * Not accepted: the wallet addresses (`0x` plus 40 mixed-case hex) the client
   * sent before 27e2c3d. That client needed a wallet and a token transfer on
   * a testnet to start, and it is not what origin/main serves, so no browser
   * can load it from the game's hosting.
   */
  static readonly ID_SHAPE = /^[0-9a-f]{6,32}$/

  // outgoing traffic ========

  /**
   * Server fog (decision #48): a connection is sent a unit, pickup,
   * projectile or StoneWall stone on its client's layer only while it is
   * within its viewpoint's sight, measured in hex rings from the cell under
   * the viewpoint's centre to the cell under the object's (`Hex.toCell`, the
   * rule every gameplay test uses). It **enters** at the robot's `vision` +
   * `VIEW_MARGIN_RINGS` rings, one ring past what the client draws, so an
   * arrival is already there when it comes out of the fog, and **leaves**
   * only beyond `VIEW_EXIT_RINGS` more, so one on the edge, or a viewer
   * walking to and fro across it, is not destroyed and re-created every tick.
   * Inside that ring it is still sent its changes. So a modified client knows
   * at most `vision` + 2 rings. Peep: 7 and 8; Periscope: 12 and 13.
   * `World.INTEREST_BUCKET` is sized from these. 1 is #48's margin; the exit
   * ring is Archie's provisional pick: nothing but a dash covers more than
   * about a cell a tick.
   */
  static VIEW_MARGIN_RINGS = 1
  static VIEW_EXIT_RINGS = 1

  /**
   * A viewpoint with no `vision` (every robot has one; a mob is never a viewpoint)
   * falls back to the interest box, so nothing silently sees nothing: it
   * enters strictly inside `INTEREST_RADIUS` and leaves only beyond
   * `INTEREST_RADIUS + EXIT_MARGIN`, in world units (2 cells). Server fog
   * replaced this as the rule for every robot (#48).
   */
  static EXIT_MARGIN = 2 * Hex.SIZE

  /** `viewOf`'s answers: beyond the leave radius, between the two, within the enter radius. */
  static readonly VIEW_OUT = 0
  static readonly VIEW_EDGE = 1
  static readonly VIEW_IN = 2

  /**
   * Where a point at (x, y), whose cell is `cell` (`Hex.toCell` of it), lies
   * in `viewer`'s sight, its layer not checked: `VIEW_IN` within the enter
   * radius, `VIEW_EDGE` beyond it but within the leave radius, `VIEW_OUT`
   * beyond both. Rings from the viewer's own cell, by its robot's `vision`
   * (`VIEW_MARGIN_RINGS`); the box with no vision (`EXIT_MARGIN`). The
   * viewer is a connection's viewpoint (`viewpoint`), so a spectator sees by
   * the watched player's vision, not its own dead robot's.
   */
  static viewOf (viewer: Player, x: number, y: number, cell: Vector): number {
    const vision = viewer.archetype?.vision
    if (vision === undefined || vision === null) {
      const dx = viewer.position.x - x
      const dy = viewer.position.y - y
      const inner = Multiplayer.INTEREST_RADIUS
      if (dx < inner && dx > -inner && dy < inner && dy > -inner) return Multiplayer.VIEW_IN
      const outer = inner + Multiplayer.EXIT_MARGIN
      return dx < outer && dx > -outer && dy < outer && dy > -outer ? Multiplayer.VIEW_EDGE : Multiplayer.VIEW_OUT
    }
    const enter = vision + Multiplayer.VIEW_MARGIN_RINGS
    const leave = enter + Multiplayer.VIEW_EXIT_RINGS
    // Out at once when it is plainly beyond the leave radius, before the cell
    // arithmetic: most candidates from the 3 x 3 buckets are (the buckets
    // are sized for Periscope). Exact, not a guess: `leave` rings is at most
    // leave x 45 units east-west and leave x 39 north-south, and each end is
    // at most half a cell (22.5, or 26 to a corner) off its cell's centre, so
    // anything further than (leave + 1) x `Hex.SIZE` on either axis is out.
    const reach = (leave + 1) * Hex.SIZE
    const dx = viewer.position.x - x
    const dy = viewer.position.y - y
    if (dx > reach || dx < -reach || dy > reach || dy < -reach) return Multiplayer.VIEW_OUT
    const rings = Hex.distance(Hex.toCell(viewer.position), cell)
    if (rings <= enter) return Multiplayer.VIEW_IN
    return rings <= leave ? Multiplayer.VIEW_EDGE : Multiplayer.VIEW_OUT
  }

  /**
   * The connection whose live player `player` is, if any: `Player.connection`,
   * set by `attach`, and always checked against `connection.player`, so a
   * player whose connection has moved on (death, exit, disconnect) is never
   * sent anything through it. It was a WeakMap; the broadcast loop asks once
   * per nearby player per object per tick, and the field is about 3x faster.
   */
  private connectionOf (player: Player): Connection | undefined {
    const connection = player.connection
    return connection?.player === player ? connection : undefined
  }

  /**
   * The connection to send to for `player`, a player some object is near:
   * none for one killed or extracted this tick, who is still in the world
   * until the next sweep. Its client has been sent its own destroy and is
   * showing the end of its run.
   */
  private viewerOf (player: Player): Connection | undefined {
    if (Multiplayer.gone(player)) return undefined
    return this.connectionOf(player)
  }

  /**
   * Every connection that sees from `player`: its own (`viewerOf`) and those
   * spectating it (#47), into `into`, cleared first. Each call site passes
   * its own scratch array, so nothing is allocated per candidate in the hot
   * loops and a nested call can't clobber an outer one's list.
   */
  private viewersOf (player: Player, into: Connection[]): Connection[] {
    into.length = 0
    if (Multiplayer.gone(player)) return into
    const own = this.connectionOf(player)
    if (own !== undefined) into.push(own)
    if (player.spectators !== undefined) for (const watcher of player.spectators) into.push(watcher)
    return into
  }

  // Static, not fields: a spec's `Object.create(Multiplayer.prototype)` runs
  // no field initialisers. Shared by every world; each call site has its own
  // and none of them re-enters itself.
  private static readonly _viewersCreate: Connection[] = []
  private static readonly _viewersUpdate: Connection[] = []
  private static readonly _viewersEffect: Connection[] = []

  /** Where a connection sees from: the player it spectates, else its own. */
  static viewpoint (connection: Connection): Player | undefined {
    return connection.spectating ?? connection.player
  }

  /**
   * Destroyed, or a player who has extracted. Either has been sent its
   * destroy, and nothing may be sent about it after that: a create for it
   * would reach the client ahead of the destroy in the same flush (`create`
   * is emitted first) and leave a sprite nobody removes.
   */
  static gone (obj: GameObject): boolean {
    return obj.destroyed || (obj as { exited?: boolean }).exited === true
  }

  /**
   * Terrain: portals, exits and any untimed obstacle (world rocks, none since
   * the valleys). It goes to every connection on its layer whatever the
   * distance (decision #35), because the client routes over the whole layer
   * from its copy of the blocked cells. By type and lifetime, because
   * `create` runs inside the constructor, before the object is in any list;
   * `GameObject`'s constructor has set the lifetime by then.
   *
   * **StoneWall stones are not terrain** (bandwidth review, 2026-09-27): they
   * go only to connections with them in range, like pickups, and are brought
   * into and out of view by `World.pickupPass`. Layer-wide they were 41-52% of
   * every client's traffic in the load harness. A client can plan a route
   * through a stone it hasn't been sent; the server has routed around it and
   * corrects it, and the client re-routes as soon as the stone comes into view
   * (`Game.block`).
   */
  static isTerrain (obj: GameObject): boolean {
    if ((obj.type & (ObjectType.Portal | ObjectType.Exit)) !== 0) return true
    return obj.type === ObjectType.Obstacle && !(obj.lifetime > 0)
  }

  /**
   * True if `connection`'s client is on layer `tag` (its `layer`) and (x, y)
   * is strictly inside the box of half-width `reach` around its viewpoint.
   * Effects drawn on a cell only (`sendAt`): #48 kept them on the 500 box,
   * widened to the fogged view where that reaches further.
   */
  static inBox (connection: Connection, x: number, y: number, tag: number, reach: number): boolean {
    const player = Multiplayer.viewpoint(connection)
    if (player === undefined || connection.layer !== tag) return false
    return player.position.withinBounds(x, y, reach)
  }

  /**
   * True if `player` is among `World.interestCandidates` around `obj`: its
   * `INTEREST` bucket (`World.INTEREST_BUCKET`) is within one of `obj`'s on
   * both axes. The layer is not checked here.
   */
  static isCandidate (player: Player, obj: GameObject): boolean {
    const size = World.INTEREST_BUCKET
    return Math.abs(Math.floor(player.position.x / size) - Math.floor(obj.position.x / size)) <= 1 &&
      Math.abs(Math.floor(player.position.y / size) - Math.floor(obj.position.y / size)) <= 1
  }

  /**
   * True if `connection`'s client is on `obj`'s layer and `obj` is in its
   * viewpoint's sight (`viewOf`): within the enter radius, or with `leave`,
   * within the leave radius (a holder keeps it that far).
   */
  static sees (connection: Connection, obj: GameObject, leave: boolean = false): boolean {
    const player = Multiplayer.viewpoint(connection)
    if (player === undefined || connection.layer !== obj.tag) return false
    const view = Multiplayer.viewOf(player, obj.position.x, obj.position.y, Hex.toCell(obj.position))
    return view >= (leave ? Multiplayer.VIEW_EDGE : Multiplayer.VIEW_IN)
  }

  /**
   * Connections by the layer whose terrain they hold (`Connection.layer`).
   * Made on first use rather than as a field, so a Multiplayer a spec builds
   * with `Object.create` (skills/aim.spec.ts) can still `attach`.
   */
  private _layers: Map<number, Set<Connection>> | undefined
  private get layers (): Map<number, Set<Connection>> {
    if (this._layers === undefined) this._layers = new Map()
    return this._layers
  }

  private outbox (connection: Connection): Outbox {
    let out = connection.outbox
    if (out === undefined) {
      out = { create: [], create_own: [], effect: [], update: [], destroy: [] }
      connection.outbox = out
    }
    return out
  }

  private know (connection: Connection, obj: GameObject): void {
    connection.known.add(obj)
    obj.knownBy.add(connection)
  }

  private unknow (connection: Connection, obj: GameObject): void {
    connection.known.delete(obj)
    obj.knownBy.delete(connection)
  }

  /**
   * The destroys each outbox (one flush's worth) has been given for objects
   * leaving its client's view, by object, so `enter` can take one back. Weak
   * on the outbox, which is replaced at every flush, so it empties itself.
   * Static: a spec's `Object.create(Multiplayer.prototype)` runs no field
   * initialisers.
   */
  private static readonly _leaving = new WeakMap<Outbox, Map<GameObject, Buffer>>()

  /** `obj` leaves `connection`'s view: queue `record` (its id-only destroy) and let go of it. */
  private leave (connection: Connection, obj: GameObject, record: Buffer): void {
    const out = this.outbox(connection)
    out.destroy.push(record)
    let leaving = Multiplayer._leaving.get(out)
    if (leaving === undefined) {
      leaving = new Map()
      Multiplayer._leaving.set(out, leaving)
    }
    leaving.set(obj, record)
    this.unknow(connection, obj)
  }

  /**
   * `obj` comes into the view of `connection`, whose client does not hold
   * it: `record` (its whole record, or null for nothing to send) goes out as
   * a create, into `into` (the outbox's creates unless given), and it is
   * held from then on. **Unless it left the same view earlier in this
   * flush**: then the client still holds it, and the destroy and a create
   * for one id in one flush would be applied create first (the client takes
   * creates before destroys), leaving a second sprite. So the destroy is
   * taken back and the whole record goes as an update instead, as
   * `switchLayer` does for what it keeps. It happens when a view is
   * re-centred between flushes (a spectator's `watch`, a layer change) and
   * the object walks back into the new view before the next flush: with
   * server fog (#48) a Periscope's dead robot re-centred on a Peep made it
   * reachable at walking pace.
   */
  private enter (connection: Connection, obj: GameObject, record: Buffer | null, into?: Buffer[]): void {
    const out = this.outbox(connection)
    const leaving = Multiplayer._leaving.get(out)
    const pending = leaving?.get(obj)
    if (pending !== undefined) {
      leaving?.delete(obj)
      const at = out.destroy.lastIndexOf(pending)
      if (at >= 0) out.destroy.splice(at, 1)
      if (record !== null) out.update.push(record)
    } else if (record !== null) {
      (into ?? out.create).push(record)
    }
    this.know(connection, obj)
  }

  /** Put the connection's client on `tag` in the bookkeeping. Sends nothing. */
  private setLayer (connection: Connection, tag: number | undefined): void {
    if (connection.layer !== undefined) this.layers.get(connection.layer)?.delete(connection)
    connection.layer = tag
    if (tag === undefined) return
    let on = this.layers.get(tag)
    if (on === undefined) {
      on = new Set()
      this.layers.set(tag, on)
    }
    on.add(connection)
  }

  /**
   * Its client holds nothing any more: the player died, extracted, never
   * finished joining, or the socket went. Sends nothing; the client either
   * already had the destroy that ended its run or is gone.
   */
  private forget (connection: Connection): void {
    Multiplayer.unwatch(connection)
    // `known` is missing on a plain object a spec passes as a connection.
    if (connection.known !== undefined) {
      for (const obj of connection.known) obj.knownBy.delete(connection)
      connection.known.clear()
    }
    this.setLayer(connection, undefined)
    Multiplayer._settled.delete(connection)
  }

  /**
   * Make `player` this connection's player: it starts receiving what happens
   * around it on its layer. It holds its own object and nothing else yet; the
   * join snapshot (`admit`) sends the rest.
   */
  private attach (connection: Connection, player: Player): void {
    this.forget(connection)
    connection.player = player
    // A new run on this connection starts from no route: the client sends its
    // route only when it changes, and its first sample of a run whatever it
    // is, so a stale route here would make a repeat of it look like no change.
    connection.lastWaypoints = []
    connection.lastStandings = undefined
    connection.known = new Set()
    this.know(connection, player)
    this.setLayer(connection, player.tag)
    player.connection = connection
    Multiplayer._settled.delete(connection)
  }

  /** A create for all of the terrain on the connection's layer, into `into`. */
  private sendTerrain (connection: Connection, into: Buffer[]): void {
    for (const obj of World.OBSTACLES) {
      if (obj.tag === connection.layer && !obj.destroyed && Multiplayer.isTerrain(obj)) into.push(Multiplayer.terrainRecord(obj))
    }
  }

  /**
   * A terrain object's create record, encoded once and kept. Every join and
   * layer change sends the whole layer's terrain, about 150 records, and
   * re-encoding them was most of a join's cost (server-cpu-trim). Safe because
   * nothing changes a rock, stone, portal or exit after its constructor: none
   * of them has a wire field written after `create`. Weak, so it goes with the
   * object; `serialise.spec.ts` checks every cached record against a fresh
   * encoding after a ticked world.
   */
  private static readonly _terrainRecords = new WeakMap<GameObject, Buffer>()

  static terrainRecord (obj: GameObject): Buffer {
    let record = Multiplayer._terrainRecords.get(obj)
    if (record === undefined) {
      record = obj.serialiseBinary(obj.allFields) as Buffer
      Multiplayer._terrainRecords.set(obj, record)
    }
    return record
  }

  /**
   * A create, into `into`, for every unit, pickup, projectile and StoneWall
   * stone within the connection's enter radius (`sees`; server fog, #48) that
   * its client does not hold yet, and mark them held. For the join and a
   * layer change only: from then on `update` keeps it current. Players come from `World.INTEREST`; the other lists are
   * walked whole (about 81 mobs, 500 pickups and a few projectiles), which is
   * cheap next to serialising what is found.
   */
  private sendVisible (connection: Connection, into: Buffer[]): void {
    const player = Multiplayer.viewpoint(connection)
    const tag = connection.layer
    if (player === undefined || tag === undefined) return
    const visit = (obj: GameObject): void => {
      if (obj.tag !== tag || obj.knownBy.has(connection) || Multiplayer.gone(obj)) return
      if (!Multiplayer.sees(connection, obj)) return
      this.enter(connection, obj, obj.serialiseBinary(obj.allFields), into)
    }
    for (const obj of World.PROJECTILES) visit(obj)
    // StoneWall stones: the obstacles that are not terrain.
    for (const obj of World.OBSTACLES) if (!Multiplayer.isTerrain(obj)) visit(obj)
    for (const obj of World.CONSUMABLES) visit(obj)
    for (const obj of World.ITEMS) visit(obj)
    for (const obj of World.interestCandidates(player.position.x, player.position.y, tag)) visit(obj)
    for (const obj of World.MOBS) visit(obj)
  }

  /**
   * The connection's player is on another layer than its client (it came
   * through a portal last tick): swap the client over, in the flush that
   * carries the player's new tag. A destroy for the old layer's terrain and
   * for every unit, pickup and projectile it held there, a create for the new
   * layer's terrain and for what is in range on it (decision #35). Its own
   * object is kept. So is anything that came through with it and is still
   * within the leave radius (`sees(…, true)`, #48): a destroy and a create for
   * one id in one flush would be applied create first, and leave a sprite
   * behind. A spectator re-centred on another player (`watch`) comes through
   * here too, and from then on sees by that player's vision.
   *
   * What is kept is sent whole, as an update. Between its player's hop and
   * this, the connection was sent no changes (`update` finds it on neither
   * layer), so the client may have missed one, such as the other player's own
   * new tag, and would go on drawing it on the old layer.
   */
  private switchLayer (connection: Connection): void {
    const player = Multiplayer.viewpoint(connection)
    if (player === undefined) return
    const out = this.outbox(connection)

    // A spectator re-centred on someone on its own layer keeps the terrain.
    if (connection.layer !== player.tag) {
      for (const obj of World.OBSTACLES) {
        if (obj.tag === connection.layer && !obj.destroyed && Multiplayer.isTerrain(obj)) {
          out.destroy.push(obj.serialiseBinary(ID_ONLY as Set<string>))
        }
      }
      this.setLayer(connection, player.tag)
      this.sendTerrain(connection, out.create)
    }

    for (const obj of connection.known) {
      if (obj === player) continue
      // Gone already, and its destroy was sent when it went: just let go.
      if (Multiplayer.gone(obj)) {
        this.unknow(connection, obj)
        continue
      }
      if (Multiplayer.sees(connection, obj, true)) {
        const whole = obj.serialiseBinary(obj.allFields)
        if (whole !== null) out.update.push(whole)
        continue
      }
      this.leave(connection, obj, obj.serialiseBinary(ID_ONLY as Set<string>) as Buffer)
    }
    this.sendVisible(connection, out.create)
    // Re-centred here, so the pickup pass settles it from scratch.
    Multiplayer._settled.delete(connection)
  }

  /**
   * Where `pickupViews` last settled each connection's pickups and stones: its
   * viewpoint, layer and cell (and position, for a viewpoint with no vision).
   * Deleted wherever the held set is rebuilt outside that pass (`switchLayer`,
   * `forget`, `attach`), so the next pass settles it whole. Static and weak: a
   * spec's `Object.create(Multiplayer.prototype)` runs no field initialisers,
   * and an entry goes with its connection.
   */
  private static readonly _settled = new WeakMap<Connection, { viewer: Player, tag: number, q: number, r: number, x: number, y: number }>()

  /**
   * What `pickupViews` did, summed over every pass since the process started,
   * so each branch is observable (`pickuppass.spec.ts`): connections skipped
   * (no change of cell), settled from the rings round a short move, settled
   * from the whole lists, and the creates and destroys it queued.
   */
  static readonly pickupViewCounts = { skipped: 0, rings: 0, whole: 0, entered: 0, left: 0 }

  /** True for what `pickupViews` brings into and out of view: loot, items and StoneWall stones. */
  static isPickupLike (obj: GameObject): boolean {
    return obj.type === ObjectType.Consumable || obj.type === ObjectType.Item ||
      (obj.type === ObjectType.Obstacle && !Multiplayer.isTerrain(obj))
  }

  /**
   * Pickups and StoneWall stones into and out of each connection's view
   * (`World.pickupPass`, after the dirty and new ones have had their own
   * `update`). They never move, so what a connection holds of them changes
   * only when its viewpoint changes cell; this does, per connection, what
   * every pickup's `update` would do for it, with the same rules:
   *
   * - one it does not hold within the enter radius (`viewOf` `VIEW_IN`) is
   *   sent a create and held;
   * - one it holds beyond the leave radius (`VIEW_OUT`) is sent an id-only
   *   destroy and dropped.
   *
   * A connection whose viewpoint is where this last left it is skipped. One
   * that moved a cell or two on the same layer and viewpoint looks only at the
   * cells that came within its enter radius (the outer rings round its new
   * cell that were beyond it from the old one) and at what it holds; anything
   * else (a first pass, a layer change, a new viewpoint, a longer move, no
   * vision) walks the lists, as `sendVisible` does. A connection whose client
   * has a layer change pending, or whose viewpoint is gone, is left alone, as
   * `update` leaves it. Replaced a per-pickup pass gated on the buckets
   * players moved in (2026-10-03): that ran about 190 pickup updates a tick
   * at 200-400 players, to send a handful of creates and destroys.
   */
  pickupViews (): void {
    Multiplayer.checkWorld(this, 'Multiplayer.pickupViews')
    const counts = Multiplayer.pickupViewCounts
    const connections = this._connections
    if (connections === undefined) return
    let stones: Map<number, Map<number, GameObject[]>> | undefined
    let records: Map<GameObject, Buffer | null> | undefined
    const enterIfIn = (connection: Connection, viewer: Player, obj: GameObject): void => {
      if (obj.knownBy.has(connection) || Multiplayer.gone(obj)) return
      if (Multiplayer.viewOf(viewer, obj.position.x, obj.position.y, Hex.toCell(obj.position)) !== Multiplayer.VIEW_IN) return
      if (records === undefined) records = new Map()
      let record = records.get(obj)
      if (record === undefined) {
        record = obj.serialiseBinary(obj.allFields)
        records.set(obj, record)
      }
      this.enter(connection, obj, record)
      counts.entered++
    }
    for (const connection of connections) {
      const viewer = Multiplayer.viewpoint(connection)
      const tag = connection.layer
      if (viewer === undefined || tag === undefined || tag !== viewer.tag || Multiplayer.gone(viewer) || connection.known === undefined) {
        Multiplayer._settled.delete(connection)
        continue
      }
      const cell = Hex.toCell(viewer.position)
      const vision = viewer.archetype?.vision
      const was = Multiplayer._settled.get(connection)
      const same = was !== undefined && was.viewer === viewer && was.tag === tag
      if (same && was.q === cell.x && was.r === cell.y &&
        (vision !== undefined && vision !== null ? true : was.x === viewer.position.x && was.y === viewer.position.y)) {
        counts.skipped++
        continue
      }

      const moved = same && vision !== undefined && vision !== null
        ? Hex.distance(new Vector(was.q, was.r), cell)
        : Infinity
      if (moved <= 2) {
        counts.rings++
        // Cells within `enter` rings of the new cell and beyond it from the
        // old one: all in the outer `moved` rings round the new cell.
        const enter = (vision as number) + Multiplayer.VIEW_MARGIN_RINGS
        const old = new Vector(was?.q as number, was?.r as number)
        const pickups = World.PICKUPS.buckets(tag)
        if (stones === undefined) stones = Multiplayer.stonesByCell()
        const layerStones = stones.get(tag)
        for (let ring = Math.max(0, enter - moved + 1); ring <= enter; ring++) {
          Multiplayer.forRing(cell, ring, (q, r) => {
            if (Hex.distance(old, new Vector(q, r)) <= enter) return
            const key = Hex.key(q, r)
            const here = pickups.get(key)
            if (here !== undefined) for (const obj of here) enterIfIn(connection, viewer, obj)
            const stone = layerStones?.get(key)
            if (stone !== undefined) for (const obj of stone) enterIfIn(connection, viewer, obj)
          })
        }
      } else {
        counts.whole++
        for (const obj of World.CONSUMABLES) if (obj.tag === tag) enterIfIn(connection, viewer, obj)
        for (const obj of World.ITEMS) if (obj.tag === tag) enterIfIn(connection, viewer, obj)
        for (const obj of World.OBSTACLES) if (obj.tag === tag && !Multiplayer.isTerrain(obj)) enterIfIn(connection, viewer, obj)
      }

      // What it holds and no longer sees. Deleting the current entry of a Set
      // while iterating it is safe.
      for (const obj of connection.known) {
        if (!Multiplayer.isPickupLike(obj) || Multiplayer.gone(obj)) continue
        const view = obj.tag === tag ? Multiplayer.viewOf(viewer, obj.position.x, obj.position.y, Hex.toCell(obj.position)) : Multiplayer.VIEW_OUT
        if (view === Multiplayer.VIEW_OUT) {
          this.leave(connection, obj, obj.serialiseBinary(ID_ONLY as Set<string>) as Buffer)
          counts.left++
        }
      }
      Multiplayer._settled.set(connection, { viewer, tag, q: cell.x, r: cell.y, x: viewer.position.x, y: viewer.position.y })
    }
  }

  /** StoneWall stones (the obstacles that are not terrain), by layer and `Hex.key` of their cell. */
  static stonesByCell (): Map<number, Map<number, GameObject[]>> {
    const result = new Map<number, Map<number, GameObject[]>>()
    for (const obj of World.OBSTACLES) {
      if (Multiplayer.isTerrain(obj)) continue
      let layer = result.get(obj.tag)
      if (layer === undefined) {
        layer = new Map()
        result.set(obj.tag, layer)
      }
      const cell = Hex.toCell(obj.position)
      const key = Hex.key(cell.x, cell.y)
      const here = layer.get(key)
      if (here === undefined) layer.set(key, [obj])
      else here.push(obj)
    }
    return result
  }

  /**
   * Calls `fn` with each cell exactly `ring` rings from `centre` (the centre
   * itself for 0): 6 x `ring` cells, walking the ring's six sides in
   * `Hex.DIRECTIONS` order from the corner `ring` steps along direction 4.
   */
  static forRing (centre: Vector, ring: number, fn: (q: number, r: number) => void): void {
    if (ring === 0) {
      fn(centre.x, centre.y)
      return
    }
    const directions = Hex.DIRECTIONS
    let q = centre.x + directions[4].x * ring
    let r = centre.y + directions[4].y * ring
    for (let side = 0; side < 6; side++) {
      const step = directions[side]
      for (let i = 0; i < ring; i++) {
        fn(q, r)
        q += step.x
        r += step.y
      }
    }
  }

  /**
   * A new object. Terrain goes to every connection on its layer; anything
   * else only to connections whose client is on its layer and has it within
   * the enter radius (`sees`; server fog, #48), which then hold it (decision
   * #35). Others get it when it comes into their range (`update`).
   */
  create (obj: GameObject): void {
    Multiplayer.checkWorld(this, 'Multiplayer.create')
    if (!Multiplayer.gone(obj)) {
      const data = Multiplayer.isTerrain(obj) ? Multiplayer.terrainRecord(obj) : obj.serialiseBinary(obj.allFields)
      if (Multiplayer.isTerrain(obj)) {
        for (const connection of this.layers.get(obj.tag) ?? []) this.outbox(connection).create.push(data)
      } else {
        for (const player of World.interestCandidates(obj.position.x, obj.position.y, obj.tag)) {
          for (const connection of this.viewersOf(player, Multiplayer._viewersCreate)) {
            // Its own player's object goes out once, as create_own (`admit`).
            if (connection.player === obj) continue
            if (obj.knownBy.has(connection) || !Multiplayer.sees(connection, obj)) continue
            this.enter(connection, obj, data)
          }
        }
      }
    }
    obj.dirtyFields.clear()
  }

  /**
   * An object's tick, for every unit, projectile and pickup, changed or not
   * (a pickup's comes from `World.update`). This is where it comes into and
   * goes out of each connection's view, whichever of the two moved:
   *
   * - a connection whose client is on its layer with it within the enter
   *   radius (server fog, #48: the viewpoint's vision + 1 ring, `viewOf`),
   *   and that does not hold it, is sent a create (the whole record) and
   *   holds it from then on;
   * - one that holds it is sent its changes, if any, while it is within the
   *   leave radius (one ring further);
   * - one that holds it and no longer has it within the leave radius on its
   *   layer is sent a destroy (`id` only) and drops it.
   *
   * So a client is never sent an update for an object it does not hold (the
   * client ignores those) or a create for one it does (the client would draw
   * a second sprite and lose track of the first). This replaces hex-cells
   * P1's `changedAt` / `seen` counters: an object out of range is not held,
   * so there is no missed change to make up with a whole record.
   *
   * The player's own object is always held by its own connection, and is
   * never destroyed on it except by death or exit. Its first update after a
   * portal moves its client to the new layer first (`switchLayer`).
   */
  update (obj: GameObject): void {
    Multiplayer.checkWorld(this, 'Multiplayer.update')
    if (Multiplayer.gone(obj)) {
      obj.dirtyFields.clear()
      return
    }

    const self = obj.type === ObjectType.Player ? this.connectionOf(obj as Player) : undefined
    if (self !== undefined && self.layer !== obj.tag) this.switchLayer(self)
    // Its spectators follow it through a portal the same way (#47).
    const watchers = obj.type === ObjectType.Player ? (obj as Player).spectators : undefined
    if (watchers !== undefined) for (const watcher of watchers) if (watcher.layer !== obj.tag) this.switchLayer(watcher)

    // Encoded at most once each, on first need, and shared by every
    // connection it goes to. `null` from the serialiser means nothing to send.
    const changed = obj.dirtyFields.size > 0
    let changedData: Buffer | null | undefined
    let fullData: Buffer | null | undefined

    // Holders still in view, found here; if that is all of them, none has
    // left and the loop over holders below is skipped. A holder in the exit
    // ring is served here too when it is among the candidates, so one
    // standing in that ring does not force that loop every tick.
    const knownBy = obj.knownBy
    // Read once: nothing below moves the object. Its cell is worked out once
    // here, and each candidate's view of it once (`viewOf`, which `sees`
    // also uses), since this loop runs for every player near every object
    // every tick.
    const ox = obj.position.x
    const oy = obj.position.y
    const otag = obj.tag
    const ocell = Hex.toCell(obj.position)
    let holdersInRange = 0
    for (const player of World.interestCandidates(ox, oy, otag)) {
      // Its own connection and its spectators, who all see from `player`,
      // by its vision (#48).
      const viewers = this.viewersOf(player, Multiplayer._viewersUpdate)
      // A bot, or a player whose run ended this tick: nobody to send to.
      if (viewers.length === 0) continue
      const view = Multiplayer.viewOf(player, ox, oy, ocell)
      for (const connection of viewers) {
        const onLayer = connection.layer === otag
        if (connection !== self && !(onLayer && view === Multiplayer.VIEW_IN)) {
          // Not within the enter radius. A holder whose client is on this
          // layer (so no switch pending) and still has it within the leave
          // radius keeps it.
          if (connection.layer === player.tag && onLayer && view === Multiplayer.VIEW_EDGE && knownBy.has(connection)) {
            holdersInRange++
            if (changed) {
              if (changedData === undefined) changedData = obj.serialiseBinary(obj.dirtyFields)
              if (changedData !== null) this.outbox(connection).update.push(changedData)
            }
          }
          continue
        }
        if (knownBy.has(connection)) {
          holdersInRange++
          if (changed) {
            if (changedData === undefined) changedData = obj.serialiseBinary(obj.dirtyFields)
            if (changedData !== null) this.outbox(connection).update.push(changedData)
          }
        } else {
          if (fullData === undefined) fullData = obj.serialiseBinary(obj.allFields)
          this.enter(connection, obj, fullData)
        }
      }
    }

    if (holdersInRange < knownBy.size) {
      let gone: Buffer | undefined
      for (const connection of knownBy) {
        // Its own: handled above.
        if (connection === self) continue
        const player = Multiplayer.viewpoint(connection)
        // A player who died or left this tick: dropped whole at the flush.
        if (player === undefined || Multiplayer.gone(player)) continue
        const view = connection.layer === otag ? Multiplayer.viewOf(player, ox, oy, ocell) : Multiplayer.VIEW_OUT
        // Within the enter radius: a candidate (the buckets cover every
        // view, `World.INTEREST_BUCKET`), handled above.
        if (view === Multiplayer.VIEW_IN) continue
        // Served above: a candidate (on the object's layer, in the 3 x 3
        // buckets around it) with no switch pending and it in the exit ring.
        if (connection.layer === player.tag && player.tag === otag &&
          Multiplayer.isCandidate(player, obj) && view === Multiplayer.VIEW_EDGE) continue
        // Its client changes layer at its player's own update (`switchLayer`),
        // which settles everything it holds. A destroy from here as well
        // could meet a create from the switch for the same id in one flush:
        // two players who come through portals together, each updated before
        // the other's switch.
        if (connection.layer !== player.tag) continue
        if (view === Multiplayer.VIEW_EDGE) {
          if (changed) {
            if (changedData === undefined) changedData = obj.serialiseBinary(obj.dirtyFields)
            if (changedData !== null) this.outbox(connection).update.push(changedData)
          }
          continue
        }
        if (gone === undefined) gone = obj.serialiseBinary(ID_ONLY as Set<string>) as Buffer
        this.leave(connection, obj, gone)
      }
    }

    obj.dirtyFields.clear()
  }

  /**
   * An effect's lifetime as the wire's int8 of tenths of a second, clamped to
   * 0..127 (12.7 s). Unclamped, a lifetime of 12.8 s or more threw
   * `ERR_OUT_OF_RANGE` inside the tick (an old audit note; no effect is that
   * long today), and a negative one did too.
   */
  static effectLifetime (lifetime: number): number {
    const tenths = Math.floor(lifetime / 100)
    return Number.isFinite(tenths) ? Math.max(0, Math.min(127, tenths)) : 0
  }

  /**
   * `[int8 type][uint16 originator id][int8 lifetime / 100]`, then, only for an
   * aimed effect, `[int16 q][int16 r]` (big-endian): the cell the effect points
   * at. For a ranged shot that is the aimed cell; for a breath it is the tip of
   * the cone, `rings` cells straight out along its held direction (see
   * `SectorArea.tipCell`). The record's own length prefix says which form it
   * is: 4 bytes means unaimed, 8 means aimed. Appended rather than inserted, so
   * a client that reads only the first four bytes still works.
   *
   * Who gets it depends on what the client draws it on (fog follow-ups,
   * #48, Nick 2026-10-03):
   *
   * - **Types 0-4** (breaths, melee, ranged, defend) are drawn on their
   *   originator, which the client looks up by id (`Game.onEffect`), so they
   *   go to exactly the connections that hold it (`knownBy`): its own, those
   *   in whose sight it is, and their spectators, who hold what their
   *   viewpoint sees. Under server fog the 500 box also reached clients that
   *   did not hold the originator, which dropped the record unread (about
   *   half of these effects; `Game.EFFECTS_UNHELD`). A connection whose own
   *   player has died and that is not yet spectating is skipped, as before.
   *
   * Types 5-8 (fireball and icicle blasts, bomb fuse and blast) are drawn on
   * a cell and go through `effectAt` instead.
   */
  effect (type: number, originator: Unit, lifetime: number, aimCell?: Vector): void {
    Multiplayer.checkWorld(this, 'Multiplayer.effect')
    const data = Buffer.alloc(aimCell === undefined ? 4 : 8)
    data.writeInt8(type)
    data.writeUInt16BE(originator.id, 1)
    data.writeInt8(Multiplayer.effectLifetime(lifetime), 3)
    if (aimCell !== undefined) {
      data.writeInt16BE(aimCell.x, 4)
      data.writeInt16BE(aimCell.y, 6)
    }

    for (const connection of originator.knownBy) {
      // A player killed this tick still holds what it held until it is
      // re-centred; its client has its own destroy already and is showing
      // its run card.
      const viewpoint = Multiplayer.viewpoint(connection)
      if (viewpoint === undefined || Multiplayer.gone(viewpoint)) continue
      this.outbox(connection).effect.push(data)
    }
  }

  /**
   * An aimed effect that belongs to a cell rather than to its originator: the
   * same record as `effect`, but sent to connections whose player is on `tag`
   * and see the cell (`sendAt`). A bomb lands up to 6
   * cells from its thrower and the fuse outlives them, so the thrower's
   * position says nothing about who can see it. The fireball and icicle
   * blasts (5, 6) come here too, with the projectile's own layer: a thrower
   * who hops a portal during the flight is on another layer by the burst,
   * and the blast belongs where it hits. `originatorId` is carried but
   * the client does not look it up for these types: by the blast it may be
   * dead, and its id reused.
   */
  effectAt (type: number, originatorId: number, lifetime: number, cell: Vector, tag: number): void {
    Multiplayer.checkWorld(this, 'Multiplayer.effectAt')
    const data = Buffer.alloc(8)
    data.writeInt8(type)
    data.writeUInt16BE(originatorId, 1)
    data.writeInt8(Multiplayer.effectLifetime(lifetime), 3)
    data.writeInt16BE(cell.x, 4)
    data.writeInt16BE(cell.y, 6)

    this.sendAt(data, cell, tag)
  }

  /**
   * Sends an effect record drawn on `cell` to every connection on layer `tag`
   * that sees the cell: its centre inside the 500 box around the viewpoint
   * (#48 kept effects off the fog), or within the viewpoint's leave radius
   * (`viewOf`), which reaches further east-west than the box for Periscope
   * (12 rings to enter, 540 units). `interestCandidates` covers both: its
   * buckets are sized for the largest view (`World.INTEREST_BUCKET`).
   */
  private sendAt (data: Buffer, cell: Vector, tag: number): void {
    const centre = Hex.toPosition(cell)
    for (const player of World.interestCandidates(centre.x, centre.y, tag)) {
      // `viewersOf` skips a player killed this tick: its client has its own
      // destroy already and is showing its run card. Every connection it
      // returns sees from `player`.
      for (const connection of this.viewersOf(player, Multiplayer._viewersEffect)) {
        if (Multiplayer.inBox(connection, centre.x, centre.y, tag, Multiplayer.INTEREST_RADIUS) ||
          (connection.layer === tag && Multiplayer.viewOf(player, centre.x, centre.y, cell) >= Multiplayer.VIEW_EDGE)) {
          this.outbox(connection).effect.push(data)
        }
      }
    }
  }

  /**
   * The object is gone: its destroy record goes to exactly the connections
   * whose client holds it (terrain: every connection on its layer), including
   * a unit killed this tick, which is still held until now. Its own
   * connection holds a player, so it is told of its own death or exit.
   */
  destroy (obj: GameObject): void {
    Multiplayer.checkWorld(this, 'Multiplayer.destroy')
    // Never null: `GameObject.destroy` and `Player.exit` both put `id` in it.
    const data = obj.serialiseBinary(obj.dirtyFields) ?? obj.serialiseBinary(ID_ONLY as Set<string>) as Buffer
    if (Multiplayer.isTerrain(obj)) {
      for (const connection of this.layers.get(obj.tag) ?? []) this.outbox(connection).destroy.push(data)
    } else {
      for (const connection of obj.knownBy) {
        this.outbox(connection).destroy.push(data)
        connection.known.delete(obj)
      }
      obj.knownBy.clear()
    }

    // The run's end, once (`Player.runOver`): flagged before anything below
    // can throw, so a second destroy of the same run (a disconnect after an
    // extraction, an `exit` that threw before `exited`) writes no stats, sends
    // no `run_end` and grants no XP again.
    if (obj.type === ObjectType.Player && !(obj as Player).runOver) {
      const player = obj as Player
      player.runOver = true
      const own = this.connectionOf(player)
      if (own !== undefined) {
        this.updateStats(player).catch(Multiplayer.logStatsFailure)
        const xp = Multiplayer.sendRunEnd(player)
        this.runEnded?.(own, player, xp)
      }
    }

    obj.dirtyFields.clear()
  }

  /**
   * Analytics `run_end` (#46; the event's params are listed in analytics.ts).
   * Sent a microtask later: a killing hit destroys its victim inside
   * `target.hit()`, before the attacker's `onKill` records itself as the
   * killer (`Unit.killedBy`). Everything else is read now.
   *
   * Returns the XP the run earned (decision #48 step 3), from the same values
   * (`xp_gained`; 0 on an offline run), which the caller grants.
   */
  static sendRunEnd (player: Player): number {
    const outcome = player.extracted ? 'extracted' : player.hp <= 0 ? 'died' : 'left'
    const at = Date.now()
    const seconds = Math.round((at - player.createdAt) / 1000)
    const deepest = World.TAGS.indexOf(Math.min(player.deepestTag, player.tag)) + 1
    const offline = Multiplayer.isOffline(player)
    const xp = earnedXp(player, offline, seconds, deepest)
    const params = {
      outcome,
      seconds,
      loot: Math.floor(player.loot),
      kills: player.kills,
      deepest_layer: deepest,
      robot: player.archetype.key,
      xp_gained: xp
    }
    const run = { playerId: player.playerId, startedAt: player.createdAt, offline }
    queueMicrotask(() => {
      Analytics.send(run, 'run_end', outcome === 'died' ? { ...params, killed_by: player.killedBy ?? 'other' } : params, at)
    })
    return xp
  }

  /**
   * The player's run is on an offline account (the account store failed,
   * decision #48): it writes no Redis stats, which would be keys nobody can
   * ever come back to, and its analytics carry `offline: 1`.
   */
  static isOffline (player: Player): boolean {
    return player.connection?.account?.persisted === false
  }

  async updateStats (player: Player): Promise<void> {
    if (Multiplayer.isOffline(player)) return
    const stats = new Stats()

    stats.lifeTime = Math.ceil((Date.now() - player.createdAt) / 1000)
    stats.games = 1

    if (player.hp > 0) { stats.lootCollected = player.loot }

    // Taken before the first await: after it, whichever world is current (or
    // none) is not this player's (worlds-per-process). The key is too.
    const redis = Multiplayer.Instance.redis
    const key = `stats-${player.playerId}`
    for (const field in stats) {
      if (stats[field] > 0) {
        await redis.hincrby(key, field, stats[field])
      }
    }
  }

  private _leaderboard: Record<string, Record<string, string>> = {}
  private _leaderboardAt: number = 0

  async getLeaderboard (): Promise<Record<string, Record<string, string>>> {
    if (Date.now() - this._leaderboardAt < 3000) return this._leaderboard

    // `this.redis`, never `Multiplayer.Instance`: this runs from the HTTP
    // handler and across awaits, outside any world (worlds-per-process).
    const redis = this.redis
    const keys = await redis.keys('stats-*')
    const data: Record<string, Record<string, string>> = {}
    for (const key of keys) data[key] = await redis.hgetall(key)

    this._leaderboard = data
    this._leaderboardAt = Date.now()
    return data
  }

  // One binary attachment per event instead of one per object. socket.io-parser
  // caps a packet at 10 attachments (added after this code was written), so a
  // join sending ~650 objects was rejected outright with "too many attachments"
  // and the client reconnected forever. Batching also collapses ~650 WebSocket
  // frames per join into one.
  static packRecords (records: Buffer[], header?: Buffer): Buffer {
    const start = header?.length ?? 0
    const out = Buffer.allocUnsafe(start + Multiplayer.packedLength(records))
    if (header !== undefined) header.copy(out, 0)
    Multiplayer.writeRecords(records, out, start)
    return out
  }

  /** Bytes `records` take packed: a uint16 length before each. */
  static packedLength (records: Buffer[]): number {
    let bytes = 0
    for (const record of records) bytes += 2 + record.length
    return bytes
  }

  /** Write `records` packed into `out` from `at`; returns the offset after them. */
  static writeRecords (records: Buffer[], out: Buffer, at: number): number {
    for (const record of records) {
      out.writeUInt16BE(record.length, at)
      record.copy(out, at + 2)
      at += 2 + record.length
    }
    return at
  }

  /**
   * The one binary frame a framed connection gets per tick (`Connection.framed`):
   *
   * `[uint8 version][uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]`
   * then sections to the end: `[uint8 kind][uint32 length][payload]`.
   *
   * The header is the `update` header. Each payload is exactly the buffer the
   * matching event carries unframed: records packed as `packRecords` does,
   * and for standings the board's buffer. Kinds, in the order written, which
   * is the order the events have always gone out in: 1 create, 2 create_own,
   * 3 effect, 4 destroy, 5 standings, 6 update. An empty section is left out,
   * and the client still applies the header when there are no update records.
   * The kind numbers are a wire contract: append-only, like field indices.
   */
  static FRAME_VERSION = 1
  static FRAME_KINDS: ReadonlyArray<[keyof Outbox | 'standings', number]> = [
    ['create', 1], ['create_own', 2], ['effect', 3], ['destroy', 4], ['standings', 5], ['update', 6]
  ]

  static packFrame (out: Outbox | undefined, standings: Buffer | undefined, tick: number, lastInputSeq: number, ackElapsedMs: number): Buffer {
    let bytes = 9
    for (const [kind] of Multiplayer.FRAME_KINDS) {
      if (kind === 'standings') {
        if (standings !== undefined) bytes += 5 + standings.length
        continue
      }
      const records = out?.[kind]
      if (records !== undefined && records.length > 0) bytes += 5 + Multiplayer.packedLength(records)
    }
    const frame = Buffer.allocUnsafe(bytes)
    frame.writeUInt8(Multiplayer.FRAME_VERSION, 0)
    frame.writeUInt32BE(tick >>> 0, 1)
    frame.writeUInt16BE(lastInputSeq, 5)
    frame.writeUInt16BE(Math.min(65535, Math.round(ackElapsedMs)), 7)
    let at = 9
    for (const [kind, code] of Multiplayer.FRAME_KINDS) {
      if (kind === 'standings') {
        if (standings === undefined) continue
        frame.writeUInt8(code, at)
        frame.writeUInt32BE(standings.length, at + 1)
        standings.copy(frame, at + 5)
        at += 5 + standings.length
        continue
      }
      const records = out?.[kind]
      if (records === undefined || records.length === 0) continue
      frame.writeUInt8(code, at)
      const end = Multiplayer.writeRecords(records, frame, at + 5)
      frame.writeUInt32BE(end - at - 5, at + 1)
      at = end
    }
    return frame
  }

  flushAll (tick: number, dtMs: number = 0): void {
    Multiplayer.checkWorld(this, 'Multiplayer.flushAll')
    const board = this.standingsDue() ? Multiplayer.rankStandings() : undefined
    for (const connection of this._connections) {
      // The watched player's run ended: on to whoever is nearest it, or stop.
      const watched = connection.spectating
      if (watched !== undefined && Multiplayer.gone(watched)) {
        const next = Multiplayer.spectateTarget(watched)
        if (next !== undefined) this.watch(connection, next)
        else this.stopWatching(connection)
      }
      if (connection.player != null) connection.ackElapsedMs += dtMs
      // Only a board that differs from the last one this connection got: the
      // client shows the last board it was sent until another arrives, so a
      // repeat changes nothing on screen (server-cpu-trim; standings were 9-15%
      // of a client's bytes, sent every second changed or not).
      let standings = board?.bufferFor(connection.player)
      if (standings !== undefined && connection.player != null) {
        if (connection.lastStandings?.equals(standings) === true) standings = undefined
        else connection.lastStandings = standings
      }
      this.flush(connection, tick, standings)
    }
  }

  // Spectate ======== (decision #47)

  /**
   * Who a connection whose player just died (or whose watched player's run
   * just ended) watches: `preferred` if it is a live player (the killer), else
   * the live player nearest `from` on its layer, else on any layer, bots
   * included. Undefined when nobody is left.
   */
  static spectateTarget (from: Player, preferred?: GameObject): Player | undefined {
    if (preferred !== undefined && preferred.type === ObjectType.Player && !Multiplayer.gone(preferred)) return preferred as Player
    let best: Player | undefined
    let bestScore = Infinity
    for (const player of World.PLAYERS) {
      if (player === from || Multiplayer.gone(player)) continue
      const dx = player.position.x - from.position.x
      const dy = player.position.y - from.position.y
      // Another layer counts as far: any one on the same layer comes first.
      const score = dx * dx + dy * dy + (player.tag === from.tag ? 0 : 1e12)
      if (score < bestScore) {
        best = player
        bestScore = score
      }
    }
    return best
  }

  /** Watch `target`: re-centre the client's view on it and tell the client whom it follows. */
  private watch (connection: Connection, target: Player): void {
    Multiplayer.unwatch(connection)
    connection.spectating = target
    if (target.spectators === undefined) target.spectators = new Set()
    target.spectators.add(connection)
    this.switchLayer(connection)
    // A plain event: framed clients still decode text packets (framedparser.ts).
    connection.socket.emit('spectate', { id: target.id, name: target.name })
  }

  /** Nobody left to watch: the client keeps its card and is sent nothing more. */
  private stopWatching (connection: Connection): void {
    this.forget(connection)
    connection.socket.emit('spectate', { id: null })
  }

  /** Off the watched player's list. Sends nothing. */
  static unwatch (connection: Connection): void {
    const watched = connection.spectating
    if (watched === undefined) return
    watched.spectators?.delete(connection)
    connection.spectating = undefined
  }

  // Standings ========

  /**
   * How often the standings board goes out, in ms. Counted in ticks. 3 s, not
   * the 1 s it was (bandwidth review, 2026-09-27): about 170-190 B/s per
   * client at 1 s whatever the player count, which at a few players was the
   * largest single part of their traffic.
   */
  static STANDINGS_INTERVAL_MS = 3000
  private _ticksSinceStandings = 0

  /**
   * True on every `STANDINGS_INTERVAL_MS / tickLengthMs`-th call (every 4th at
   * 250 ms ticks, and every tick if the tick is a second or longer). Counted
   * per `flushAll` call, which is once per tick, rather than read off the
   * tick number or the clock: no timer, and nothing a spec's tick numbering
   * can upset.
   */
  private standingsDue (): boolean {
    const every = Math.max(1, Math.round(Multiplayer.STANDINGS_INTERVAL_MS / this.tickLengthMs))
    this._ticksSinceStandings++
    if (this._ticksSinceStandings < every) return false
    this._ticksSinceStandings = 0
    return true
  }

  /** How many of the best rows every connection is sent (decision #30). */
  static STANDINGS_TOP = 10

  /**
   * The `standings` event: the top `STANDINGS_TOP` rows of the board, plus the
   * connection's own row when it is not among them, packed with `packRecords`.
   * The board is every player in the world plus those who finished in the
   * last `World.FINISHED_LINGER_MS`, ranked by loot (most first, ties by id).
   * Finished rows rank by their loot like live ones, so they can be among the
   * top rows, as when the whole board was sent. One record per row:
   *
   * `[uint16 id][uint8 status][uint32 loot][name, UTF-8][0][uint16 rank]`, big-endian.
   *
   * Status is a `Standing`: 0 ACTIVE, 1 EXTRACTED, 2 DEAD. The rank is 1-based,
   * the row's position on the whole board, so tied rows get distinct ranks in
   * id order. It is sent because the own row, appended after the top rows, is
   * not at its rank's position; a client that reads no rank ranks by position
   * and shows the appended row as 11th, so the client ships first. The client
   * finds its own row by id **and** ACTIVE: ids are recycled a second after a
   * player leaves, so a lingering finished row can carry the id of a newer
   * object, but no two live players share one. The server picks the own row
   * by the player object, not the id. Fields after the rank are for later
   * additions (the layer, say) and an older client ignores them. World-wide,
   * not per plane.
   *
   * A player killed or extracted during this tick is still in PLAYERS until
   * the next tick's sweep moves it to FINISHED; its flags give its status here,
   * so it does not drop off the board for that tick.
   *
   * Ranking happens once per board. The per-connection part is
   * `StandingsBoard.bufferFor`, which returns the shared top buffer itself
   * unless the own row has to be appended.
   */
  static rankStandings (): StandingsBoard {
    const rows: StandingsRow[] = []
    for (const player of World.PLAYERS) {
      const status = player.destroyed ? Standing.DEAD : player.exited ? Standing.EXTRACTED : Standing.ACTIVE
      rows.push({ id: player.id, status, loot: player.loot ?? 0, name: player.name ?? '', player, bot: player.bot !== undefined })
    }
    for (const finished of World.FINISHED) rows.push(finished)

    rows.sort((a, b) => (b.loot - a.loot) || (a.id - b.id))
    return new StandingsBoard(rows, Multiplayer.STANDINGS_TOP)
  }

  /** One connection's `standings` buffer; `own` is its player, if it has one. */
  static buildStandings (own?: Player): Buffer {
    return Multiplayer.rankStandings().bufferFor(own)
  }

  onDisconnect (socket: Socket): void {
    Multiplayer.checkWorld(this, 'Multiplayer.onDisconnect')
    for (let i = 0; i < this._connections.length; i++) {
      if (this._connections[i].socket === socket) {
        this.drop(this._connections[i], i)
        break
      }
    }
  }

  /** Connection `i` goes: the socket closed, or `release` moves it to another world. */
  private drop (connection: Connection, i: number): void {
    // Not a player that is already gone. One killed between ticks (a skill
    // runs from its socket handler) is still here until the next flush,
    // and destroying it again freed its id twice and counted the run twice.
    // Nor one that extracted (`exit` never sets `destroyed`, and frees the id
    // itself): the flush that lets it go is skipped when the world's tick
    // throws after the extraction, and destroying it again on a disconnect
    // before the next good flush freed its id twice. (The run's end itself,
    // stats, `run_end` and XP, is kept single by `Player.runOver`.)
    const player = connection.player
    if (player != null && !player.destroyed && !player.exited) player.destroy()
    this.forget(connection)
    connection.outbox = undefined
    this._connections.splice(i, 1)
  }
}

interface StandingsRow {
  id: number
  status: Standing
  loot: number
  name: string
  /** The live player the row is for; absent on a finished row. */
  player?: Player
  /** A bot's row (decision #47). */
  bot?: boolean
}

/**
 * One ranked standings board (`Multiplayer.rankStandings`). Encodes the top
 * rows once; `bufferFor` appends a connection's own row when it is below them.
 */
export class StandingsBoard {
  /** The packed top rows: the same Buffer for every connection. */
  readonly top: Buffer
  /** Each live player's index on the board. Finished rows have no player. */
  private readonly _indexOf = new Map<Player, number>()

  constructor (private readonly _rows: StandingsRow[], private readonly _topCount: number) {
    const records: Buffer[] = []
    for (let i = 0; i < _rows.length; i++) {
      const player = _rows[i].player
      if (player !== undefined) this._indexOf.set(player, i)
      if (i < _topCount) records.push(StandingsBoard.encode(_rows[i], i + 1))
    }
    this.top = Multiplayer.packRecords(records)
  }

  /**
   * The buffer for the connection whose player is `own`: the top rows, plus
   * `own`'s row if it is on the board and not already among them.
   */
  bufferFor (own: Player | undefined): Buffer {
    if (own === undefined) return this.top
    const index = this._indexOf.get(own)
    if (index === undefined || index < this._topCount) return this.top
    const record = StandingsBoard.encode(this._rows[index], index + 1)
    const length = Buffer.alloc(2)
    length.writeUInt16BE(record.length)
    return Buffer.concat([this.top, length, record], this.top.length + 2 + record.length)
  }

  /**
   * `[uint16 id][uint8 status][uint32 loot][UTF-8 name][0][uint16 rank][uint8 flags]`,
   * big-endian. Flags (decision #47): bit 0 a bot. Appended after the rank,
   * which a client from before it ignores. Append-only, like the rest.
   */
  static encode (row: StandingsRow, rank: number): Buffer {
    const name = Buffer.from(row.name, 'utf8')
    const record = Buffer.alloc(7 + name.length + 1 + 2 + 1)
    record.writeUInt16BE(row.id)
    record.writeUInt8(row.status, 2)
    record.writeUInt32BE(Math.max(0, Math.min(0xFFFFFFFF, Math.floor(row.loot))), 3)
    name.copy(record, 7)
    // The NUL after the name is already 0: Buffer.alloc zero-fills.
    record.writeUInt16BE(Math.min(0xFFFF, rank), 7 + name.length + 1)
    record.writeUInt8(row.bot === true ? 1 : 0, 7 + name.length + 3)
    return record
  }
}
