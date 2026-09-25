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

test('key is unique across every cell a map can address', () => {
  const seen = new Map<number, string>()
  for (let q = -80; q <= 130; q++) {
    for (let r = -10; r <= 150; r++) {
      const k = Hex.key(q, r)
      const clash = seen.get(k)
      assert.equal(clash, undefined, `${q},${r} collides with ${clash} at key ${k}`)
      seen.set(k, `${q},${r}`)
    }
  }
})

test('key survives the negative q the axial skew produces', () => {
  // r grows downward and q leans back by r/2, so the left edge of a square map
  // reaches roughly q = -66. A packing that assumed q >= 0 would fold those
  // cells onto real ones and block terrain on the far side of the map.
  assert.notEqual(Hex.key(-66, 0), Hex.key(66, 0))
  assert.notEqual(Hex.key(-1, 0), Hex.key(0, 0))
  assert.notEqual(Hex.key(0, -1), Hex.key(0, 0))
})

test('a blocking cell leaves its neighbours standable', () => {
  // RADIUS is the inradius, so a player shoved off a blocked cell stops short of
  // the neighbouring centre. If it were the circumradius the push-out would
  // eject them past it and the grid would describe a world the collision code
  // does not agree with.
  const player = 2 * Math.sqrt(50)
  assert.ok(Hex.RADIUS + player < Hex.SIZE, 'push-out reaches past the next cell centre')
  assert.equal(Hex.RADIUS, Hex.SIZE / 2)
})

// --- line (decision #25) ------------------------------------------------------

const LINE_ORIGINS = [new Vector(0, 0), new Vector(-3, 51), new Vector(40, -20)]

const cellsOf = (cells: Vector[]): number[][] => cells.map((c) => [c.x, c.y])

test('a line is length + 1 cells from its start, each one step further out and next to the last', () => {
  for (const from of LINE_ORIGINS) {
    for (const d of disc(10)) {
      if (d.x === 0 && d.y === 0) continue
      const toward = from.add(d)
      for (const length of [0, 1, 5, 8, 12]) {
        const line = Hex.line(from, toward, length)
        assert.equal(line.length, length + 1)
        for (let i = 0; i <= length; i++) {
          assert.equal(Hex.distance(from, line[i]), i, `${d.x},${d.y} length ${length}: cell ${i}`)
          if (i > 0) assert.equal(Hex.distance(line[i - 1], line[i]), 1, `${d.x},${d.y}: cells ${i - 1} and ${i} not adjacent`)
        }
      }
    }
  }
})

test('the aimed cell is on its own line, at its distance, whenever it is within the length', () => {
  for (const from of LINE_ORIGINS) {
    for (const d of disc(8)) {
      if (d.x === 0 && d.y === 0) continue
      const toward = from.add(d)
      const line = Hex.line(from, toward, 8)
      const at = line[Hex.distance(from, toward)]
      assert.deepEqual([at.x, at.y], [toward.x, toward.y], `aimed ${d.x},${d.y} from ${from.x},${from.y}`)
    }
  }
})

test('aiming further out along the same line gives the same line', () => {
  // So a shot's cells depend on its direction, not on how far away the click was.
  for (const d of disc(4)) {
    if (d.x === 0 && d.y === 0) continue
    const base = cellsOf(Hex.line(new Vector(0, 0), d, 12))
    for (const k of [2, 3, 5]) {
      assert.deepEqual(cellsOf(Hex.line(new Vector(0, 0), d.multiply(k), 12)), base, `${d.x},${d.y} x${k}`)
    }
  }
})

test('a line along a cell edge breaks every tie the same way: lower s, then higher r', () => {
  // Toward DIRECTIONS[d] + DIRECTIONS[d + 1] the line runs exactly along the
  // edge between the two, and every odd sample is a tie. Pinned: this is the
  // LINE_NUDGE rule, and both packages must draw the same cells.
  const expected = [
    [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]],
    [[0, 0], [0, 1], [-1, 2], [-1, 3], [-2, 4]],
    [[0, 0], [-1, 1], [-2, 1], [-3, 2], [-4, 2]],
    [[0, 0], [-1, 0], [-1, -1], [-2, -1], [-2, -2]],
    [[0, 0], [1, -1], [1, -2], [2, -3], [2, -4]],
    [[0, 0], [1, 0], [2, -1], [3, -1], [4, -2]]
  ]
  for (let d = 0; d < 6; d++) {
    const a = Hex.DIRECTIONS[d]
    const b = Hex.DIRECTIONS[(d + 1) % 6]
    const edge = new Vector(a.x + b.x, a.y + b.y)
    for (const from of LINE_ORIGINS) {
      const got = cellsOf(Hex.line(from, from.add(edge), 4)).map(([q, r]) => [q - from.x, r - from.y])
      assert.deepEqual(got, expected[d], `edge ${d} from ${from.x},${from.y}`)
    }
  }
})

test('the line between two cells is the same cells whichever end it is drawn from', () => {
  for (const from of LINE_ORIGINS) {
    for (const d of disc(8)) {
      const n = Hex.distance(new Vector(0, 0), d)
      if (n === 0) continue
      const to = from.add(d)
      assert.deepEqual(
        cellsOf(Hex.line(to, from, n).reverse()),
        cellsOf(Hex.line(from, to, n)),
        `${from.x},${from.y} to ${to.x},${to.y}`
      )
    }
  }
})

test('a line toward its own start has no direction and is just the start', () => {
  assert.deepEqual(cellsOf(Hex.line(new Vector(4, -2), new Vector(4, -2), 8)), [[4, -2]])
})
