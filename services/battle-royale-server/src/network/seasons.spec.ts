import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import Player from '../objects/player'
import { MemoryAccountStore } from '../db/accounts'
import { type SeasonCredit, seasonStart, type SeasonView, seasonView } from '../progress/seasons'
import { lastNotice, onSeason, resetsIn, SEEN_KEY, seasonLine } from '../../../../plunder-land-client/src/net/season'

/**
 * Weekly seasons through `Worlds` (decision #48 step 6): the season credit
 * rides on the run's one grant, so it lands once per run whatever ends it,
 * never for an offline run or a bot; the `season` event follows `account` and
 * `progress`; a run counts in the season of its end. The pure half is
 * progress/seasons.spec.ts, the stores' half db/storecontract.ts.
 */

void Multiplayer

let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
let reported: unknown[] = []

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

/** The memory store, recording every credit that reached it; able to fail. */
class SeasonStore extends MemoryAccountStore {
  credits: Array<[string, SeasonCredit | undefined]> = []
  down = false
  grantFails = false

  async resolve (token: string): ReturnType<MemoryAccountStore['resolve']> {
    if (this.down) throw new Error('connection refused (stub)')
    return await super.resolve(token)
  }

  async create (): ReturnType<MemoryAccountStore['create']> {
    if (this.down) throw new Error('connection refused (stub)')
    return await super.create()
  }

  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> {
    if (this.grantFails) throw new Error('connection refused (stub)')
    this.credits.push([publicId, credit])
    return await super.grant(publicId, xp, credit)
  }
}

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

  start (name: unknown = this.id): void {
    this.handlers.start_requested({ id: 'abcdef', name })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }

  /** The text events in order (frames left out). */
  get names (): string[] {
    return this.emitted.map(([event]) => event).filter((e) => e !== 'frame')
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Wednesday 2026-10-07 12:00 UTC, in the season of 2026-10-05. */
const WEDNESDAY = Date.parse('2026-10-07T12:00:00.000Z')

function makeWorlds (store: SeasonStore, clock: { now: number }, bots?: number): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => clock.now, accounts: store, bots })
}

/** A human in a run, with nothing in its world to end the run by accident. */
async function inRun (worlds: Worlds, client: Client, name?: unknown): Promise<{ player: Player, world: World }> {
  if (client.connection === undefined) client.connection = worlds.onConnection(client.socket)
  client.start(name)
  await settle()
  const player = client.connection.player
  assert.ok(player !== undefined, 'the run did not start')
  const world = worlds.worldFor(client.connection) as World
  World.run(world, () => {
    World.MOBS.length = 0
    World.OBSTACLES.length = 0
  })
  return { player, world }
}

async function extract (worlds: Worlds, world: World, player: Player, loot: number): Promise<void> {
  World.run(world, () => {
    player.addLoot(loot)
    player.exit()
  })
  worlds.tickAll(250)
  await settle()
}

async function view (store: SeasonStore, publicId: string, at: number): Promise<SeasonView> {
  return await store.season(publicId, at)
}

test('an extraction credits its capped banked loot, a run, an extraction and the run\'s XP, under the sanitised name', async () => {
  const store = new SeasonStore()
  const clock = { now: WEDNESDAY }
  const worlds = makeWorlds(store, clock)
  const client = new Client('a')
  const raw = '  <b>Zoë​</b>  '
  const { player, world } = await inRun(worlds, client, raw)
  await extract(worlds, world, player, 7500)
  assert.equal(store.credits.length, 1)
  const [id, credit] = store.credits[0]
  assert.equal(id, player.playerId)
  assert.equal(credit?.banked, 6000, 'the 6,000 cap')
  assert.equal(credit?.extracted, true)
  assert.equal(credit?.season, '2026-10-05')
  assert.equal(credit?.atMs, WEDNESDAY)
  assert.equal(credit?.name, Player.displayName(raw, player.playerId))
  assert.equal(credit?.name, player.name)
  assert.ok(credit !== undefined && !/[<>​]/.test(credit.name) && credit.name !== raw, `a raw name stored: ${JSON.stringify(credit?.name)}`)
  const v = await view(store, player.playerId, WEDNESDAY)
  assert.deepEqual([v.banked, v.runs, v.extractions, v.xp > 0], [6000, 1, 1, true])

  // A name that sanitises to nothing is stored as the id's callsign.
  const next = await inRun(worlds, client, '​​')
  await extract(worlds, next.world, next.player, 10)
  assert.equal(store.credits[1][1]?.name, Player.callsign(next.player.playerId))
})

