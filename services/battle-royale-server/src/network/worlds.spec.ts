import test, { afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from './multiplayer'
import Worlds from './worlds'
import World, { WrongWorldError } from '../objects/world'
import Obstacle from '../objects/obstacle'
import Timers from '../objects/timers'
import { GameObject } from '../objects/gameobject'
import type Player from '../objects/player'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { unpackFrame } from '../../../../plunder-land-client/src/net/framedparser'
import { decodeRecord } from '../../../../plunder-land-client/src/net/records'

/**
 * Several worlds in one process (worlds-per-process, decision #39): runs are
 * assigned fill-first per `start_requested`, worlds open on demand and close
 * when idle, nothing crosses from one world to another, and work that
 * reaches a world outside `World.run` for it is caught (`WrongWorldError`).
 */

afterEach(() => {
  // `Worlds` turns strict mode on for the process; the other specs in this
  // file build their own.
  World.strict = false
})

/** A Redis stand-in that keeps its listeners, so a listener per world would show. */
function redisStub (writes: string[] = []): Redis {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    hincrby: async (key: string, field: string) => { writes.push(`${key} ${field}`); return 1 },
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

/** What one client was sent, frame by frame. */
class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly socket: Socket
  connection!: Connection
  /** Every frame's events, oldest first; `writes` counts frames. */
  events: Array<[string, Buffer]> = []
  writes = 0
  hellos = 0

  constructor (readonly id: string) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' } },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string) => { if (event === 'hello') this.hellos++; return true },
      conn: {
        write: (frame: Buffer) => {
          this.writes++
          const events = unpackFrame(new Uint8Array(frame))
          assert.ok(events !== undefined, 'a frame the client cannot read')
          for (const [event, data] of events) this.events.push([event, Buffer.from(data)])
        }
      }
    } as unknown as Socket
  }

  fire (event: string, data?: unknown): void {
    this.handlers[event](data)
  }

  /** A start, then the wait for the account (guest accounts, decision #48). */
  async start (name: string): Promise<void> {
    this.fire('start_requested', { id: 'abcdef', name })
    await settle()
  }

  get player (): Player | undefined {
    return this.connection.player
  }

  take (): Array<[string, Buffer]> {
    const out = this.events
    this.events = []
    return out
  }
}

/** Let the account lookup and creation (memory store) finish. */
async function settle (): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

function connect (worlds: Worlds, id: string): Client {
  const client = new Client(id)
  client.connection = worlds.onConnection(client.socket)
  return client
}

function makeWorlds (cap: number, idleMs = 300_000, now: () => number = () => 0): Worlds {
  return new Worlds({ tickLengthMs: 250, cap, idleMs, redis: redisStub(), now })
}

/** Kill `client`'s player, in its own world, and tick so the run ends. */
function kill (worlds: Worlds, client: Client): void {
  const world = worlds.worldFor(client.connection)
  assert.ok(world !== undefined && client.player !== undefined)
  const player = client.player
  World.run(world, () => { player.destroy() })
  worlds.tickAll(250)
}

/** The standings rows' names: `[uint16 id][uint8 status][uint32 loot][name][0][uint16 rank]`. */
function standingNames (buffer: Buffer): string[] {
  const out: string[] = []
  let at = 0
  while (at + 2 <= buffer.length) {
    const length = buffer.readUInt16BE(at)
    const record = buffer.subarray(at + 2, at + 2 + length)
    const end = record.indexOf(0, 7)
    out.push(record.subarray(7, end).toString('utf8'))
    at += 2 + length
  }
  return out
}

/** Every object a world holds in its lists, by id. */
function objectsOf (world: World): Map<number, GameObject> {
  const out = new Map<number, GameObject>()
  for (const list of [world.PLAYERS, world.MOBS, world.OBSTACLES, world.PROJECTILES, world.CONSUMABLES, world.ITEMS]) {
    for (const obj of list as GameObject[]) out.set(obj.id, obj)
  }
  return out
}

/**
 * Says whether an id a client was sent belongs to `world`. Ids are per world,
 * so both worlds hand out 1, 2, 3... A world's constructor makes only its
 * terrain (portals and exits); right after it, the spec moves the world's
 * counter to `base`, so every later object's id says which world it is in.
 * The terrain ids overlap between worlds, and a create for one is checked by
 * the position it carries against this world's own object.
 */
class WorldIds {
  readonly terrain = new Map<number, { x: number, y: number }>()
  constructor (readonly world: World, readonly base: number, readonly top: number) {
    // As the wire has it: whole units, rounded down.
    for (const obj of world.OBSTACLES) this.terrain.set(obj.id, { x: Math.floor(obj.position.x), y: Math.floor(obj.position.y) })
    world.ids.last = base
  }

