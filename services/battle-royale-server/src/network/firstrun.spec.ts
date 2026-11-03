import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds, { HANDOFF_CLEARANCE } from './worlds'
import World from '../objects/world'
import Mob from '../objects/mob'
import type Player from '../objects/player'
import { type Account, MemoryAccountStore } from '../db/accounts'
import { type SeasonCredit } from '../progress/seasons'
import { energyAt } from '../progress/energy'
import { ARCHETYPES } from '../archetypes/archetypes'
import { PROGRESSION } from '../progress/xp'
import Analytics from '../analytics'
import { Hex } from '../utils/hex'
import { FIRST_RUN } from '../firstrun/scenario'

/**
 * The safe first run (decision #58, task retest-4) through `Worlds`: who gets
 * a private world, what reads `worlds` and what reads `firstRuns`, the HP
 * floor, the handoff into a shared world (and that it never ends the first
 * run as a run: `runOver` first), energy across it, and leaving halfway.
 */

let reported: unknown[] = []
let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
const realPost = Analytics.post
let sent: Array<{ name: string, params: Record<string, unknown> }> = []

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  reported = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = (e) => { reported.push(e) }
  Worlds.accountSuccess()
  sent = []
  Analytics.post = async (_url, body) => {
    const parsed = JSON.parse(body) as { events: Array<{ name: string, params: Record<string, unknown> }> }
    sent.push(...parsed.events)
  }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  World.strict = false
  Analytics.post = realPost
  delete process.env.GA_MEASUREMENT_ID
  delete process.env.GA_API_SECRET
})

/** Redis that counts the stats writes (`hincrby`). */
function redisStub (): Redis & { writes: string[] } {
  const writes: string[] = []
  return Object.assign(new EventEmitter(), {
    writes,
    hincrby: async (key: string, field: string) => { writes.push(`${key} ${field}`); return 1 },
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis & { writes: string[] }
}

/** The memory store, counting what the first run must do exactly once or never. */
class Store extends MemoryAccountStore {
  finished: string[] = []
  grants: Array<{ publicId: string, xp: number }> = []
  refunds = 0

  async finishFirstRun (publicId: string, nowMs: number): Promise<void> {
    this.finished.push(publicId)
    await super.finishFirstRun(publicId, nowMs)
  }

  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> {
    this.grants.push({ publicId, xp })
    return await super.grant(publicId, xp, credit)
  }

  async refund (publicId: string, nowMs: number): ReturnType<MemoryAccountStore['refund']> {
    this.refunds++
    return await super.refund(publicId, nowMs)
  }

  /** The account's stock now (no record: a new account's 6). */
  async stock (token: string): Promise<number> {
    return energyAt((await this.resolve(token))?.energy ?? null, Date.now()).stock
  }
}

class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection
  closed = false

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: {
        write: () => {},
        close: () => {
          if (this.closed) return
          this.closed = true
          this.handlers.disconnect?.()
        }
      }
    } as unknown as Socket
  }

  start (extra: Record<string, unknown> = { firstRun: true }): void {
    this.handlers.start_requested({ id: 'abcdef', name: this.id, ...extra })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function makeWorlds (store: MemoryAccountStore, options: { bots?: number, maxPlayers?: number, firstRunCap?: number, redis?: Redis } = {}): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: options.redis ?? redisStub(), accounts: store, bots: options.bots, maxPlayers: options.maxPlayers, firstRunCap: options.firstRunCap })
}

