import assert from 'node:assert/strict'
import { type AccountStore, newToken, PUBLIC_ID_SHAPE, TOKEN_SHAPE } from './accounts'
import { PAYOUT_DELAY_MS, type SeasonCredit, seasonEndMs, seasonStart, seasonView } from '../progress/seasons'

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
  assert.deepEqual(found, { publicId: account.publicId, persisted: true, xp: 0, loadouts: [] }, 'create then resolve gave another account')
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
  assert.deepEqual(await store.resolve(token), { publicId: account.publicId, persisted: true, xp: 92, loadouts: [] })
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