  /** Throws unless record `id`, in an `event` (with its bytes for a create), is this world's. */
  check (who: string, event: string, id: number, record?: Buffer): void {
    const own = this.terrain.get(id)
    if (own !== undefined && event !== 'effect') {
      if (event === 'create' && record !== undefined) {
        const data = decodeRecord(new Uint8Array(record), GameObject.fieldOrder)
        assert.ok(data.position !== undefined && data.position.x === own.x && data.position.y === own.y,
          `${who} got a create for terrain ${id} that is not this world's`)
      }
      return
    }
    assert.ok(id > this.base && id < this.top, `${who} got ${event} for id ${id}, from another world`)
  }

  /** Every id in a frame's event. */
  checkEvent (who: string, event: string, data: Buffer): void {
    if (event === 'standings') return
    let at = event === 'update' ? 8 : 0
    while (at + 2 <= data.length) {
      const length = data.readUInt16BE(at)
      const record = data.subarray(at + 2, at + 2 + length)
      // An effect is [type][originator id]; every other record opens [0][id].
      this.check(who, event, record.readUInt16BE(1), record)
      at += 2 + length
    }
  }
}

/** A `pointer` packet: one waypoint cell and a sequence number. */
function pointer (q: number, r: number, seq: number): Buffer {
  const buf = Buffer.alloc(7)
  buf.writeUInt8(1, 0)
  buf.writeInt16BE(q, 1)
  buf.writeInt16BE(r, 3)
  buf.writeUInt16BE(seq & 0xffff, 5)
  return buf
}

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

// --- assignment ---------------------------------------------------------------

test('runs fill the fullest world under the cap, open a new one when all are full, and tie to the oldest', async () => {
  const worlds = makeWorlds(2)
  assert.equal(worlds.worlds.length, 1, 'one world at the start')
  const [a1, a2, b1, x, y] = ['a1', 'a2', 'b1', 'x', 'y'].map((id) => connect(worlds, id))

  // Connecting joins nothing: a world is picked per run.
  assert.equal(worlds.worldFor(a1.connection), undefined)

  await a1.start('A1')
  await a2.start('A2')
  const [first] = worlds.worlds
  assert.equal(worlds.worldFor(a1.connection), first)
  assert.equal(worlds.worldFor(a2.connection), first, 'fill-first: the second run joined the first world')
  assert.equal(Worlds.activePlayers(first), 2)

  await b1.start('B1')
  assert.equal(worlds.worlds.length, 2, 'every world was full: a second one opened')
  const second = worlds.worlds[1]
  assert.equal(worlds.worldFor(b1.connection), second)

  // One each: a tie, which goes to the oldest.
  kill(worlds, a1)
  assert.equal(Worlds.activePlayers(first), 1)
  await x.start('X')
  assert.equal(worlds.worldFor(x.connection), first, 'a tie went to the oldest world')

  // 2 and 1: the fullest under the cap is the second.
  kill(worlds, a2)
  kill(worlds, x)
  await a2.start('A2 again')
  assert.equal(worlds.worldFor(a2.connection), second, 'not the fullest world under the cap')
  await y.start('Y')
  // Second is full now (B1, A2), first has none.
  assert.equal(worlds.worldFor(y.connection), first)
  assert.equal(worlds.worlds.length, 2)
})

test('a run that moves to another world leaves the old one completely', async () => {
  const worlds = makeWorlds(1)
  const mover = connect(worlds, 'mover')
  const stayer = connect(worlds, 'stayer')

  await mover.start('MOVER')
  const [a] = worlds.worlds
  for (let i = 0; i < 4; i++) worlds.tickAll(250)
  kill(worlds, mover)
  await stayer.start('STAYER')
  assert.equal(worlds.worldFor(stayer.connection), a)

  // B is opened first, so its ids can be told from A's (`WorldIds`). A is
  // full (cap 1), so the next run goes to B.
  const b = worlds.open()
  const bIds = new WorldIds(b, 20_000, 40_000)
  // What the first run was sent, in A, is not checked.
  mover.take()
  await mover.start('MOVER AGAIN')
  assert.equal(worlds.worldFor(mover.connection), b, 'the run did not go to the other world')
  assert.equal(a.multiplayer?.connectionCount, 1, 'the old Multiplayer kept the connection')
  for (const obj of objectsOf(a).values()) {
    assert.ok(!obj.knownBy.has(mover.connection), `old object ${obj.id} still lists the connection as a holder`)
  }

  // From now on only the new world writes to it, one frame a tick, about the
  // new world's objects only, while A goes on around its old run.
  const writesBefore = mover.writes
  for (let i = 0; i < 12; i++) {
    World.run(a, () => { stayer.player?.setWaypoints([Hex.toCell(stayer.player.position).add(new Vector(i % 2 === 0 ? 2 : -2, 0))]) })
    worlds.tickAll(250)
  }
  assert.equal(mover.writes - writesBefore, 12, 'the connection is flushed by more than one world')
  const events = mover.take()
  assert.ok(events.some(([event]) => event === 'create'), 'the new run was sent nothing')
  for (const [event, data] of events) bIds.checkEvent('mover', event, data)
})

