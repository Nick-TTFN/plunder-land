import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  type AccountStore, GEAR_SOURCE, type GearStore, type MergeRule, newToken, PUBLIC_ID_SHAPE, RECONCILE_AFTER_MS, ROW_ID_SHAPE,
  STALE_CARRY_MS, type StashEdits, type StashItem, TOKEN_SHAPE
} from './accounts'
// The merge rule draws through `rollGear` (archetypes), whose import graph
// only loads in index.ts's order: enter it through multiplayer, as the world
// specs do, or a class extends an undefined base.
import '../network/multiplayer'
import { mergeOutcome } from '../gear/merge'
import { PAYOUT_DELAY_MS, type SeasonCredit, seasonEndMs, seasonStart, seasonView } from '../progress/seasons'
import { type GearInstance, STASH_MAX } from '../utils/gear'

/**
 * What every `AccountStore` must do (decision #48), run against the memory
 * store (accounts.spec.ts) and Postgres (pgstore.spec.ts). Test support only;
 * not imported by the server.
 */
export async function storeContract (store: AccountStore): Promise<void> {
  const { account, token } = await store.create()
  assert.match(token, TOKEN_SHAPE)
  assert.match(account.publicId, PUBLIC_ID_SHAPE)
  assert.equal(account.persisted, true)

  const found = await store.resolve(token)
  assert.equal(account.xp, 0, 'a new account has XP')
  assert.deepEqual(account.loadouts, [], 'a new account has loadouts')
  assert.deepEqual(found, { publicId: account.publicId, persisted: true, xp: 0, loadouts: [], energy: null }, 'create then resolve gave another account')
  assert.equal(await store.resolve(newToken()), null, 'an unknown token resolved')

  const other = await store.create()
  assert.notEqual(other.token, token)
  assert.notEqual(other.account.publicId, account.publicId)
  assert.equal((await store.resolve(other.token))?.publicId, other.account.publicId)
  assert.equal((await store.resolve(token))?.publicId, account.publicId)

  // XP (decision #48 step 3): grants add up, per account, and resolve reads them back.
  assert.equal(await store.grant(account.publicId, 87), 87)
  assert.equal(await store.grant(account.publicId, 0), 87, 'a grant of 0')
  assert.equal(await store.grant(account.publicId, 5), 92)
  assert.deepEqual(await store.resolve(token), { publicId: account.publicId, persisted: true, xp: 92, loadouts: [], energy: null })
  assert.equal((await store.resolve(other.token))?.xp, 0, 'another account\'s XP moved')
  // Concurrent grants all count (one atomic step each).
  const totals = await Promise.all(Array.from({ length: 10 }, async () => await store.grant(other.account.publicId, 3)))
  assert.equal(Math.max(...totals), 30)
  assert.equal(new Set(totals).size, 10, 'two concurrent grants saw the same total')
  assert.equal((await store.resolve(other.token))?.xp, 30)
  await assert.rejects(store.grant('0123456789abcdef', 10), 'a grant to an unknown account succeeded')

  // Loadouts (decision #48 step 4): one row per (robot, index), replaced by a
  // second save, per account. The store stores; validation is the caller's.
  await store.saveLoadout(account.publicId, 'peep', 0, [4, 1, 2, 3])
  assert.deepEqual((await store.resolve(token))?.loadouts, [{ robot: 'peep', index: 0, skills: [4, 1, 2, 3] }])
  await store.saveLoadout(account.publicId, 'peep', 0, [1, 2, 3, 0])
  assert.deepEqual((await store.resolve(token))?.loadouts, [{ robot: 'peep', index: 0, skills: [1, 2, 3, 0] }], 'a second save did not replace the first')
  await store.saveLoadout(account.publicId, 'peep', 1, [2, 0, 0, 0])
  await store.saveLoadout(account.publicId, 'magnet', 0, [3, 0, 0, 1])
  assert.deepEqual((await store.resolve(token))?.loadouts, [
    { robot: 'magnet', index: 0, skills: [3, 0, 0, 1] },
    { robot: 'peep', index: 0, skills: [1, 2, 3, 0] },
    { robot: 'peep', index: 1, skills: [2, 0, 0, 0] }
  ], 'another (robot, index) is not a row of its own')
  assert.deepEqual((await store.resolve(other.token))?.loadouts, [], 'another account\'s loadouts moved')
  await assert.rejects(store.saveLoadout('0123456789abcdef', 'peep', 0, [1, 2, 3, 0]), 'a save to an unknown account succeeded')
  // Concurrent saves to one key: exactly one row, holding one of the values.
  const written = Array.from({ length: 10 }, (_, i) => [1 + (i % 8), 0, 0, 0])
  await Promise.all(written.map(async (skills) => { await store.saveLoadout(other.account.publicId, 'hopper', 0, skills) }))
  const rows = (await store.resolve(other.token))?.loadouts ?? []
  assert.equal(rows.length, 1, 'concurrent saves to one key made more than one row')
  assert.ok(written.some((skills) => JSON.stringify(skills) === JSON.stringify(rows[0].skills)), 'the row holds a value nobody wrote')

  await seasonContract(store)
  await energyContract(store)
}

/**
 * Energy (decision #48 step 7): a new account reads as no record (6), a spend
 * is one atomic check-and-spend (two at once with one play left: one run),
 * refunds add back, and resolve reads the stock back.
 */
