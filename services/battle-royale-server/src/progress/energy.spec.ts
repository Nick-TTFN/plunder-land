import test from 'node:test'
import assert from 'node:assert/strict'
import { ENERGY } from './xp'
import { energyAt, energyView, refundAt, spendAt } from './energy'

/**
 * Energy's arithmetic (decision #48 step 7): 1 play per 30 min, a cap of 3,
 * new accounts start with 6, nothing regenerates above the cap, a run costs 1
 * and an extraction gives it back.
 */

const MIN = 60_000
const T = 1_000_000_000

test('the numbers are #48\'s: 1 per 30 min, cap 3, start 6', () => {
  assert.deepEqual({ ...ENERGY }, { regenMs: 30 * MIN, cap: 3, start: 6 })
})

test('a new account (no record) has 6, and nothing regenerates above the cap', () => {
  assert.deepEqual(energyAt(null, T), { stock: 6, asOfMs: T })
  assert.deepEqual(energyView(null, T), { stock: 6, cap: 3, nextInMs: null, regenMs: 30 * MIN })
  // Six runs lost, and only from the fourth does the clock run.
  let record = null as ReturnType<typeof energyAt> | null
  for (let i = 0; i < 3; i++) {
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

test('a refund gives the play back: from 6 back to 6, from the cap back to the cap', () => {
  const six = spendAt(null, T).record
  assert.deepEqual(refundAt(six, T + 5 * MIN), { stock: 6, asOfMs: T + 5 * MIN })
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
