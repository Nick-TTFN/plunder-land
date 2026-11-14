import test from 'node:test'
import assert from 'node:assert/strict'
import { ENERGY } from './xp'
import { AD_REFILL, adRefillAt, adRefillCheck, type AdRefillRecord, adRefillView, energyAt, type EnergyRecord, energyView, refundAt, spendAt, utcDay } from './energy'

/**
 * Energy's arithmetic (decision #48 step 7): 1 play per 30 min, a cap of 3,
 * new accounts start with 10, nothing regenerates above the cap, a run costs 1
 * and an extraction gives it back.
 */

const MIN = 60_000
const T = 1_000_000_000

test('the numbers are #48\'s: 1 per 30 min, cap 3, start 10 (#62)', () => {
  assert.deepEqual({ ...ENERGY }, { regenMs: 30 * MIN, cap: 3, start: 10 })
})

test('a new account (no record) has the start stock, and nothing regenerates above the cap', () => {
  assert.deepEqual(energyAt(null, T), { stock: ENERGY.start, asOfMs: T })
  assert.deepEqual(energyView(null, T), { stock: ENERGY.start, cap: 3, nextInMs: null, regenMs: 30 * MIN })
  // Runs lost down to the cap; only below it does the clock run.
  let record = null as ReturnType<typeof energyAt> | null
  for (let i = 0; i < ENERGY.start - ENERGY.cap; i++) {
    const spent = spendAt(record, T + i * 60 * MIN)
    assert.equal(spent.ok, true)
    record = spent.record
  }
  assert.equal(record?.stock, 3)
  // Hours later, still 3: at the cap nothing is regenerated.
  assert.deepEqual(energyAt(record, T + 10 * 60 * MIN), { stock: 3, asOfMs: T + 10 * 60 * MIN })
  // A stock above the cap stays where it is.
  assert.equal(energyAt({ stock: 5, asOfMs: T }, T + 24 * 60 * MIN).stock, 5)
})

test('below the cap: one play per whole 30 minutes, the part waited carries over, never past the cap', () => {
  // Spent at the cap: the clock starts at the spend.
  const spent = spendAt({ stock: 3, asOfMs: T - 999 * MIN }, T)
  assert.deepEqual(spent, { ok: true, record: { stock: 2, asOfMs: T } })
  assert.deepEqual(energyView(spent.record, T), { stock: 2, cap: 3, nextInMs: 30 * MIN, regenMs: 30 * MIN })
  assert.equal(energyAt(spent.record, T + 30 * MIN - 1).stock, 2)
  assert.equal(energyAt(spent.record, T + 30 * MIN).stock, 3)
  // From 0: 29 minutes waited carry into the next spend.
  const empty = { stock: 0, asOfMs: T }
  assert.deepEqual(energyAt(empty, T + 29 * MIN), { stock: 0, asOfMs: T })
  assert.deepEqual(energyView(empty, T + 29 * MIN).nextInMs, MIN)
  assert.deepEqual(energyAt(empty, T + 61 * MIN), { stock: 2, asOfMs: T + 60 * MIN }, 'two whole periods, the minute over kept')
  assert.deepEqual(energyView(empty, T + 61 * MIN).nextInMs, 29 * MIN)
  assert.deepEqual(energyAt(empty, T + 95 * MIN), { stock: 3, asOfMs: T + 95 * MIN }, 'capped at 3')
  assert.deepEqual(energyAt(empty, T + 9999 * MIN).stock, 3)
  // A spend below the cap keeps the clock where it was.
  assert.deepEqual(spendAt(empty, T + 61 * MIN), { ok: true, record: { stock: 1, asOfMs: T + 60 * MIN } })
})

test('at 0 a spend is refused, and the view says when the next play comes', () => {
  const empty = { stock: 0, asOfMs: T }
  assert.deepEqual(spendAt(empty, T + 10 * MIN), { ok: false, record: { stock: 0, asOfMs: T } })
  assert.deepEqual(energyView(empty, T + 10 * MIN), { stock: 0, cap: 3, nextInMs: 20 * MIN, regenMs: 30 * MIN })
  assert.equal(spendAt(empty, T + 30 * MIN).ok, true, 'refused only until the play has come back')
})