async function energyContract (store: AccountStore): Promise<void> {
  const t = Date.parse('2025-09-01T10:00:00.000Z')
  const min = 60_000
  const { account, token } = await store.create()
  assert.equal(account.energy, null, 'a new account has an energy record')
  assert.equal((await store.resolve(token))?.energy, null, 'a new account resolves with an energy record')
  for (let i = 1; i <= 6; i++) {
    const spent = await store.spend(account.publicId, t + i)
    // At or above the cap the record is as of the spend; the spend that takes
    // it below the cap (the 4th, to 2) starts the clock, which later ones keep.
    assert.deepEqual(spent, { ok: true, energy: { stock: 6 - i, asOfMs: t + Math.min(i, 4) } }, `spend ${i}`)
  }
  const refused = await store.spend(account.publicId, t + 10 * min)
  assert.deepEqual(refused, { ok: false, energy: { stock: 0, asOfMs: t + 4 } }, 'a seventh spend')
  assert.deepEqual((await store.resolve(token))?.energy, { stock: 0, asOfMs: t + 4 }, 'a refused spend wrote')
  // 30 minutes after the clock started, one play is back.
  assert.equal((await store.spend(account.publicId, t + 4 + 30 * min - 1)).ok, false)
  assert.deepEqual(await store.spend(account.publicId, t + 4 + 30 * min), { ok: true, energy: { stock: 0, asOfMs: t + 4 + 30 * min } })
  assert.deepEqual(await store.refund(account.publicId, t + 4 + 40 * min), { stock: 1, asOfMs: t + 4 + 30 * min })
  assert.deepEqual((await store.resolve(token))?.energy, { stock: 1, asOfMs: t + 4 + 30 * min })

  // Two spends at once with one play left: exactly one run.
  const race = await Promise.all([store.spend(account.publicId, t + 41 * min), store.spend(account.publicId, t + 41 * min)])
  assert.deepEqual(race.map((r) => r.ok).sort(), [false, true], 'two concurrent spends of the last play')
  assert.equal((await store.resolve(token))?.energy?.stock, 0)
  // Many at once on a new account (no row yet): exactly 6.
  const fresh = await store.create()
  const many = await Promise.all(Array.from({ length: 9 }, async () => await store.spend(fresh.account.publicId, t)))
  assert.equal(many.filter((r) => r.ok).length, 6, 'nine concurrent spends on a new account')
  assert.equal((await store.resolve(fresh.token))?.energy?.stock, 0)
  // A refund on a new account (no row): 6 + 1. Concurrent refunds all count.
  const other = await store.create()
  await Promise.all(Array.from({ length: 4 }, async () => await store.refund(other.account.publicId, t)))
  assert.equal((await store.resolve(other.token))?.energy?.stock, 10, 'concurrent refunds')
  assert.equal((await store.resolve(token))?.energy?.stock, 0, 'another account\'s stock moved')

  await assert.rejects(store.spend('0123456789abcdef', t), 'a spend for an unknown account')
  await assert.rejects(store.refund('0123456789abcdef', t), 'a refund for an unknown account')
}

/** A credit for a run ending at `atMs`: banked > 0 means an extraction (`extracted` forces one). */
function credit (atMs: number, banked: number, xp: number, extracted = banked > 0, name = 'PILOT'): SeasonCredit {
  return { season: seasonStart(atMs), atMs, banked, extracted, xp, name }
}

/**
 * Seasons (decision #48 step 6): credits add up through `grant`, both stores
 * rank exactly by `compareEntries` (ties included, which pins the pg
 * `ORDER BY`), and `payDue` pays Dez's N = 20 row once.
 */
