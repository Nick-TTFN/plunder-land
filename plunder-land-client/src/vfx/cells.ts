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
export const RANGED_RANGE_CELLS = 6
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
 * An NPC's attack cells, structurally the mirror's `NpcAttack`
 * (`utils/archetypes.ts`), restated so this file still imports nothing.
 * `effectcells.spec.ts` checks every row of the mirror against it.
 */
export type AttackShape =
  | { readonly kind: 'lob', readonly range: number, readonly rings: number }
  | { readonly kind: 'disc', readonly rings: number }
  | { readonly kind: 'line', readonly length: number }

/**
 * How far an NPC's attack reaches from its cell, in rings: a disc its rings,
 * a line its length, a lob its range plus the blast's rings (the furthest
 * cell it can hit).
 */
export function attackReach (attack: AttackShape): number {
  switch (attack.kind) {
    case 'disc': return attack.rings
    case 'line': return attack.length
    case 'lob': return attack.range + attack.rings
  }
}

/**
 * The cells an NPC's attack covers: a disc round `origin` (its own cell), a
 * line of `length` cells straight out of `origin` along DIRECTIONS[direction]
 * (origin not included), or a lob's blast disc round `aim` (the landing
 * cell). `direction` is for a line and `aim` for a lob; either missing gives
 * no cells.
 */
export function attackCells (attack: AttackShape, origin: Cell, direction?: number, aim?: Cell): Cell[] {
  switch (attack.kind) {
    case 'disc': return discCells(origin, attack.rings)
    case 'lob': return aim === undefined ? [] : discCells(aim, attack.rings)
    case 'line': {
      if (direction === undefined) return []
      const step = DIRECTIONS[direction]
      const result: Cell[] = []
      for (let i = 1; i <= attack.length; i++) result.push({ x: origin.x + step.x * i, y: origin.y + step.y * i })
      return result
    }
  }
}

/**
 * How far a mob's attack reaches from its cell, in rings, for the threat cells
 * (world-markers, M2), or 0 for none. Boss: its FireBreath cone, which it can
 * turn to any of the six directions, so the whole disc. Gunner, Crawler and
 * any other mob with a shot: its RangedAttack range (`rangedCells`). An NPC
 * with `attack` cells: `attackReach` (the caller passes the row's `attack`;
 * one that doesn't gets 0 for those until it does). Grunts only touch (1 ring)
 * and are left out, or every grunt would stand in a red patch. Takes values,
 * not the row, so this file still imports nothing; `effectcells.spec.ts` pins
 * it to the server's numbers.
 */
export function threatRingsOf (key: string, kind: string, rangedCells: number | null, attack?: AttackShape): number {
  if (kind !== 'mob') return 0
  if (key === 'boss') return FIRE_BREATH_RINGS
  if (key === 'gunner') return rangedRangeCells(rangedCells, true)
  if (rangedCells !== null) return rangedCells
  if (attack !== undefined) return attackReach(attack)
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

/**
 * The cells of a Compactor's shockwave (effect 14, decision #51, l1-6) from
 * the caster's cell as the client sees it and the line's uncut tip the effect
 * carries: the direction snapped from caster to tip (`directionToward`, exact
 * even when the client places the caster a cell off), the origin `length`
 * steps back from the tip, and `attackCells`' line from there, cut at the
 * first cell `onMap` refuses, as server `Shockwave.lineCells` cuts at the
 * map's edge. `shockwave.spec.ts` checks it against the server.
 */
export function lineFromTip (casterCell: Cell, tip: Cell, length: number, onMap: (q: number, r: number) => boolean): Cell[] {
  const direction = directionToward(casterCell, tip)
  const step = DIRECTIONS[direction]
  const origin = { x: tip.x - step.x * length, y: tip.y - step.y * length }
  const result: Cell[] = []
  for (const cell of attackCells({ kind: 'line', length }, origin, direction)) {
    if (!onMap(cell.x, cell.y)) break
    result.push(cell)
  }
  return result
}

export interface Body {
  /** Where the viewer draws the unit. */
  x: number
  y: number
  /** The cell under `x`, `y` (`cellOf`), which is what decides if it is on the line. */
  cell: Cell
  /**
   * Its archetype's `bodyRings` (ring-footprint): with 1, every cell within a
   * ring of `cell` is on the line too, as the server's `World.BODIES` makes
   * it. Pass it only for a unit a player's shot can stop on (a mob); 0 or
   * missing is the one cell.
   */
  rings?: number
}

/** The earliest index in `line` of any cell of `body` (its `cell`, and its ring with `rings`), or -1. */
export function lineIndexOf (line: Cell[], body: Body): number {
  const cells = (body.rings ?? 0) > 0 ? discCells(body.cell, body.rings as number) : [body.cell]
  let best = -1
  for (let i = 0; i < line.length && best < 0; i++) {
    for (const c of cells) {
      if (c.x === line[i].x && c.y === line[i].y) {
        best = i
        break
      }
    }
  }
  return best
}

/**
 * Port of `World.FIRST_ON_LINE`, `RangedAttack`'s hit test (decision #25): the
 * body standing on the earliest cell of `line` (a `Hex.line`, caster's cell
 * first; a body with `rings` stands on each of its cells), and of several on
 * that cell the one nearest (fromX, fromY). Returns
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
    let index = order.get(key(b.cell.x, b.cell.y))
    if ((b.rings ?? 0) > 0) {
      // A body is on the line at the earliest of its cells.
      for (const c of discCells(b.cell, b.rings as number)) {
        const at = order.get(key(c.x, c.y))
        if (at !== undefined && (index === undefined || at < index)) index = at
      }
    }
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
