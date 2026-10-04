import test, { afterEach, beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import { ObjectType } from '../objects/gameobject'
import type Player from '../objects/player'
import Analytics from '../analytics'
import { type Account, type AccountStore, MemoryAccountStore } from '../db/accounts'
import type { EnergyRecord } from '../progress/energy'
import type { PaidSeason, SeasonBoard, SeasonCredit, SeasonView } from '../progress/seasons'
import { runXp, standingOf } from '../progress/xp'
import { earnedXp } from '../progress/run'
import { applyProgress, onAccount, onProgress, PROGRESS_WAIT_MS, setAccountInfo, ACCOUNT, standingOf as clientStanding, xpLine } from '../../../../plunder-land-client/src/net/account'

/**
 * XP at each run's end (decision #48 step 3), through `Worlds` as in
 * production: granted once per run whatever ends it (a death, an extraction,
 * a disconnect, a drain's cut-off), only to a persisted account, never to an
 * offline run or a bot; `progress` to the client; `run_end` carries
 * `xp_gained`. The formula itself is pinned in progress/xp.spec.ts.
 */

let failures: unknown[] = []
let reported: unknown[] = []
let savedLog: ThrottledLog
const savedReport = Worlds.accountReport

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  failures = []
  reported = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), (...args) => { failures.push(args) })
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
        write: (data: unknown) => { this.emitted.push(['frame', data]) },
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

/** The memory store, counting grants, able to fail or hold them. */
class GrantStore implements AccountStore {
  readonly inner = new MemoryAccountStore()
  grants: Array<[string, number]> = []
  mode: 'ok' | 'throw' | 'hang' = 'ok'
  /** Fail lookups and creations (an offline account). */
  down = false
  gate: Promise<void> | undefined

  async resolve (token: string): Promise<Account | null> {
    if (this.down) throw new Error('connection refused (stub)')
    return await this.inner.resolve(token)
  }

  async create (): Promise<{ account: Account, token: string }> {
    if (this.down) throw new Error('connection refused (stub)')
    return await this.inner.create()
  }

  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> {
    this.grants.push([publicId, xp])
    if (this.gate !== undefined) await this.gate
    if (this.mode === 'hang') return await new Promise(() => {})
    if (this.mode === 'throw') throw new Error('connection refused (stub)')
    return await this.inner.grant(publicId, xp, credit)
  }

  async saveLoadout (publicId: string, robot: string, index: number, skills: number[]): Promise<void> { await this.inner.saveLoadout(publicId, robot, index, skills) }
  async season (publicId: string, atMs: number): Promise<SeasonView> { return await this.inner.season(publicId, atMs) }
  async seasonBoard (atMs: number, limit: number): Promise<SeasonBoard> { return await this.inner.seasonBoard(atMs, limit) }
  async payDue (nowMs: number): Promise<PaidSeason[]> { return await this.inner.payDue(nowMs) }
  async spend (publicId: string, nowMs: number): Promise<{ ok: boolean, energy: EnergyRecord }> { return await this.inner.spend(publicId, nowMs) }
  async refund (publicId: string, nowMs: number): Promise<EnergyRecord> { return await this.inner.refund(publicId, nowMs) }
  async close (): Promise<void> {}
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function makeWorlds (store: AccountStore, options: { bots?: number, timeoutMs?: number } = {}): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => Date.now(), accounts: store, accountTimeoutMs: options.timeoutMs, bots: options.bots })
}

/** A human in a run, on an account, with nothing in its world to end the run by accident. */
async function inRun (worlds: Worlds, name = 'a', auth?: unknown): Promise<{ client: Client, player: Player, world: World }> {
  const client = new Client(name, auth)
  client.connection = worlds.onConnection(client.socket)
  client.start()
  await settle()
  const player = client.connection.player
  assert.ok(player !== undefined, 'the run did not start')
  const world = worlds.worldFor(client.connection) as World
  // No mobs, portals or exits: nothing ends or moves this run but the test.
  World.run(world, () => {
    World.MOBS.length = 0
    World.OBSTACLES.length = 0
  })
  return { client, player, world }
}

/** Credit `player` with kills of the given kinds, as `Player.onKill` is called. */
function credit (world: World, player: Player, kills: { player?: number, grunt?: number, gunner?: number, boss?: number }): void {
  World.run(world, () => {
    for (let i = 0; i < (kills.player ?? 0); i++) player.onKill({ type: ObjectType.Player } as never)
    for (const key of ['grunt', 'gunner', 'boss'] as const) {
      for (let i = 0; i < (kills[key] ?? 0); i++) player.onKill({ type: ObjectType.Mob, archetype: { key, killStats: [] } } as never)
    }
  })
}

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

