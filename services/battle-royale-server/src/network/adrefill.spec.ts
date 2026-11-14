import test, { afterEach, beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import { type Connection, ThrottledLog } from './multiplayer'
import Worlds, { AD_REQUEST_GAP_MS, AD_RESULTS_PER_CONNECTION, adRefillPortalsFrom, type EnergyAdAnswer } from './worlds'
import World from '../objects/world'
import { type Account, type AccountStore, MemoryAccountStore } from '../db/accounts'
import { AD_REFILL, energyAt, type EnergyRecord } from '../progress/energy'
import { ENERGY } from '../progress/xp'
import type { PaidSeason, SeasonBoard, SeasonCredit, SeasonView } from '../progress/seasons'
import Analytics from '../analytics'

/**
 * The rewarded-video refill through `Worlds` (g2-6d; decision #62 addendum
 * 2026-11-13): the switch (`AD_REFILL_PORTALS`) and the connection's portal
 * decide whether the energy view carries `adRefill` and whether `energy_ad`
 * reaches the store; the store grants within `AD_REFILL` (only at 0 plays,
 * one per 30 min, three per UTC day). The arithmetic is pinned in
 * progress/energy.spec.ts, the store's atomicity in db/storecontract.ts.
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

type Handler = (data?: unknown, ack?: unknown) => void

class Client {
  readonly handlers: Record<string, Handler> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection
  closed = false

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: Handler) => { this.handlers[event] = cb },
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

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }

  /** `energy_ad` with an acknowledgement; its answer once the store has answered. */
  async askRefill (): Promise<EnergyAdAnswer | undefined> {
    let answer: EnergyAdAnswer | undefined
    this.handlers.energy_ad({}, (reply: EnergyAdAnswer) => { answer = reply })
    await settle()
    return answer
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

const MIN = 60_000
/** A Saturday morning, UTC. */
const T0 = Date.parse('2026-11-14T10:00:00.000Z')

function makeWorlds (store: AccountStore, clock: { now: number }, adRefillPortals?: readonly string[], timeoutMs?: number): Worlds {
  return new Worlds({ privateRuns: false, tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => clock.now, accounts: store, accountTimeoutMs: timeoutMs, adRefillPortals })
}

/** A stored account with `left` plays at `nowMs`. */
async function accountWith (store: MemoryAccountStore, left: number, nowMs: number): Promise<{ token: string, publicId: string }> {
  const { account, token } = await store.create()
  for (let i = left; i < ENERGY.start; i++) assert.equal((await store.spend(account.publicId, nowMs)).ok, true)
  return { token, publicId: account.publicId }
}

/** `portal` null: a client from before portals, whose handshake names none (`web`). */
async function connect (worlds: Worlds, token: string, portal: string | null = 'crazygames'): Promise<Client> {
  const client = new Client('a', portal === null ? { token } : { token, portal })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  return client
}

function accountEnergy (client: Client): Record<string, unknown> | undefined {
  return (client.events('account')[0] as { energy?: Record<string, unknown> } | undefined)?.energy
}

/**
 * Spends every play left straight in the store, then shows the connection
 * the stock as it now stands (0), as its own spend or `start_refused` would:
 * the in-memory view refuses before the store (g2-6d review), so a spend it
 * hasn't seen reads as plays left.
 */
async function drainSeen (store: MemoryAccountStore, client: Client, publicId: string, nowMs: number): Promise<void> {
  for (;;) {
    const spent = await store.spend(publicId, nowMs)
    if (!spent.ok) {
      assert.equal(spent.energy.stock, 0);
      (client.connection.account as Account).energy = spent.energy
      return
    }
  }
}

/** Counts the store's `adRefill` calls. */
function spyRefills (store: MemoryAccountStore): { calls: number } {
  const spy = { calls: 0 }
  const real = store.adRefill.bind(store)
  store.adRefill = async (publicId: string, nowMs: number) => {
    spy.calls++
    return await real(publicId, nowMs)
  }
  return spy
}

async function stockOf (store: MemoryAccountStore, token: string, nowMs: number): Promise<number> {
  return energyAt((await store.resolve(token))?.energy ?? null, nowMs).stock
}

/** GA events the test sends, captured. */
function withGa (t: TestContext): Array<{ name: string, params: Record<string, unknown> }> {
  const sent: Array<{ name: string, params: Record<string, unknown> }> = []
  const realPost = Analytics.post
  Analytics.post = async (_url, body) => { sent.push(...JSON.parse(body).events) }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
  t.after(() => {
    Analytics.post = realPost
    delete process.env.GA_MEASUREMENT_ID
    delete process.env.GA_API_SECRET
  })
  return sent
}

test('AD_REFILL_PORTALS: a comma list of portal names; unset or empty is off everywhere, unknown names drop', () => {
  assert.deepEqual(adRefillPortalsFrom(undefined), [])
  assert.deepEqual(adRefillPortalsFrom(''), [])
  assert.deepEqual(adRefillPortalsFrom('crazygames'), ['crazygames'])
  assert.deepEqual(adRefillPortalsFrom(' crazygames , poki '), ['crazygames', 'poki'])
  assert.deepEqual(adRefillPortalsFrom('CrazyGames,other,nowhere'), [], 'only the handshake\'s exact names; `other` never')
})

test('the switch unset (the default, read from the environment): no adRefill anywhere, and energy_ad grants nothing', async () => {
  const saved = process.env.AD_REFILL_PORTALS
  delete process.env.AD_REFILL_PORTALS
  try {
    const clock = { now: T0 }
    const store = new MemoryAccountStore()
    const worlds = makeWorlds(store, clock)
    const known = await accountWith(store, 0, clock.now)
    const client = await connect(worlds, known.token)
    assert.ok(accountEnergy(client) !== undefined)
    assert.ok(!('adRefill' in (accountEnergy(client) ?? {})), 'a refill offered with the switch off')
    assert.deepEqual(await client.askRefill(), { ok: false, reason: 'off' })
    assert.equal(await stockOf(store, known.token, clock.now), 0)
    assert.equal(client.events('energy').length, 0)
  } finally {
    if (saved !== undefined) process.env.AD_REFILL_PORTALS = saved
  }
})

for (const portal of ['web', 'itch', 'poki', null]) {
  test(`a ${portal ?? 'portal-less (old)'} client with the switch on for crazygames: no adRefill, no grant`, async () => {
    const clock = { now: T0 }
    const store = new MemoryAccountStore()
    const worlds = makeWorlds(store, clock, ['crazygames'])
    const known = await accountWith(store, 0, clock.now)
    const client = await connect(worlds, known.token, portal)
    assert.ok(!('adRefill' in (accountEnergy(client) ?? {})))
    assert.deepEqual(await client.askRefill(), { ok: false, reason: 'off' })
    assert.equal(await stockOf(store, known.token, clock.now), 0)
  })
}

test('at 0 plays on a listed portal: offered; energy_ad refills to the cap exactly, and GA hears it', async (t) => {
  const sent = withGa(t)
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 0, clock.now)
  const client = await connect(worlds, known.token)
  assert.deepEqual(accountEnergy(client), { stock: 0, cap: 3, nextInMs: 30 * MIN, regenMs: 30 * MIN, adRefill: { offered: true } })
  clock.now += 5 * MIN
  assert.deepEqual(await client.askRefill(), { ok: true })
  assert.equal(await stockOf(store, known.token, clock.now), ENERGY.cap)
  // Plays left now: not offered, and no limit's timer (one only shows at 0).
  assert.deepEqual(client.events('energy'), [{ stock: ENERGY.cap, cap: 3, nextInMs: null, regenMs: 30 * MIN, adRefill: { offered: false } }])
  assert.deepEqual(sent.map((e) => e.name), ['visit_start', 'energy_ad_granted'])
  assert.equal(sent[1].params.portal, 'crazygames')
  // The refilled plays play.
  client.handlers.start_requested({ id: 'abcdef' })
  await settle()
  assert.ok(client.connection.player !== undefined, 'the refilled play did not start a run')
})

test('a guest (no token yet) on CrazyGames: counted as an account once it has one (Q7)', async () => {
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const client = new Client('a', { portal: 'crazygames' })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  // No account until the first READY: nothing to refill.
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'off' })
  client.handlers.start_requested({ id: 'abcdef' })
  await settle()
  const account = client.connection.account as Account
  assert.ok(account.persisted)
  // A start stock is far above 0: offered is false, and the refill is refused as plays left.
  assert.deepEqual((client.events('account')[0] as { energy: { adRefill: unknown } }).energy.adRefill, { offered: false })
})

