/**
 * The cells a skill's area covers, worked out on the client so an effect can
 * draw exactly the cells the server damages (decisions #18, #20).
 *
 * **This file imports nothing, on purpose.** The server's test suite imports it
 * (`services/battle-royale-server/src/skills/effectcells.spec.ts`) and checks
 * every function and constant here against the server's own: `World.FACING_INDEX`,
 * `World.CONE_CELLS`, the skills' `RINGS` and ranged range, and
 * `Hex.DIRECTIONS`. The client's `Vector` extends a pixi `Point`, so importing
 * `utils/hex.ts` from here would drag pixi into the server's tests.
 *
 * It is a port, not a mirror: `utils/hex.ts` is byte-identical in both packages
 * and must stay so, and none of this belongs there.
 */

export interface Cell { x: number, y: number }

/**
 * `Hex.DIRECTIONS`, copied so this file needs no imports: E, SE, SW, W, NW, NE,
 * clockwise from East in screen space. The spec asserts it still equals the
 * server's table.
 */
export const DIRECTIONS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
  { x: 1, y: -1 }
]

/** Server `MeleeAttack.RINGS`: 2 rings around the caster, 19 cells. */
export const MELEE_RINGS = 2
/** Server `ThrowFireball.BLAST_RINGS` and `Throwicicle.BLAST_RINGS`. */
export const BLAST_RINGS = 1
/** Server `FireBreath.RINGS`. */
export const FIRE_BREATH_RINGS = 4
/** Server `IceBreath.RINGS`. */
export const ICE_BREATH_RINGS = 3
/** Server `RangedAttack.range`, in world units (8 cells). */
export const RANGED_RANGE = 360

/**
 * Port of `World.FACING_INDEX`: the DIRECTIONS index nearest to a world-space
 * vector. Halfway facings round clockwise; a zero vector is East.
 */
export function facingIndex (x: number, y: number): number {
  const sixths = Math.atan2(y, x) / (Math.PI / 3)
  const index = Math.floor(sixths + 0.5 + 1e-9)
  return ((index % 6) + 6) % 6
}

/** `Hex.key`'s packing, so dedupe matches the server's exactly. */
function key (q: number, r: number): number {
  return (q + 1024) * 4096 + (r + 1024)
}

/**
 * Port of `World.CONE_CELLS`: `rings` rings of the 120-degree wedge in front of
 * `origin`, grown by the three forward neighbours of every cell and
 * deduplicated against the whole cone so far. The origin is not included.
 */
export function coneCells (origin: Cell, direction: number, rings: number): Cell[] {
  const turns = [(direction + 5) % 6, direction, (direction + 1) % 6]
  const result: Cell[] = []
  const seen = new Set<number>([key(origin.x, origin.y)])
  let frontier: Cell[] = [origin]
  for (let ring = 1; ring <= rings; ring++) {
    const next: Cell[] = []
    for (const cell of frontier) {
      for (const turn of turns) {
        const step = DIRECTIONS[turn]
        const q = cell.x + step.x
        const r = cell.y + step.y
        const k = key(q, r)
        if (seen.has(k)) continue
        seen.add(k)
        next.push({ x: q, y: r })
      }
    }
    for (const cell of next) result.push(cell)
    frontier = next
  }
  return result
}

/**
 * Every cell within `rings` steps of `origin`, origin included: the cell set of
 * `World.FIND_IN_CELLS` (`Hex.distance <= rings`). 1 ring is 7 cells, 2 is 19.
 */
export function discCells (origin: Cell, rings: number): Cell[] {
  const result: Cell[] = []
  for (let dq = -rings; dq <= rings; dq++) {
    const lo = Math.max(-rings, -dq - rings)
    const hi = Math.min(rings, -dq + rings)
    for (let dr = lo; dr <= hi; dr++) result.push({ x: origin.x + dq, y: origin.y + dr })
  }
  return result
}

/**
 * The direction index a breath effect holds, from the caster's cell and the
 * tip cell the effect record carries (`SectorArea.tipCell`: `rings` steps
 * straight out). Uses the axial difference, so it is exact whenever the client
 * agrees about the caster's cell, and snaps the same way `SectorArea` does
 * when it is one cell out.
 */
export function directionToward (from: Cell, to: Cell): number {
  const dq = to.x - from.x
  const dr = to.y - from.y
  // Axial to screen space, unscaled: x = q + r / 2, y = r * sqrt(3) / 2.
  return facingIndex(dq + dr / 2, dr * Math.sqrt(3) / 2)
}

export interface Body { x: number, y: number, radius: number }

/**
 * Port of how `RangedAttack` picks what it hits: of the bodies
 * `World.FIND_BETWEEN_POINTS` finds on the segment (x1,y1)-(x2,y2), the one
 * whose centre is nearest the start. Returns its index in `bodies`, or -1.
 *
 * The client runs it over the positions it is drawing, which lag the server's
 * by the interpolation delay, so for a moving target the drawn end can differ
 * from the one the server hit. The damage number is the authority.
 */
export function firstOnLine (x1: number, y1: number, x2: number, y2: number, bodies: Body[]): number {
  const sqLength = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)
  if (sqLength === 0) return -1
  const minx = Math.min(x1, x2)
  const maxx = Math.max(x1, x2)
  const miny = Math.min(y1, y2)
  const maxy = Math.max(y1, y2)

  let found = -1
  let nearest = Infinity
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    if (b.x + b.radius < minx || b.x - b.radius > maxx) continue
    if (b.y + b.radius < miny || b.y - b.radius > maxy) continue
    const area = (x2 - x1) * (y1 - b.y) - (y2 - y1) * (x1 - b.x)
    if ((area * area) / sqLength >= b.radius * b.radius) continue
    const sq = (b.x - x1) * (b.x - x1) + (b.y - y1) * (b.y - y1)
    if (sq < nearest) {
      nearest = sq
      found = i
    }
  }
  return found
}
