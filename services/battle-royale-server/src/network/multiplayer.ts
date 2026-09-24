import { type Socket } from 'socket.io'
import { type GameObject } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import type Player from '../objects/player'
import World from '../objects/world'
import { Vector } from '../utils/vector'
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
  pendingObjectIDs: Record<string, boolean> | undefined

  get id (): string {
    return this.socket?.id
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

  constructor (tickLengthMs: number) {
    Multiplayer.Instance = this
    this.tickLengthMs = tickLengthMs
    this._connections = []

    this.redis = new Redis(parseInt(process.env.REDIS_PORT ?? '6379'), process.env.REDIS_HOST ?? 'redis')
  }

  onConnect (socket: Socket): void {
    const connection = new Connection()
    connection.socket = socket

    socket.on('start_requested', (playerId) => {
      if (connection.started) return
      connection.started = true
      void this.onStart(connection, playerId)
    })
    this._connections.push(connection)
  }

  // incoming traffic ========
  async onStart (connection: Connection, playerId: string): Promise<void> {
    connection.socket.on('pointer', (data) => {
      this.onPointer(connection, data)
    })
    connection.socket.on('skill', (data) => {
      this.onSkill(connection, data)
    })

    const player = World.createPlayer(playerId)

    connection.player = player

    // Everything the client would otherwise have to assume about this server.
    connection.socket.emit('hello', {
      tick: this.tickLengthMs,
      map: World.mapSize,
      interest: Multiplayer.INTEREST_RADIUS
    })

    this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }

    const snapshot: GameObject[] = [
      ...World.OBSTACLES,
      ...World.CONSUMABLES,
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

    this.flush(connection, 0)
  }

  flush (connection: Connection, tick: number): void {
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

  // outgoing traffic ========
  create (obj: GameObject): void {
    const data = obj.serialiseBinary(obj.allFields)
    for (const connection of this._connections) {
      if (this._buffer[connection.id] === undefined) this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }

      this._buffer[connection.id].create.push(data)
    }
    obj.dirtyFields.clear()
  }

  update (obj: GameObject): void {
    let fullData
    let changedData
    let data

    for (const connection of this._connections) {
      if (
        (connection.player != null) &&
        connection.player.tag === obj.tag &&
        connection.player.position.withinBounds(
          obj.position.x,
          obj.position.y,
          500
        )
      ) {
        if (connection.pendingObjectIDs?.[obj.id] ?? false) {
          if (fullData == null) {
            fullData = obj.serialiseBinary(
              connection.player === obj ? obj.allFieldsOwn : obj.allFields
            )
          }
          data = fullData
          connection.pendingObjectIDs[obj.id] = false
        } else {
          if (changedData == null) changedData = obj.serialiseBinary(obj.dirtyFields)
          data = changedData
        }

        if (data == null) continue

        if (this._buffer[connection.id] === undefined) { this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] } }

        this._buffer[connection.id].update.push(data)
      } else {
        if (obj.dirtyFields.size > 0) {
          if (connection.pendingObjectIDs === undefined) connection.pendingObjectIDs = {}
          connection.pendingObjectIDs[obj.id] = true
        }
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

    for (const connection of this._connections) {
      if (
        connection.player?.position.withinBounds(
          originator.position.x,
          originator.position.y,
          Multiplayer.INTEREST_RADIUS
        )
      ) {
        if (this._buffer[connection.id] === undefined) this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }

        this._buffer[connection.id].effect.push(data)
      }
    }
  }

  destroy (obj): void {
    const data = obj.serialiseBinary(obj.dirtyFields)
    for (const connection of this._connections) {
      if (this._buffer[connection.id] === undefined) this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }
      this._buffer[connection.id].destroy.push(data)

      if (connection.player === obj) { void this.updateStats(obj as Player) }
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
    for (const connection of this._connections) {
      if (connection.player != null) connection.ackElapsedMs += dtMs
      this.flush(connection, tick)
    }
  }

  onDisconnect (socket: Socket): void {
    for (let i = 0; i < this._connections.length; i++) {
      const connection = this._connections[i]

      if (connection.socket === socket) {
        if (connection.player != null) connection.player.destroy()
        delete this._buffer[connection.id] // eslint-disable-line @typescript-eslint/no-dynamic-delete
        this._connections.splice(i, 1)
        break
      }
    }
  }
}