test('with plays left: not offered, and energy_ad is refused (plays_left) with nothing written, before the store', async (t) => {
  const sent = withGa(t)
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 1, clock.now)
  const client = await connect(worlds, known.token)
  const spy = spyRefills(store)
  assert.deepEqual((accountEnergy(client) as { adRefill: unknown }).adRefill, { offered: false })
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'plays_left' })
  assert.equal(spy.calls, 0, 'the in-memory view refuses; the store was asked')
  assert.equal(await stockOf(store, known.token, clock.now), 1)
  assert.equal((await store.resolve(known.token))?.adRefill, undefined, 'a refused refill was counted')
  // The readout as the connection sees it, as after a store refusal.
  assert.deepEqual((client.events('energy').at(-1) as { stock: number, adRefill: unknown }).adRefill, { offered: false })
  // An in-memory refusal is a client's noise: no GA.
  assert.deepEqual(sent.filter((e) => e.name.startsWith('energy_ad')), [])
})

test('the 30-minute limit: a second refill is refused until 30 min after the first, with the timer', async () => {
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 0, clock.now)
  const client = await connect(worlds, known.token)
  assert.deepEqual(await client.askRefill(), { ok: true })
  // Three runs lost: 0 again, 10 minutes later.
  clock.now += 10 * MIN
  await drainSeen(store, client, known.publicId, clock.now)
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'cooldown' })
  assert.equal(await stockOf(store, known.token, clock.now), 0)
  assert.deepEqual((client.events('energy').at(-1) as { adRefill: unknown }).adRefill, { offered: false, nextInMs: 20 * MIN })
  // Two seconds short of the 30 minutes: still refused, and asked again
  // exactly AD_REQUEST_GAP_MS later, at the 30 minutes: granted.
  clock.now += 20 * MIN - AD_REQUEST_GAP_MS
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'cooldown' })
  assert.deepEqual((client.events('energy').at(-1) as { adRefill: unknown }).adRefill, { offered: false, nextInMs: AD_REQUEST_GAP_MS })
  clock.now += AD_REQUEST_GAP_MS
  assert.deepEqual(await client.askRefill(), { ok: true })
  assert.equal(await stockOf(store, known.token, clock.now), ENERGY.cap)
})