test('a refund gives the play back: from the start stock back to it, from the cap back to the cap', () => {
  const six = spendAt(null, T).record
  assert.deepEqual(refundAt(six, T + 5 * MIN), { stock: ENERGY.start, asOfMs: T + 5 * MIN })
  const three = spendAt({ stock: 3, asOfMs: T }, T).record
  const back = refundAt(three, T + 5 * MIN)
  assert.equal(back.stock, 3)
  assert.equal(energyView(back, T + 5 * MIN).nextInMs, null, 'back at the cap, no clock')
  // Below the cap, the clock keeps running.
  assert.deepEqual(refundAt({ stock: 0, asOfMs: T }, T + 10 * MIN), { stock: 1, asOfMs: T })
})

test('the accepted overshoot: a run spent at the cap and extracted after 30 minutes ends at cap + 1, and no higher after another', () => {
  const spent = spendAt({ stock: 3, asOfMs: T }, T).record
  const back = refundAt(spent, T + 31 * MIN)
  assert.equal(back.stock, 4)
  // Above the cap a spend starts no clock, so the same again ends at 4.
  const again = refundAt(spendAt(back, T + 40 * MIN).record, T + 80 * MIN)
  assert.equal(again.stock, 4)
})

test('another server\'s clock a little behind: no play is taken away, and the wait never shows over 30 minutes', () => {
  const record = { stock: 1, asOfMs: T }
  assert.deepEqual(energyAt(record, T - 5000), record)
  assert.equal(energyView(record, T - 5000).nextInMs, 30 * MIN)
})

// --- the rewarded-video refill (g2-6d; decision #62 addendum 2026-11-13) ---

const DAY = 24 * 60 * MIN
/** 2026-11-14 10:00 UTC. */
const AT = Date.parse('2026-11-14T10:00:00.000Z')
/** No play left, as of `AT` (the clock started then). */
const EMPTY = { stock: 0, asOfMs: AT }

test('the refill\'s limits are #62\'s: one per 30 min, three per UTC day', () => {
  assert.deepEqual({ ...AD_REFILL }, { cooldownMs: 30 * MIN, perDay: 3 })
})

test('a refill only at 0 plays: refused with any play left, counting the plays regenerated since', () => {
  for (const stock of [1, 2, 3, 4, 10]) {
    assert.deepEqual(adRefillCheck({ stock, asOfMs: AT }, null, AT), { ok: false, reason: 'plays_left' }, `stock ${stock}`)
  }
  // A new account (no record) has the start stock.
  assert.deepEqual(adRefillCheck(null, null, AT), { ok: false, reason: 'plays_left' })
  assert.deepEqual(adRefillCheck(EMPTY, null, AT + 30 * MIN - 1), { ok: true })
  assert.deepEqual(adRefillCheck(EMPTY, null, AT + 30 * MIN), { ok: false, reason: 'plays_left' }, 'a regenerated play counts')
  // Refused: nothing changes.
  const refused = adRefillAt({ stock: 1, asOfMs: AT }, null, AT + MIN)
  assert.deepEqual(refused, { ok: false, reason: 'plays_left', energy: { stock: 1, asOfMs: AT }, ads: null })
})

test('a refill fills to the cap exactly, at the cap so no clock runs, and counts one for the UTC day', () => {
  const done = adRefillAt(EMPTY, null, AT + 5 * MIN)
  assert.deepEqual(done, { ok: true, energy: { stock: ENERGY.cap, asOfMs: AT + 5 * MIN }, ads: { lastAtMs: AT + 5 * MIN, day: '2026-11-14', count: 1 } })
  // Hours later, still the cap: nothing regenerates above it.
  assert.deepEqual(energyAt(done.energy, AT + 10 * 60 * MIN), { stock: ENERGY.cap, asOfMs: AT + 10 * 60 * MIN })
})