// --- isolation ----------------------------------------------------------------

test('two worlds ticked together share no object, id, timer, standings row, create, update, destroy or effect', async (t) => {
  mockClock(t)
  const worlds = makeWorlds(3)
  const clients = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'].map((id) => connect(worlds, id))
  const [a, b] = [worlds.worlds[0], worlds.open()]
  // A's later ids from 10000, B's from 20000 (`WorldIds`).
  const ids = new Map([[a, new WorldIds(a, 10_000, 20_000)], [b, new WorldIds(b, 20_000, 30_000)]])
  const worldOf = (client: Client): World => client.id.startsWith('a') ? a : b
  const inWorld = (world: World, id: number): boolean => {
    const own = ids.get(world) as WorldIds
    return own.terrain.has(id) || (id > own.base && id < own.top)
  }

  // A and B's players, all close together, so each sees the others' work.
  for (const client of clients) await client.start(client.id.toUpperCase())
  for (const client of clients) assert.equal(worlds.worldFor(client.connection), worldOf(client))
  const centre = new Vector(40, 40)
  for (const world of [a, b]) {
    World.run(world, () => {
      world.PLAYERS.forEach((player, i) => { player.position = Hex.toPosition(centre.add(new Vector(i, 0))) })
      // A StoneWall stone each, with a lifetime timer.
      const at = Hex.toPosition(centre.add(new Vector(0, 2)))
      World.addObstacle(new Obstacle(at.x, at.y, 0, 60_000))
    })
  }
  const guardBefore = World.wrongWorld

  const names = { a: new Set(['A1', 'A2', 'A3']), b: new Set(['B1', 'B2', 'B3']) }
  /** Events of each kind each world's clients received, to show the run exercised them. */
  const seen = new Map([[a, new Map<string, number>()], [b, new Map<string, number>()]])
  let ownedTimers = 0
  for (let tick = 0; tick < 120; tick++) {
    for (const [i, client] of clients.entries()) {
      // A dead one stays out: a new run could go to either world.
      if (client.player === undefined) continue
      // Walk about and press skills through the socket, as a client would.
      const cell = Hex.toCell(client.player.position)
      if ((tick + i) % 5 === 0) client.fire('pointer', pointer(cell.x + ((tick + i) % 3) - 1, cell.y + 1, tick))
      if ((tick + i) % 3 === 0) client.fire('skill', (tick + i) % 8)
      if ((tick + i) % 7 === 0) client.fire('use_item', 0)
    }
    t.mock.timers.tick(250)
    worlds.tickAll(250)

    for (const client of clients) {
      const world = worldOf(client)
      assert.equal(worlds.worldFor(client.connection), world, `${client.id} changed world`)
      for (const [event, data] of client.take()) {
        (ids.get(world) as WorldIds).checkEvent(client.id, event, data)
        const tally = seen.get(world) as Map<string, number>
        tally.set(event, (tally.get(event) ?? 0) + 1)
        if (event === 'standings') {
          for (const name of standingNames(data)) {
            assert.ok((world === a ? names.a : names.b).has(name), `${client.id}'s standings show ${name}, from the other world`)
          }
        }
      }
    }
    for (const world of [a, b]) {
      for (const obj of objectsOf(world).values()) {
        assert.ok(inWorld(world, obj.id), `object ${obj.id} in the wrong world's lists`)
        for (const holder of obj.knownBy) {
          assert.equal(worlds.worldFor(holder), world, `object ${obj.id} is held by a connection of the other world`)
        }
      }
      const pending = (world.timers as unknown as { pending: Array<{ owner?: object, done: boolean }> }).pending
      for (const timer of pending) {
        if (timer.done || !(timer.owner instanceof GameObject)) continue
        assert.ok(inWorld(world, timer.owner.id), `a timer in one world is owned by object ${timer.owner.id} of the other`)
        ownedTimers++
      }
    }
  }

  assert.equal(World.wrongWorld, guardBefore, 'the wrong-world guard fired during the run')
  assert.ok(ownedTimers > 0, 'no owned timer was ever pending: the timer check checked nothing')
  // The run exercised every kind of event in both worlds.
  for (const [world, tally] of seen) {
    for (const event of ['create', 'create_own', 'update', 'destroy', 'effect', 'standings']) {
      assert.ok((tally.get(event) ?? 0) > 0, `${world === a ? 'A' : 'B'}'s clients were sent no ${event}`)
    }
  }
})

// --- idle close ---------------------------------------------------------------