test('three per UTC day: the fourth is refused until UTC midnight, then the day starts again', async () => {
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 0, clock.now)
  const client = await connect(worlds, known.token)
  const drain = async (): Promise<void> => { await drainSeen(store, client, known.publicId, clock.now) }
  for (let i = 0; i < AD_REFILL.perDay; i++) {
    if (i > 0) {
      clock.now += 30 * MIN
      await drain()
    }
    assert.deepEqual(await client.askRefill(), { ok: true }, `refill ${i + 1}`)
  }
  clock.now += 30 * MIN
  await drain()
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'daily_cap' })
  // 11:30 UTC: 12.5 hours to midnight.
  assert.deepEqual((client.events('energy').at(-1) as { adRefill: unknown }).adRefill, { offered: false, nextInMs: 12.5 * 60 * MIN })
  // A minute before midnight (the regenerated plays spent again): still the cap.
  clock.now = Date.parse('2026-11-14T23:59:00.000Z')
  await drain()
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'daily_cap' })
  clock.now = Date.parse('2026-11-15T00:00:00.000Z')
  assert.deepEqual(await client.askRefill(), { ok: true }, 'the new UTC day allowed no refill')
  const stored = (await store.resolve(known.token))?.adRefill
  assert.deepEqual(stored, { lastAtMs: clock.now, day: '2026-11-15', count: 1 })
})