/** A connected client on a new persisted account (not done), its account resolved. */
async function connect (worlds: Worlds, store: MemoryAccountStore, name = 'a'): Promise<{ client: Client, token: string, account: Account }> {
  const { account, token } = await store.create()
  const client = new Client(name, { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  assert.equal(client.connection.account?.publicId, account.publicId)
  return { client, token, account }
}

/** Connect and start; the client's world after the start. */
async function begin (worlds: Worlds, store: MemoryAccountStore, extra?: Record<string, unknown>, name = 'a'): Promise<{ client: Client, token: string, world: World, player: Player }> {
  const { client, token } = await connect(worlds, store, name)
  client.start(extra)
  await settle()
  const world = worlds.worldFor(client.connection)
  const player = client.connection.player
  assert.ok(world !== undefined && player !== undefined, 'the run did not start')
  return { client, token, world, player }
}

/** The handoff gate's cell in a first-run world. */
function gateCell (world: World): { x: number, y: number } {
  const gate = world.OBSTACLES.find((o) => (o as { handoff?: boolean }).handoff === true)
  assert.ok(gate !== undefined, 'no handoff gate')
  return Hex.toCell(gate.position)
}

/** Put the player on the gate and tick: the handoff runs after the tick. */
function stepOnGate (worlds: Worlds, world: World, player: Player): void {
  World.run(world, () => { player.position = Hex.toPosition(gateCell(world) as never) })
  worlds.tickAll(250)
}

test('a persisted account that has not done it, starting with firstRun, gets a private first-run world', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { world, player } = await begin(worlds, store)
  assert.equal(world.firstRun, true)
  assert.deepEqual(worlds.firstRuns, [world])
  assert.ok(!worlds.worlds.includes(world), 'a first-run world is in the shared list')
  assert.equal(world.mapSize, FIRST_RUN.mapSize)
  World.run(world, () => {
    const cell = Hex.toCell(player.position)
    assert.deepEqual([cell.x, cell.y], [FIRST_RUN.start.q, FIRST_RUN.start.r], 'not on the scenario\'s start')
    assert.equal(player.tag, World.TAGS[0])
    // The scenario and nothing else: no valleys, walls, exits or portals of a shared map.
    assert.equal(World.VOIDS.size, 0)
    assert.equal(World.WALLS.size, 0)
    assert.equal(World.OBSTACLES.length, 1)
  })
  // Its tick tops nothing up.
  for (let i = 0; i < 8; i++) worlds.tickAll(250)
  World.run(world, () => {
    assert.equal(World.MOBS.length, 0, 'the refill ran in a first-run world')
    assert.equal(World.GEAR.length, 0)
    assert.equal(World.CONSUMABLES.length, 1)
  })
  assert.equal(sent.filter((e) => e.name === 'run_start').length, 0, 'a first run sent run_start')
  assert.equal(sent.filter((e) => e.name === 'first_run_start').length, 1)
})

test('today\'s path: an older start (no key), an offline account, a done account, a drain, and the cap reached', async () => {
  // No key: a client from before the first run.
  {
    const store = new Store()
    const worlds = makeWorlds(store)
    const { world } = await begin(worlds, store, {})
    assert.equal(world.firstRun, false)
    assert.equal(worlds.firstRuns.length, 0)
  }
  // A key that isn't literally true.
  {
    const store = new Store()
    const worlds = makeWorlds(store)
    const { world } = await begin(worlds, store, { firstRun: 'yes' })
    assert.equal(world.firstRun, false)
  }
  // An offline account (the store failed): reads as done.
  {
    const store = new Store()
    store.create = async () => { throw new Error('down (stub)') }
    const worlds = makeWorlds(store)
    const client = new Client('a')
    client.connection = worlds.onConnection(client.socket)
    client.start()
    await settle()
    assert.equal(client.connection.account?.persisted, false)
    assert.equal(worlds.worldFor(client.connection)?.firstRun, false)
    assert.equal(worlds.firstRuns.length, 0)
  }
  // A done account.
  {
    const store = new Store()
    const worlds = makeWorlds(store)
    const { account, token } = await store.create()
    await store.finishFirstRun(account.publicId, Date.now())
    const client = new Client('a', { token })
    client.connection = worlds.onConnection(client.socket)
    await settle()
    client.start()
    await settle()
    assert.equal(worlds.worldFor(client.connection)?.firstRun, false)
  }
  // A store with no finishFirstRun: it couldn't record one, so none.
  {
    const store = new Store()
    ;(store as { finishFirstRun?: unknown }).finishFirstRun = undefined
    const worlds = makeWorlds(store)
    const { world } = await begin(worlds, store)
    assert.equal(world.firstRun, false)
  }
  // The cap: the second start plays a normal run, and stays not done.
  {
    const store = new Store()
    const worlds = makeWorlds(store, { firstRunCap: 1 })
    const one = await begin(worlds, store, undefined, 'one')
    const two = await begin(worlds, store, undefined, 'two')
    assert.equal(one.world.firstRun, true)
    assert.equal(two.world.firstRun, false)
    assert.equal(two.client.connection.account?.firstRunDone, false)
    assert.equal(worlds.firstRuns.length, 1)
  }
  // A drain: the start goes to the next server; no world opens.
  {
    const store = new Store()
    const worlds = makeWorlds(store)
    const { client } = await connect(worlds, store)
    worlds.drain()
    client.start()
    await settle()
    assert.equal(worlds.firstRuns.length, 0)
    assert.equal(client.closed, true)
  }
})

test('choose never returns a first-run world, and no bot ever joins one', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { bots: 8 })
  const { world } = await begin(worlds, store)
  for (let i = 0; i < 40; i++) worlds.tickAll(250)
  World.run(world, () => {
    assert.deepEqual(World.PLAYERS.filter((p) => p.bot !== undefined), [], 'a bot joined a first-run world')
  })
  for (let i = 0; i < 20; i++) assert.ok(!worlds.firstRuns.includes(worlds.choose()), 'choose returned a first-run world')
  for (let i = 0; i < 20; i++) assert.ok(!worlds.firstRuns.includes(worlds.choose('party1')))
  // closeIdle never closes it as an idle shared world either: it is still open.
  assert.deepEqual(worlds.firstRuns, [world])
})

