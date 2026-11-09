import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import { type Connection, ThrottledLog } from './multiplayer'
import Worlds, { LOAD_COOL, LOAD_HOLD_TICKS, LOAD_HOT, LOAD_WARM, PRIVATE_BOTS_DEFAULT } from './worlds'
import World from '../objects/world'
import { MemoryAccountStore } from '../db/accounts'
import Analytics from '../analytics'

/**
 * Private-15 (decision #60, Nick's Q-E and Q-F): starts bound for a private
 * world beyond `privateOpensPerTick` a tick wait in a queue before `admit`
 * (nothing spent), are let through in order on later ticks, vanish on
 * disconnect and get `full` after `privateQueueMaxMs`; a first run is never
 * queued. The load level from the tick's share sheds private-world work
 * (far bots slower, one bot fewer, the wake margin at 0) and gives it back.
 *
 * Worlds and players are compared by identity only (CLAUDE.md).
 */

let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
const realPost = Analytics.post
const realNow = Date.now
let clock = 0

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = () => {}
  Worlds.accountSuccess()
  Analytics.post = async () => {}
  clock = realNow()
  Date.now = () => clock
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  World.strict = false
  Analytics.post = realPost
  Date.now = realNow
})

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

/** The memory store, counting spends: a queued start must spend nothing. */
class Store extends MemoryAccountStore {
  spends = 0
  async spend (publicId: string, nowMs: number): ReturnType<MemoryAccountStore['spend']> {
    this.spends++
    return await super.spend(publicId, nowMs)
  }
}

class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
  }

  start (extra: Record<string, unknown> = {}): void {
    this.handlers.start_requested({ id: 'abcdef', name: this.id, ...extra })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

interface Options { opens?: number, maxMs?: number, tickClock?: () => number }

function makeWorlds (store: MemoryAccountStore, options: Options = {}): Worlds {
  return new Worlds({
    tickLengthMs: 250,
    cap: 10,
    idleMs: 300_000,
    redis: redisStub(),
    accounts: store,
    bots: 4,
    privateBots: PRIVATE_BOTS_DEFAULT,
    privateOpensPerTick: options.opens,
    privateQueueMaxMs: options.maxMs,
    tickClock: options.tickClock
  })
}

/** Connected clients on new persisted accounts, accounts resolved. */
async function connect (worlds: Worlds, store: MemoryAccountStore, n: number): Promise<Client[]> {
  const clients: Client[] = []
  for (let i = 0; i < n; i++) {
    const { token } = await store.create()
    const client = new Client(`c${i}`, { token })
    client.connection = worlds.onConnection(client.socket)
    clients.push(client)
  }
  await settle()
  return clients
}

/** Ticks with the clock moved on; settles so released starts' spends land. */
async function tickOnce (worlds: Worlds, ms = 250): Promise<void> {
  clock += ms
  worlds.tickAll(250)
  await settle()
}

const tick = tickOnce

const started = (clients: Client[]): string[] => clients.filter((c) => c.connection.started).map((c) => c.id)

test('starts over the budget wait, spend nothing, and are let through in order on later ticks', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { opens: 2 })
  const clients = await connect(worlds, store, 5)
  for (const client of clients) client.start()
  await settle()
  assert.deepEqual(started(clients), ['c0', 'c1'], 'not the first two through at once')
  assert.equal(store.spends, 2, 'a queued start spent a play')
  assert.equal(worlds.queued, 3)
  assert.ok(clients.slice(2).every((c) => c.events('hello').length === 0), 'a queued start got a hello')
  await tick(worlds)
  assert.deepEqual(started(clients), ['c0', 'c1', 'c2', 'c3'])
  assert.equal(store.spends, 4)
  await tick(worlds)
  assert.deepEqual(started(clients), ['c0', 'c1', 'c2', 'c3', 'c4'])
  assert.equal(worlds.queued, 0)
  assert.equal(worlds.privates.length, 5)
  assert.deepEqual(worlds.queueStats, { queued: 3, refused: 0, longestWaitMs: 500 })
})

test('a start behind the queue waits its turn, even with budget left this tick', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { opens: 1 })
  const clients = await connect(worlds, store, 3)
  clients[0].start()
  clients[1].start()
  await settle()
  await tick(worlds)
  // The tick let c1 through: none is left this tick, and none is queued.
  clients[2].start()
  await settle()
  assert.deepEqual(started(clients), ['c0', 'c1'])
  await tick(worlds)
  assert.deepEqual(started(clients), ['c0', 'c1', 'c2'])
})

test('a repeat start while queued is ignored; a queued start that disconnects vanishes, spending nothing', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { opens: 1 })
  const clients = await connect(worlds, store, 3)
  for (const client of clients) client.start()
  clients[1].start()
  await settle()
  assert.equal(worlds.queued, 2, 'a repeat start queued twice')
  clients[1].socket.conn.close()
  await settle()
  await tick(worlds)
  await tick(worlds)
  assert.deepEqual(started(clients), ['c0', 'c2'])
  assert.equal(store.spends, 2, 'the disconnected start spent a play')
  assert.equal(worlds.queued, 0)
  assert.equal(worlds.privates.length, 2)
})

test('a start queued past the longest wait gets full, as today, with nothing spent', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { opens: 1, maxMs: 1000 })
  const clients = await connect(worlds, store, 8)
  for (const client of clients) client.start()
  await settle()
  for (let i = 0; i < 6; i++) await tick(worlds, 400)
  const refused = clients.filter((c) => c.events('full').length > 0)
  assert.ok(refused.length > 0, 'nobody waited past the limit: the check checks nothing')
  for (const client of refused) {
    assert.equal(client.connection.started, false, 'a refused start ran')
    assert.equal(client.events('hello').length, 0)
  }
  assert.equal(store.spends, started(clients).length, 'a refused start spent a play')
  assert.equal(worlds.queueStats.refused, refused.length)
  assert.equal(started(clients).length + refused.length, clients.length, 'a start neither ran nor was refused')
})

