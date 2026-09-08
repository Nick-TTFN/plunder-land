import test from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph at an objects/ file leaves
// GameObject undefined, so go in through multiplayer the way index.ts does.
import '../network/multiplayer'
import { Unit } from './unit'
import World from './world'
import { ObjectType } from './gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'

/** A bare unit standing on a given cell, with a route already assigned. */
function unitOn (cell: Vector, path: Vector[]): Unit {
  World.mapSize = 4000
  const at = Hex.toPosition(cell)
  const unit = new Unit(ObjectType.Mob, at.x, at.y, 10, 0)
  unit.path = path
  unit.pathIndex = 0
  return unit
}

const cells = (...pairs: Array<[number, number]>): Vector[] =>
  pairs.map(([q, r]) => new Vector(q, r))

test('walking a straight route advances one cell at a time', () => {
  const path = cells([11, 60], [12, 60], [13, 60])
  const unit = unitOn(new Vector(10, 60), path)

  unit.followPath()
  assert.equal(unit.pathIndex, 0, 'not standing on a route cell yet')

  // Up to the last cell only: arriving at that one ends the route, which clears
  // the index. That is asserted on its own below.
  for (let i = 0; i < path.length - 1; i++) {
    unit.position = Hex.toPosition(path[i])
    unit.followPath()
    assert.equal(unit.pathIndex, i + 1)
  }
})

test('a route that doubles back does not skip to the far side of itself', () => {
  // The reported bug. Leg one runs east, leg two comes straight back, so the
  // cell the unit is standing in appears again late in the route. Matching that
  // later occurrence sent the unit off toward the last leg's destination while
  // the whole of the first leg was still ahead of it.
  const here = new Vector(10, 60)
  const path = cells(
    [11, 60], [12, 60], [13, 60], // out
    [12, 60], [11, 60], [10, 60], [9, 60] // and back, through `here`
  )

  const unit = unitOn(here, path)
  unit.followPath()

  assert.equal(unit.pathIndex, 0, 'should still be aiming at the first cell of leg one')

  const target = unit.path[unit.pathIndex]
  assert.deepEqual(
    { q: target.x, r: target.y }, { q: 11, r: 60 },
    'aimed somewhere other than the next cell east'
  )
})

test('standing on a cell that repeats later advances by one, not to the repeat', () => {
  const path = cells([11, 60], [12, 60], [11, 60], [10, 60])
  const unit = unitOn(new Vector(10, 60), path)

  unit.position = Hex.toPosition(path[0]) // on (11,60), which repeats at index 2
  unit.followPath()

  assert.equal(unit.pathIndex, 1)
})

test('a shove one cell ahead is recovered from, not walked back', () => {
  // The case the look-ahead exists for: push-out, or a tick covering a whole
  // cell, can carry a unit past a cell it never stood in.
  const path = cells([11, 60], [12, 60], [13, 60])
  const unit = unitOn(new Vector(10, 60), path)

  unit.position = Hex.toPosition(path[1]) // skipped straight to the second cell
  unit.followPath()

  assert.equal(unit.pathIndex, 2, 'should carry on from where it landed')
})

test('reaching the last cell ends the route', () => {
  const path = cells([11, 60], [12, 60])
  const unit = unitOn(new Vector(10, 60), path)

  unit.position = Hex.toPosition(path[0])
  unit.followPath()
  unit.position = Hex.toPosition(path[1])
  unit.followPath()

  assert.equal(unit.path.length, 0)
  assert.equal(unit.pathIndex, 0)
  assert.equal(unit.direction.getSquareMagnitude(), 0, 'should be standing still')
})
