/**
 * The cells a skill's area covers, worked out on the client so an effect can
 * draw exactly the cells the server damages (decisions #18, #20).
 *
 * **This file imports nothing, on purpose.** The server's test suite imports it
 * (`services/battle-royale-server/src/skills/effectcells.spec.ts`) and checks
 * every function and constant here against the server's own: `World.FACING_INDEX`,
 * `World.CONE_CELLS`, `World.FIRST_ON_LINE`, the skills' `RINGS` and ranged
 * ranges, and `Hex.DIRECTIONS`. The client's `Vector` extends a pixi `Point`,
 * so importing `utils/hex.ts` from here would drag pixi into the server's tests.
 *
 * It is a port, not a mirror: `utils/hex.ts` is byte-identical in both packages
 * and must stay so, and none of this belongs there. The one exception is the
 * ranged shot's line, `Hex.line`: it is plain grid maths and its tie-break has
 * to agree to the last bit, so it lives in the mirror and the effect imports it
 * from there (decision #25).
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
/**
 * Server `RangedAttack.RANGE_CELLS`: a player's ranged range, in cells. The
 * fallback for a player whose archetype this build doesn't know.
 */
export const RANGED_RANGE_CELLS = 8
/**
 * The gunner's range, in cells: the fallback for a mob whose archetype this
 * build doesn't know, which is what every mob's shot was drawn at before the
 * client could tell archetypes apart.
 */
export const RANGED_RANGE_MOB_CELLS = 6

/**
 * How far to draw a unit's ranged shot, in cells: its archetype's
 * `rangedCells` from the mirrored `utils/archetypes.ts`, which is the range the
 * server built its RangedAttack with. Pass `undefined` for no archetype or one
 * this build doesn't know, and null for one the table says has no RangedAttack
 * (only a newer server could make that shoot); both fall back to the unit
 * type's default. Takes the value, not the row, so this file still imports
 * nothing.
 */
export function rangedRangeCells (rangedCells: number | null | undefined, isMob: boolean): number {
  if (typeof rangedCells === 'number') return rangedCells
  return isMob ? RANGED_RANGE_MOB_CELLS : RANGED_RANGE_CELLS
}

/**
 * How far a mob's attack reaches from its cell, in rings, for the threat cells
 * (world-markers, M2), or 0 for none. Boss: its FireBreath cone, which it can
 * turn to any of the six directions, so the whole disc. Gunner: its
 * RangedAttack range (`rangedCells`). Grunts only touch (1 ring) and are left
 * out, or every grunt would stand in a red patch. Takes values, not the row,
 * so this file still imports nothing; `effectcells.spec.ts` pins it to the
 * server's numbers.
 */
export function threatRingsOf (key: string, kind: string, rangedCells: number | null): number {
  if (kind !== 'mob') return 0
  if (key === 'boss') return FIRE_BREATH_RINGS
  if (key === 'gunner') return rangedRangeCells(rangedCells, true)
  return 0
}

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

export interface Body {
  /** Where the viewer draws the unit. */
  x: number
  y: number
  /** The cell under `x`, `y` (`cellOf`), which is what decides if it is on the line. */
  cell: Cell
}

/**
 * Port of `World.FIRST_ON_LINE`, `RangedAttack`'s hit test (decision #25): the
 * body standing on the earliest cell of `line` (a `Hex.line`, caster's cell
 * first), and of several on that cell the one nearest (fromX, fromY). Returns
 * its index in `bodies`, or -1 if nobody is on the line. The caller leaves the
 * caster out.
 *
 * The client runs it over the positions it is drawing, which lag the server's
 * by the interpolation delay, so a beam at a unit crossing a cell edge can
 * stop on a different unit than the one the server hit. The damage number is
 * the authority.
 */
export function firstOnLine (line: Cell[], fromX: number, fromY: number, bodies: Body[]): number {
  const order = new Map<number, number>()
  line.forEach((cell, i) => {
    const k = key(cell.x, cell.y)
    if (!order.has(k)) order.set(k, i)
  })

  let found = -1
  let foundIndex = Infinity
  let foundSq = Infinity
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]
    const index = order.get(key(b.cell.x, b.cell.y))
    if (index === undefined || index > foundIndex) continue
    const sq = (b.x - fromX) * (b.x - fromX) + (b.y - fromY) * (b.y - fromY)
    if (index < foundIndex || sq < foundSq) {
      found = i
      foundIndex = index
      foundSq = sq
    }
  }
  return found
}