async function seasonContract (store: AccountStore): Promise<void> {
  // Season A (2025-03-03, far outside the payout's look-back below).
  const a = Date.parse('2025-03-05T12:00:00.000Z')
  assert.equal(seasonStart(a), '2025-03-03')
  // Created in this order, so the key order (y < z < x) is the wrong answer for x.
  const y = await store.create()
  const z = await store.create()
  const x = await store.create()
  const none = await store.season(x.account.publicId, a)
  assert.deepEqual(none, seasonView('2025-03-03', a, undefined, 0, null, undefined), 'no entry: zeros, no rank')

  assert.equal(await store.grant(x.account.publicId, 10, credit(a, 0, 10)), 10, 'a grant with a credit returns the XP total')
  assert.equal(await store.grant(x.account.publicId, 40, credit(a + 1000, 500, 40)), 50)
  let view = await store.season(x.account.publicId, a + 1000)
  assert.deepEqual([view.banked, view.runs, view.extractions, view.xp, view.ranked, view.rank], [500, 2, 1, 50, 0, null], 'credits add up; 2 runs is not ranked')
  // An extraction that banked nothing and a death: runs and XP move, bankedAt doesn't.
  await store.grant(x.account.publicId, 30, credit(a + 2000, 0, 30, true))
  // The entry keeps the name of the run that last credited it.
  await store.grant(x.account.publicId, 5, credit(a + 3000, 0, 5, false, 'XRAY'))
  view = await store.season(x.account.publicId, a + 3000)
  assert.deepEqual([view.banked, view.runs, view.extractions, view.xp, view.ranked, view.rank, view.tier, view.payout], [500, 4, 2, 85, 1, 1, 1, 85])
  assert.equal((await store.resolve(x.token))?.xp, 85, 'the credit\'s grant added the XP once')

  // y and z tie with x on banked, later than x (a + 1500), and with each other.
  for (const [who, name] of [[y, 'YANKEE'], [z, 'ZULU']] as const) {
    await store.grant(who.account.publicId, 20, credit(a + 100, 0, 20, false, name))
    await store.grant(who.account.publicId, 20, credit(a + 200, 0, 20, false, name))
    // A run with no name (none can reach here; the store must not blank the entry's).
    await store.grant(who.account.publicId, 20, credit(a + 1500, 500, 20, true, ''))
  }
  // Not ranked: two runs, however much they banked.
  const w = await store.create()
  await store.grant(w.account.publicId, 20, credit(a, 9999, 20))
  await store.grant(w.account.publicId, 20, credit(a, 9999, 20))
  // Not ranked: three runs and an extraction, but the extraction carried no loot (minBanked).
  const v = await store.create()
  await store.grant(v.account.publicId, 20, credit(a, 0, 20, true, 'VICTOR'))
  await store.grant(v.account.publicId, 20, credit(a + 1, 0, 20, false, 'VICTOR'))
  await store.grant(v.account.publicId, 20, credit(a + 2, 0, 20, false, 'VICTOR'))
  const unbanked = await store.season(v.account.publicId, a + 5000)
  assert.deepEqual([unbanked.runs, unbanked.extractions, unbanked.banked, unbanked.ranked, unbanked.rank], [3, 1, 0, 3, null], 'an entry with nothing banked is ranked')
  const ranks = await Promise.all([x, y, z, w].map(async (who) => (await store.season(who.account.publicId, a + 5000)).rank))
  assert.deepEqual(ranks, [1, 2, 3, null], 'ties: the earlier bankedAt (x), then the older account (y before z)')
  assert.equal((await store.season(w.account.publicId, a)).banked, 19998)
  const board = await store.seasonBoard(a + 5000, 10)
  assert.deepEqual(board, {
    start: '2025-03-03',
    endsInMs: seasonEndMs('2025-03-03') - (a + 5000),
    ranked: 3,
    places: [1, 1, 1],
    top: [
      { rank: 1, name: 'XRAY', id: x.account.publicId, banked: 500 },
      { rank: 2, name: 'YANKEE', id: y.account.publicId, banked: 500 },
      { rank: 3, name: 'ZULU', id: z.account.publicId, banked: 500 }
    ]
  })
  assert.equal((await store.seasonBoard(a, 2)).top.length, 2, 'the board\'s limit')
  assert.equal((await store.season(x.account.publicId, a + 7 * 86_400_000)).runs, 0, 'the next season starts empty')
  await assert.rejects(store.season('0123456789abcdef', a), 'a season view for an unknown account')

  // Season B (2025-06-09): Dez's N = 20 row, built through grant credits.
  const b = Date.parse('2025-06-11T12:00:00.000Z')
  const start = seasonStart(b)
  assert.equal(start, '2025-06-09')
  const players: Array<{ account: { publicId: string }, token: string }> = []
  for (let i = 0; i < 20; i++) players.push(await store.create())
  const runXp = (i: number): number => i === 4 ? 30 : 2000
  for (let i = 0; i < 20; i++) {
    // players[1] and players[2] tie on banked; players[2] banked first, so it is
    // rank 2 although the older account is players[1]. players[4] earned 100 XP: capped.
    const banked = i === 2 ? 19_000 : 20_000 - 1000 * i
    const bankedAt = i === 2 ? b + 10 : i === 1 ? b + 50 : b + 100 + i
    await store.grant(players[i].account.publicId, runXp(i), credit(b, 0, runXp(i)))
    await store.grant(players[i].account.publicId, runXp(i), credit(b + 1, 0, runXp(i)))
    await store.grant(players[i].account.publicId, i === 4 ? 40 : runXp(i), credit(bankedAt, banked, i === 4 ? 40 : runXp(i)))
  }
  // Three runs and an extraction with nothing banked: not ranked, so not counted in N and not paid.
  const empty = await store.create()
  await store.grant(empty.account.publicId, 2000, credit(b, 0, 2000, true))
  await store.grant(empty.account.publicId, 2000, credit(b + 1, 0, 2000, false))
  await store.grant(empty.account.publicId, 2000, credit(b + 2, 0, 2000, false))
  const before = await Promise.all(players.map(async (p) => (await store.resolve(p.token))?.xp ?? -1))
  assert.equal(before[4], 100)
  const end = seasonEndMs(start)
  assert.deepEqual(await store.payDue(end + PAYOUT_DELAY_MS - 1), [], 'paid before end + 10 min')
  assert.deepEqual(await store.payDue(end + PAYOUT_DELAY_MS), [{ start, ranked: 20, paid: 5 }])
  const after = await Promise.all(players.map(async (p) => (await store.resolve(p.token))?.xp ?? -1))
  const gained = after.map((xp, i) => xp - before[i])
  assert.deepEqual(gained, [1000, 250, 500, 250, 100, ...Array(15).fill(0)], 'rank 1 1,000; rank 2 (players[2]) 500; ranks 3-5 250, capped at 100')
  assert.equal((await store.resolve(empty.token))?.xp, 6000, 'an entry with nothing banked was paid')
  assert.equal((await store.season(empty.account.publicId, b)).rank, null)
  assert.deepEqual(await store.payDue(end + PAYOUT_DELAY_MS + 60_000), [], 'a second payDue paid again')
  assert.deepEqual((await Promise.all(players.map(async (p) => (await store.resolve(p.token))?.xp ?? -1))), after, 'XP moved on the second payDue')
  assert.deepEqual((await store.season(players[2].account.publicId, end + PAYOUT_DELAY_MS)).last, { start, rank: 2, ranked: 20, tier: 10, xp: 500 })
  assert.equal((await store.season(players[9].account.publicId, b)).last, undefined, 'an unpaid rank has a last payout')
  // A credit into the paid season: the XP lands, the entry doesn't move.
  assert.equal(await store.grant(players[5].account.publicId, 7, credit(b + 2, 300, 7)), after[5] + 7)
  const late = await store.season(players[5].account.publicId, b)
  assert.deepEqual([late.runs, late.banked, late.xp], [3, 15_000, 6000], 'a credit into a paid season moved its entry')
}

// --- the gear stash (decision #49, task 49-3) ----------------------------------

/** What the gear contract needs from each store's spec besides the store. */
export interface GearHooks {
  /**
   * Let `ms` pass on the store's clock for everything already written:
   * memory advances its clock; pg moves `carried_at` and `seen_at` back.
   */
  age: (ms: number) => Promise<void>
  /** Every stash row's id in the store, any account, any state. */
  allRowIds: () => Promise<string[]>
}

type GearTestStore = AccountStore & GearStore & StashEdits

