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

/**
 * The occupancy side of World only - block, unblock and the ring test. These are
 * plain statics that touch nothing else, so they can be exercised without a
 * Multiplayer instance or a world to put things in.
 */

function clear (): void {
  World.BLOCKED.clear()
}

test('a blocked cell reads back blocked, on that plane only', () => {
  clear()
  World.block(3, -2, 0)

  assert.equal(World.isBlocked(3, -2, 0), true)
  // Planes are separate grids. A rock on the ground is not a rock in the air.
  assert.equal(World.isBlocked(3, -2, -1), false)
  assert.equal(World.isBlocked(3, -1, 0), false)
})

test('unblocking releases exactly the one cell', () => {
  clear()
  World.block(0, 0, 0)
  World.block(1, 0, 0)

  World.unblock(0, 0, 0)

  assert.equal(World.isBlocked(0, 0, 0), false)
  assert.equal(World.isBlocked(1, 0, 0), true)
})

test('unblocking a cell that was never blocked is harmless', () => {
  clear()
  World.unblock(5, 5, 0)
  assert.equal(World.isBlocked(5, 5, 0), false)
})

test('isClear with no rings tests only the cell itself', () => {
  clear()
  World.block(0, 0, 0)

  assert.equal(World.isClear(0, 0, 0, 0), false)
  assert.equal(World.isClear(1, 0, 0, 0), true)
})

test('isClear reaches exactly `rings` steps and no further', () => {
  clear()
  // Three steps due east of the origin.
  World.block(3, 0, 0)

  assert.equal(World.isClear(0, 0, 0, 2), true, 'two rings should not see a cell three away')
  assert.equal(World.isClear(0, 0, 0, 3), false, 'three rings should see it')
})

test('a blocker in any of the six directions is seen', () => {
  for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
    clear()
    const d = Hex.DIRECTIONS[i]
    World.block(d.x, d.y, 0)
    assert.equal(World.isClear(0, 0, 0, 1), false, `direction ${i} was missed`)
  }
})

test('the ring test covers a true hex disc', () => {
  // The easy thing to get wrong is looping a square: it would also cover cells
  // further than `rings` steps away and reject spawns that are actually fine.
  const origin = { x: 0, y: 0 }
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
