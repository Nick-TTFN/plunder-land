import { type Socket } from 'socket.io'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import type Player from '../objects/player'
import World from '../objects/world'
import Redis from 'ioredis'
import { Stats } from '../objects/player'

class Connection {
  socket: Socket
  player: Player | undefined
  started: boolean = false
  pendingObjectIDs: Record<string, boolean> | undefined

  get id (): string {
    return this.socket?.id
  }
}

export default class Multiplayer {
  static order = ['create', 'update', 'effect', 'destroy']

  static Instance: Multiplayer
  private readonly _connections: Connection[]
  private _buffer: Record<string, { create: Buffer[], create_own: Buffer[], effect: Buffer[], update: Buffer[], destroy: Buffer[] }> = {}
  redis: Redis

  constructor () {
    Multiplayer.Instance = this
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

    this._buffer[connection.id] = { create: [], create_own: [], effect: [], update: [], destroy: [] }

    for (const obj of World.OBSTACLES.concat(
      World.CONSUMABLES.concat(World.PLAYERS).concat(World.MOBS)
    )) {
      if (obj !== undefined) {
        if (connection.player === obj) {
          this._buffer[connection.id].create_own.push(obj.serialiseBinary(obj.allFields))
        } else {
          this._buffer[connection.id].create.push(obj.serialiseBinary(obj.allFields))
        }
      }
    }

    this.flush(connection)
  }

  flush (connection: Connection): void {
    if (this._buffer[connection.id] === undefined) return

    // Always drop the buffer, even for a socket that never started a run.
    // Clients connect on page load but only send `start_requested` on button
    // click, so returning early here leaked a buffer per idle visitor.
    if (connection.player != null) {
      const buffered = this._buffer[connection.id]
      for (const event in buffered) {
        const records: Buffer[] = buffered[event]
        if (records.length === 0) continue
        connection.socket.emit(event, Multiplayer.packRecords(records))
      }
    }
    this._buffer[connection.id] = undefined

    if (connection.player?.destroyed ?? false) connection.player = undefined
  }

  onPointer (connection: Connection, data): void {
    if (connection.player != null) {
      connection.player.setDirection(data.x, data.y)
    }
  }

  onSkill (connection: Connection, data): void {
    if (connection.player != null) {
      connection.player.tryExecuteSkill(data)
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
        // update nearby players even if they dont do anything
        if (obj.type === ObjectType.Player && !obj.dirtyFields.has('id')) {
          obj.dirtyFields.add('id')
        }

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

  effect (type: number, originator: Unit, lifetime: number): void {
    const data = Buffer.alloc(4)
    data.writeInt8(type)
    data.writeUInt16BE(originator.id, 1)
    data.writeInt8(Math.floor(lifetime / 100), 3)

    for (const connection of this._connections) {
      if (
        connection.player?.position.withinBounds(
          originator.position.x,
          originator.position.y,
          500
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
  static packRecords (records: Buffer[]): Buffer {
    const parts: Buffer[] = []
    for (const record of records) {
      const header = Buffer.alloc(2)
      header.writeUInt16BE(record.length)
      parts.push(header, record)
    }
    return Buffer.concat(parts)
  }

  flushAll (): void {
    for (const connection of this._connections) this.flush(connection)
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
