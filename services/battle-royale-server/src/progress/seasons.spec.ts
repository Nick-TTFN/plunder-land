import test from 'node:test'
import assert from 'node:assert/strict'
import { SEASON } from './xp'
import {
  BOARD_SIZE, CHECK_EVERY_MS, compareEntries, creditOf, dueStarts, eligible, LOOKBACK_WEEKS, PAYOUT_DELAY_MS, payable,
  type SeasonEntry, seasonEndMs, SeasonPayer, seasonPayouts, seasonStart, seasonView, tierOf, tierPlaces
} from './seasons'

/**
 * Weekly seasons (decision #48 step 6), the pure half: Dez's numbers
 * (`ideas/meta-progression-numbers.md` section 4), the calendar, the ranking
 * order and the payout table. A change to `SEASON` that isn't also a change
 * to the spec fails here.
 */

test('SEASON is Dez\'s v1, and the timing constants are the task\'s', () => {
  assert.equal(SEASON.minRuns, 3)
  assert.equal(SEASON.minExtractions, 1)
  assert.equal(SEASON.minBanked, 1)
  assert.equal(SEASON.creditCap, 6000)
  assert.deepEqual(SEASON.tiers.map((t) => ({ ...t })), [
    { top: 1, share: 0.01, xp: 1000 },
    { top: 10, share: 0.10, xp: 500 },
    { top: 25, share: 0.25, xp: 250 }
  ])
  assert.ok(Object.isFrozen(SEASON) && Object.isFrozen(SEASON.tiers) && SEASON.tiers.every((t) => Object.isFrozen(t)))
  assert.equal(PAYOUT_DELAY_MS, 600_000)
  assert.equal(CHECK_EVERY_MS, 300_000)
  assert.equal(LOOKBACK_WEEKS, 8)
  assert.equal(BOARD_SIZE, 10)
})

test('seasonStart: the Monday 00:00 UTC at or before, across a year boundary', () => {
  assert.equal(seasonStart(Date.parse('2026-10-04T23:59:59.999Z')), '2026-09-28', 'Sunday, the last ms')
  assert.equal(seasonStart(Date.parse('2026-10-05T00:00:00.000Z')), '2026-10-05', 'Monday 00:00 exactly')
  assert.equal(seasonStart(Date.parse('2026-10-05T00:00:00.001Z')), '2026-10-05')
  assert.equal(seasonStart(Date.parse('2026-10-11T23:59:59.999Z')), '2026-10-05', 'the Sunday before the next')
  assert.equal(seasonStart(Date.parse('2026-10-12T00:00:00.000Z')), '2026-10-12')
  assert.equal(seasonStart(Date.parse('2027-01-03T12:00:00.000Z')), '2026-12-28', 'year boundary')
  assert.equal(seasonStart(Date.parse('2026-10-07T15:30:00.000Z')), '2026-10-05', 'a Wednesday')
  assert.equal(seasonEndMs('2026-09-28'), Date.parse('2026-10-05T00:00:00.000Z'))
})

test('payable 10 minutes after the end, and a check looks back 8 weeks, oldest first', () => {
  const end = seasonEndMs('2026-09-28')
  assert.equal(payable('2026-09-28', end + PAYOUT_DELAY_MS - 1), false)
  assert.equal(payable('2026-09-28', end + PAYOUT_DELAY_MS), true)
  assert.deepEqual(dueStarts(end + PAYOUT_DELAY_MS - 1).slice(-1), ['2026-09-21'], 'the season just ended is not due yet')
  const due = dueStarts(end + PAYOUT_DELAY_MS)
  assert.equal(due.length, 8)
  assert.equal(due[7], '2026-09-28')
  assert.equal(due[0], '2026-08-10')
})

/** N entries ranked 1..N, each with 5,000 season XP (no cap). */
function paid (n: number): Map<number, number> {
  const ranked = Array.from({ length: n }, (_, i) => ({ key: i + 1, xp: 5000 }))
  const out = new Map<number, number>()
  for (const p of seasonPayouts(ranked)) {
    assert.equal(p.rank, p.key, 'ranks follow the input order')
    out.set(p.rank, p.xp)
  }
  return out
}

function total (payouts: Map<number, number>): number {
  return [...payouts.values()].reduce((a, b) => a + b, 0)
}

/** Ranks in [from, to] each paid exactly `xp`. */
function each (payouts: Map<number, number>, from: number, to: number, xp: number): void {
  for (let r = from; r <= to; r++) assert.equal(payouts.get(r), xp, `rank ${r}`)
}

