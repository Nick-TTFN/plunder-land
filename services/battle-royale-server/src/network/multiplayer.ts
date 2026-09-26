import { type Socket } from 'socket.io'
import { type GameObject } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import type Player from '../objects/player'
import World, { Standing } from '../objects/world'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import Redis from 'ioredis'
import { Stats } from '../objects/player'

class Connection {
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
   * What this connection was last sent of each object: object id to that
   * object's `changedAt` at the time. An object whose `changedAt` has moved
   * past it changed while out of this connection's range, and is sent whole
   * the next time it is in range (`Multiplayer.update`). Bounded by the
   * largest id (ids are recycled), and dropped with the connection.
   */
  seen = new Map<number, number>()
  /**
   * `Multiplayer`'s change counter when this connection's join snapshot was
   * built: every object it has not been sent since is known as of then.
   */
  joinedAt: number = 0

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

  static Instance: Multiplayer
  readonly tickLengthMs: number
  private readonly _connections: Connection[]
  private _buffer: Record<string, { create: Buffer[], create_own: Buffer[], effect: Buffer[], update: Buffer[], destroy: Buffer[] }> = {}
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

  constructor (tickLengthMs: number, redis?: Redis) {
    Multiplayer.Instance = this
    this.tickLengthMs = tickLengthMs
    this._connections = []

    // Start-up does not wait for Redis: ioredis connects in the background and
    // queues commands meanwhile, so a server with Redis down still starts and
    // runs the world; only stats are lost.
    this.redis = redis ?? new Redis(parseInt(process.env.REDIS_PORT ?? '6379'), process.env.REDIS_HOST ?? 'redis')
    // Without a listener ioredis prints "[ioredis] Unhandled error event" with a
    // stack on every reconnect attempt, forever, while Redis is down.
    this.redis.on('error', (e) => { Multiplayer.REDIS_LOG.report(e) })
  }

  onConnect (socket: Socket): void {
    const connection = new Connection()
    connection.socket = socket

    socket.on('start_requested', (data) => {
      if (connection.started) return
      Multiplayer.guarded(() => {
        const start = Multiplayer.parseStart(data)
        if (start === undefined) return
        connection.started = true
        this.onStart(connection, start.id, start.name)
      })
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
      Multiplayer.guarded(() => { this.onPointer(connection, data) })
    })
    socket.on('skill', (data) => {
      Multiplayer.guarded(() => { this.onSkill(connection, data) })
    })
    // On arrival too, like `skill`: the heal or the fuse starts from the press.
    socket.on('use_item', (data) => {
      Multiplayer.guarded(() => { this.onUseItem(connection, data) })
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
      delete this._buffer[connection.id] // eslint-disable-line @typescript-eslint/no-dynamic-delete
      throw e
    }
  }

  private admit (connection: Connection, player: Player): void {
    this.attach(connection, player)

    this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }

    const snapshot: GameObject[] = [
      ...World.OBSTACLES,
      ...World.PROJECTILES,
      ...World.CONSUMABLES,
      ...World.ITEMS,
      ...World.PLAYERS,
      ...World.MOBS
    ]

    for (const obj of snapshot) {
      if (obj !== undefined) {
        if (connection.player === obj) {
          // allFieldsOwn, not allFields: the owner needs loot and maxVelocity,
          // and maxVelocity is what makes local prediction possible at all.
          this._buffer[connection.id].create_own.push(obj.serialiseBinary(obj.allFieldsOwn))
        } else {
          this._buffer[connection.id].create.push(obj.serialiseBinary(obj.allFields))
        }
      }
    }

    // Everything the client would otherwise have to assume about this server.
    // Sent after the snapshot is built, so a snapshot that throws sends nothing;
    // still before the flush, so the client gets it first, as it always has.
    connection.socket.emit('hello', {
      tick: this.tickLengthMs,
      map: World.mapSize,
      interest: Multiplayer.INTEREST_RADIUS,
      // Every layer's tag, top (01) first. The client builds its planes from
      // this and labels portals by position in it, so it never hardcodes a tag.
      layers: World.TAGS
    })

    this.flush(connection, 0)
  }

