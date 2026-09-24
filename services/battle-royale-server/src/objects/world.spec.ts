import test from 'node:test'
import assert from 'node:assert/strict'
// Must come before './world'. There is an existing import cycle - gameobject
// imports multiplayer, multiplayer imports world, world reaches back to
// gameobject - and entering it at world.ts leaves `GameObject` undefined when
// unit.ts evaluates `class Unit extends GameObject`. index.ts enters through
// multiplayer, which is the order that resolves, so this does the same.
// Reordering the imports in index.ts would break the server the same way.
import '../network/multiplayer'
import World from './world'
import { Hex } from '../utils/hex'
import { Path } from '../utils/path'
import { Vector } from '../utils/vector'

/**
 * The occupancy side of World only - block, unblock and the ring test. These are
 * plain statics that touch nothing else, so they can be exercised without a
 * Multiplayer instance or a world to put things in.
 */

/**
 * A cell comfortably inside a 4000-unit map, about (2000, 1800) in world units.
 *
 * Not the origin: occupancy answers "off the map" as well as "solid" now, and
 * (0, 0) is the map's own corner, so three of its six neighbours are outside it.
 */
const MID_CELL = Hex.toCell(new Vector(2000, 1800))
const MID = { q: MID_CELL.x, r: MID_CELL.y }

function clear (): void {
  World.BLOCKED.clear()
  // Occupancy answers "off the map" as well as "solid", so the size has to be
  // established. In the server this happens in the World constructor, which
  // runs at startup long before anything can path.
  World.mapSize = 4000
}

test('a blocked cell reads back blocked, on that plane only', () => {
  clear()
  World.block(MID.q, MID.r, 0)

  assert.equal(World.isBlocked(MID.q, MID.r, 0), true)
  // Planes are separate grids. A rock on the ground is not a rock in the air.
  assert.equal(World.isBlocked(MID.q, MID.r, -1), false)
  assert.equal(World.isBlocked(MID.q, MID.r + 1, 0), false)
})

test('unblocking releases exactly the one cell', () => {
  clear()
  World.block(MID.q, MID.r, 0)
  World.block(MID.q + 1, MID.r, 0)

  World.unblock(MID.q, MID.r, 0)

  assert.equal(World.isBlocked(MID.q, MID.r, 0), false)
  assert.equal(World.isBlocked(MID.q + 1, MID.r, 0), true)
})

test('unblocking a cell that was never blocked is harmless', () => {
  clear()
  World.unblock(MID.q, MID.r, 0)
  assert.equal(World.isBlocked(MID.q, MID.r, 0), false)
})

test('isClear with no rings tests only the cell itself', () => {
  clear()
  World.block(MID.q, MID.r, 0)

  assert.equal(World.isClear(MID.q, MID.r, 0, 0), false)
  assert.equal(World.isClear(MID.q + 1, MID.r, 0, 0), true)
})

test('isClear reaches exactly `rings` steps and no further', () => {
  clear()
  // Three steps due east.
  World.block(MID.q + 3, MID.r, 0)

  assert.equal(World.isClear(MID.q, MID.r, 0, 2), true, 'two rings should not see a cell three away')
  assert.equal(World.isClear(MID.q, MID.r, 0, 3), false, 'three rings should see it')
})

test('a blocker in any of the six directions is seen', () => {
  for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
    clear()
    const d = Hex.DIRECTIONS[i]
    World.block(MID.q + d.x, MID.r + d.y, 0)
    assert.equal(World.isClear(MID.q, MID.r, 0, 1), false, `direction ${i} was missed`)
  }
})

test('the ring test covers a true hex disc', () => {
  // The easy thing to get wrong is looping a square: it would also cover cells
  // further than `rings` steps away and reject spawns that are actually fine.
  const origin = { x: MID.q, y: MID.r }
  for (let dq = -2; dq <= 2; dq++) {
    for (let dr = -2; dr <= 2; dr++) {
      const distance = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
      if (distance !== 2) continue

      clear()
      World.block(origin.x + dq, origin.y + dr, 0)
      assert.equal(
        World.isClear(origin.x, origin.y, 0, 2), false,
        `rings=2 missed a blocker at ${dq},${dr}`
      )
      assert.equal(
        World.isClear(origin.x, origin.y, 0, 1), true,
        `rings=1 should not reach ${dq},${dr}`
      )
    }
  }
})

test('cells off the map count as blocked', () => {
  clear()

  // Nothing solid anywhere, but the map runs out.
  assert.equal(World.isBlocked(0, 0, 0), false)

  // West of the origin, and north of it.
  assert.equal(World.isBlocked(-1, 0, 0), true)
  assert.equal(World.isBlocked(0, -1, 0), true)

  // Past the eastern edge. The axial skew pulls that edge back by half a row,
  // so at r = 40 it sits 20 cells short of where it does at r = 0 - and a q
  // that is a perfectly ordinary distance elsewhere on the map is outside it.
  // Derived rather than written down: the last two times the cell size moved,
  // a literal here went stale and the test failed for the wrong reason.
  const edge = Math.floor(World.mapSize / Hex.SIZE) - 20
  assert.equal(World.isBlocked(edge, 40, 0), false)
  assert.equal(World.isBlocked(edge + 40, 40, 0), true)
})

test('a route cannot be built off the edge of the map', () => {
  clear()

  // This is the failure it guards: the search sees open ground, the unit walks
  // east, `Unit.update` clamps it to the map, and it presses against the
  // boundary forever aiming at a cell it can never enter.
  const blocked = (q: number, r: number): boolean => World.isBlocked(q, r, 0)
  assert.deepEqual(Path.find(new Vector(94, 40), new Vector(134, 40), blocked), [])
})