test('exact payouts by N: Dez\'s table', () => {
  assert.equal(paid(0).size, 0)
  assert.deepEqual([...paid(1)], [[1, 1000]])
  assert.deepEqual([...paid(3)], [[1, 1000]])
  assert.deepEqual([...paid(10)], [[1, 1000], [2, 250]])
  const n20 = paid(20)
  assert.deepEqual([...n20], [[1, 1000], [2, 500], [3, 250], [4, 250], [5, 250]])
  assert.equal(total(n20), 2250)
  const n100 = paid(100)
  each(n100, 1, 1, 1000)
  each(n100, 2, 10, 500)
  each(n100, 11, 25, 250)
  assert.equal(n100.size, 25)
  assert.equal(total(n100), 9250)
  const n1000 = paid(1000)
  each(n1000, 1, 10, 1000)
  each(n1000, 11, 100, 500)
  each(n1000, 101, 250, 250)
  assert.equal(n1000.size, 250)
  assert.equal(total(n1000), 92500)
  assert.equal(total(paid(10)), 1250)
  assert.equal(total(paid(3)), 1000)
  assert.equal(total(paid(1)), 1000)
})

test('the top tier grows its second place at N = 200', () => {
  assert.deepEqual(tierPlaces(0), [0, 0, 0])
  assert.deepEqual(tierPlaces(1), [1, 1, 1])
  assert.deepEqual(tierPlaces(19), [1, 1, 4])
  assert.deepEqual(tierPlaces(199), [1, 19, 49])
  assert.deepEqual(tierPlaces(200), [2, 20, 50])
  const n199 = paid(199)
  each(n199, 1, 1, 1000)
  each(n199, 2, 19, 500)
  each(n199, 20, 49, 250)
  assert.equal(n199.size, 49)
  const n200 = paid(200)
  each(n200, 1, 2, 1000)
  each(n200, 3, 20, 500)
  each(n200, 21, 50, 250)
  assert.equal(n200.size, 50)
  assert.equal(tierOf(1, 0), null)
  assert.equal(tierOf(2, 10), 25)
  assert.equal(tierOf(3, 10), null)
  assert.equal(tierOf(0, 10), null)
})

test('the payout is capped by the season\'s run XP, and a place worth 0 is left out', () => {
  assert.deepEqual(seasonPayouts([{ key: 'a', xp: 180 }]), [{ key: 'a', rank: 1, tier: 1, xp: 180 }])
  const n20 = Array.from({ length: 20 }, (_, i) => ({ key: i + 1, xp: i === 1 ? 300 : 5000 }))
  assert.equal(seasonPayouts(n20).find((p) => p.rank === 2)?.xp, 300, 'rank 2 with 300 XP is paid 300, not 500')
  assert.deepEqual(seasonPayouts([{ key: 'a', xp: 0 }]), [])
  // Postgres passes only the paid places and the count.
  assert.deepEqual(seasonPayouts([{ key: 'a', xp: 900 }, { key: 'b', xp: 900 }], 10), [{ key: 'a', rank: 1, tier: 1, xp: 900 }, { key: 'b', rank: 2, tier: 25, xp: 250 }])
})

function entry (key: number, banked: number, bankedAt: number | null, xp = 5000): SeasonEntry {
  return { key, banked, bankedAt, runs: 3, extractions: 1, xp }
}

/** Rank `entries` by `compareEntries` and pay them: payout by key. */
function payByKey (entries: SeasonEntry[]): Map<number, number> {
  const ranked = [...entries].sort(compareEntries)
  return new Map(seasonPayouts(ranked).map((p) => [p.key, p.xp]))
}

test('ties at tier edges: the earlier bankedAt, then the lower key; places are never shared', () => {
  // N = 100: ranks 10 and 11 tie on banked. Key 90 banked first.
  const entries = Array.from({ length: 100 }, (_, i) => entry(i + 1, 10_000 - i * 10, 1000))
  entries[9] = entry(10, 5555, 2000)
  entries[89] = entry(90, 5555, 1500)
  // Keep them at ranks 10 and 11: everything else above 5555 or below.
  for (let i = 10; i < 100; i++) if (i !== 89) entries[i] = entry(i + 1, 5000 - i, 1000)
  const byKey = payByKey(entries)
  assert.equal(byKey.get(90), 500, 'the earlier bankedAt gets 500')
  assert.equal(byKey.get(10), 250)
  assert.equal([...byKey.values()].filter((xp) => xp === 500).length, 9, 'the 500 tier pays exactly its places')

  // Same banked and same bankedAt: the lower key wins.
  entries[89] = entry(90, 5555, 2000)
  const again = payByKey(entries)
  assert.equal(again.get(10), 500)
  assert.equal(again.get(90), 250)

  // N = 20, two tied for first: one 1,000, one 500.
  const twenty = Array.from({ length: 20 }, (_, i) => entry(i + 1, 1000 - i, 1000))
  twenty[7] = entry(8, 9999, 300)
  twenty[3] = entry(4, 9999, 300)
  const top = payByKey(twenty)
  assert.equal(top.get(4), 1000)
  assert.equal(top.get(8), 500)
  assert.equal([...top.values()].filter((xp) => xp === 1000).length, 1)
  assert.equal(top.size, 5)
})

