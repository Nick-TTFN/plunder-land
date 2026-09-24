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

  // Up to the last cell only: the index is capped there, so standing on it
  // leaves the index alone rather than advancing. Asserted on its own below.
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

test('entering the last cell is not arriving at it', () => {
  // The regression. `followPath` used to end the route as soon as the unit's
  // cell matched the last cell of it, which is the moment it crosses the
  // boundary - so a walk stopped about half a cell short of the middle. It has
  // to keep aiming at that centre until `walkPath` lands on it.
  const path = cells([11, 60], [12, 60])
  const unit = unitOn(new Vector(10, 60), path)

  const centre = Hex.toPosition(path[1])
  // Just inside the last cell, a third of the way in from the near edge.
  unit.position = new Vector(centre.x - Hex.SIZE * 0.3, centre.y)
  unit.followPath()

  assert.equal(unit.path.length, 2, 'the route was dropped on entering the cell')
  assert.equal(unit.pathIndex, 1, 'should still be aiming at the last cell')
})

test('a walk comes to rest on the last cell centre, not where it entered it', () => {
  // Runs the real loop - `followPath` then `walkPath`, a tick's travel at a
  // time - because the bug was in the interaction between the two and neither
  // shows it alone. 35 units is 140 u/s over a 250 ms tick, which is
  // deliberately not a whole cell: when it was, the two crossings fell in the
  // same tick and `walkPath` always reached the centre first, which is why this
  // stayed hidden until the cell grew.
  const path = cells([11, 60], [12, 60], [13, 60])
  const unit = unitOn(new Vector(10, 60), path)

  for (let tick = 0; tick < 20 && unit.path.length > 0; tick++) {
    unit.followPath()
    if (unit.path.length === 0) break
    const walked = unit.walkPath(unit.position.x, unit.position.y, 35)
    unit.position = new Vector(walked.x, walked.y)
  }

  const centre = Hex.toPosition(path[path.length - 1])
  assert.equal(unit.path.length, 0, 'the route never finished')
  assert.ok(
    Math.hypot(unit.position.x - centre.x, unit.position.y - centre.y) < 1e-9,
    `came to rest ${Math.hypot(unit.position.x - centre.x, unit.position.y - centre.y)} units off the centre`
  )
  assert.equal(unit.direction.getSquareMagnitude(), 0, 'should be standing still')
})

test('facing starts East, follows every non-zero heading, and survives stop()', () => {
  const unit = unitOn(new Vector(10, 60), [])
  assert.deepEqual({ x: unit.facing.x, y: unit.facing.y }, { x: 1, y: 0 }, 'default is not East')

  // The AI routines' path: setDirectionTo a point well away.
  unit.setDirectionTo(unit.position.x, unit.position.y - 500)
  assert.ok(Math.abs(unit.facing.x) < 1e-9 && Math.abs(unit.facing.y + 1) < 1e-9, 'did not face north')

  unit.stop()
  assert.equal(unit.direction.getSquareMagnitude(), 0, 'stop() left a heading')
  assert.ok(Math.abs(unit.facing.y + 1) < 1e-9, 'stop() cleared the facing')

  // Aiming at the point it stands on is a zero vector: must not face anywhere new.
  unit.setDirectionTo(unit.position.x, unit.position.y)
  assert.ok(Math.abs(unit.facing.y + 1) < 1e-9, 'a zero heading changed the facing')

  // A raw assignment of an unnormalised vector still gives a unit-length
  // facing: Dash scales it straight into an impulse.
  unit.direction = new Vector(-3, 4)
  assert.ok(Math.abs(unit.facing.getMagnitude() - 1) < 1e-9, 'facing is not unit length')
  assert.ok(Math.abs(unit.facing.x + 0.6) < 1e-9 && Math.abs(unit.facing.y - 0.8) < 1e-9)
})

test('the path re-aim keeps facing along the route', () => {
  const unit = unitOn(new Vector(10, 60), cells([9, 60], [8, 60]))
  unit.followPath()
  assert.ok(unit.facing.x < -0.99, 'facing does not point west along the route')
})