test('a death and a disconnect credit a run with nothing banked; an end reported twice credits once', async () => {
  const store = new SeasonStore()
  const clock = { now: WEDNESDAY }
  const worlds = makeWorlds(store, clock)
  const client = new Client('a')
  const run1 = await inRun(worlds, client)
  World.run(run1.world, () => {
    run1.player.addLoot(4000)
    assert.equal(run1.player.hit(1e6), true)
  })
  worlds.tickAll(250)
  await settle()
  const run2 = await inRun(worlds, client)
  World.run(run2.world, () => { run2.player.exit() })
  // Before the flush: the disconnect destroys the exited player again.
  client.socket.conn.close()
  await settle()
  const other = new Client('b')
  const run3 = await inRun(worlds, other)
  World.run(run3.world, () => { run3.player.addLoot(900) })
  other.socket.conn.close()
  await settle()
  assert.deepEqual(store.credits.map(([, c]) => [c?.banked, c?.extracted]), [[0, false], [0, true], [0, false]])
  const v = await view(store, run1.player.playerId, WEDNESDAY)
  assert.deepEqual([v.banked, v.runs, v.extractions], [0, 2, 1])
  assert.equal((await view(store, run3.player.playerId, WEDNESDAY)).runs, 1)
})

test('a drain\'s cut-off (closeAll) credits each live run once', async () => {
  const store = new SeasonStore()
  const worlds = makeWorlds(store, { now: WEDNESDAY })
  const a = new Client('a')
  const b = new Client('b')
  const ra = await inRun(worlds, a)
  const rb = await inRun(worlds, b)
  worlds.drain()
  worlds.closeAll()
  await settle()
  worlds.tickAll(250)
  await settle()
  assert.deepEqual(store.credits.map(([id]) => id).sort(), [ra.player.playerId, rb.player.playerId].sort())
})

test('offline writes nothing: an offline run makes no entry, and a failed grant leaves neither XP nor entry', async () => {
  const store = new SeasonStore()
  store.down = true
  const worlds = makeWorlds(store, { now: WEDNESDAY })
  const client = new Client('a')
  const run = await inRun(worlds, client)
  assert.equal(client.connection.account?.persisted, false)
  await extract(worlds, run.world, run.player, 3000)
  assert.deepEqual(store.credits, [])
  assert.deepEqual(client.events('season'), [], 'a season event for an offline account')
  assert.equal((await store.seasonBoard(WEDNESDAY, 10)).ranked, 0)

  const failing = new SeasonStore()
  const worlds2 = makeWorlds(failing, { now: WEDNESDAY })
  const c2 = new Client('b')
  const r2 = await inRun(worlds2, c2)
  failing.grantFails = true
  await extract(worlds2, r2.world, r2.player, 3000)
  const v = await view(failing, r2.player.playerId, WEDNESDAY)
  assert.deepEqual([v.runs, v.banked, v.xp], [0, 0, 0])
  assert.equal((await failing.resolve((c2.events('account')[0] as { token: string }).token))?.xp, 0)
  assert.ok(reported.length > 0, 'the failed grant was not reported')
})

test('bots never appear: minutes of play with 8 bots credit only the human; the board and ranked exclude bots', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new SeasonStore()
  const worlds = makeWorlds(store, { now: WEDNESDAY }, 8)
  const client = new Client('human')
  client.connection = worlds.onConnection(client.socket)
  for (let run = 0; run < 3; run++) {
    client.start()
    await settle()
    const world = worlds.worldFor(client.connection) as World
    const human = client.connection.player as Player
    // No mobs or exits, and a human the bots can't kill in 40 s (they fought
    // it to death in about 1 run in 5, leaving it unranked): the human's run
    // lasts, so the world keeps its bots.
    World.run(world, () => {
      World.MOBS.length = 0
      World.OBSTACLES.length = 0
      human.maxHp = 60000
      human.hp = 60000
    })
    for (let i = 0; i < 160; i++) { t.mock.timers.tick(250); worlds.tickAll(250) }
    // Some bots end their runs, both ways, every round.
    const bots = World.run(world, () => World.PLAYERS.filter((p) => p.bot !== undefined && !p.destroyed && !p.exited))
    assert.ok(bots.length >= 2, `round ${run}: only ${bots.length} bots, human ${human.destroyed ? 'dead' : human.exited ? 'out' : 'in'}`)
    World.run(world, () => {
      bots[0].addLoot(5000)
      bots[0].exit()
      bots[1].hit(1e6)
      if (!human.destroyed && !human.exited) {
        human.addLoot(500)
        human.exit()
      }
    })
    for (let i = 0; i < 8; i++) { t.mock.timers.tick(250); worlds.tickAll(250) }
    await settle()
  }
  const humanId = client.connection.account?.publicId as string
  assert.equal(store.credits.length, 3, 'the human\'s three runs')
  for (const [id] of store.credits) assert.equal(id, humanId, `a credit to ${id}`)
  const board = await store.seasonBoard(WEDNESDAY, 10)
  assert.deepEqual(board.top.map((row) => [row.id, row.name]), [[humanId, 'human']], `the board: ${JSON.stringify(board.top)}`)
  assert.equal(board.ranked, 1, 'ranked counts a bot')
  const v = await view(store, humanId, WEDNESDAY)
  assert.equal(v.ranked, board.ranked)
})

