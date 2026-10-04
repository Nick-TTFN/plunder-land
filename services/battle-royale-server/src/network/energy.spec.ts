import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import type Player from '../objects/player'
import { type Account, type AccountStore, MemoryAccountStore } from '../db/accounts'
import { energyAt, type EnergyRecord } from '../progress/energy'
import type { PaidSeason, SeasonBoard, SeasonCredit, SeasonView } from '../progress/seasons'
import { energyLine, onEnergy, onRefused, projectEnergy } from '../../../../plunder-land-client/src/net/energy'

/**
 * Energy through `Worlds` (decision #48 step 7): a start spends a play before
 * the run begins, none left is `start_refused` and leaves the connection free
 * to ask again, an extraction or a server cut-off gives the play back once,
 * a death or a disconnect doesn't, and a store that fails plays free (Nick,
 * #48 build call 9). The arithmetic is pinned in progress/energy.spec.ts.
 */

let reported: unknown[] = []
let savedLog: ThrottledLog
const savedReport = Worlds.accountReport

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  reported = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = (e) => { reported.push(e) }
  Worlds.accountSuccess()
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  World.strict = false
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

  start (): void {
    this.handlers.start_requested({ id: 'abcdef', name: this.id })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }
}

/** A store whose spends can fail, hang or be held, counting every spend and refund. */
class EnergyStore implements AccountStore {
  readonly inner = new MemoryAccountStore()
  spends = 0
  refunds = 0
  spendMode: 'ok' | 'throw' | 'hang' = 'ok'
  /** Holds `spend` until released. */
  spendGate: Promise<void> | undefined

  async resolve (token: string): Promise<Account | null> { return await this.inner.resolve(token) }
  async create (): Promise<{ account: Account, token: string }> { return await this.inner.create() }
  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> { return await this.inner.grant(publicId, xp, credit) }
  async saveLoadout (publicId: string, robot: string, index: number, skills: number[]): Promise<void> { await this.inner.saveLoadout(publicId, robot, index, skills) }
  async season (publicId: string, atMs: number): Promise<SeasonView> { return await this.inner.season(publicId, atMs) }
  async seasonBoard (atMs: number, limit: number): Promise<SeasonBoard> { return await this.inner.seasonBoard(atMs, limit) }
  async payDue (nowMs: number): Promise<PaidSeason[]> { return await this.inner.payDue(nowMs) }
  async spend (publicId: string, nowMs: number): Promise<{ ok: boolean, energy: EnergyRecord }> {
    this.spends++
    if (this.spendGate !== undefined) await this.spendGate
    if (this.spendMode === 'hang') return await new Promise(() => {})
    if (this.spendMode === 'throw') throw new Error('connection refused (stub)')
    return await this.inner.spend(publicId, nowMs)
  }

  async refund (publicId: string, nowMs: number): Promise<EnergyRecord> {
    this.refunds++
    return await this.inner.refund(publicId, nowMs)
  }

  async close (): Promise<void> {}

  /** The account's stock as the store holds it now. */
  async stock (token: string, nowMs: number): Promise<number> {
    const record = (await this.inner.resolve(token))?.energy ?? null
    // No record: a new account's 6.
    return energyAt(record, nowMs).stock
  }
}

const ENERGY_START = 6
const MIN = 60_000

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Worlds on a clock the test moves. */
function makeWorlds (store: AccountStore, clock: { now: number }, timeoutMs?: number): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => clock.now, accounts: store, accountTimeoutMs: timeoutMs })
}

/** An account with `left` plays, its stock settled at `clock.now`. */
async function accountWith (store: EnergyStore, left: number, clock: { now: number }): Promise<{ token: string, publicId: string }> {
  const { account, token } = await store.inner.create()
  for (let i = left; i < ENERGY_START; i++) assert.equal((await store.inner.spend(account.publicId, clock.now)).ok, true)
  return { token, publicId: account.publicId }
}

