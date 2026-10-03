import test from 'node:test'
import assert from 'node:assert/strict'
import { Fog, SEEN } from '../../../../plunder-land-client/src/objects/fog'
import { Hex } from './hex'
import { ARCHETYPE_INFO } from './archetypes'
import { Vector } from './vector'

/**
 * fog-of-war (M2): the client's fog model, run here because the client has no
 * test runner. It only depends on the mirrored `utils/hex.ts`.
 */

// #43, deliberate: 6 rings (it was 8); Periscope 10 (11 until 2026-10-03).
test('peep sees 6 rings: a disc of 1 + 3 x 6 x 7 = 127 cells, exactly the cells within 6 rings', () => {
  assert.equal(ARCHETYPE_INFO.peep.vision, 6)
  assert.equal(ARCHETYPE_INFO.periscope.vision, 10)
  const fog = new Fog()
  fog.reset(6)
  fog.update(10, -4, 0)
  let visible = 0
  for (let q = -10; q <= 30; q++) {
    for (let r = -25; r <= 15; r++) {
      const inside = Hex.distance(new Vector(q, r), new Vector(10, -4)) <= 6
      const seen = fog.state(q, r, 0)
      assert.equal(seen === SEEN.VISIBLE, inside, `cell ${q},${r}`)
      if (inside) visible++
    }
  }
  assert.equal(visible, 127)
})

test('cells left behind stay explored; never-seen ones are unknown', () => {
  const fog = new Fog()
  fog.reset(3)
  fog.update(0, 0, 0)
  assert.equal(fog.update(0, 0, 0), false, 'the same cell is not a change')
  assert.equal(fog.update(10, 0, 0), true)
  assert.equal(fog.state(0, 0, 0), SEEN.EXPLORED)
  assert.equal(fog.state(10, 0, 0), SEEN.VISIBLE)
  assert.equal(fog.state(5, 5, 0), SEEN.UNKNOWN)
})

test('explored is per layer, and a new run forgets it', () => {
  const fog = new Fog()
  fog.reset(3)
  fog.update(0, 0, 0)
  fog.update(0, 0, -1)
  assert.equal(fog.state(0, 0, -1), SEEN.VISIBLE)
  assert.equal(fog.state(0, 0, 0), SEEN.EXPLORED, 'layer 01 was seen, from before the portal')
  assert.equal(fog.state(20, 20, -2), SEEN.UNKNOWN)
  fog.reset(3)
  assert.equal(fog.state(0, 0, 0), SEEN.UNKNOWN)
})

test('no radius means no fog: everything reads visible', () => {
  const fog = new Fog()
  fog.reset(null)
  fog.update(0, 0, 0)
  assert.equal(fog.state(99, -99, -2), SEEN.VISIBLE)
})
