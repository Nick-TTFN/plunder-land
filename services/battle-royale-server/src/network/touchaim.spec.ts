import test from 'node:test'
import assert from 'node:assert/strict'
import { TouchAim } from '../../../../plunder-land-client/src/skills/touchaim'

/** Aiming on touch (plunder-land-client/src/skills/touchaim.ts): arm, then the next world tap is the target. */

class Card {
  armed = false
  setArmed (armed: boolean): void { this.armed = armed }
}

test('client touch aim: one card armed at a time; a world tap takes it once; it times out', () => {
  TouchAim.disarm()
  const a = new Card()
  const b = new Card()
  assert.equal(TouchAim.take(0), undefined, 'nothing armed: the tap moves')
  TouchAim.arm(a, 1000)
  assert.equal(a.armed, true)
  TouchAim.arm(b, 1100)
  assert.deepEqual([a.armed, b.armed], [false, true], 'arming another disarms the first')
  assert.equal(TouchAim.take(1200), b)
  assert.equal(b.armed, false)
  assert.equal(TouchAim.take(1300), undefined, 'taken once')
  TouchAim.arm(a, 2000)
  assert.equal(TouchAim.armed(2000 + TouchAim.TIMEOUT_MS), a)
  assert.equal(TouchAim.take(2001 + TouchAim.TIMEOUT_MS), undefined, 'a forgotten arm never eats a move')
  assert.equal(a.armed, false)
})