/** A client in a run on the account, its world emptied of anything that could end the run. */
async function join (worlds: Worlds, token: string, name = 'a'): Promise<{ client: Client, player: Player, world: World }> {
  const client = new Client(name, { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  client.start()
  await settle()
  const player = client.connection.player
  assert.ok(player !== undefined, 'the run did not start')
  const world = worlds.worldFor(client.connection) as World
  World.run(world, () => {
    World.MOBS.length = 0
    World.OBSTACLES.length = 0
  })
  return { client, player, world }
}

test('a start spends one play before the run, and account and energy say so', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const known = await accountWith(store, 6, clock)
  const { client } = await join(worlds, known.token)
  assert.deepEqual((client.events('account')[0] as { energy: unknown }).energy, { stock: 6, cap: 3, nextInMs: null, regenMs: 30 * MIN }, 'the lobby is told the stock on connect')
  assert.equal(store.spends, 1)
  assert.deepEqual(client.events('energy'), [{ stock: 5, cap: 3, nextInMs: null, regenMs: 30 * MIN }])
  assert.ok(client.emitted.findIndex(([e]) => e === 'energy') > client.emitted.findIndex(([e]) => e === 'hello'), 'energy before the run began')
  assert.equal(await store.stock(known.token, clock.now), 5)
})

test('a first play (a new account) spends too: 6 becomes 5', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const client = new Client('a')
  client.connection = worlds.onConnection(client.socket)
  client.start()
  await settle()
  assert.ok(client.connection.player !== undefined)
  const [account] = client.events('account') as Array<{ energy: { stock: number } }>
  assert.equal(account.energy.stock, 6, 'the new account is announced with 6')
  assert.deepEqual(client.events('energy').map((e) => (e as { stock: number }).stock), [5])
})

test('an extraction gives the play back, once', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const known = await accountWith(store, 3, clock)
  const { client, player, world } = await join(worlds, known.token)
  assert.equal(await store.stock(known.token, clock.now), 2)
  clock.now += 5 * MIN
  World.run(world, () => { player.exit() })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(known.token, clock.now), 3)
  assert.deepEqual(client.events('energy').at(-1), { stock: 3, cap: 3, nextInMs: null, regenMs: 30 * MIN })
  // The disconnect after it ends nothing again.
  client.socket.conn.close()
  await settle()
  assert.equal(store.refunds, 1, 'refunded twice')
  assert.equal(await store.stock(known.token, clock.now), 3)
})

test('a death or a disconnect keeps the play spent', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const known = await accountWith(store, 6, clock)
  const dead = await join(worlds, known.token)
  World.run(dead.world, () => { assert.equal(dead.player.hit(1e6), true) })
  worlds.tickAll(250)
  await settle()
  assert.equal(await store.stock(known.token, clock.now), 5)
  const left = await join(worlds, known.token, 'b')
  left.client.socket.conn.close()
  await settle()
  assert.equal(store.refunds, 0)
  assert.equal(await store.stock(known.token, clock.now), 4)
})

test('a run the server cuts short (closeAll: a drain\'s deadline) gets its play back', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const known = await accountWith(store, 6, clock)
  await join(worlds, known.token)
  assert.equal(await store.stock(known.token, clock.now), 5)
  worlds.drain()
  worlds.closeAll()
  await settle()
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(known.token, clock.now), 6)
})