// --- one grant per run, whatever ends it ---------------------------------------

test('an extraction: one grant of the formula\'s XP, progress to the client, xp_gained in run_end', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const sent = withGa(t)
  const store = new GrantStore()
  const worlds = makeWorlds(store)
  const { client, player, world } = await inRun(worlds)
  credit(world, player, { player: 1, grunt: 3, boss: 1 })
  World.run(world, () => {
    player.addLoot(1000)
    player.deepestTag = World.TAGS[1] // reached layer 02, back on 01 now
  })
  t.mock.timers.tick(125_000)
  World.run(world, () => { player.exit() })
  worlds.tickAll(250)
  await settle()

  // 40 loot + (10 + min(20, 6 + 10)) kills + 15 depth + 12 time = 93, x1.5 = 140 (139.5 rounded).
  const expected = runXp({ extracted: true, loot: 1000, playerKills: 1, mobKills: { grunt: 3, boss: 1 }, deepestLayer: 2, seconds: 125 })
  assert.equal(expected, 140)
  assert.deepEqual(store.grants, [[player.playerId, 140]])
  const progress = client.events('progress')
  assert.deepEqual(progress, [{ gained: 140, xp: 140, level: 2, levelAt: 40, nextAt: 220, levelUp: true }])
  assert.equal(client.connection.account?.xp, 140)
  const runEnd = sent.find((e) => e.name === 'run_end')
  assert.equal(runEnd?.params.xp_gained, 140)
  assert.equal(runEnd?.params.outcome, 'extracted')

  // The next run's card: a second extraction adds to the total, no level up.
  await settle()
  client.start()
  await settle()
  const next = client.connection.player as Player
  assert.notEqual(next, player)
  World.run(worlds.worldFor(client.connection) as World, () => { next.exit() })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.grants.length, 2)
  assert.deepEqual(client.events('progress')[1], { gained: 0, xp: 140, level: 2, levelAt: 40, nextAt: 220, levelUp: false })
})

test('a death: one grant (half of kills + depth + time, at least 5), progress sent, no loot XP', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const sent = withGa(t)
  const store = new GrantStore()
  const worlds = makeWorlds(store)
  const { client, player, world } = await inRun(worlds)
  credit(world, player, { grunt: 2 })
  World.run(world, () => { player.addLoot(4000) })
  t.mock.timers.tick(200_000)
  World.run(world, () => { assert.equal(player.hit(1e6), true) })
  worlds.tickAll(250)
  await settle()
  // floor((4 + 0 + 20) / 2) = 12; the loot is lost.
  assert.deepEqual(store.grants, [[player.playerId, 12]])
  assert.deepEqual(client.events('progress'), [{ gained: 12, ...standingOf(12), levelUp: false }])
  assert.equal(sent.find((e) => e.name === 'run_end')?.params.xp_gained, 12)
})

test('a disconnect mid-run: one grant, as a death; nothing is sent to the closed socket', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new GrantStore()
  const worlds = makeWorlds(store)
  const { client, player } = await inRun(worlds)
  t.mock.timers.tick(30_000)
  client.socket.conn.close()
  await settle()
  assert.deepEqual(store.grants, [[player.playerId, 5]])
  assert.deepEqual(client.events('progress'), [])
  worlds.tickAll(250)
  await settle()
  assert.equal(store.grants.length, 1)
})

test('a drain\'s cut-off (closeAll): every live run is granted once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new GrantStore()
  const worlds = makeWorlds(store)
  const a = await inRun(worlds, 'a')
  const b = await inRun(worlds, 'b')
  t.mock.timers.tick(60_000)
  worlds.drain()
  worlds.tickAll(250)
  assert.equal(store.grants.length, 0, 'a drain alone ended a run')
  worlds.closeAll()
  await settle()
  assert.deepEqual(store.grants.map(([id]) => id).sort(), [a.player.playerId, b.player.playerId].sort())
  // Left after 60 s: floor(6 / 2) = 3, so the floor of 5.
  for (const [, xp] of store.grants) assert.equal(xp, 5)
  worlds.tickAll(250)
  await settle()
  assert.equal(store.grants.length, 2)
})

test('a run whose end is reported twice (an extraction, then a disconnect before the flush) is granted once', async () => {
  const store = new GrantStore()
  const worlds = makeWorlds(store)
  const { client, player, world } = await inRun(worlds)
  World.run(world, () => { player.exit() })
  // Before the flush lets the exited player go: the disconnect destroys it again.
  assert.equal(client.connection.player, player)
  client.socket.conn.close()
  await settle()
  assert.equal(store.grants.length, 1)
})