/** A seeded 0 <= r < 1 (mulberry32), so a merge's rolls repeat run to run. */
export function seeded (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The real merge rule (`mergeOutcome`) with a seeded random and an optional keep. */
function rule (seed: number, keep?: string): MergeRule {
  const random = seeded(seed)
  return (inputs) => mergeOutcome(inputs, keep, random)
}

/** A T1 skill item, a T2 skill item and a part, as found. */
export const T1: GearInstance = { tier: 1, skill: 3, rolls: [{ stat: 1, q: 500 }] }
export const T2: GearInstance = { tier: 2, skill: 5, rolls: [{ stat: 2, q: 0 }, { stat: 4, q: 1000 }] }
export const PART: GearInstance = { tier: 1, skill: 0, rolls: [] }

/** A new account with `items` in its stash (through `settleGear`'s found, the only insert there is). */
async function stocked (store: GearTestStore, items: readonly GearInstance[]): Promise<{ publicId: string, token: string, rows: StashItem[] }> {
  const { account, token } = await store.create()
  const settled = await store.settleGear(account.publicId, randomUUID(), [], items)
  assert.equal(settled.inserted, items.length)
  return { publicId: account.publicId, token, rows: settled.stash }
}

/** A holder that has heartbeat (a live process). */
async function liveHolder (store: GearTestStore): Promise<string> {
  const holder = randomUUID()
  await store.heartbeat(holder, [])
  return holder
}

async function bring (store: GearTestStore, publicId: string, ids: string[], holder: string): Promise<string[]> {
  const spent = await store.spend(publicId, Date.now(), { ids, holder })
  assert.equal(spent.ok, true, 'the spend was refused')
  assert.ok(Array.isArray(spent.carried))
  return (spent.carried ?? []).map((i) => i.rowId as string)
}

function idsOf (rows: readonly StashItem[]): string[] {
  return rows.map((r) => r.rowId)
}

function carriedIds (rows: readonly StashItem[]): string[] {
  return rows.filter((r) => r.carried).map((r) => r.rowId)
}

/** No row id appears twice and the store holds exactly `expected` rows. */
async function rowCount (hooks: GearHooks, expected: number, message: string): Promise<void> {
  const ids = await hooks.allRowIds()
  assert.equal(new Set(ids).size, ids.length, `${message}: a row id twice`)
  assert.equal(ids.length, expected, message)
}

/**
 * The stash (decision #49, 49-3): every `GearStore` method, and each of the
 * task's dupe races 1-11 at the store, identically on both stores. The
 * memory store runs it in accounts.spec.ts, pg in pgstore.spec.ts (where
 * races 1 and 11 are real concurrent transactions). Races 3, 9 and 10 also
 * depend on `Worlds` and `Player` (49-4); here is what the store owes them.
 */
export async function gearContract (store: GearTestStore, hooks: GearHooks): Promise<void> {
  await stashBasics(store, hooks)
  await carrying(store, hooks)
  await reconcile(store, hooks)
  await races(store, hooks)
  await mergeAndScrap(store, hooks)
}

const P2: GearInstance = { tier: 2, skill: 0, rolls: [] }
const P3: GearInstance = { tier: 3, skill: 0, rolls: [] }
const T3: GearInstance = { tier: 3, skill: 2, rolls: [{ stat: 1, q: 10 }, { stat: 5, q: 20 }] }

/** One merge that must be refused and change nothing, anywhere. */
async function refusedMerge (store: GearTestStore, hooks: GearHooks, publicId: string, ids: string[], mergeRule: MergeRule, message: string): Promise<void> {
  const before = await hooks.allRowIds()
  const stash = await store.loadStash(publicId)
  const merged = await store.mergeGear(publicId, ids, mergeRule)
  assert.equal(merged.item, null, `${message}: merged`)
  assert.deepEqual(merged.stash, stash, `${message}: the answer's stash differs`)
  assert.deepEqual(await store.loadStash(publicId), stash, `${message}: the stash changed`)
  assert.deepEqual(await hooks.allRowIds(), before, `${message}: rows changed`)
}

/** Merge and scrap (49-5): the store's half; the rule's odds are in gear/merge.spec.ts. */
async function mergeAndScrap (store: GearTestStore, hooks: GearHooks): Promise<void> {
  // A mixed merge keeps the chosen skill, a fresh tier-2 roll count, source merged.
  {
    const a = await stocked(store, [T1, PART, { ...T1, skill: 6 }, T2])
    const [x, y, z, t2] = idsOf(a.rows)
    const before = (await hooks.allRowIds()).length
    const merged = await store.mergeGear(a.publicId, [x, y, z], rule(7, z))
    assert.ok(merged.item !== null)
    assert.match(merged.item.rowId, ROW_ID_SHAPE)
    assert.deepEqual([merged.item.tier, merged.item.skill, merged.item.rolls.length, merged.item.carried, merged.item.source],
      [2, 6, 2, false, GEAR_SOURCE.merged], 'the merged row')
    assert.deepEqual(idsOf(merged.stash), [t2, merged.item.rowId], 'the inputs stayed, or the result is missing')
    assert.deepEqual(merged.stash, await store.loadStash(a.publicId))
    await rowCount(hooks, before - 2, 'merge: 3 rows into 1')
    // Default keep: the first skill item in the order given.
    const b = await stocked(store, [T1, PART, { ...T1, skill: 6 }])
    const [bx, by, bz] = idsOf(b.rows)
    assert.equal((await store.mergeGear(b.publicId, [by, bz, bx], rule(8))).item?.skill, 6, 'the default keep is not the first skill item listed')
  }

  // Refusals: nothing changes, for any account.
  {
    const a = await stocked(store, [T1, T1, T2, PART, T1])
    const other = await stocked(store, [T1])
    const [x, y, t2, part, w] = idsOf(a.rows)
    const o = other.rows[0].rowId
    await refusedMerge(store, hooks, a.publicId, [x, y, t2], rule(1), 'mixed tiers')
    await refusedMerge(store, hooks, a.publicId, [x, y], rule(1), '2 rows')
    await refusedMerge(store, hooks, a.publicId, [x, y, part, w], rule(1), '4 rows')
    await refusedMerge(store, hooks, a.publicId, [x, x, y], rule(1), 'a row twice')
    await refusedMerge(store, hooks, a.publicId, [x, y, 'junk'], rule(1), 'a malformed id')
    await refusedMerge(store, hooks, a.publicId, [x, y, '999999999'], rule(1), 'a missing row')
    await refusedMerge(store, hooks, a.publicId, [x, y, o], rule(1), 'another account\'s row')
    assert.deepEqual(idsOf(await store.loadStash(other.publicId)), [o])
    await refusedMerge(store, hooks, a.publicId, [x, y, part], rule(1, part), 'keep names a part')
    await refusedMerge(store, hooks, a.publicId, [x, y, part], rule(1, w), 'keep names a row not merged')
    await refusedMerge(store, hooks, a.publicId, [x, y, part], () => ({ tier: 4, skill: 1, rolls: [] }) as unknown as GearInstance, 'an unstorable outcome')
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, a.publicId, [w], holder), [w])
    await refusedMerge(store, hooks, a.publicId, [x, y, w], rule(1), 'a carried row')
    assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [w])
    await assert.rejects(store.mergeGear('0123456789abcdef', [x, y, part], rule(1)), 'a merge for an unknown account')
    await store.uncarry(holder, [w])
  }

  // Tier 3: three parts always make a skill item; anything with a skill item is refused.
  {
    const a = await stocked(store, [P3, P3, P3, T3, P3, P3, T3, T3, T3])
    const ids = idsOf(a.rows)
    const merged = await store.mergeGear(a.publicId, ids.slice(0, 3), rule(4))
    assert.deepEqual([merged.item?.tier, (merged.item?.skill ?? 0) > 0, merged.item?.rolls.length], [3, true, 2], '3 T3 parts')
    await refusedMerge(store, hooks, a.publicId, ids.slice(3, 6), rule(4), 'a T3 mix with a skill item')
    await refusedMerge(store, hooks, a.publicId, ids.slice(6, 9), rule(4), '3 T3 skill items')
    // Parts at T2 go up a tier, as a part or a skill item.
    const b = await stocked(store, [P2, P2, P2])
    assert.equal((await store.mergeGear(b.publicId, idsOf(b.rows), rule(5))).item?.tier, 3)
  }

  // Scrap: this account's stashed rows only, and nothing comes back for it.
  {
    const a = await stocked(store, [T1, T2, PART])
    const other = await stocked(store, [T1])
    const [x, y, part] = idsOf(a.rows)
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, a.publicId, [y], holder), [y])
    const scrapped = await store.scrapGear(a.publicId, part)
    assert.equal(scrapped.ok, true)
    assert.deepEqual(idsOf(scrapped.stash), [x, y])
    assert.deepEqual(scrapped.stash, await store.loadStash(a.publicId))
    const before = await hooks.allRowIds()
    assert.equal((await store.scrapGear(a.publicId, part)).ok, false, 'scrapped twice')
    assert.equal((await store.scrapGear(a.publicId, y)).ok, false, 'a carried row was scrapped')
    assert.equal((await store.scrapGear(a.publicId, other.rows[0].rowId)).ok, false, 'another account\'s row was scrapped')
    assert.equal((await store.scrapGear(a.publicId, 'junk')).ok, false)
    assert.deepEqual(await hooks.allRowIds(), before, 'a refused scrap changed rows')
    assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [y])
    await assert.rejects(store.scrapGear('0123456789abcdef', x), 'a scrap for an unknown account')
    await store.uncarry(holder, [y])
  }
}