test('none left: start_refused with when the next play comes, no run, and the connection can ask again', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const known = await accountWith(store, 0, clock)
  const client = new Client('a', { token: known.token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  assert.deepEqual((client.events('account')[0] as { energy: unknown }).energy, { stock: 0, cap: 3, nextInMs: 30 * MIN, regenMs: 30 * MIN })
  clock.now += 10 * MIN
  client.start()
  await settle()
  assert.deepEqual(client.events('start_refused'), [{ reason: 'energy', energy: { stock: 0, cap: 3, nextInMs: 20 * MIN, regenMs: 30 * MIN } }])
  assert.equal(client.connection.player, undefined)
  assert.equal(client.events('hello').length, 0)
  assert.equal(client.connection.started, false)
  assert.equal(client.connection.starting, false)
  // Asked again too soon: refused again.
  client.start()
  await settle()
  assert.equal(client.events('start_refused').length, 2)
  // Once the play is back, the same connection plays.
  clock.now += 20 * MIN
  client.start()
  await settle()
  assert.ok(client.connection.player !== undefined, 'the run did not start')
  assert.deepEqual(client.events('energy').at(-1), { stock: 0, cap: 3, nextInMs: 30 * MIN, regenMs: 30 * MIN })
})

test('two connections on one account with one play left: one run', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const known = await accountWith(store, 1, clock)
  const a = new Client('a', { token: known.token })
  const b = new Client('b', { token: known.token })
  a.connection = worlds.onConnection(a.socket)
  b.connection = worlds.onConnection(b.socket)
  await settle()
  a.start()
  b.start()
  await settle()
  const runs = [a, b].filter((c) => c.connection.player !== undefined)
  assert.equal(runs.length, 1, 'both ran, or neither')
  assert.equal(a.events('start_refused').length + b.events('start_refused').length, 1)
  assert.equal(await store.stock(known.token, clock.now), 0)
})

test('a second start while the spend is in flight is ignored: one spend, one run', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = makeWorlds(store, clock)
  const known = await accountWith(store, 6, clock)
  let release!: () => void
  store.spendGate = new Promise((resolve) => { release = resolve })
  const client = new Client('a', { token: known.token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  client.start()
  client.start()
  await settle()
  assert.equal(client.connection.player, undefined, 'started before the play was spent')
  release()
  await settle()
  assert.equal(store.spends, 1)
  assert.equal(client.events('hello').length, 1)
  assert.equal(await store.stock(known.token, clock.now), 5)
})

for (const how of ['disconnect', 'drain'] as const) {
  test(`a ${how} while the spend is in flight: no run, and the play is given back`, async () => {
    const clock = { now: 1_000_000_000 }
    const store = new EnergyStore()
    const worlds = makeWorlds(store, clock)
    const known = await accountWith(store, 6, clock)
    let release!: () => void
    store.spendGate = new Promise((resolve) => { release = resolve })
    const client = new Client('a', { token: known.token })
    client.connection = worlds.onConnection(client.socket)
    await settle()
    client.start()
    await settle()
    if (how === 'disconnect') client.socket.conn.close()
    else worlds.drain()
    release()
    await settle()
    assert.equal(client.events('hello').length, 0, 'a run started')
    assert.equal(store.refunds, 1)
    assert.equal(await store.stock(known.token, clock.now), 6)
    if (how === 'drain') assert.equal(client.closed, true, 'not sent on to the next server')
  })
}

for (const mode of ['throw', 'hang'] as const) {
  test(`a spend that ${mode === 'throw' ? 'fails' : 'never answers'}: the run plays free, is reported, and an extraction refunds nothing`, async () => {
    const clock = { now: 1_000_000_000 }
    const store = new EnergyStore()
    const worlds = makeWorlds(store, clock, 50)
    const known = await accountWith(store, 6, clock)
    store.spendMode = mode
    const client = new Client('a', { token: known.token })
    client.connection = worlds.onConnection(client.socket)
    await settle()
    client.start()
    await settle()
    if (mode === 'hang') {
      await new Promise((resolve) => setTimeout(resolve, 80))
      await settle()
    }
    const player = client.connection.player
    assert.ok(player !== undefined, 'the run did not start')
    assert.equal(reported.length, 1)
    assert.equal(client.events('energy').length, 0)
    World.run(worlds.worldFor(client.connection) as World, () => { player.exit() })
    worlds.tickAll(250)
    await settle()
    assert.equal(store.refunds, 0, 'a free run was refunded')
    assert.equal(await store.stock(known.token, clock.now), 6)
  })
}

test('an offline account spends nothing, and is told no energy', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  store.inner.create = async () => { throw new Error('down (stub)') }
  const worlds = makeWorlds(store, clock)
  const client = new Client('a')
  client.connection = worlds.onConnection(client.socket)
  client.start()
  await settle()
  assert.equal(client.connection.account?.persisted, false)
  assert.ok(client.connection.player !== undefined)
  assert.equal(store.spends, 0)
  assert.equal((client.events('account')[0] as { energy?: unknown }).energy, undefined)
})