// --- offline runs and bots earn nothing ------------------------------------------

test('an offline run earns nothing: no grant, no progress, xp_gained 0', async (t) => {
  const sent = withGa(t)
  const store = new GrantStore()
  store.down = true
  const worlds = makeWorlds(store)
  const { client, player, world } = await inRun(worlds)
  assert.equal(client.connection.account?.persisted, false)
  credit(world, player, { player: 2 })
  World.run(world, () => {
    player.addLoot(3000)
    player.exit()
  })
  worlds.tickAll(250)
  await settle()
  assert.deepEqual(store.grants, [])
  assert.deepEqual(client.events('progress'), [])
  const runEnd = sent.find((e) => e.name === 'run_end')
  assert.equal(runEnd?.params.xp_gained, 0)
  assert.equal(runEnd?.params.offline, 1)
  assert.equal(earnedXp(player, true, 100, 3), 0)
})

test('bots earn nothing: only the human\'s runs are granted, whatever the bots do', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new GrantStore()
  const worlds = makeWorlds(store, { bots: 4 })
  const client = new Client('human')
  client.connection = worlds.onConnection(client.socket)
  client.start()
  await settle()
  const world = worlds.worlds[0]
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); worlds.tickAll(250) }
  const bots = World.run(world, () => World.PLAYERS.filter((p) => p.bot !== undefined && !p.destroyed && !p.exited))
  assert.ok(bots.length >= 2, `only ${bots.length} bots`)
  World.run(world, () => {
    bots[0].addLoot(2000)
    bots[0].exit()
    bots[1].hit(1e6)
  })
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(250); worlds.tickAll(250) }
  await settle()
  assert.equal(bots[0].exited, true)
  assert.equal(bots[1].destroyed, true)
  const humanId = client.connection.account?.publicId
  for (const [id] of store.grants) assert.equal(id, humanId, `a grant to ${id}`)
  assert.equal(earnedXp(bots[0], false, 300, 3), 0, 'a bot earned XP')
})

// --- the grant failing ---------------------------------------------------------------

test('a failed grant is logged and reported, no progress is sent, and it is not carried into the next run', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new GrantStore()
  store.mode = 'throw'
  const worlds = makeWorlds(store)
  const { client, player, world } = await inRun(worlds)
  t.mock.timers.tick(100_000)
  World.run(world, () => { player.exit() })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.grants.length, 1)
  assert.deepEqual(client.events('progress'), [])
  assert.ok(failures.length > 0, 'not logged')
  assert.equal(reported.length, 1, 'not reported')

  store.mode = 'ok'
  client.start()
  await settle()
  const next = client.connection.player as Player
  World.run(worlds.worldFor(client.connection) as World, () => { next.exit() })
  worlds.tickAll(250)
  await settle()
  assert.deepEqual(store.grants.map(([, xp]) => xp), [15, 0], 'the failed run\'s XP was added to the next')
  assert.deepEqual(client.events('progress'), [{ gained: 0, ...standingOf(0), levelUp: false }])
})

test('a grant that never answers times out: logged, no progress', async () => {
  const store = new GrantStore()
  store.mode = 'hang'
  const worlds = makeWorlds(store, { timeoutMs: 30 })
  const { client, player, world } = await inRun(worlds)
  World.run(world, () => { player.exit() })
  worlds.tickAll(250)
  await new Promise((resolve) => setTimeout(resolve, 60))
  await settle()
  assert.deepEqual(client.events('progress'), [])
  assert.ok(failures.length > 0)
})

test('progress is never sent after the next run began: that card is gone, and account carries the new standing instead', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new GrantStore()
  let release!: () => void
  store.gate = new Promise((resolve) => { release = resolve })
  const worlds = makeWorlds(store)
  const { client, player, world } = await inRun(worlds)
  t.mock.timers.tick(100_000)
  World.run(world, () => { player.exit() })
  worlds.tickAll(250)
  await settle()
  client.start()
  await settle()
  assert.notEqual(client.connection.player, player)
  const accountsBefore = client.events('account').length
  release()
  await settle()
  assert.deepEqual(client.events('progress'), [])
  assert.equal(client.connection.account?.xp, 15)
  // The lobby's standing doesn't go stale: one `account` with the new
  // standing (extracted after 100 s: 10 time XP x 1.5 = 15), no token, sent
  // mid-run.
  const accounts = client.events('account')
  assert.equal(accounts.length, accountsBefore + 1, 'no account with the new standing')
  assert.deepEqual(accounts.at(-1), { id: player.playerId, ...standingOf(15) })
  const order = client.emitted.map(([event]) => event)
  assert.ok(order.lastIndexOf('account') > order.lastIndexOf('hello'), 'expected mid-run, after the next run\'s hello')
  // The client takes it as a standing update only: same id, nothing stored.
  const writes: string[] = []
  const info = onAccount(accounts.at(-1), { getItem: () => null, setItem: (key) => { writes.push(key) } })
  assert.deepEqual(info, { id: player.playerId, offline: false, standing: { xp: 15, level: 1, levelAt: 0, nextAt: 40 }, loadouts: undefined })
  assert.deepEqual(writes, [], 'a mid-run account stored something')
})