test('spam is free: requests the in-memory view refuses (plays left, cooldown, daily cap) never reach the store; allowed ones do, and the store can still refuse', async (t) => {
  const sent = withGa(t)
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 0, clock.now)
  const client = await connect(worlds, known.token)
  const spy = spyRefills(store)
  const ask = async (): Promise<EnergyAdAnswer | undefined> => {
    clock.now += AD_REQUEST_GAP_MS
    return await client.askRefill()
  }
  assert.deepEqual(await ask(), { ok: true })
  assert.equal(spy.calls, 1)
  // Plays left (the refill's): a burst of requests, none to the store.
  for (let i = 0; i < 20; i++) assert.deepEqual(await ask(), { ok: false, reason: 'plays_left' })
  assert.equal(spy.calls, 1, 'a plays_left refusal reached the store')
  // At 0 inside the cooldown: refused cooldown, none to the store.
  await drainSeen(store, client, known.publicId, clock.now)
  for (let i = 0; i < 20; i++) assert.deepEqual(await ask(), { ok: false, reason: 'cooldown' })
  assert.equal(spy.calls, 1, 'a cooldown refusal reached the store')
  // Two more refills, then the day's cap: none to the store.
  for (let i = 0; i < AD_REFILL.perDay - 1; i++) {
    clock.now += 30 * MIN
    await drainSeen(store, client, known.publicId, clock.now)
    assert.deepEqual(await ask(), { ok: true })
    await drainSeen(store, client, known.publicId, clock.now)
  }
  assert.equal(spy.calls, AD_REFILL.perDay)
  clock.now += 30 * MIN
  await drainSeen(store, client, known.publicId, clock.now)
  for (let i = 0; i < 20; i++) assert.deepEqual(await ask(), { ok: false, reason: 'daily_cap' })
  assert.equal(spy.calls, AD_REFILL.perDay, 'a daily_cap refusal reached the store')
  assert.deepEqual(sent.filter((e) => e.name === 'energy_ad_refused'), [], 'GA heard an in-memory refusal')

  // The view behind the store (another tab of the account refilled): the
  // view allows, so the request reaches the store, which refuses it.
  const other = await accountWith(store, 0, clock.now)
  const tabA = await connect(worlds, other.token)
  const tabB = await connect(worlds, other.token)
  assert.deepEqual(await tabB.askRefill(), { ok: true })
  await drainSeen(store, tabB, other.publicId, clock.now)
  const before = spy.calls
  assert.deepEqual(await tabA.askRefill(), { ok: false, reason: 'cooldown' })
  assert.equal(spy.calls, before + 1, 'a request the view allows did not reach the store')
  assert.deepEqual(sent.filter((e) => e.name === 'energy_ad_refused').map((e) => e.params.reason), ['cooldown'])
})

test('the view ahead of the store (a play spent in another tab): refused plays_left from memory, as the view shows; the next READY corrects it', async () => {
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 1, clock.now)
  const tabA = await connect(worlds, known.token)
  const spy = spyRefills(store)
  assert.equal((await store.spend(known.publicId, clock.now)).ok, true)
  assert.deepEqual(await tabA.askRefill(), { ok: false, reason: 'plays_left' })
  assert.equal(spy.calls, 0)
  tabA.handlers.start_requested({ id: 'abcdef' })
  await settle()
  assert.equal((tabA.connection.account as Account).energy?.stock, 0, 'start_refused did not refresh the view')
  clock.now += AD_REQUEST_GAP_MS
  assert.deepEqual(await tabA.askRefill(), { ok: true })
  assert.equal(spy.calls, 1)
})

test('lobby only: energy_ad in a run (or while a start is in flight) is refused, and a second one in flight is busy', async () => {
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 1, clock.now)
  const client = await connect(worlds, known.token)
  client.handlers.start_requested({ id: 'abcdef' })
  await settle()
  assert.ok(client.connection.started)
  // The run's play took the stock to 0: a refill now would be "in a run".
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'in_run' })
  assert.equal(await stockOf(store, known.token, clock.now), 0)

  const other = await accountWith(store, 0, clock.now)
  const second = await connect(worlds, other.token)
  const answers: unknown[] = []
  second.handlers.energy_ad({}, (a: unknown) => { answers.push(a) })
  second.handlers.energy_ad({}, (a: unknown) => { answers.push(a) })
  await settle()
  assert.deepEqual(answers, [{ ok: false, reason: 'busy' }, { ok: true }])
  // Within AD_REQUEST_GAP_MS of the last: busy, whatever the limits say.
  clock.now += 1000
  assert.deepEqual(await second.askRefill(), { ok: false, reason: 'busy' })
})

