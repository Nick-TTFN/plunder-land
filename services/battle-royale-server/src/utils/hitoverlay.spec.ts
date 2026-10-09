import test from 'node:test'
import assert from 'node:assert/strict'
import { HitOverlay, multiplyTint } from '../../../../plunder-land-client/src/vfx/hitoverlay'

// Decision #52: a hit is an overlay (tint flash and a small jolt of the drawn
// body), shown by `RobotSprite` and `NpcSprite` over whatever plays.

/** Steps an overlay by `dt` over `seconds`, triggering every `every` s; returns the flash starts. */
function run (every: number, seconds: number, dt = 1 / 60): { starts: number[], maxJolt: number } {
  const o = new HitOverlay()
  const starts: number[] = []
  let maxJolt = 0
  let next = 0
  for (let t = 0; t < seconds; t += dt) {
    if (t >= next - 1e-9) {
      if (o.trigger()) starts.push(t)
      next += every
    }
    maxJolt = Math.max(maxJolt, Math.abs(o.jolt(1)))
    o.advance(dt)
  }
  return { starts, maxJolt }
}

test('damage every 250 ms tick flashes every other tick, not every tick', () => {
  const { starts } = run(0.25, 1.9)
  assert.deepEqual(starts.map((t) => Math.round(t * 100) / 100), [0, 0.5, 1, 1.5])
  // Hits further apart than the cap are each shown.
  assert.equal(run(0.5, 1.9).starts.length, 4)
})

test('the flash lasts FLASH_S and the jolt stays within a few px and is gone by JOLT_S', () => {
  const o = new HitOverlay()
  assert.equal(o.flashing, false)
  assert.equal(o.jolt(1), 0)
  assert.equal(o.trigger(), true)
  assert.equal(o.flashing, true)
  // Knocked back against the facing first.
  assert.ok(o.jolt(1) < 0 && o.jolt(-1) > 0)
  o.advance(HitOverlay.FLASH_S + 1e-6)
  assert.equal(o.flashing, false)
  o.advance(HitOverlay.JOLT_S)
  assert.equal(o.jolt(1), 0)
  assert.ok(run(0.25, 2).maxJolt <= HitOverlay.JOLT_PX)
  // Not shown again inside RETRIGGER_S of the last; then again.
  assert.equal(o.trigger(), false)
  o.advance(HitOverlay.RETRIGGER_S)
  // A death clears it.
  assert.equal(o.trigger(), true)
  o.clear()
  assert.equal(o.flashing, false)
  assert.equal(o.jolt(1), 0)
})

test('a finish colour through the hit tint is multiplied per channel', () => {
  assert.equal(multiplyTint(0xffffff, HitOverlay.TINT), HitOverlay.TINT)
  assert.equal(multiplyTint(0x000000, HitOverlay.TINT), 0)
  assert.equal(multiplyTint(0x808080, 0xff0000), 0x800000)
})
