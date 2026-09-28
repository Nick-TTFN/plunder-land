import { type Socket } from 'socket.io'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import type Player from '../objects/player'
import World, { Standing } from '../objects/world'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import Redis from 'ioredis'
import { Stats } from '../objects/player'

type Outbox = { create: Buffer[], create_own: Buffer[], effect: Buffer[], update: Buffer[], destroy: Buffer[] }

/** Only `id`: the destroy record for an object that left a client's view. */
const ID_ONLY: ReadonlySet<string> = new Set(['id'])

export class Connection {
  socket: Socket
  player: Player | undefined
  started: boolean = false
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
   */
  static connectRedis (): Redis {
    return Multiplayer.shareRedis(new Redis(parseInt(process.env.REDIS_PORT ?? '6379'), process.env.REDIS_HOST ?? 'redis'))
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
   * `start_requested`: `{ id, name }` (`parseStart`). Ignored while a run is
   * in progress on the connection. Throws what `onStart` throws.
   */
  startRequested (connection: Connection, data: unknown): void {
    if (connection.started) return
    Multiplayer.checkWorld(this, 'Multiplayer.startRequested')
    const start = Multiplayer.parseStart(data)
    if (start === undefined) return
    connection.started = true
    this.onStart(connection, start.id, start.name)
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
      Multiplayer.HANDLER_LOG.report(e)
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
  onStart (connection: Connection, playerId: string, name?: unknown): void {
    Multiplayer.checkWorld(this, 'Multiplayer.onStart')
    let player: Player | undefined
    try {
      player = World.createPlayer(playerId, name)
      this.admit(connection, player)
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
   * all of it, and the units, pickups and projectiles inside the interest box
   * around the player. It was every object on every layer.
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
    if (connection.player != null && connection.framed) {
      connection.socket.conn.write(Multiplayer.packFrame(
        buffered, standings, tick, connection.lastInputSeq, connection.ackElapsedMs
      ))
    } else if (connection.player != null) {
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
      this.forget(connection)
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
   * `start_requested` is `{ id, name }`: the client's persistent id and the
   * name it typed, which may be missing or empty. `name` is passed on raw and
   * cleaned by Player (`Player.sanitiseName`), so its type and content
   * are not checked here.
   *
   * A bare string is the old form, the id alone, and is still accepted so a
   * client from before names keeps working for one release (player-names,
   * 2026-09-25); remove it after that. Anything without an id of the shape
   * below is ignored and leaves the connection free to ask again.
   */
  static parseStart (data: unknown): { id: string, name?: unknown } | undefined {
    if (typeof data === 'string') return Multiplayer.ID_SHAPE.test(data) ? { id: data } : undefined
    if (data === null || typeof data !== 'object') return undefined
    const { id, name } = data as { id?: unknown, name?: unknown }
    if (typeof id !== 'string' || !Multiplayer.ID_SHAPE.test(id)) return undefined
    return { id, name }
  }

  /**
   * The shape of a player id. It becomes the Redis key `stats-${id}`, so it is
   * bounded here rather than trusted (bound-player-id, 2026-09-25).
   *
   * Every shipped client makes it the same way, `genRanHex(6)` in the client's
   * `GameEnterPopup`: six lowercase hex digits, one `Math.floor(random * 16)`
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
   * How far past the interest box a unit, pickup or projectile a client holds
   * may go before it is sent a destroy, in world units: 2 cells. An object
   * enters a client's view strictly inside `INTEREST_RADIUS` and leaves it
   * only beyond `INTEREST_RADIUS + EXIT_MARGIN`, so one standing on the edge,
   * or a viewer walking to and fro across it, is not destroyed and re-created
   * every tick. Inside the margin it is still sent its changes.
   */
  static EXIT_MARGIN = 2 * Hex.SIZE

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
   * is strictly inside the box of half-width `reach` around its player. The
   * box test is the one `update` has always used.
   */
  static inView (connection: Connection, x: number, y: number, tag: number, reach: number): boolean {
    const player = connection.player
    if (player === undefined || connection.layer !== tag) return false
    return player.position.withinBounds(x, y, reach)
  }

  /**
   * True if `player` is among `World.interestCandidates` around `obj`: its
   * `INTEREST` bucket is within one of `obj`'s on both axes. The layer is
   * not checked here.
   */
  static isCandidate (player: Player, obj: GameObject): boolean {
    const size = Multiplayer.INTEREST_RADIUS
    return Math.abs(Math.floor(player.position.x / size) - Math.floor(obj.position.x / size)) <= 1 &&
      Math.abs(Math.floor(player.position.y / size) - Math.floor(obj.position.y / size)) <= 1
  }

  /** `inView` for an object's own position and layer; `reach` defaults to the interest box. */
  static sees (connection: Connection, obj: GameObject, reach: number = Multiplayer.INTEREST_RADIUS): boolean {
    return Multiplayer.inView(connection, obj.position.x, obj.position.y, obj.tag, reach)
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
    // `known` is missing on a plain object a spec passes as a connection.
    if (connection.known !== undefined) {
      for (const obj of connection.known) obj.knownBy.delete(connection)
      connection.known.clear()
    }
    this.setLayer(connection, undefined)
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
   * A create, into `into`, for every unit, pickup and projectile inside the
   * connection's interest box that its client does not hold yet, and mark
   * them held. For the join and a layer change only: from then on `update`
   * keeps it current. Players come from `World.INTEREST`; the other lists are
   * walked whole (about 81 mobs, 500 pickups and a few projectiles), which is
   * cheap next to serialising what is found.
   */
  private sendVisible (connection: Connection, into: Buffer[]): void {
    const player = connection.player
    const tag = connection.layer
    if (player === undefined || tag === undefined) return
    const visit = (obj: GameObject): void => {
      if (obj.tag !== tag || obj.knownBy.has(connection) || Multiplayer.gone(obj)) return
      if (!Multiplayer.sees(connection, obj)) return
      into.push(obj.serialiseBinary(obj.allFields))
      this.know(connection, obj)
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
   * object is kept. So is anything that came through with it and is still in
   * view: a destroy and a create for one id in one flush would be applied
   * create first, and leave a sprite behind.
   *
   * What is kept is sent whole, as an update. Between its player's hop and
   * this, the connection was sent no changes (`update` finds it on neither
   * layer), so the client may have missed one, such as the other player's own
   * new tag, and would go on drawing it on the old layer.
   */
  private switchLayer (connection: Connection): void {
    const player = connection.player
    if (player === undefined) return
    const out = this.outbox(connection)

    for (const obj of World.OBSTACLES) {
      if (obj.tag === connection.layer && !obj.destroyed && Multiplayer.isTerrain(obj)) {
        out.destroy.push(obj.serialiseBinary(ID_ONLY as Set<string>))
      }
    }
    this.setLayer(connection, player.tag)
    this.sendTerrain(connection, out.create)

    for (const obj of connection.known) {
      if (obj === player) continue
      if (Multiplayer.sees(connection, obj, Multiplayer.INTEREST_RADIUS + Multiplayer.EXIT_MARGIN)) {
        const whole = obj.serialiseBinary(obj.allFields)
        if (whole !== null) out.update.push(whole)
        continue
      }
      out.destroy.push(obj.serialiseBinary(ID_ONLY as Set<string>))
      this.unknow(connection, obj)
    }
    this.sendVisible(connection, out.create)
  }

  /**
   * A new object. Terrain goes to every connection on its layer; anything
   * else only to connections whose player is on its layer and has it inside
   * the interest box, which then hold it (decision #35). Others get it when
   * it comes into their range (`update`).
   */
  create (obj: GameObject): void {
    Multiplayer.checkWorld(this, 'Multiplayer.create')
    if (!Multiplayer.gone(obj)) {
      const data = Multiplayer.isTerrain(obj) ? Multiplayer.terrainRecord(obj) : obj.serialiseBinary(obj.allFields)
      if (Multiplayer.isTerrain(obj)) {
        for (const connection of this.layers.get(obj.tag) ?? []) this.outbox(connection).create.push(data)
      } else {
        for (const player of World.interestCandidates(obj.position.x, obj.position.y, obj.tag)) {
          const connection = this.viewerOf(player)
          // Its own player's object goes out once, as create_own (`admit`).
          if (connection === undefined || connection.player === obj) continue
          if (obj.knownBy.has(connection) || !Multiplayer.sees(connection, obj)) continue
          this.outbox(connection).create.push(data)
          this.know(connection, obj)
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
   * - a connection whose player is on its layer with it inside the interest
   *   box, and that does not hold it, is sent a create (the whole record) and
   *   holds it from then on;
   * - one that holds it is sent its changes, if any;
   * - one that holds it and no longer has it within `INTEREST_RADIUS +
   *   EXIT_MARGIN` on its layer is sent a destroy (`id` only) and drops it.
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

    // Encoded at most once each, on first need, and shared by every
    // connection it goes to. `null` from the serialiser means nothing to send.
    const changed = obj.dirtyFields.size > 0
    let changedData: Buffer | null | undefined
    let fullData: Buffer | null | undefined

    // Holders still in view, found here; if that is all of them, none has
    // left and the loop over holders below is skipped. A holder in the exit
    // margin is served here too when it is among the candidates, so one
    // standing in the margin does not force that loop every tick.
    const outer = Multiplayer.INTEREST_RADIUS + Multiplayer.EXIT_MARGIN
    const knownBy = obj.knownBy
    // Read once: nothing below moves the object. The box tests are
    // `Multiplayer.sees` written out on these, since this loop runs for every
    // player near every object every tick.
    const ox = obj.position.x
    const oy = obj.position.y
    const otag = obj.tag
    const inner = Multiplayer.INTEREST_RADIUS
    let holdersInRange = 0
    for (const player of World.interestCandidates(ox, oy, otag)) {
      const connection = this.viewerOf(player)
      if (connection === undefined) continue
      // `viewerOf` returned it, so `connection.player` is `player`.
      const dx = player.position.x - ox
      const dy = player.position.y - oy
      const onLayer = connection.layer === otag
      if (connection !== self && !(onLayer && dx < inner && dx > -inner && dy < inner && dy > -inner)) {
        // Not in the box. A holder whose client is on this layer (so no
        // switch pending) and still has it in the margin keeps it.
        if (connection.layer === player.tag && onLayer && dx < outer && dx > -outer && dy < outer && dy > -outer && knownBy.has(connection)) {
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
        if (fullData !== null) this.outbox(connection).create.push(fullData)
        this.know(connection, obj)
      }
    }

    if (holdersInRange < knownBy.size) {
      let gone: Buffer | undefined
      for (const connection of knownBy) {
        // Its own, and anyone handled above.
        if (connection === self || Multiplayer.sees(connection, obj)) continue
        const player = connection.player
        // A player who died or left this tick: dropped whole at the flush.
        if (player === undefined || Multiplayer.gone(player)) continue
        // Served above: a candidate (on the object's layer, in the 3 x 3
        // buckets around it) with no switch pending and it in the margin.
        if (connection.layer === player.tag && player.tag === obj.tag &&
          Multiplayer.isCandidate(player, obj) && Multiplayer.sees(connection, obj, outer)) continue
        // Its client changes layer at its player's own update (`switchLayer`),
        // which settles everything it holds. A destroy from here as well
        // could meet a create from the switch for the same id in one flush:
        // two players who come through portals together, each updated before
        // the other's switch.
        if (connection.layer !== player.tag) continue
        if (Multiplayer.sees(connection, obj, outer)) {
          if (changed) {
            if (changedData === undefined) changedData = obj.serialiseBinary(obj.dirtyFields)
            if (changedData !== null) this.outbox(connection).update.push(changedData)
          }
          continue
        }
        if (gone === undefined) gone = obj.serialiseBinary(ID_ONLY as Set<string>) as Buffer
        this.outbox(connection).destroy.push(gone)
        this.unknow(connection, obj)
      }
    }

    obj.dirtyFields.clear()
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
   * Sent to connections on the originator's layer with it inside the interest
   * box. It went to every layer until interest-filtered-broadcasts (#35).
   */
  effect (type: number, originator: Unit, lifetime: number, aimCell?: Vector): void {
    Multiplayer.checkWorld(this, 'Multiplayer.effect')
    const data = Buffer.alloc(aimCell === undefined ? 4 : 8)
    data.writeInt8(type)
    data.writeUInt16BE(originator.id, 1)
    data.writeInt8(Math.floor(lifetime / 100), 3)
    if (aimCell !== undefined) {
      data.writeInt16BE(aimCell.x, 4)
      data.writeInt16BE(aimCell.y, 6)
    }

    for (const player of World.interestCandidates(originator.position.x, originator.position.y, originator.tag)) {
      const connection = this.connectionOf(player)
      if (connection === undefined || !Multiplayer.sees(connection, originator)) continue
      this.outbox(connection).effect.push(data)
    }
  }

  /**
   * An aimed effect that belongs to a cell rather than to its originator: the
   * same record as `effect`, but sent to connections whose player is on `tag`
   * and within the interest radius of the cell's centre. A bomb lands up to 6
   * cells from its thrower and the fuse outlives them, so the thrower's
   * position says nothing about who can see it. `originatorId` is carried but
   * the client does not look it up for these types: by the blast it may be
   * dead, and its id reused.
   */
  effectAt (type: number, originatorId: number, lifetime: number, cell: Vector, tag: number): void {
    Multiplayer.checkWorld(this, 'Multiplayer.effectAt')
    const data = Buffer.alloc(8)
    data.writeInt8(type)
    data.writeUInt16BE(originatorId, 1)
    data.writeInt8(Math.floor(lifetime / 100), 3)
    data.writeInt16BE(cell.x, 4)
    data.writeInt16BE(cell.y, 6)

    const centre = Hex.toPosition(cell)
    for (const player of World.interestCandidates(centre.x, centre.y, tag)) {
      const connection = this.connectionOf(player)
      if (connection === undefined) continue
      if (!Multiplayer.inView(connection, centre.x, centre.y, tag, Multiplayer.INTEREST_RADIUS)) continue
      this.outbox(connection).effect.push(data)
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

    if (obj.type === ObjectType.Player) {
      const own = this.connectionOf(obj as Player)
      if (own !== undefined) this.updateStats(obj as Player).catch(Multiplayer.logStatsFailure)
    }

    obj.dirtyFields.clear()
  }

  async updateStats (player: Player): Promise<void> {
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
      rows.push({ id: player.id, status, loot: player.loot ?? 0, name: player.name ?? '', player })
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
    const player = connection.player
    if (player != null && !player.destroyed) player.destroy()
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

  /** `[uint16 id][uint8 status][uint32 loot][UTF-8 name][0][uint16 rank]`, big-endian. */
  static encode (row: StandingsRow, rank: number): Buffer {
    const name = Buffer.from(row.name, 'utf8')
    const record = Buffer.alloc(7 + name.length + 1 + 2)
    record.writeUInt16BE(row.id)
    record.writeUInt8(row.status, 2)
    record.writeUInt32BE(Math.max(0, Math.min(0xFFFFFFFF, Math.floor(row.loot))), 3)
    name.copy(record, 7)
    // The NUL after the name is already 0: Buffer.alloc zero-fills.
    record.writeUInt16BE(Math.min(0xFFFF, rank), 7 + name.length + 1)
    return record
  }
}