async function stashBasics (store: GearTestStore, hooks: GearHooks): Promise<void> {
  const before = (await hooks.allRowIds()).length
  const { account } = await store.create()
  assert.deepEqual(await store.loadStash(account.publicId), [], 'a new account has a stash')
  const holder = randomUUID()
  const settled = await store.settleGear(account.publicId, holder, [], [T1, PART, T2])
  assert.equal(settled.inserted, 3)
  assert.deepEqual(settled.kept, [])
  for (const row of settled.stash) assert.match(row.rowId, ROW_ID_SHAPE)
  assert.deepEqual(settled.stash.map(({ rowId, ...rest }) => rest), [
    { ...T1, carried: false, source: GEAR_SOURCE.found },
    { ...PART, carried: false, source: GEAR_SOURCE.found },
    { ...T2, carried: false, source: GEAR_SOURCE.found }
  ], 'found items read back as written, in order')
  assert.deepEqual(await store.loadStash(account.publicId), settled.stash, 'loadStash and the settle\'s stash differ')
  // Ascending numerically, whatever the digits.
  const ids = settled.stash.map((r) => BigInt(r.rowId))
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : 1)))

  // What a row can't hold is dropped, not a failed settle (which would undo the keeps).
  const bad = [
    { tier: 4, skill: 1, rolls: [] }, { tier: 0, skill: 1, rolls: [] }, { tier: 1, skill: 256, rolls: [] },
    { tier: 1, skill: 1, rolls: [{ stat: 1, q: 1001 }] }, { tier: 1, skill: 1, rolls: [{ stat: 1, q: 0.5 }] },
    { tier: 1, skill: 1, rolls: Array.from({ length: 9 }, () => ({ stat: 1, q: 1 })) }
  ] as unknown as GearInstance[]
  const dropped = await store.settleGear(account.publicId, holder, ['junk', '-1', '0'], [...bad, T1])
  assert.equal(dropped.inserted, 1, 'an unstorable found item was inserted')
  assert.equal(dropped.stash.length, 4)

  // Unknown accounts and malformed holders write nothing.
  await assert.rejects(store.loadStash('0123456789abcdef'), 'a stash for an unknown account')
  await assert.rejects(store.settleGear('0123456789abcdef', holder, [], [T1]), 'a settle for an unknown account')
  for (const malformed of ['', 'not-a-uuid', holder.toUpperCase()]) {
    await assert.rejects(store.settleGear(account.publicId, malformed, [], [T1]), `settle, holder ${malformed}`)
    await assert.rejects(store.discardGear(malformed, [settled.stash[0].rowId]), `discard, holder ${malformed}`)
    await assert.rejects(store.uncarry(malformed, [settled.stash[0].rowId]), `uncarry, holder ${malformed}`)
    await assert.rejects(store.heartbeat(malformed, []), `heartbeat, holder ${malformed}`)
    await assert.rejects(store.releaseHolder(malformed), `release, holder ${malformed}`)
    await assert.rejects(store.spend(account.publicId, Date.now(), { ids: [settled.stash[0].rowId], holder: malformed }), `spend, holder ${malformed}`)
  }
  assert.equal((await store.loadStash(account.publicId)).length, 4)
  await rowCount(hooks, before + 4, 'basics')
  // Nothing to resolve: no query, no error.
  assert.equal(await store.discardGear(holder, []), 0)
  assert.equal(await store.uncarry(holder, ['junk']), 0)
}