test('activeRuns, drained and full count a first run', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { maxPlayers: 1 })
  await begin(worlds, store)
  assert.equal(Worlds.activeRuns(worlds), 1)
  assert.equal(worlds.drained, false)
  assert.equal(worlds.full, true)
  const { client } = await connect(worlds, store, 'b')
  client.start()
  await settle()
  assert.equal(client.events('full').length, 1, 'a burst cap undercounted a first run')
})

test('HP never drops below 1 in a first-run world, and does in a shared one', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const first = await begin(worlds, store, undefined, 'one')
  World.run(first.world, () => {
    assert.equal(first.player.hit(1e6), false)
    assert.equal(first.player.hp, 1)
    assert.equal(first.player.destroyed, false)
    assert.equal(first.player.hit(5), false)
    assert.equal(first.player.hp, 1)
  })
  const shared = await begin(worlds, store, {}, 'two')
  World.run(shared.world, () => {
    assert.equal(shared.player.hit(1e6), true)
    assert.equal(shared.player.destroyed, true)
  })
})

test('the handoff: a shared world on layer 0 at a spawn 6+ cells from every mob, loot and kill XP carried, the first run never ended as a run', async () => {
  const redis = redisStub()
  const store = new Store()
  const worlds = makeWorlds(store, { redis })
  const started = await begin(worlds, store)
  const { client, token, player: first } = started
  // Held only through `ref` past the handoff, so the spec can see it collected.
  let firstWorld: World | undefined = started.world
  ;(started as { world?: World }).world = undefined
  const publicId = client.connection.account?.publicId as string
  // A kill (a Crawler: 1 XP) and some loot in the first run.
  World.run(firstWorld, () => {
    const mob = new Mob(first.position.x + 200, first.position.y, first.tag, ARCHETYPES.crawler)
    World.addUnit(World.MOBS, mob)
    mob.hit(1e6)
    first.onKill(mob)
    first.addLoot(75)
  })
  worlds.tickAll(250)
  redis.writes.length = 0
  assert.equal(first.kills, 1)
  const ref = new WeakRef(firstWorld)

  stepOnGate(worlds, firstWorld, first)
  await settle()
  const closed = new WeakRef(firstWorld)
  firstWorld = undefined
  const shared = worlds.worldFor(client.connection) as World
  const next = client.connection.player as Player
  assert.ok(shared !== undefined && next !== undefined && next !== first)
  assert.equal(shared.firstRun, false)
  assert.ok(worlds.worlds.includes(shared))
  // `handoff`, then the new world's hello, in that order, and no lobby.
  const order = client.emitted.map(([e]) => e).filter((e) => e === 'handoff' || e === 'hello')
  assert.deepEqual(order, ['hello', 'handoff', 'hello'])
  World.run(shared, () => {
    assert.equal(next.tag, World.TAGS[0], 'not on layer 0')
    const cell = Hex.toCell(next.position)
    for (const mob of World.MOBS) {
      if (mob.tag !== next.tag || mob.destroyed) continue
      assert.ok(Hex.distance(cell, Hex.toCell(mob.position)) >= HANDOFF_CLEARANCE, 'a mob within the handoff\'s clearance')
    }
    assert.equal(next.loot, 75, 'the loot was not carried')
    assert.equal(next.kills, 1, 'the kills were not carried')
    assert.equal(next.hp, next.maxHP(), 'HP not fresh')
  })
  // The first run was not a run: no grant, no Redis stats, no run_end, no refund.
  assert.deepEqual(store.grants, [], 'XP granted at the handoff')
  assert.deepEqual(redis.writes, [], 'Redis stats written for the first run')
  assert.equal(sent.filter((e) => e.name === 'run_end').length, 0, 'run_end for the first run')
  assert.equal(store.refunds, 0)
  assert.equal(sent.filter((e) => e.name === 'first_run_done').length, 1)
  // Done once, in memory and in the store.
  assert.deepEqual(store.finished, [publicId])
  assert.equal(client.connection.account?.firstRunDone, true)
  assert.equal((await store.resolve(token))?.firstRunDone, true)
  // The private world is closed, gone from every list, and (below) collected.
  assert.equal(closed.deref()?.closed, true)
  assert.deepEqual(worlds.firstRuns, [])
  assert.equal(worlds.worlds.length, 1)

  // The shared run's extraction pays the first run's kill too (a Crawler, 1)
  // and the carried loot, once; its energy comes back.
  const stockBefore = await store.stock(token)
  World.run(shared, () => { next.exit() })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.grants.length, 1)
  const end = sent.find((e) => e.name === 'run_end')
  assert.ok(end !== undefined)
  assert.equal(end.params.kills, 1)
  assert.equal(end.params.loot, 75)
  // The same run without the carried kill pays less by the Crawler's XP x1.5.
  const withoutKill = Math.round(PROGRESSION.extractMultiplier * (Math.floor(75 / PROGRESSION.loot.per)))
  assert.equal(store.grants[0].xp, Math.round(PROGRESSION.extractMultiplier * (Math.floor(75 / PROGRESSION.loot.per) + PROGRESSION.kills.mob.crawler)))
  assert.ok(store.grants[0].xp > withoutKill)
  assert.equal(await store.stock(token), stockBefore + 1, 'the play did not come back on the shared run\'s extraction')
  assert.equal(store.finished.length, 1, 'marked done twice')

  // Nothing keeps it: no timer, listener, index or connection.
  for (let i = 0; i < 10 && ref.deref() !== undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    setFlagsFromString('--expose_gc')
    ;(runInNewContext('gc') as () => void)()
  }
  assert.equal(ref.deref(), undefined, 'the closed first-run world was never collected')
})

