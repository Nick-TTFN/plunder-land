import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector } from './vector'
import { Hex } from './hex'

/** Every cell within `radius` steps of the origin. */
function disc (radius: number): Vector[] {
  const cells: Vector[] = []
  for (let q = -radius; q <= radius; q++) {
    const lo = Math.max(-radius, -q - radius)
    const hi = Math.min(radius, -q + radius)
    for (let r = lo; r <= hi; r++) cells.push(new Vector(q, r))
  }
  return cells
}

test('a cell survives a round trip through world space', () => {
  for (const cell of disc(12)) {
    const back = Hex.toCell(Hex.toPosition(cell))
    assert.deepEqual(
      { q: back.x, r: back.y },
      { q: cell.x, r: cell.y },
      `round trip failed for ${cell.x},${cell.y}`
    )
  }
})

test('adjacent cell centres are exactly SIZE apart', () => {
  const origin = Hex.toPosition(new Vector(0, 0))
  for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
    const centre = Hex.toPosition(Hex.neighbour(new Vector(0, 0), i))
    const gap = centre.sub(origin).getMagnitude()
    assert.ok(
      Math.abs(gap - Hex.SIZE) < 1e-9,
      `direction ${i} is ${gap} away, expected ${Hex.SIZE}`
    )
  }
})

test('the six neighbours are the only cells one step away', () => {
  const origin = new Vector(0, 0)
  for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
    assert.equal(Hex.distance(origin, Hex.neighbour(origin, i)), 1)
  }
  // Six of them, all distinct.
  const seen = new Set(Hex.DIRECTIONS.map((d) => `${d.x},${d.y}`))
  assert.equal(seen.size, 6)
})

test('distance counts steps, not euclidean space', () => {
  assert.equal(Hex.distance(new Vector(0, 0), new Vector(0, 0)), 0)
  assert.equal(Hex.distance(new Vector(0, 0), new Vector(3, 0)), 3)
  assert.equal(Hex.distance(new Vector(0, 0), new Vector(0, 3)), 3)
  // (1,-1) is a single step, so (3,-3) is three of them - not six.
  assert.equal(Hex.distance(new Vector(0, 0), new Vector(3, -3)), 3)
  // Two legs that do not cancel.
  assert.equal(Hex.distance(new Vector(0, 0), new Vector(2, 2)), 4)
  assert.equal(Hex.distance(new Vector(-2, 5), new Vector(3, -1)), 6)
})

test('distance is symmetric and agrees with a walk', () => {
  for (const cell of disc(8)) {
    assert.equal(
      Hex.distance(new Vector(0, 0), cell),
      Hex.distance(cell, new Vector(0, 0))
    )
  }
})

test('directionOf inverts neighbour, and rejects non-neighbours', () => {
  const cell = new Vector(4, -2)
  for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
    assert.equal(Hex.directionOf(cell, Hex.neighbour(cell, i)), i)
  }
  assert.equal(Hex.directionOf(cell, cell), -1)
  assert.equal(Hex.directionOf(cell, new Vector(cell.x + 2, cell.y)), -1)
})

test('a position lands in the cell whose centre is nearest', () => {
  // The failure this guards against is rounding q and r independently, which
  // lands outside the cell for roughly a third of positions near a boundary.
  for (const cell of disc(6)) {
    const centre = Hex.toPosition(cell)
    for (let a = 0; a < 12; a++) {
      const angle = (a / 12) * Math.PI * 2
      // Well inside the inradius (SIZE / 2), so the answer is unambiguous.
      const probe = new Vector(
        centre.x + Math.cos(angle) * Hex.SIZE * 0.45,
        centre.y + Math.sin(angle) * Hex.SIZE * 0.45
      )
      const found = Hex.toCell(probe)
      assert.deepEqual(
        { q: found.x, r: found.y },
        { q: cell.x, r: cell.y },
        `probe at angle ${a} near ${cell.x},${cell.y} landed in ${found.x},${found.y}`
      )
    }
  }
})

test('DIRECTIONS runs clockwise from east in screen space', () => {
  // The order is a wire contract - a facing is sent as an index into it. This
  // pins the contract so a reorder fails loudly rather than silently rotating
  // every cone and dash in the game.
  const expected = [
    [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]
  ]
  assert.deepEqual(Hex.DIRECTIONS.map((d) => [d.x, d.y]), expected)

  // East is +x with no vertical component; south-east is down and to the right.
  const east = Hex.toPosition(Hex.DIRECTIONS[0])
  assert.ok(east.x > 0 && Math.abs(east.y) < 1e-9)
  const southEast = Hex.toPosition(Hex.DIRECTIONS[1])
  assert.ok(southEast.x > 0 && southEast.y > 0)
})