async function carrying (store: GearTestStore, hooks: GearHooks): Promise<void> {
  const a = await stocked(store, [T1, PART, T2])
  const b = await stocked(store, [T1])
  const [t1, part, t2] = idsOf(a.rows)
  const holder = await liveHolder(store)

  // The account's, stashed, not a part; junk and repeats name nothing more.
  const carried = await store.spend(a.publicId, Date.now(), { ids: [t2, part, b.rows[0].rowId, 'junk', t1, t1], holder })
  assert.equal(carried.ok, true)
  assert.deepEqual(carried.carried, [{ ...T1, rowId: t1 }, { ...T2, rowId: t2 }], 'carried: the account\'s stashed skill items, in id order')
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [t1, t2], 'a live holder\'s carry was returned')
  assert.deepEqual(carriedIds(await store.loadStash(b.publicId)), [], 'another account\'s row was carried')
  // Carried rows aren't carried again, by anyone.
  assert.deepEqual(await bring(store, a.publicId, [t1, t2], randomUUID()), [])
  // Without bring the answer has no `carried`, as before 49-3.
  assert.equal('carried' in (await store.spend(a.publicId, Date.now())), false)

  // A refused spend carries nothing.
  const poor = await stocked(store, [T1])
  for (let i = 0; i < 6; i++) assert.equal((await store.spend(poor.publicId, Date.now())).ok, true)
  const refused = await store.spend(poor.publicId, Date.now(), { ids: [poor.rows[0].rowId], holder })
  assert.deepEqual([refused.ok, refused.carried], [false, []])
  assert.deepEqual(carriedIds(await store.loadStash(poor.publicId)), [], 'a refused spend carried')

  // discard and uncarry act only on rows this holder carries.
  const other = randomUUID()
  assert.equal(await store.discardGear(other, [t1]), 0, 'another holder discarded')
  assert.equal(await store.uncarry(other, [t1]), 0, 'another holder uncarried')
  assert.equal(await store.discardGear(holder, [part]), 0, 'a stashed row was discarded')
  assert.equal(await store.discardGear(holder, [t1]), 1)
  assert.deepEqual(idsOf(await store.loadStash(a.publicId)), [part, t2])
  assert.equal(await store.discardGear(holder, [t1]), 0, 'a second discard')

  // releaseHolder: every row of this holder back, and the holder forgotten.
  assert.equal(await store.releaseHolder(holder), 1)
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [])
  assert.equal(await store.releaseHolder(holder), 0)
  // Forgotten: a carry on it now (a straggler after release) reads as a dead holder's.
  assert.deepEqual(await bring(store, a.publicId, [t2], holder), [t2])
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [], 'a released holder\'s carry was not returned at once')
  await rowCount(hooks, (await hooks.allRowIds()).length, 'carrying')
}

async function reconcile (store: GearTestStore, hooks: GearHooks): Promise<void> {
  const a = await stocked(store, [T1, T2, T1])
  const [x, y, z] = idsOf(a.rows)
  const holder = await liveHolder(store)
  assert.deepEqual(await bring(store, a.publicId, [x, y], holder), [x, y])

  // Under 2 minutes old: spared even though not held (a carry after the heartbeat's snapshot).
  await hooks.age(RECONCILE_AFTER_MS - 5000)
  assert.equal(await store.heartbeat(holder, []), 0, 'a carry under 2 minutes old was returned')
  // Over 2 minutes: only what isn't held goes back.
  await hooks.age(10_000)
  assert.equal(await store.heartbeat(holder, [x, 'junk']), 1)
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [x], 'reconcile returned a held row, or kept an unheld one')
  // Another holder's heartbeat never touches this holder's rows.
  await hooks.age(RECONCILE_AFTER_MS + 1000)
  assert.equal(await store.heartbeat(randomUUID(), []), 0)
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [x])

  // A live run longer than 15 minutes: heartbeats every minute, the item stays carried.
  for (let minute = 0; minute < 20; minute++) {
    await hooks.age(60_000)
    assert.equal(await store.heartbeat(holder, [x]), 0)
    assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [x], `minute ${minute + 1}: a live holder's carry was returned`)
  }
  // The holder stops (a crash): just under 15 minutes it still counts as alive...
  await hooks.age(STALE_CARRY_MS - 5000)
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [x], 'returned before 15 minutes of silence')
  // ...and past it, the owner's next load returns it.
  await hooks.age(10_000)
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [], 'not returned after 15 minutes of silence')
  // A holder that never heartbeat at all reads as dead at once.
  assert.deepEqual(await bring(store, a.publicId, [z], randomUUID()), [z])
  assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [])
  assert.equal((await store.loadStash(a.publicId)).length, 3)
}