test('the 30-minute limit: refused until 30 min after the last refill, with the time left', () => {
  const ads = { lastAtMs: AT, day: '2026-11-14', count: 1 }
  assert.deepEqual(adRefillCheck(EMPTY, ads, AT + 10 * MIN), { ok: false, reason: 'cooldown', nextInMs: 20 * MIN })
  assert.deepEqual(adRefillCheck(EMPTY, ads, AT + 30 * MIN - 1), { ok: false, reason: 'cooldown', nextInMs: 1 })
  // At 30 min the stock regenerated one play; a stock emptied again then is allowed.
  assert.deepEqual(adRefillCheck({ stock: 0, asOfMs: AT + 30 * MIN }, ads, AT + 30 * MIN), { ok: true })
  assert.deepEqual(adRefillView(EMPTY, ads, AT + 10 * MIN), { offered: false, nextInMs: 20 * MIN })
  // A refill stamped in the future (another server's clock ahead) waits one cooldown at most.
  assert.deepEqual(adRefillCheck(EMPTY, { ...ads, lastAtMs: AT + DAY }, AT), { ok: false, reason: 'cooldown', nextInMs: 30 * MIN })
})

test('three per UTC day: the fourth waits for UTC midnight, and the count starts again on the next day', () => {
  let energy: EnergyRecord | null = EMPTY
  let ads: AdRefillRecord | null = null
  for (let i = 0; i < 3; i++) {
    const at = AT + i * 30 * MIN
    const done = adRefillAt({ stock: 0, asOfMs: at }, ads, at)
    assert.equal(done.ok, true, `refill ${i + 1}`)
    energy = done.energy
    ads = done.ads
  }
  assert.deepEqual(ads, { lastAtMs: AT + 60 * MIN, day: '2026-11-14', count: 3 })
  const fourth = AT + 90 * MIN
  // 11:30 UTC: 12.5 hours to midnight.
  assert.deepEqual(adRefillCheck({ stock: 0, asOfMs: fourth }, ads, fourth), { ok: false, reason: 'daily_cap', nextInMs: 12.5 * 60 * MIN })
  assert.deepEqual(adRefillView({ stock: 0, asOfMs: fourth }, ads, fourth), { offered: false, nextInMs: 12.5 * 60 * MIN })
  const midnight = Date.parse('2026-11-15T00:00:00.000Z')
  assert.deepEqual(adRefillCheck({ stock: 0, asOfMs: midnight - 1 }, ads, midnight - 1), { ok: false, reason: 'daily_cap', nextInMs: 1 })
  const next = adRefillAt({ stock: 0, asOfMs: midnight }, ads, midnight)
  assert.deepEqual(next.ads, { lastAtMs: midnight, day: '2026-11-15', count: 1 }, 'the new day counts from 1')
  // The cap a refill just before midnight hit, with the cooldown ending after it: the later one.
  const late = { lastAtMs: midnight - 10 * MIN, day: '2026-11-14', count: 3 }
  assert.deepEqual(adRefillCheck({ stock: 0, asOfMs: midnight - 5 * MIN }, late, midnight - 5 * MIN), { ok: false, reason: 'daily_cap', nextInMs: 25 * MIN })
  // And just after midnight the cooldown still holds.
  assert.deepEqual(adRefillCheck({ stock: 0, asOfMs: midnight + MIN }, late, midnight + MIN), { ok: false, reason: 'cooldown', nextInMs: 19 * MIN })
  assert.equal(utcDay(midnight - 1), '2026-11-14')
  assert.equal(utcDay(midnight), '2026-11-15')
})

test('the view: offered only at 0 plays with both limits allowing; no timer with plays left', () => {
  assert.deepEqual(adRefillView(EMPTY, null, AT), { offered: true })
  assert.deepEqual(adRefillView({ stock: 2, asOfMs: AT }, { lastAtMs: AT, day: '2026-11-14', count: 3 }, AT), { offered: false })
})