test('the play moves across the handoff: the shared run\'s death keeps it spent', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, token, world, player } = await begin(worlds, store)
  assert.equal(await store.stock(token), 5)
  stepOnGate(worlds, world, player)
  await settle()
  const shared = worlds.worldFor(client.connection) as World
  const next = client.connection.player as Player
  World.run(shared, () => { assert.equal(next.hit(1e6), true) })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.refunds, 0)
  assert.equal(await store.stock(token), 5)
})

test('a disconnect inside the first run refunds the play, leaves the account not done, and closes the world', async () => {
  const redis = redisStub()
  const store = new Store()
  const worlds = makeWorlds(store, { redis })
  const { client, token, world } = await begin(worlds, store)
  assert.equal(await store.stock(token), 5)
  client.socket.conn.close()
  await settle()
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(token), 6)
  assert.deepEqual(store.finished, [])
  assert.equal((await store.resolve(token))?.firstRunDone, false)
  assert.deepEqual(store.grants, [], 'XP granted for a first run left halfway')
  assert.deepEqual(redis.writes, [])
  assert.equal(sent.filter((e) => e.name === 'run_end').length, 0)
  assert.equal(sent.filter((e) => e.name === 'first_run_left').length, 1)
  assert.equal(world.closed, true)
  assert.deepEqual(worlds.firstRuns, [])
  // The next start replays it.
  const again = new Client('a', { token })
  again.connection = worlds.onConnection(again.socket)
  await settle()
  again.start()
  await settle()
  assert.equal(worlds.worldFor(again.connection)?.firstRun, true)
})

test('a drain\'s cut-off inside the first run refunds once', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { token } = await begin(worlds, store)
  worlds.drain()
  assert.equal(worlds.drained, false, 'a drain would cut a first run')
  worlds.closeAll()
  await settle()
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(token), 6)
  assert.deepEqual(worlds.firstRuns, [])
})

test('a handoff during a drain redirects, refunds and still marks the account done', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, token, world, player } = await begin(worlds, store)
  worlds.drain()
  stepOnGate(worlds, world, player)
  await settle()
  assert.equal(client.closed, true, 'not redirected')
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(token), 6)
  assert.equal(store.finished.length, 1)
  assert.equal(world.closed, true)
  assert.deepEqual(store.grants, [])
})

test('a party code lands the handoff in the friend\'s world', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  // A friend in a shared run with the code, and another shared world besides.
  const friend = await begin(worlds, store, { party: 'abc123' }, 'friend')
  assert.equal(friend.world.firstRun, false)
  const { client, world, player } = await begin(worlds, store, { party: 'abc123', firstRun: true }, 'me')
  assert.equal(world.firstRun, true)
  stepOnGate(worlds, world, player)
  await settle()
  assert.equal(worlds.worldFor(client.connection), friend.world)
})

test('standing on the gate across several ticks hands off once', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, world, player } = await begin(worlds, store)
  World.run(world, () => { player.position = Hex.toPosition(gateCell(world) as never) })
  // Two calls of the world's hook in one tick (a re-entry) and the tick itself.
  world.handoff?.(player)
  world.handoff?.(player)
  worlds.tickAll(250)
  worlds.tickAll(250)
  await settle()
  assert.equal(client.events('handoff').length, 1)
  assert.equal(store.finished.length, 1)
  assert.equal(client.events('hello').length, 2)
})