test('progress that lands before the run\'s own flush (a death from a socket handler) is still sent', async () => {
  const store = new GrantStore()
  const worlds = makeWorlds(store)
  const { client, player, world } = await inRun(worlds)
  World.run(world, () => { player.hit(1e6) })
  await settle()
  assert.equal(client.events('progress').length, 1)
})

// --- the client half (plunder-land-client/src/net/account.ts) ------------------

test('client: progress and standing are read only when whole and consistent; the card\'s line', () => {
  const good = { gained: 87, xp: 87, level: 2, levelAt: 40, nextAt: 220, levelUp: true }
  assert.deepEqual(onProgress(good), good)
  assert.equal(onProgress({ ...good, levelUp: 'yes' })?.levelUp, false)
  for (const bad of [null, 5, {}, { ...good, xp: -1 }, { ...good, gained: 88 }, { ...good, level: 0 }, { ...good, nextAt: 87 }, { ...good, levelAt: 88 }, { ...good, xp: 1.5 }, { ...good, gained: '87' }]) {
    assert.equal(onProgress(bad), undefined, JSON.stringify(bad))
  }
  assert.equal(clientStanding({ id: 'x' }), undefined, 'an account from a server before XP')

  assert.deepEqual(xpLine(undefined, false, false), ['...', 'pending'])
  assert.deepEqual(xpLine(undefined, true, false), ['UNAVAILABLE', 'muted'])
  assert.deepEqual(xpLine(undefined, false, true), ['UNAVAILABLE', 'muted'], 'an offline run waits for nothing')
  assert.deepEqual(xpLine(good, false, false), ['+87  LEVEL UP 2', 'accent'])
  assert.deepEqual(xpLine({ ...good, levelUp: false }, true, false), ['+87  LV 2', 'text'])
  assert.ok(PROGRESS_WAIT_MS >= 3000, 'the card gives up before a slow grant could land')
})

test('client: the account\'s standing follows progress, and listeners hear of it; offline has none', () => {
  let heard = 0
  const listener = (): void => { heard++ }
  ACCOUNT.listeners.add(listener)
  try {
    setAccountInfo(onAccount({ id: 'a', xp: 30, level: 1, levelAt: 0, nextAt: 40 }, undefined))
    assert.deepEqual(ACCOUNT.info?.standing, { xp: 30, level: 1, levelAt: 0, nextAt: 40 })
    applyProgress({ gained: 12, xp: 42, level: 2, levelAt: 40, nextAt: 220, levelUp: true })
    assert.deepEqual(ACCOUNT.info?.standing, { xp: 42, level: 2, levelAt: 40, nextAt: 220 })
    assert.equal(heard, 2)
    setAccountInfo(onAccount({ id: 'b', offline: true, xp: 99, level: 3, levelAt: 0, nextAt: 9999 }, undefined))
    assert.equal(ACCOUNT.info?.standing, undefined, 'an offline account showed a level')
    applyProgress({ gained: 12, xp: 42, level: 2, levelAt: 40, nextAt: 220, levelUp: true })
    assert.equal(ACCOUNT.info?.standing, undefined)
    setAccountInfo(undefined)
  } finally {
    ACCOUNT.listeners.delete(listener)
  }
})

test('the account event carries the standing of a known account', async () => {
  const store = new GrantStore()
  const known = await store.inner.create()
  await store.inner.grant(known.account.publicId, 600)
  const worlds = makeWorlds(store)
  const client = new Client('a', { token: known.token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  assert.deepEqual(client.events('account'), [{ id: known.account.publicId, xp: 600, level: 4, levelAt: 540, nextAt: 1000, loadouts: { peep: [[1, 2, 3, 0]], periscope: [[1, 2, 3, 0]], magnet: [[1, 2, 3, 0]], hopper: [[1, 2, 3, 0]], waddle: [[1, 2, 3, 0]] }, energy: { stock: 6, cap: 3, nextInMs: null, regenMs: 1_800_000 } }])
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