test('bots spend nothing', async () => {
  const clock = { now: 1_000_000_000 }
  const store = new EnergyStore()
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => clock.now, accounts: store, bots: 4 })
  const known = await accountWith(store, 6, clock)
  const { world } = await join(worlds, known.token)
  for (let i = 0; i < 40; i++) worlds.tickAll(250)
  const bots = World.run(world, () => World.PLAYERS.filter((p) => p.bot !== undefined).length)
  assert.ok(bots > 0, 'no bot joined')
  assert.equal(store.spends, 1, 'a bot spent')
})

// --- the client half (plunder-land-client/src/net/energy.ts) ---------------------

test('client: energy and start_refused are read whole, or not at all', () => {
  const view = { stock: 2, cap: 3, nextInMs: 20 * MIN, regenMs: 30 * MIN }
  assert.deepEqual(onEnergy(view), view)
  assert.deepEqual(onEnergy({ stock: 6, cap: 3, nextInMs: null, regenMs: 30 * MIN }), { stock: 6, cap: 3, nextInMs: null, regenMs: 30 * MIN })
  for (const bad of [null, 3, {}, { ...view, stock: -1 }, { ...view, stock: 1.5 }, { ...view, cap: 0 }, { ...view, regenMs: 0 }, { ...view, nextInMs: -5 }, { ...view, nextInMs: undefined }]) {
    assert.equal(onEnergy(bad), undefined, JSON.stringify(bad))
  }
  assert.deepEqual(onRefused({ reason: 'energy', energy: view }), { reason: 'energy', energy: view })
  assert.deepEqual(onRefused({ reason: 'something new' }), { reason: 'something new', energy: undefined })
  assert.equal(onRefused(null), undefined)
})

test('client: the stock counts up on its own while the lobby is open, to the cap and no further', () => {
  const view = { stock: 0, cap: 3, nextInMs: 20 * MIN, regenMs: 30 * MIN }
  assert.deepEqual(projectEnergy(view, 0), { stock: 0, nextInMs: 20 * MIN })
  assert.deepEqual(projectEnergy(view, 20 * MIN), { stock: 1, nextInMs: 30 * MIN })
  assert.deepEqual(projectEnergy(view, 51 * MIN), { stock: 2, nextInMs: 29 * MIN })
  assert.deepEqual(projectEnergy(view, 80 * MIN), { stock: 3, nextInMs: null })
  assert.deepEqual(projectEnergy(view, 999 * MIN), { stock: 3, nextInMs: null })
  assert.deepEqual(projectEnergy({ stock: 6, cap: 3, nextInMs: null, regenMs: 30 * MIN }, 999 * MIN), { stock: 6, nextInMs: null })
  assert.equal(energyLine({ stock: 6, cap: 3, nextInMs: null, regenMs: 30 * MIN }, 0), 'PLAYS 6/3')
  assert.equal(energyLine({ stock: 2, cap: 3, nextInMs: 20 * MIN + 1, regenMs: 30 * MIN }, 0), 'PLAYS 2/3 · +1 IN 21M')
  assert.equal(energyLine(view, 0), 'NO PLAYS LEFT · NEXT IN 20M')
  assert.equal(energyLine(view, 19 * MIN + 30_000), 'NO PLAYS LEFT · NEXT IN 1M')
})