test('the season event follows account on connect and progress after a grant; none to a closed socket', async () => {
  const store = new SeasonStore()
  const worlds = makeWorlds(store, { now: WEDNESDAY })
  const first = new Client('a')
  const run = await inRun(worlds, first)
  // A creation: account, then season (runs 0).
  assert.deepEqual(first.names.filter((e) => e === 'account' || e === 'season').slice(0, 2), ['account', 'season'])
  assert.equal((first.events('season')[0] as SeasonView).runs, 0)
  await extract(worlds, run.world, run.player, 800)
  const names = first.names
  assert.ok(names.lastIndexOf('season') > names.lastIndexOf('progress'), `order: ${names.join(',')}`)
  const after = first.events('season').at(-1) as SeasonView
  assert.deepEqual([after.runs, after.extractions, after.banked, after.minRuns, after.minExtractions, after.rank], [1, 1, 800, 3, 1, null])

  // A known token on a new connection: account, then season with the run counted.
  const token = (first.events('account')[0] as { token: string }).token
  const again = new Client('a2', { token })
  again.connection = worlds.onConnection(again.socket)
  await settle()
  assert.deepEqual(again.names.filter((e) => e === 'account' || e === 'season'), ['account', 'season'])
  assert.equal((again.events('season')[0] as SeasonView).runs, 1)

  // A run ended by its disconnect: the grant lands, nothing goes to the closed socket.
  const r2 = await inRun(worlds, again)
  const before = again.emitted.length
  again.socket.conn.close()
  await settle()
  assert.equal(again.emitted.length, before, 'something was sent to a closed socket')
  assert.equal((await view(store, r2.player.playerId, WEDNESDAY)).runs, 2)
})

test('a run ending either side of Monday 00:00 UTC lands in that season', async () => {
  const store = new SeasonStore()
  const clock = { now: Date.parse('2026-10-11T23:59:59.999Z') }
  const worlds = makeWorlds(store, clock)
  const client = new Client('a')
  const r1 = await inRun(worlds, client)
  await extract(worlds, r1.world, r1.player, 100)
  // Started on Sunday, ended on Monday: the new season.
  const r2 = await inRun(worlds, client)
  clock.now = Date.parse('2026-10-12T00:00:00.000Z')
  await extract(worlds, r2.world, r2.player, 200)
  assert.deepEqual(store.credits.map(([, c]) => c?.season), ['2026-10-05', '2026-10-12'])
  assert.equal((await view(store, r1.player.playerId, Date.parse('2026-10-11T12:00:00.000Z'))).banked, 100)
  assert.equal((await view(store, r1.player.playerId, clock.now)).banked, 200)
  assert.equal(seasonStart(clock.now), '2026-10-12')
})

// --- the client half (plunder-land-client/src/net/season.ts) -------------------------

const D = 86_400_000
const H = 3_600_000
const M = 60_000
const DOT = ' · '

/** A view as the server builds it, 2 days 4 hours 30 minutes before its end. */
function serverView (entry: { banked: number, runs: number, extractions: number, xp: number } | undefined, ranked: number, rank: number | null, last?: SeasonView['last']): SeasonView {
  return seasonView('2026-10-05', Date.parse('2026-10-12T00:00:00.000Z') - (2 * D + 4 * H + 30 * M), entry, ranked, rank, last)
}

function line (...parts: string[]): string {
  return parts.join(DOT)
}

test('client: onSeason takes what the server sends and rejects anything malformed', () => {
  const good = serverView({ banked: 900, runs: 4, extractions: 2, xp: 200 }, 37, 4, { start: '2026-09-28', rank: 3, ranked: 41, tier: 10, xp: 500 })
  const wire = JSON.parse(JSON.stringify(good))
  assert.deepEqual(onSeason(wire), good)
  assert.deepEqual(onSeason(JSON.parse(JSON.stringify(serverView(undefined, 0, null)))), serverView(undefined, 0, null))
  const bad: Array<Record<string, unknown>> = [
    { start: '2026-10-5' },
    { start: 20261005 },
    { endsInMs: -1 },
    { banked: 1.5 },
    { runs: '3' },
    { ranked: Number.MAX_SAFE_INTEGER + 2 },
    { rank: 0 },
    { rank: 38 },
    { tier: 5 },
    { rank: null, tier: 25 },
    { payout: undefined },
    { minRuns: null },
    { last: { start: '2026-09-28', rank: 42, ranked: 41, tier: 10, xp: 500 } },
    { last: { start: '2026-09-28', rank: 3, ranked: 41, tier: null, xp: 500 } },
    { last: { start: '2026-09-28', rank: 3, ranked: 41, tier: 10, xp: 0 } },
    { last: 'x' }
  ]
  for (const change of bad) assert.equal(onSeason({ ...wire, ...change }), undefined, JSON.stringify(change))
  for (const junk of [null, undefined, 'season', 7, []]) assert.equal(onSeason(junk), undefined)
})