test('an offline account (the store failed), or a store without the refill: never offered, never granted', async () => {
  const clock = { now: T0 }
  const failing = new MemoryAccountStore()
  failing.resolve = async () => { throw new Error('connection refused (stub)') }
  const worlds = makeWorlds(failing, clock, ['crazygames'])
  const client = await connect(worlds, 'a'.repeat(43))
  assert.equal(client.connection.account?.persisted, false)
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'off' })

  // A wrapper implementing only `AccountStore`: `adRefillStoreOf` finds no refill.
  const inner = new MemoryAccountStore()
  const plain: AccountStore = {
    resolve: async (token: string): Promise<Account | null> => await inner.resolve(token),
    create: async () => await inner.create(),
    grant: async (publicId: string, xp: number, credit?: SeasonCredit) => await inner.grant(publicId, xp, credit),
    saveLoadout: async (publicId: string, robot: string, index: number, skills: number[]) => { await inner.saveLoadout(publicId, robot, index, skills) },
    season: async (publicId: string, atMs: number): Promise<SeasonView> => await inner.season(publicId, atMs),
    seasonBoard: async (atMs: number, limit: number): Promise<SeasonBoard> => await inner.seasonBoard(atMs, limit),
    payDue: async (nowMs: number): Promise<PaidSeason[]> => await inner.payDue(nowMs),
    spend: async (publicId: string, nowMs: number) => await inner.spend(publicId, nowMs),
    refund: async (publicId: string, nowMs: number): Promise<EnergyRecord> => await inner.refund(publicId, nowMs),
    close: async () => {}
  }
  const known = await accountWith(inner, 0, clock.now)
  const second = await connect(makeWorlds(plain, clock, ['crazygames']), known.token)
  assert.ok(!('adRefill' in (accountEnergy(second) ?? {})))
  assert.deepEqual(await second.askRefill(), { ok: false, reason: 'off' })
  assert.equal(await stockOf(inner, known.token, clock.now), 0)
})

test('a store that fails the refill: refused (error), nothing granted, reported, GA says error', async (t) => {
  const sent = withGa(t)
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 0, clock.now)
  const client = await connect(worlds, known.token)
  store.adRefill = async () => { throw new Error('connection refused (stub)') }
  assert.deepEqual(await client.askRefill(), { ok: false, reason: 'error' })
  assert.equal(reported.length, 1)
  assert.deepEqual(sent.filter((e) => e.name.startsWith('energy_ad')).map((e) => [e.name, e.params.reason]), [['energy_ad_refused', 'error']])
})

test('energy_ad without an acknowledgement (a client that doesn\'t wait) still refills, and throws nothing', async () => {
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store, clock, ['crazygames'])
  const known = await accountWith(store, 0, clock.now)
  const client = await connect(worlds, known.token)
  client.handlers.energy_ad({})
  client.handlers.energy_ad()
  await settle()
  assert.equal(await stockOf(store, known.token, clock.now), ENERGY.cap)
})

test('ad_result: to GA with the portal, only known results, only where offered, at most AD_RESULTS_PER_CONNECTION', async (t) => {
  const sent = withGa(t)
  const clock = { now: T0 }
  const store = new MemoryAccountStore()
  const known = await accountWith(store, 0, clock.now)
  const off = await connect(makeWorlds(store, clock, []), known.token)
  off.handlers.ad_result({ result: 'rewarded' })
  const client = await connect(makeWorlds(store, clock, ['crazygames']), known.token)
  for (const result of ['rewarded', 'unavailable', 'adblock', 'failed', 'bogus', 42]) client.handlers.ad_result({ result })
  client.handlers.ad_result(null)
  const results = (): Array<Record<string, unknown>> => sent.filter((e) => e.name === 'ad_result').map((e) => e.params)
  assert.deepEqual(results().map((p) => [p.result, p.portal]), [['rewarded', 'crazygames'], ['unavailable', 'crazygames'], ['adblock', 'crazygames'], ['failed', 'crazygames']])
  for (let i = 0; i < AD_RESULTS_PER_CONNECTION * 2; i++) client.handlers.ad_result({ result: 'unavailable' })
  assert.equal(results().length, AD_RESULTS_PER_CONNECTION)
})
