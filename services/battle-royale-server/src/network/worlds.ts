import { type Socket } from 'socket.io'
import type Redis from 'ioredis'
import Multiplayer, { type Connection } from './multiplayer'
import World from '../objects/world'
import { PROTOCOL } from '../utils/protocol'
import { reportError } from '../errors'

export interface WorldsOptions {
  /** The tick, sent to every client in `hello`. */
  tickLengthMs: number
  /** Active players a world takes before a run goes to another (`WORLD_CAP`). */
  cap: number
  /** How long a world with no active players stays open (`WORLD_IDLE_MS`). */
  idleMs: number
  /** Shared by every world: stats only (`Multiplayer.connectRedis`). */
  redis: Redis
  mapSize?: number
  /** The clock for idle closing. Specs pass their own. */
  now?: () => number
}

/**
 * Every world in this process (worlds-per-process, decision #39), and the one
 * socket.io server's connections to them.
 *
 * **A world is picked per run, not per connection** (Nick, 2026-09-28): on
 * every `start_requested`, the fullest world with fewer than `cap` active
 * players, ties to the oldest, or a new world when every open one is full.
 * Fill-first keeps worlds lively at low player counts. A connection between
 * runs (on its run card) belongs to no world for assignment; it stays in its
 * last world's Multiplayer, which sends it nothing without a player, until its
 * next run goes elsewhere or the world closes. Moving it detaches it
 * completely (`Multiplayer.release`): it leaves the old Multiplayer and every
 * old object's `knownBy`, so nothing from the old world reaches it again.
 *
 * **Worlds open on demand and close when idle.** There is always at least one.
 * One with no active players for `idleMs` is closed and dropped (`closeIdle`,
 * once a tick), newest first, never the last one open.
 *
 * **Everything runs inside `World.run`** for the world it belongs to: each
 * world's tick and flush, and every socket handler, inside `guarded`. The
 * server sets `World.strict`, so between those no world is current and a stray
 * `World.X` throws a `WrongWorldError` rather than reaching some world.
 */
export default class Worlds {
  /** Open worlds, oldest first. */
  readonly worlds: World[] = []
  /** The loop's tick counter, shared by every world: each client's clock is monotonic. */
  tick = 0
  /**
   * Set by `drain` when the host asks this process to stop (SIGTERM, a
   * deploy): no run starts here any more, the live ones play out.
   */
  draining = false

  private readonly tickLengthMs: number
  private readonly cap: number
  private readonly idleMs: number
  private readonly redis: Redis
  private readonly mapSize: number
  private readonly now: () => number
  /** Each connection's current world: the one whose Multiplayer holds it. */
  private readonly worldOf = new Map<Connection, World>()
  /** When each open world was last seen with no active players. */
  private readonly emptySince = new Map<World, number>()
  /** Every open connection, in a world or not: `drain` reaches the lobby ones too. */
  private readonly connections = new Set<Connection>()

  constructor (options: WorldsOptions) {
    this.tickLengthMs = options.tickLengthMs
    this.cap = options.cap
    this.idleMs = options.idleMs
    // One error listener for every world: one per Multiplayer would pile up
    // with each world ever opened.
    this.redis = Multiplayer.shareRedis(options.redis)
    this.mapSize = options.mapSize ?? 4000
    this.now = options.now ?? (() => Date.now())
    World.strict = true
    this.open()
  }

  /** A new world with its own Multiplayer, not left current. */
  open (): World {
    const multiplayer = new Multiplayer(this.tickLengthMs, this.redis)
    const world = World.build(this.mapSize, { multiplayer })
    this.worlds.push(world)
    return world
  }

  /** Players in `world` whose run is in progress: not dead, not extracted. */
  static activePlayers (world: World): number {
    let n = 0
    for (const player of world.PLAYERS) if (!player.destroyed && !player.exited) n++
    return n
  }

  /** Where the next run goes: the fullest world under the cap, ties to the oldest; else a new one. */
  choose (): World {
    let best: World | undefined
    let bestCount = -1
    for (const world of this.worlds) {
      const count = Worlds.activePlayers(world)
      if (count < this.cap && count > bestCount) {
        best = world
        bestCount = count
      }
    }
    return best ?? this.open()
  }

  /** The world a connection is in, if any. */
  worldFor (connection: Connection): World | undefined {
    return this.worldOf.get(connection)
  }

  /** A new socket. It joins no world until it asks for a run. */
  onConnection (socket: Socket): Connection {
    const connection = Multiplayer.connectionFor(socket)
    this.connections.add(connection)
    // The protocol before anything else, so a stale client reloads at the
    // lobby (utils/protocol.ts).
    socket.emit('welcome', { protocol: PROTOCOL })
    if (this.draining) Worlds.redirect(connection)
    socket.on('start_requested', (data) => {
      Multiplayer.guarded(() => { this.start(connection, data) })
    })
    // Applied on arrival, as with one world (`Multiplayer.onConnect`).
    socket.on('pointer', (data) => {
      this.inWorld(connection, (mp) => { mp.onPointer(connection, data) })
    })
    socket.on('skill', (data) => {
      this.inWorld(connection, (mp) => { mp.onSkill(connection, data) })
    })
    socket.on('use_item', (data) => {
      this.inWorld(connection, (mp) => { mp.onUseItem(connection, data) })
    })
    socket.on('disconnect', () => {
      this.inWorld(connection, (mp) => { mp.release(connection) })
      this.worldOf.delete(connection)
      this.connections.delete(connection)
    })
    return connection
  }

