import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector } from './vector'
import { Hex } from './hex'
import { Path } from './path'

const OPEN = (): boolean => false

/** A predicate blocking exactly the listed "q,r" cells. */
function walls (...cells: Array<[number, number]>): (q: number, r: number) => boolean {
  const blocked = new Set(cells.map(([q, r]) => `${q},${r}`))
  return (q, r) => blocked.has(`${q},${r}`)
}

/** Every step adjacent to the last, none blocked, ending on the destination. */
function assertWalkable (
  from: Vector,
  to: Vector,
  path: Vector[],
  isBlocked: (q: number, r: number) => boolean
): void {
  assert.ok(path.length > 0, 'expected a path')

  let previous = from
  for (const cell of path) {
    assert.equal(
      Hex.distance(previous, cell), 1,
      `${previous.x},${previous.y} -> ${cell.x},${cell.y} is not a single step`
    )
    assert.equal(isBlocked(cell.x, cell.y), false, `walked into ${cell.x},${cell.y}`)
    previous = cell
  }

  assert.deepEqual({ q: previous.x, r: previous.y }, { q: to.x, r: to.y })
}

test('open ground gives the shortest possible path', () => {
  const from = new Vector(0, 0)
  for (const to of [new Vector(4, 0), new Vector(0, 5), new Vector(3, -3), new Vector(-2, 4)]) {
    const path = Path.find(from, to, OPEN)
    assertWalkable(from, to, path, OPEN)
    assert.equal(path.length, Hex.distance(from, to))
  }
})

test('the first step is a move, and the origin is not in the path', () => {
  const from = new Vector(7, -3)
  const to = new Vector(9, -3)
  const path = Path.find(from, to, OPEN)

  assert.equal(path.length, 2)
  assert.equal(Hex.distance(from, path[0]), 1)
  for (const cell of path) {
    assert.ok(cell.x !== from.x || cell.y !== from.y, 'origin leaked into the path')
  }
})

test('paths are returned in absolute cells, not offsets from the origin', () => {
  // The search works in offsets internally; a missing re-base here would send
  // every unit toward the middle of the map.
  const from = new Vector(50, -20)
  const to = new Vector(53, -20)
  const path = Path.find(from, to, OPEN)
  assertWalkable(from, to, path, OPEN)
  assert.deepEqual(path.map((c) => [c.x, c.y]), [[51, -20], [52, -20], [53, -20]])
})

test('a wall is routed around, not through', () => {
  const from = new Vector(0, 0)
  const to = new Vector(0, 3)
  // Seal the two direct approaches to the destination's south side.
  const isBlocked = walls([0, 1], [-1, 2], [0, 2], [1, 1])

  const path = Path.find(from, to, isBlocked)
  assertWalkable(from, to, path, isBlocked)
  assert.ok(path.length > Hex.distance(from, to), 'detour should be longer than the direct route')
})

test('a fully enclosed origin has nowhere to go', () => {
  const from = new Vector(0, 0)
  const ring = Hex.DIRECTIONS.map((d) => [d.x, d.y] as [number, number])
  assert.deepEqual(Path.find(from, new Vector(0, 4), walls(...ring)), [])
})

test('a blocked destination is refused outright', () => {
  assert.deepEqual(Path.find(new Vector(0, 0), new Vector(2, 0), walls([2, 0])), [])
})

test('the destination being the origin is not a path', () => {
  assert.deepEqual(Path.find(new Vector(3, 3), new Vector(3, 3), OPEN), [])
})

test('destinations beyond the window are unreachable', () => {
  const from = new Vector(0, 0)

  const edge = new Vector(Path.WINDOW, 0)
  assert.equal(Path.find(from, edge, OPEN).length, Path.WINDOW)

  const past = new Vector(Path.WINDOW + 1, 0)
  assert.deepEqual(Path.find(from, past, OPEN), [])
})

test('the window is a disc, so square corners are out of range', () => {
  // (WINDOW, WINDOW) sits inside the scratch array's square but is 2*WINDOW
  // steps away. Searching it would break the client/server agreement, which
  // depends on both sides bounding the search identically.
  const corner = new Vector(Path.WINDOW, Path.WINDOW)
  assert.equal(Hex.distance(new Vector(0, 0), corner), 2 * Path.WINDOW)
  assert.deepEqual(Path.find(new Vector(0, 0), corner, OPEN), [])
})

test('a walled-off destination inside the window is unreachable', () => {
  const to = new Vector(0, 4)
  const ring = Hex.DIRECTIONS.map((d) => [to.x + d.x, to.y + d.y] as [number, number])
  assert.deepEqual(Path.find(new Vector(0, 0), to, walls(...ring)), [])
})

test('repeated searches do not leak state into one another', () => {
  const from = new Vector(0, 0)
  const to = new Vector(0, 3)
  const isBlocked = walls([0, 1], [-1, 2], [0, 2], [1, 1])

  const detour = Path.find(from, to, isBlocked)
  const direct = Path.find(from, to, OPEN)
  const again = Path.find(from, to, isBlocked)

  assert.equal(direct.length, 3)
  assert.deepEqual(
    again.map((c) => [c.x, c.y]),
    detour.map((c) => [c.x, c.y]),
    'a search was contaminated by the one before it'
  )
})

test('a long detour along the window edge still terminates', () => {
  // A near-complete wall forces the search to visit most of the disc.
  const from = new Vector(0, 0)
  const to = new Vector(0, 2)
  // Row r=1 only reaches q=9 inside the disc - (10,1) is 11 steps away and out
  // of the window - so the gap has to be at 9 to be a gap at all.
  const barrier: Array<[number, number]> = []
  for (let q = -Path.WINDOW; q < Path.WINDOW; q++) {
    if (q === Path.WINDOW - 1) continue // one gap, far to the east
    barrier.push([q, 1])
  }
  const isBlocked = walls(...barrier)

  const path = Path.find(from, to, isBlocked)
  assertWalkable(from, to, path, isBlocked)
})