test('compareEntries: banked first, a missing bankedAt last, then the key', () => {
  assert.ok(compareEntries(entry(5, 10, 9), entry(1, 9, 1)) < 0)
  assert.ok(compareEntries(entry(5, 10, 1), entry(1, 10, 2)) < 0)
  assert.ok(compareEntries(entry(5, 10, null), entry(1, 10, 2)) > 0)
  assert.ok(compareEntries(entry(1, 10, 2), entry(5, 10, 2)) < 0)
  assert.equal(compareEntries(entry(1, 10, 2), entry(1, 10, 2)), 0)
})

test('eligible: 3 runs, 1 extraction and some banked loot', () => {
  assert.equal(eligible({ runs: 2, extractions: 1, banked: 100 }), false)
  assert.equal(eligible({ runs: 3, extractions: 0, banked: 100 }), false)
  assert.equal(eligible({ runs: 3, extractions: 1, banked: 0 }), false)
  assert.equal(eligible({ runs: 3, extractions: 1, banked: 1 }), true)
})

test('creditOf: an extraction is capped at 6,000, a death banks nothing, loot floors', () => {
  const at = Date.parse('2026-10-07T12:00:00.000Z')
  assert.deepEqual(creditOf({ extracted: true, loot: 7500, name: 'NOVA-7' }, 120, at), { season: '2026-10-05', atMs: at, banked: 6000, extracted: true, xp: 120, name: 'NOVA-7' })
  assert.deepEqual(creditOf({ extracted: false, loot: 900, name: 'Ann' }, 7, at), { season: '2026-10-05', atMs: at, banked: 0, extracted: false, xp: 7, name: 'Ann' })
  assert.equal(creditOf({ extracted: true, loot: 1234.9, name: 'x' }, 0, at).banked, 1234)
  assert.equal(creditOf({ extracted: true, loot: -5, name: 'x' }, 0, at).banked, 0)
  assert.equal(creditOf({ extracted: true, loot: 6000, name: 'x' }, 0, at).banked, 6000)
})

test('seasonView: the projected payout is the tier\'s, capped; no rank, no tier', () => {
  const at = Date.parse('2026-10-07T00:00:00.000Z')
  const view = seasonView('2026-10-05', at, { banked: 900, runs: 4, extractions: 2, xp: 200 }, 37, 4, undefined)
  assert.deepEqual(view, {
    start: '2026-10-05', endsInMs: 5 * 86_400_000, banked: 900, runs: 4, extractions: 2, xp: 200, ranked: 37, rank: 4, tier: 25, payout: 200, minRuns: 3, minExtractions: 1
  })
  assert.equal(seasonView('2026-10-05', at, undefined, 0, null, undefined).payout, 0)
  assert.equal(seasonView('2026-10-05', at, { banked: 1, runs: 3, extractions: 1, xp: 999 }, 37, 30, undefined).tier, null)
})

test('SeasonPayer: a check pays through the store, never rejects, and two at once run once', async () => {
  const lines: string[] = []
  const reported: unknown[] = []
  let calls = 0
  let release: () => void = () => {}
  const store = {
    payDue: async () => {
      calls++
      await new Promise<void>((resolve) => { release = resolve })
      return [{ start: '2026-09-28', ranked: 20, paid: 5 }]
    }
  }
  const payer = new SeasonPayer(store, (e) => { reported.push(e) }, () => 0, (line) => { lines.push(line) })
  const both = Promise.all([payer.check(), payer.check()])
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await both
  assert.equal(calls, 1)
  assert.deepEqual(lines, ['seasons: paid 2026-09-28, 5 of 20 ranked'])
  const failing = new SeasonPayer({ payDue: async () => { throw new Error('down') } }, (e) => { reported.push(e) })
  await failing.check()
  assert.equal(reported.length, 1)
  const throwingReport = new SeasonPayer({ payDue: async () => { throw new Error('down') } }, () => { throw new Error('report broke') })
  await throwingReport.check()
  payer.start()
  payer.stop()
})