test('a first run is never queued', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { opens: 1 })
  const clients = await connect(worlds, store, 3)
  clients[0].start()
  clients[1].start()
  await settle()
  assert.equal(worlds.queued, 1)
  clients[2].start({ firstRun: true })
  await settle()
  assert.equal(clients[2].connection.started, true, 'a first run waited in the queue')
  assert.equal(worlds.firstRuns.length, 1)
  assert.equal(worlds.queued, 1)
})

test('the load level rises with the tick, sheds private work, and gives it back as it falls', async () => {
  const store = new Store()
  let now = 0
  let tickCostMs = 10
  // The clock tickAll times itself with: each read after the first in a tick
  // is `tickCostMs` later.
  let reads = 0
  const worlds = makeWorlds(store, { tickClock: () => { reads++; if (reads % 2 === 0) now += tickCostMs; return now } })
  const [client] = await connect(worlds, store, 1)
  client.start()
  await settle()
  const world = worlds.worldFor(client.connection)
  assert.ok(world !== undefined && worlds.privates.includes(world), 'no private world')
  const player = client.connection.player
  assert.ok(player !== undefined)
  World.run(world, () => { player.hit = () => false })
  // Unkillable bots too: a bot an NPC kills is replaced up to 2 s later, so a
  // live count taken at a random tick read 0 or 2 now and then (1 run in 20).
  // This checks the target, not that churn.
  const immortal = (): void => { for (const p of world.PLAYERS) if (p.bot !== undefined) p.hit = () => false }
  const tick = async (w: Worlds, ms = 250): Promise<void> => { immortal(); await tickOnce(w, ms) }
  // Still playing: a bot over the target is marked `leaving` and walks out
  // (`BotFill`), which takes a while with the human on its layer.
  const bots = (): number => world.PLAYERS.filter((p) => p.bot !== undefined && !p.destroyed && !p.exited && !p.bot.leaving).length
  for (let i = 0; i < 6; i++) await tick(worlds, 2500)
  assert.equal(worlds.load, LOAD_COOL)
  assert.equal(bots(), PRIVATE_BOTS_DEFAULT[0], 'not the cool bot count on the top layer')
  assert.equal(world.farThinkFactor, World.FAR_THINK_FACTOR)
  assert.equal(world.wakeMargin, World.WAKE_MARGIN_RINGS)

  tickCostMs = 120 // 48% of the tick
  for (let i = 0; i < 20; i++) await tick(worlds)
  assert.equal(worlds.load, LOAD_WARM)
  assert.equal(world.farThinkFactor, World.FAR_THINK_FACTOR * 2)
  assert.equal(world.wakeMargin, World.WAKE_MARGIN_RINGS)

  tickCostMs = 200 // 80%
  for (let i = 0; i < 20; i++) await tick(worlds, 2500)
  assert.equal(worlds.load, LOAD_HOT)
  assert.equal(world.wakeMargin, 0)
  assert.equal(player.tag, World.TAGS[0], 'the human left the top layer')
  assert.equal(bots(), PRIVATE_BOTS_DEFAULT[0] - 1, 'hot did not take a bot away')

  // Between the hot threshold and its hysteresis: stays hot.
  tickCostMs = 135 // 54%
  for (let i = 0; i < 20; i++) await tick(worlds)
  assert.equal(worlds.load, LOAD_HOT, 'fell inside the hysteresis band')

  // Hot has held long enough by now: cheap ticks take it down (straight to
  // cool when the share falls that far).
  tickCostMs = 10
  for (let i = 0; i < 30; i++) await tick(worlds, 2500)
  assert.equal(worlds.load, LOAD_COOL)
  // A fresh level holds `LOAD_HOLD_TICKS` before it steps down, however
  // cheap the ticks become.
  tickCostMs = 120
  let ticks = 0
  while (worlds.load === LOAD_COOL && ticks < 30) { await tick(worlds); ticks++ }
  assert.equal(worlds.load, LOAD_WARM, 'did not rise to warm')
  tickCostMs = 10
  for (let i = 0; i < LOAD_HOLD_TICKS - 5; i++) await tick(worlds, 2500)
  assert.equal(worlds.load, LOAD_WARM, 'warm stepped down before holding its level')
  for (let i = 0; i < 10; i++) await tick(worlds, 2500)
  assert.equal(worlds.load, LOAD_COOL)
  assert.equal(world.farThinkFactor, World.FAR_THINK_FACTOR)
  assert.equal(world.wakeMargin, World.WAKE_MARGIN_RINGS)
  assert.equal(bots(), PRIVATE_BOTS_DEFAULT[0], 'the bot did not come back')
})

test('a private world opened while hot starts shed; a shared world is never touched', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  worlds.setLoad(LOAD_HOT)
  const [client] = await connect(worlds, store, 1)
  client.start()
  await settle()
  const world = worlds.worldFor(client.connection)
  assert.ok(world !== undefined && worlds.privates.includes(world))
  assert.equal(world.wakeMargin, 0)
  assert.equal(world.farThinkFactor, World.FAR_THINK_FACTOR * 2)
  const shared = worlds.worlds[0]
  assert.equal(shared.sleepFar, false)
  assert.equal(shared.wakeMargin, World.WAKE_MARGIN_RINGS)
  assert.equal(shared.farThinkFactor, World.FAR_THINK_FACTOR)
})