  /**
   * `standings`, when given, is this tick's standings board for this
   * connection (`StandingsBoard.bufferFor`), sent under the same gate as the
   * buffered events.
   */
  flush (connection: Connection, tick: number, standings?: Buffer): void {
    const buffered = this._buffer[connection.id]

    // Always drop the buffer, even for a socket that never started a run.
    // Clients connect on page load but only send `start_requested` on button
    // click, so returning early here leaked a buffer per idle visitor.
    if (connection.player != null) {
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

    if (buffered !== undefined) this._buffer[connection.id] = undefined

    // Exiting removes the player from the world but never set `destroyed`, so the
    // connection kept pointing at it and the input handlers kept reaching it.
    const player = connection.player
    if (player != null && (player.destroyed || player.exited)) connection.player = undefined
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
   * A count of zero means stop. Sent every tick whether or not it changed, so
   * the newest packet always holds complete current intent and a dropped one
   * costs nothing.
   */
  static MAX_WAYPOINTS = 16

  onPointer (connection: Connection, data): void {
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

    // Only re-route when the client asks for something different. The packet
    // arrives every tick; searching on each one would put a BFS per player per
    // tick into the loop for no gain, since a standing route does not change
    // unless the terrain does - and when it does, `World.block` re-routes.
    if (sameCells(connection.lastWaypoints, waypoints)) return

    connection.lastWaypoints = waypoints
    connection.player.setWaypoints(waypoints)
  }

  onSkill (connection: Connection, data): void {
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
   * Counts every `update` that carried changes. An object's `changedAt` and a
   * connection's `seen` / `joinedAt` are values of it. Static, like the world
   * it counts for, and only ever increases.
   */
  private static _changes = 0

  /**
   * Each player's connection, for the players `World.INTEREST` finds. Weak, and
   * always checked against `connection.player`, so a player whose connection
   * has moved on (death, exit, disconnect) is never sent anything through it.
   */
  private static readonly _connectionOf = new WeakMap<Player, Connection>()

  /** The connection whose live player `player` is, if any. */
  private connectionOf (player: Player): Connection | undefined {
    const connection = Multiplayer._connectionOf.get(player)
    return connection?.player === player ? connection : undefined
  }

  /**
   * Make `player` this connection's player: it starts receiving what happens
   * around it, knowing everything as of now (the join snapshot is built next).
   */
  private attach (connection: Connection, player: Player): void {
    connection.player = player
    connection.seen = new Map()
    connection.joinedAt = Multiplayer._changes
    Multiplayer._connectionOf.set(player, connection)
  }

  create (obj: GameObject): void {
    const data = obj.serialiseBinary(obj.allFields)
    for (const connection of this._connections) {
      if (this._buffer[connection.id] === undefined) this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }

      this._buffer[connection.id].create.push(data)
    }
    obj.dirtyFields.clear()
  }

  /**
   * Send `obj`'s changes to every connection whose player is on its layer and
   * inside the interest box around it (`withinBounds`, `INTEREST_RADIUS`), and
   * its whole record instead to one that missed a change while it was out of
   * range.
   *
   * Hex-cells P1: the candidates come from `World.INTEREST` (the 3 x 3 coarse
   * buckets around the object), not from every connection, and "missed a
   * change" is a comparison of counters rather than a flag written to every
   * out-of-range connection on every change: `obj.changedAt` against what the
   * connection was last sent (`seen`, or its `joinedAt`). It used to mark a
   * `pendingObjectIDs` entry on each of those connections, which cost the
   * whole connection list for every moving object every tick. Same records:
   * a change made while out of range still brings the whole record on
   * re-entry, and one made in range still goes as a delta.
   *
   * One difference, at id reuse only: the old flag was keyed by id and
   * outlived its object, so a new object on a recycled id could be sent whole
   * once for its predecessor's change. The counters are ordered in time, so
   * that no longer happens.
   */
  update (obj: GameObject): void {
    const changed = obj.dirtyFields.size > 0
    const missedIfBefore = obj.changedAt
    const stamp = changed ? ++Multiplayer._changes : obj.changedAt
    let fullData
    let changedData

    for (const player of World.interestCandidates(obj.position.x, obj.position.y)) {
      if (player.tag !== obj.tag) continue
      if (!player.position.withinBounds(obj.position.x, obj.position.y, Multiplayer.INTEREST_RADIUS)) continue
      const connection = this.connectionOf(player)
      if (connection === undefined) continue

      let data
      if (missedIfBefore > (connection.seen.get(obj.id) ?? connection.joinedAt)) {
        if (fullData == null) {
          fullData = obj.serialiseBinary(
            connection.player === obj ? obj.allFieldsOwn : obj.allFields
          )
        }
        data = fullData
      } else if (changed) {
        if (changedData == null) changedData = obj.serialiseBinary(obj.dirtyFields)
        data = changedData
      } else {
        continue
      }
      connection.seen.set(obj.id, stamp)

      if (data == null) continue

      if (this._buffer[connection.id] === undefined) { this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] } }

      this._buffer[connection.id].update.push(data)
    }
    obj.changedAt = stamp
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
   */
  effect (type: number, originator: Unit, lifetime: number, aimCell?: Vector): void {
    const data = Buffer.alloc(aimCell === undefined ? 4 : 8)
    data.writeInt8(type)
    data.writeUInt16BE(originator.id, 1)
    data.writeInt8(Math.floor(lifetime / 100), 3)
    if (aimCell !== undefined) {
      data.writeInt16BE(aimCell.x, 4)
      data.writeInt16BE(aimCell.y, 6)
    }

    // Every layer, as it always was: this test has never looked at the tag.
    for (const player of World.interestCandidates(originator.position.x, originator.position.y)) {
      if (!player.position.withinBounds(originator.position.x, originator.position.y, Multiplayer.INTEREST_RADIUS)) continue
      const connection = this.connectionOf(player)
      if (connection === undefined) continue
      if (this._buffer[connection.id] === undefined) this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }

      this._buffer[connection.id].effect.push(data)
    }
  }