test('client: the season line in each state, and the countdown', () => {
  assert.equal(seasonLine(serverView({ banked: 300, runs: 1, extractions: 0, xp: 30 }, 37, null), 0), line('SEASON', '2 RUNS + 1 EXTRACTION TO RANK', 'RESETS IN 2D 4H'))
  assert.equal(seasonLine(serverView(undefined, 0, null), 0), line('SEASON', '3 RUNS + 1 EXTRACTION TO RANK', 'RESETS IN 2D 4H'))
  assert.equal(seasonLine(serverView({ banked: 300, runs: 2, extractions: 1, xp: 30 }, 37, null), 0), line('SEASON', '1 RUN TO RANK', 'RESETS IN 2D 4H'))
  assert.equal(seasonLine(serverView({ banked: 0, runs: 5, extractions: 0, xp: 30 }, 37, null), 0), line('SEASON', '1 EXTRACTION TO RANK', 'RESETS IN 2D 4H'))
  assert.equal(seasonLine(serverView({ banked: 0, runs: 5, extractions: 2, xp: 30 }, 37, null), 0), line('SEASON', 'BANK LOOT TO RANK', 'RESETS IN 2D 4H'))
  assert.equal(seasonLine(serverView({ banked: 900, runs: 4, extractions: 2, xp: 900 }, 37, 4), 0), line('SEASON', '#4 OF 37', 'TOP 25% +250 XP', 'RESETS IN 2D 4H'))
  assert.equal(seasonLine(serverView({ banked: 900, runs: 4, extractions: 2, xp: 120 }, 37, 4), 0), line('SEASON', '#4 OF 37', 'TOP 25% +120 XP', 'RESETS IN 2D 4H'), 'the projected payout is capped')
  assert.equal(seasonLine(serverView({ banked: 9, runs: 4, extractions: 2, xp: 900 }, 37, 30), 0), line('SEASON', '#30 OF 37', 'RESETS IN 2D 4H'))
  assert.equal(line('SEASON', '#30 OF 37', 'RESETS IN 2D 4H'), 'SEASON · #30 OF 37 · RESETS IN 2D 4H')
  // The countdown runs from when the view arrived.
  assert.equal(seasonLine(serverView(undefined, 0, null), 5 * H), line('SEASON', '3 RUNS + 1 EXTRACTION TO RANK', 'RESETS IN 1D 23H'))
  assert.equal(resetsIn(D), '1D 0H')
  assert.equal(resetsIn(D - 1), '23H 59M')
  assert.equal(resetsIn(5 * H + 12 * M), '5H 12M')
  assert.equal(resetsIn(H), '1H 0M')
  assert.equal(resetsIn(H - 1), '59M')
  assert.equal(resetsIn(12 * M + 59_999), '12M')
  assert.equal(resetsIn(M), '1M')
  assert.equal(resetsIn(M - 1), '<1M')
  assert.equal(resetsIn(-5), '<1M')
})

test('client: the last payout\'s notice shows once per season, and survives a throwing storage', () => {
  const kept = new Map<string, string>()
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v) } }
  const view = serverView(undefined, 0, null, { start: '2026-09-28', rank: 3, ranked: 41, tier: 10, xp: 500 })
  const notice = line('LAST SEASON', '#3 OF 41', 'TOP 10%', '+500 XP')
  assert.equal(lastNotice(view, storage), notice)
  assert.equal(kept.get(SEEN_KEY), '2026-09-28')
  assert.equal(lastNotice(view, storage), undefined, 'shown twice')
  const later = serverView(undefined, 0, null, { start: '2026-10-05', rank: 1, ranked: 2, tier: 1, xp: 90 })
  assert.equal(lastNotice(later, storage), line('LAST SEASON', '#1 OF 2', 'TOP 1%', '+90 XP'))
  assert.equal(lastNotice(serverView(undefined, 0, null), storage), undefined, 'a notice with no payout')
  const throwing = { getItem: (): string | null => { throw new Error('blocked') }, setItem: (): void => { throw new Error('blocked') } }
  assert.equal(lastNotice(view, throwing), notice)
  assert.equal(lastNotice(view, undefined), notice)
})