  /** `fn` with the connection's world current, inside `guarded`; nothing if it is in none. */
  private inWorld (connection: Connection, fn: (multiplayer: Multiplayer) => void): void {
    Multiplayer.guarded(() => {
      const world = this.worldOf.get(connection)
      if (world === undefined) return
      World.run(world, () => { fn(world.multiplayer as Multiplayer) })
    })
  }

  /**
   * `start_requested`. A malformed one, or one while a run is in progress,
   * moves nothing. Otherwise the connection goes to `choose()`'s world,
   * leaving its old one first if that is another, and the run starts there.
   */
  start (connection: Connection, data: unknown): void {
    if (connection.started || Multiplayer.parseStart(data) === undefined) return
    if (this.draining) {
      // To the next server: the client reconnects and lands in the lobby.
      Worlds.redirect(connection)
      return
    }
    const target = this.choose()
    const from = this.worldOf.get(connection)
    if (from !== target) {
      if (from !== undefined) World.run(from, () => { from.multiplayer?.release(connection) })
      World.run(target, () => { target.multiplayer?.adopt(connection) })
      this.worldOf.set(connection, target)
    }
    World.run(target, () => { target.multiplayer?.startRequested(connection, data) })
  }

  /**
   * One pass of the loop: every open world's tick and flush, each in its own
   * `World.run` and its own try/catch (one world's throw costs only that
   * world's tick), then the idle check.
   */
  tickAll (dtMs: number): void {
    this.tick++
    const dt = dtMs / 1000
    for (const world of this.worlds) {
      World.run(world, () => {
        try {
          world.update(dt)
          world.multiplayer?.flushAll(this.tick, dtMs)
        } catch (e) {
          reportError('tick', e)
        }
      })
    }
    this.closeIdle()
  }

  /** Close every world idle for `idleMs`, newest first, keeping at least one open. */
  closeIdle (): void {
    const now = this.now()
    for (let i = this.worlds.length - 1; i >= 0; i--) {
      const world = this.worlds[i]
      if (Worlds.activePlayers(world) > 0) {
        this.emptySince.delete(world)
        continue
      }
      const since = this.emptySince.get(world)
      if (since === undefined) {
        this.emptySince.set(world, now)
        continue
      }
      if (now - since >= this.idleMs && this.worlds.length > 1) this.close(world)
    }
  }

  /**
   * Close `world` and drop every reference this holds to it. Its connections
   * (all between runs: it has no active players) are released and belong to
   * no world until their next run.
   */
  close (world: World): void {
    for (const [connection, of] of this.worldOf) {
      if (of !== world) continue
      World.run(world, () => { world.multiplayer?.release(connection) })
      this.worldOf.delete(connection)
    }
    world.close()
    this.emptySince.delete(world)
    const i = this.worlds.indexOf(world)
    if (i >= 0) this.worlds.splice(i, 1)
  }

  /**
   * Stop taking runs (decision #46): the host is replacing this process.
   * Connections with no run behind them, which have only ever seen the lobby,
   * go to the next server now; one on its run card goes when it asks for its
   * next run (`start`), so the card stays up. Live runs play out; the caller
   * ends the process once `drained`, or at its deadline.
   */
  drain (): void {
    this.draining = true
    for (const connection of this.connections) {
      if (!connection.started && !this.worldOf.has(connection)) Worlds.redirect(connection)
    }
  }

  /** Open connections, in a world or not. */
  get connectionCount (): number {
    return this.connections.size
  }

  /** Runs in progress across every world. */
  static activeRuns (worlds: Worlds): number {
    let n = 0
    for (const world of worlds.worlds) n += Worlds.activePlayers(world)
    return n
  }

  /** No run in progress in any world: a draining process can stop. */
  get drained (): boolean {
    return this.worlds.every((world) => Worlds.activePlayers(world) === 0)
  }

  /**
   * Close every connection the way a dying server would, live runs included:
   * each one's disconnect handler runs (stats writes, the player destroyed as
   * on any disconnect) and its client reconnects to the next server.
   */
  closeAll (): void {
    for (const connection of [...this.connections]) Worlds.redirect(connection)
  }

  /**
   * Close the connection's transport, not the socket.io session: a client
   * told to disconnect by the server (`socket.disconnect()`) does not
   * reconnect, one whose transport closed does, which lands it on whatever
   * server the host routes new connections to.
   */
  static redirect (connection: Connection): void {
    connection.socket.conn.close()
  }

  private _leaderboard: Record<string, Record<string, string>> = {}
  private _leaderboardAt = 0

  /**
   * `/stats`: every `stats-*` hash, cached for 3 s, as `Multiplayer.getLeaderboard`
   * does for one world. Global (Redis), not per world, and outside every world:
   * it reads only the shared Redis client.
   */
  async getLeaderboard (): Promise<Record<string, Record<string, string>>> {
    if (Date.now() - this._leaderboardAt < 3000) return this._leaderboard
    const redis = this.redis
    const keys = await redis.keys('stats-*')
    const data: Record<string, Record<string, string>> = {}
    for (const key of keys) data[key] = await redis.hgetall(key)
    this._leaderboard = data
    this._leaderboardAt = Date.now()
    return data
  }
}