async function races (store: GearTestStore, hooks: GearHooks): Promise<void> {
  // 1. Two tabs bring the same items at once: each item goes to one of them.
  for (let round = 0; round < 8; round++) {
    const a = await stocked(store, [T1, T2])
    const ids = idsOf(a.rows)
    const holder = await liveHolder(store)
    const [one, two] = await Promise.all([
      store.spend(a.publicId, Date.now(), { ids, holder }),
      store.spend(a.publicId, Date.now(), { ids: [...ids].reverse(), holder: randomUUID() })
    ])
    const got = [...(one.carried ?? []), ...(two.carried ?? [])].map((i) => i.rowId as string).sort()
    assert.deepEqual(got, [...ids].sort(), `race 1, round ${round}: an item carried twice or by nobody`)
    assert.equal((await store.loadStash(a.publicId)).length, 2)
  }

  // 2. Merge/scrap vs bring-in: both act only on stashed rows (the real merge
  // and scrap since 49-5; 49-3 stood in for them with a conditional delete).
  {
    const a = await stocked(store, [T1, T1, T1, T1, T1, T1, T1])
    const [x, y, z, w, v, u, t] = idsOf(a.rows)
    const holder = await liveHolder(store)
    const merged = await store.mergeGear(a.publicId, [x, y, z], rule(1))
    assert.notEqual(merged.item, null)
    assert.deepEqual(await bring(store, a.publicId, [x, w], holder), [w], 'a merged row was carried')
    assert.equal((await store.mergeGear(a.publicId, [w, v, u], rule(2))).item, null, 'a carried row was merged')
    assert.equal((await store.scrapGear(a.publicId, w)).ok, false, 'a carried row was scrapped')
    const [carried, raced] = await Promise.all([bring(store, a.publicId, [v], holder), store.mergeGear(a.publicId, [v, u, t], rule(3))])
    assert.equal(carried.length + (raced.item === null ? 0 : 1), 1, 'race 2: v both carried and merged, or neither')
    // x y z went into one row; w carried; v carried or merged with u t.
    assert.equal((await store.loadStash(a.publicId)).length, carried.length === 1 ? 5 : 3)
  }

  // 3. The extraction's write in flight vs the next READY bringing the same items.
  {
    const a = await stocked(store, [T1, T2])
    const ids = idsOf(a.rows)
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, a.publicId, ids, holder), ids)
    // Before the settle lands: still carried, so the carry skips them.
    assert.deepEqual(await bring(store, a.publicId, ids, holder), [], 'race 3: a carried item carried again')
    // Both at once: one row each whichever lands first.
    const [settled, again] = await Promise.all([
      store.settleGear(a.publicId, holder, ids, []),
      bring(store, a.publicId, ids, holder)
    ])
    assert.deepEqual(settled.kept, ids)
    const stash = await store.loadStash(a.publicId)
    assert.equal(stash.length, 2, 'race 3: rows multiplied')
    assert.deepEqual(carriedIds(stash), again, 'race 3: what the carry says differs from the stash')
    await store.uncarry(holder, again)
  }

  // 4. Death, then someone extracts the dropped lineage item: the row moves.
  {
    const owner = await stocked(store, [T2])
    const extractor = await stocked(store, [T1])
    const [x] = idsOf(owner.rows)
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, owner.publicId, [x], holder), [x])
    // The death writes nothing. The extractor's run end keeps x.
    const settled = await store.settleGear(extractor.publicId, holder, [x], [])
    assert.deepEqual(settled.kept, [x])
    assert.deepEqual(settled.stash.map((r) => [r.rowId, r.carried, r.skill]), [[x, false, T2.skill], [extractor.rows[0].rowId, false, T1.skill]])
    assert.deepEqual(await store.loadStash(owner.publicId), [], 'race 4: the dead owner kept the item too')
    // A late write by the owner can't take it back.
    assert.deepEqual((await store.settleGear(owner.publicId, holder, [x], [])).kept, [])
    // Passed in as found by mistake (a lineage instance): moved, never inserted.
    const lineage = await stocked(store, [T1])
    const [w] = idsOf(lineage.rows)
    assert.deepEqual(await bring(store, lineage.publicId, [w], holder), [w])
    const before = (await hooks.allRowIds()).length
    const wrong = await store.settleGear(extractor.publicId, holder, [], [{ ...T1, rowId: w }])
    assert.deepEqual([wrong.kept, wrong.inserted], [[w], 0], 'a lineage instance in found was inserted')
    await rowCount(hooks, before, 'race 4: a lineage instance made a row')
  }

  // 5. The stale return vs an extractor's transfer.
  {
    const owner = await stocked(store, [T1, T2, T1])
    const extractor = await stocked(store, [])
    const [x, y, z] = idsOf(owner.rows)
    const live = await liveHolder(store)
    assert.deepEqual(await bring(store, owner.publicId, [x, z], live), [x, z])
    // A live holder (heartbeating) is never returned from under the world.
    await hooks.age(14 * 60_000)
    await store.heartbeat(live, [x, z])
    await hooks.age(14 * 60_000)
    assert.deepEqual(carriedIds(await store.loadStash(owner.publicId)), [x, z], 'race 5: returned while its holder lives')
    assert.deepEqual((await store.settleGear(extractor.publicId, live, [x], [])).kept, [x])
    // A dead holder's carry is returned, and its late transfer then matches nothing.
    const dead = await liveHolder(store)
    assert.deepEqual(await bring(store, owner.publicId, [y], dead), [y])
    await hooks.age(STALE_CARRY_MS + 1000)
    await store.heartbeat(live, [z])
    assert.deepEqual(carriedIds(await store.loadStash(owner.publicId)), [z], 'race 5: a dead holder\'s carry was not returned')
    assert.deepEqual((await store.settleGear(extractor.publicId, dead, [y], [])).kept, [], 'race 5: a returned row transferred')
    // A clean exit after its settles: the settled row stays where the settle put it.
    await store.heartbeat(live, [z])
    assert.equal(await store.releaseHolder(live), 1)
    assert.deepEqual(idsOf(await store.loadStash(extractor.publicId)), [x])
    assert.deepEqual(idsOf(await store.loadStash(owner.publicId)), [y, z])
  }

  // 6. A settle that times out and lands later: the reconcile may return first; never two rows.
  {
    const owner = await stocked(store, [T2])
    const extractor = await stocked(store, [])
    const [x] = idsOf(owner.rows)
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, owner.publicId, [x], holder), [x])
    const before = (await hooks.allRowIds()).length
    // The ledger let x go at the timeout; the next heartbeat returns it.
    await hooks.age(RECONCILE_AFTER_MS + 1000)
    assert.equal(await store.heartbeat(holder, []), 1)
    // The late settle: its keep matches no row (the extractor loses x), its found lands once.
    const late = await store.settleGear(extractor.publicId, holder, [x], [PART])
    assert.deepEqual([late.kept, late.inserted], [[], 1])
    assert.deepEqual(idsOf(await store.loadStash(owner.publicId)), [x], 'race 6: the owner lost x')
    await rowCount(hooks, before + 1, 'race 6')
  }

  // 7. A database outage over 15 minutes while the process lives: never an insert.
  {
    const owner = await stocked(store, [T1])
    const extractor = await stocked(store, [])
    const [x] = idsOf(owner.rows)
    const stuck = await liveHolder(store)
    assert.deepEqual(await bring(store, owner.publicId, [x], stuck), [x])
    await hooks.age(STALE_CARRY_MS + 1000)
    // Another process's load returns x; the owner brings it again elsewhere.
    assert.deepEqual(carriedIds(await store.loadStash(owner.publicId)), [])
    const elsewhere = await liveHolder(store)
    assert.deepEqual(await bring(store, owner.publicId, [x], elsewhere), [x])
    const before = (await hooks.allRowIds()).length
    // The stuck process's live copy, extracted when the database is back: no match.
    assert.deepEqual((await store.settleGear(extractor.publicId, stuck, [x], [])).kept, [], 'race 7: a stale holder moved a re-carried row')
    // Re-carried on that same holder, its copy moves the one row: still one row.
    await store.uncarry(elsewhere, [x])
    await store.heartbeat(stuck, [])
    assert.deepEqual(await bring(store, owner.publicId, [x], stuck), [x])
    assert.deepEqual((await store.settleGear(extractor.publicId, stuck, [x], [])).kept, [x])
    await rowCount(hooks, before, 'race 7')
  }

  // 8. A play spent and carried, a run that never began: uncarry.
  {
    const a = await stocked(store, [T1, T2])
    const ids = idsOf(a.rows)
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, a.publicId, ids, holder), ids)
    assert.equal(await store.uncarry(holder, ids), 2)
    assert.deepEqual(carriedIds(await store.loadStash(a.publicId)), [])
    assert.equal(await store.uncarry(holder, ids), 0, 'a second uncarry')
    assert.deepEqual(await bring(store, a.publicId, ids, holder), ids, 'an uncarried item could not be brought again')
    await store.uncarry(holder, ids)
  }

  // 9. A drain's cut-off settles as a keep; the disconnect's death sweep then finds nothing.
  {
    const a = await stocked(store, [T2])
    const [x] = idsOf(a.rows)
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, a.publicId, [x], holder), [x])
    const cut = await store.settleGear(a.publicId, holder, [x], [T1])
    assert.deepEqual([cut.kept, cut.inserted], [[x], 1])
    assert.equal(await store.discardGear(holder, [x]), 0, 'race 9: the death sweep deleted a kept row')
    assert.equal((await store.loadStash(a.publicId)).length, 2)
  }

  // 10. A double run end: the second settle's keep moves nothing. (Its found
  // would insert again: keeping the end single is `Player.runOver`'s job.)
  {
    const a = await stocked(store, [T1])
    const [x] = idsOf(a.rows)
    const holder = await liveHolder(store)
    assert.deepEqual(await bring(store, a.publicId, [x], holder), [x])
    assert.deepEqual((await store.settleGear(a.publicId, holder, [x], [])).kept, [x])
    assert.deepEqual((await store.settleGear(a.publicId, holder, [x], [])).kept, [], 'race 10: a second keep')
    assert.equal(await store.discardGear(holder, [x]), 0, 'race 10: a death after the extraction deleted it')
    assert.equal((await store.loadStash(a.publicId)).length, 1)
  }

  // 11. Found items at the cap: two settles at once can't both pass it.
  {
    const a = await stocked(store, Array.from({ length: STASH_MAX - 1 }, (_, i) => (i % 2 === 0 ? T1 : PART)))
    const holders = [randomUUID(), randomUUID()]
    const [one, two] = await Promise.all(holders.map(async (h) => await store.settleGear(a.publicId, h, [], [T2, T2])))
    assert.equal(one.inserted + two.inserted, 1, 'race 11: the cap was passed')
    assert.equal((await store.loadStash(a.publicId)).length, STASH_MAX)
    // At the cap, found items stop, but a keep still moves in (extraction never loses a lineage item).
    const owner = await stocked(store, [T1])
    const holder = await liveHolder(store)
    const [x] = idsOf(owner.rows)
    assert.deepEqual(await bring(store, owner.publicId, [x], holder), [x])
    const full = await store.settleGear(a.publicId, holder, [x], [T1])
    assert.deepEqual([full.kept, full.inserted, full.stash.length], [[x], 0, STASH_MAX + 1])
  }
}