  /**
   * An aimed effect that belongs to a cell rather than to its originator: the
   * same record as `effect`, but sent to connections whose player is on `tag`
   * and within the interest radius of the cell's centre. A bomb lands up to 6
   * cells from its thrower and the fuse outlives them, so the thrower's
   * position says nothing about who can see it, and `effect`'s check ignores
   * the layer. `originatorId` is carried but the client does not look it up
   * for these types: by the blast it may be dead, and its id reused.
   */
  effectAt (type: number, originatorId: number, lifetime: number, cell: Vector, tag: number): void {
    const data = Buffer.alloc(8)
    data.writeInt8(type)
    data.writeUInt16BE(originatorId, 1)
    data.writeInt8(Math.floor(lifetime / 100), 3)
    data.writeInt16BE(cell.x, 4)
    data.writeInt16BE(cell.y, 6)

    const centre = Hex.toPosition(cell)
    for (const player of World.interestCandidates(centre.x, centre.y)) {
      if (player.tag !== tag) continue
      if (!player.position.withinBounds(centre.x, centre.y, Multiplayer.INTEREST_RADIUS)) continue
      const connection = this.connectionOf(player)
      if (connection === undefined) continue
      if (this._buffer[connection.id] === undefined) this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }
      this._buffer[connection.id].effect.push(data)
    }
  }

  destroy (obj): void {
    const data = obj.serialiseBinary(obj.dirtyFields)
    for (const connection of this._connections) {
      if (this._buffer[connection.id] === undefined) this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }
      this._buffer[connection.id].destroy.push(data)

      if (connection.player === obj) { this.updateStats(obj as Player).catch(Multiplayer.logStatsFailure) }
    }

    obj.dirtyFields.clear()
  }

  async updateStats (player: Player): Promise<void> {
    const stats = new Stats()

    stats.lifeTime = Math.ceil((Date.now() - player.createdAt) / 1000)
    stats.games = 1

    if (player.hp > 0) { stats.lootCollected = player.loot }

    for (const key in stats) {
      if (stats[key] > 0) {
        await Multiplayer.Instance.redis.hincrby(`stats-${player.playerId}`, key, stats[key])
      }
    }
  }

  private _leaderboard: Record<string, Record<string, string>> = {}
  private _leaderboardAt: number = 0

  async getLeaderboard (): Promise<Record<string, Record<string, string>>> {
    if (Date.now() - this._leaderboardAt < 3000) return this._leaderboard

    const keys = await this.redis.keys('stats-*')
    const data: Record<string, Record<string, string>> = {}
    for (const key of keys) data[key] = await this.redis.hgetall(key)

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
    const parts: Buffer[] = []
    if (header !== undefined) parts.push(header)
    for (const record of records) {
      const header = Buffer.alloc(2)
      header.writeUInt16BE(record.length)
      parts.push(header, record)
    }
    return Buffer.concat(parts)
  }

  flushAll (tick: number, dtMs: number = 0): void {
    const board = this.standingsDue() ? Multiplayer.rankStandings() : undefined
    for (const connection of this._connections) {
      if (connection.player != null) connection.ackElapsedMs += dtMs
      this.flush(connection, tick, board?.bufferFor(connection.player))
    }
  }

  // Standings ========

  /** How often the standings board goes out, in ms. Counted in ticks. */
  static STANDINGS_INTERVAL_MS = 1000
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
    for (let i = 0; i < this._connections.length; i++) {
      const connection = this._connections[i]

      if (connection.socket === socket) {
        // Not a player that is already gone. One killed between ticks (a skill
        // runs from its socket handler) is still here until the next flush,
        // and destroying it again freed its id twice and counted the run twice.
        const player = connection.player
        if (player != null && !player.destroyed) player.destroy()
        delete this._buffer[connection.id] // eslint-disable-line @typescript-eslint/no-dynamic-delete
        this._connections.splice(i, 1)
        break
      }
    }
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