test('a world with no active players closes after WORLD_IDLE_MS, the last one never does, and a closed world is collected', async () => {
  let now = 0
  const worlds = makeWorlds(1, 1000, () => now)
  const one = connect(worlds, 'one')
  const two = connect(worlds, 'two')
  await one.start('ONE')
  await two.start('TWO')
  assert.equal(worlds.worlds.length, 2)
  let second: World | undefined = worlds.worlds[1]
  const ref = new WeakRef(second)

  kill(worlds, two) // at now = 0: idle from here
  now = 999
  worlds.tickAll(250)
  assert.equal(worlds.worlds.length, 2, 'closed before WORLD_IDLE_MS')
  now = 1000
  worlds.tickAll(250)
  assert.equal(worlds.worlds.length, 1, 'not closed after WORLD_IDLE_MS')
  assert.equal(second.closed, true)
  assert.equal(worlds.worldFor(two.connection), undefined, 'the idle connection still belongs to the closed world')
  assert.throws(() => { World.run(second as World, () => {}) }, WrongWorldError, 'a closed world was made current')

  // The last world stays, however long it is idle.
  kill(worlds, one)
  for (now = 2000; now < 100_000; now += 10_000) worlds.tickAll(250)
  assert.equal(worlds.worlds.length, 1, 'the last world closed')

  // Its connection plays on elsewhere.
  await two.start('TWO AGAIN')
  assert.equal(worlds.worldFor(two.connection), worlds.worlds[0])

  // Nothing keeps the closed world alive: no timer, listener or index.
  second = undefined
  setFlagsFromString('--expose_gc')
  const gc = runInNewContext('gc') as () => void
  for (let i = 0; i < 10 && ref.deref() !== undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    gc()
  }
  assert.equal(ref.deref(), undefined, 'the closed world was never collected')
})

test('the shared Redis client gets one error listener, however many worlds open', () => {
  const redis = redisStub()
  const worlds = new Worlds({ tickLengthMs: 250, cap: 1, idleMs: 1000, redis })
  worlds.open()
  worlds.open()
  assert.equal((redis as unknown as EventEmitter).listenerCount('error'), 1)
})

// --- the guard ----------------------------------------------------------------

test('with no world current, reaching for world state throws and is counted', () => {
  const worlds = makeWorlds(10)
  const before = World.wrongWorld
  assert.throws(() => World.PLAYERS, WrongWorldError)
  assert.equal(World.wrongWorld, before + 1)
  // Timers and ids have no world either, so nothing can be made or scheduled.
  assert.throws(() => { new Obstacle(100, 100, 0) }, /no world is current/) // eslint-disable-line no-new
  assert.throws(() => { Timers.schedule(0, () => {}) }, /no world is current/)
  // Inside a run the same reads are fine.
  assert.equal(World.run(worlds.worlds[0], () => World.PLAYERS.length), 0)
})

test('a world, or its Multiplayer, used while another world is current throws a WrongWorldError', async () => {
  const worlds = makeWorlds(1)
  const one = connect(worlds, 'one')
  const two = connect(worlds, 'two')
  await one.start('ONE')
  await two.start('TWO')
  const [a, b] = worlds.worlds
  const before = World.wrongWorld

  // A handler that skipped World.run for its connection's world.
  assert.throws(() => {
    World.run(a, () => { b.multiplayer?.onPointer(two.connection, Buffer.from([0, 0, 1])) })
  }, WrongWorldError)
  // A tick outside World.run, or under the wrong world.
  assert.throws(() => { a.update(0.25) }, WrongWorldError)
  assert.throws(() => { World.run(b, () => { a.update(0.25) }) }, WrongWorldError)
  assert.throws(() => { World.run(a, () => { b.multiplayer?.flushAll(1) }) }, WrongWorldError)
  assert.equal(World.wrongWorld, before + 4)

  // Through Worlds, the same events are handled in their own world.
  two.fire('pointer', Buffer.from([0, 0, 1]))
  worlds.tickAll(250)
  assert.equal(World.wrongWorld, before + 4)
})

// --- async ----------------------------------------------------------------------

test('a stats write finishes after its world is no longer current', async (t) => {
  mockClock(t)
  const writes: string[] = []
  const logged = t.mock.method(Multiplayer.STATS_LOG, 'report', () => {})
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 1000, redis: redisStub(writes) })
  const one = connect(worlds, 'one')
  await one.start('ONE')
  t.mock.timers.tick(5000)
  kill(worlds, one)
  // Every await in updateStats runs with no world current (strict mode).
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  // Two awaits: the second write runs after the first has resolved.
  // Under the account's id, not the start's 'abcdef' (decision #48).
  const id = one.connection.account?.publicId as string
  assert.match(id, /^[0-9a-f]{16}$/)
  assert.deepEqual(writes.sort(), [`stats-${id} games`, `stats-${id} lifeTime`])
  assert.equal(logged.mock.callCount(), 0, 'a stats write failed')
})
