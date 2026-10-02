import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

/**
 * Walls (decision #44, 2026-10-01): short raised runs of cells inside the
 * islands the valleys leave. They block every robot's movement but Hopper's,
 * block shots, and are drawn standing up, so they are cover and chokepoints
 * where the islands were open floor. Void and the map edge still block
 * Hopper; walls are what its trait is for.
 *
 * Generated once per layer when the world is built (`World` constructor),
 * after the valleys and the gates, at random. Wall cells are blocked cells
 * (`World.BLOCKED`, blocker null) like void, so everything that avoids
 * blocked cells (mob steps, spawns, drops, StoneWall, the gates' clear discs)
 * avoids walls with no change, and are kept apart in `World.WALLS` for what
 * treats them differently. They reach the client as runs in `hello.walls`
 * (`encodeRuns` in valleys.ts), not as objects.
 *
 * The guarantees, which `walls.spec.ts` checks:
 * - The free ground stays one region: every robot can still reach every
 *   free cell (a segment that would cut any off, or force a detour of more
 *   than `DETOUR_RINGS`, is not placed).
 * - No wall on void, off the map, or in `keepOut` (the gates' clear discs).
 * - Segments never touch each other, so a wall reads as one piece and two
 *   can't close a pocket between them.
 */

/** A segment's length in cells: 2 to 5, a short run, not a maze. */
const MIN_LENGTH = 2
const MAX_LENGTH = 5

/** Tries per segment before the layer is taken as full. */
const ATTEMPTS = 40

/**
 * Wall cells for a map `size` units across: about `share` of the free
 * ground (provisional, decision #44), in straight segments along one of the
 * six hex directions. `blocked` is what is already solid (the valleys);
 * `keepOut` cells take no wall. `random` is injectable so a spec can pin a map.
 */
export function placeWalls (size: number, blocked: ReadonlySet<number>, keepOut: ReadonlySet<number>, share: number, random: () => number = Math.random): Set<number> {
  const cells = Hex.mapCells(size)
  const free: Vector[] = cells.filter((c) => !blocked.has(Hex.key(c.x, c.y)))
  const walls = new Set<number>()
  const target = Math.round(free.length * share)
  let misses = 0
  while (walls.size < target && misses < ATTEMPTS) {
    const start = free[Math.floor(random() * free.length)]
    const direction = Math.floor(random() * 6)
    const length = MIN_LENGTH + Math.floor(random() * (MAX_LENGTH - MIN_LENGTH + 1))
    const segment: number[] = []
    const segmentCells: Vector[] = []
    let cell = start
    for (let i = 0; i < length; i++) {
      const key = Hex.key(cell.x, cell.y)
      if (!Hex.onMap(cell.x, cell.y, size) || blocked.has(key) || keepOut.has(key) || walls.has(key) || touches(cell, walls)) break
      segment.push(key)
      segmentCells.push(cell)
      cell = Hex.neighbour(cell, direction)
    }
    if (segment.length < MIN_LENGTH || !staysConnected(size, blocked, walls, segment, segmentCells)) {
      misses++
      continue
    }
    misses = 0
    for (const key of segment) walls.add(key)
  }
  return walls
}

/** True if any neighbour of `cell` is already a wall. */
function touches (cell: Vector, walls: ReadonlySet<number>): boolean {
  for (let d = 0; d < 6; d++) {
    const n = Hex.neighbour(cell, d)
    if (walls.has(Hex.key(n.x, n.y))) return true
  }
  return false
}

/**
 * How far around a segment `staysConnected` looks for a way round it, in
 * rings. A segment whose sides can only meet by a longer detour is not
 * placed: as good a rule for play as for speed.
 */
const DETOUR_RINGS = 10

/**
 * True if the free ground is still one region with `segment` walled too.
 * Exact without a whole-layer fill: ground that was one region stays one if
 * and only if the segment's free neighbours can still all reach each other
 * (any path that ran through the segment can go round it between two of
 * them). Searched within `DETOUR_RINGS` of the segment's first cell, so a
 * segment needing a longer way round is refused (conservative).
 */
function staysConnected (size: number, blocked: ReadonlySet<number>, walls: ReadonlySet<number>, segment: readonly number[], cells: readonly Vector[]): boolean {
  const solid = (q: number, r: number): boolean => {
    const key = Hex.key(q, r)
    return !Hex.onMap(q, r, size) || blocked.has(key) || walls.has(key) || segment.includes(key)
  }
  const sides = new Map<number, Vector>()
  for (const cell of cells) {
    for (let d = 0; d < 6; d++) {
      const n = Hex.neighbour(cell, d)
      if (!solid(n.x, n.y)) sides.set(Hex.key(n.x, n.y), n)
    }
  }
  if (sides.size <= 1) return true
  const centre = cells[0]
  const [first] = sides.values()
  const seen = new Set<number>([Hex.key(first.x, first.y)])
  let found = 1
  const queue: Vector[] = [first]
  for (let i = 0; i < queue.length && found < sides.size; i++) {
    for (let d = 0; d < 6; d++) {
      const n = Hex.neighbour(queue[i], d)
      const k = Hex.key(n.x, n.y)
      if (seen.has(k) || solid(n.x, n.y) || Hex.distance(n, centre) > DETOUR_RINGS) continue
      seen.add(k)
      if (sides.has(k)) found++
      queue.push(n)
    }
  }
  return found === sides.size
}
