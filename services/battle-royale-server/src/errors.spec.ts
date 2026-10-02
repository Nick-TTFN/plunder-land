import test from 'node:test'
import assert from 'node:assert/strict'
import { withinBudget } from './errors'

test('Sentry gets at most 30 events per 10 minutes, then a new window', () => {
  const t0 = 1_000_000_000
  let sent = 0
  for (let i = 0; i < 100; i++) if (withinBudget(t0 + i)) sent++
  assert.equal(sent, 30)
  assert.equal(withinBudget(t0 + 9 * 60 * 1000), false, 'still the same window')
  assert.equal(withinBudget(t0 + 10 * 60 * 1000), true, 'a new window')
})
