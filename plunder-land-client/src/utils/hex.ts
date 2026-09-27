import { Vector } from './vector'

/**
 * Pointy-top hex grid in axial coordinates.
 *
 * Cells are `Vector`s, the same as positions and directions - the type does
 * double duty throughout this codebase and the variable name is what tells them
 * apart. A cell's `x` is axial `q`, its `y` is axial `r`. Always name one `cell`.
 *
 * Pointy-top rather than flat-top so that pure east and west movement exist:
 * the client flips a unit's sprite from its horizontal motion, and a grid with
 * no due-east neighbour makes that flip ambiguous on every step.
 *
 * **Mirrored in the client at the same path and the two copies must stay byte
 * identical**, the way `utils/vector.ts` already is. The client predicts its own
 * route by running this same maths, and it agrees with the server only for as
 * long as the code does. `mirror.spec.ts` fails if they drift.
 */
export class Hex {
  /**
   * Distance between the centres of two adjacent cells, in world units.
   *
   * Not the circumradius - this is the number that matters, because it is one
   * step of movement.
   *
   * It was 35, chosen so that the 140 u/s base speed covered exactly one cell
   * per 250 ms tick. That was a tuning argument and it lost to a rendering one:
   * the player sprite is 50 px tall and the client draws the world at 1:1, so a
   * 35-unit cell was visibly smaller than the character standing on it and the
   * grid read as background texture rather than as the thing you move across.
   * At 45 a cell is about the size of the character, which is what makes a
   * route legible. Movement is continuous along the path rather than a cell per
   * tick, so nothing depended on the old coincidence - a cell is now about 1.3
   * ticks and no speed changed.
   */
  static SIZE = 45

  /**
   * Collision radius of a cell that blocks, in world units - the hex's inradius,
   * so the circle sits inside the cell rather than spilling into its neighbours.
   *
   * A unit pushed off a blocked cell ends up `RADIUS + its own radius` from the
   * centre, which for a player is about 37 against a 45-unit spacing. It can
   * still stand on the adjacent cell, which is the property that keeps push-out
   * and the grid describing the same world.
   */
  static RADIUS = Hex.SIZE / 2

  /** sqrt(3)/2. The vertical spacing between rows is SIZE times this. */
  private static readonly ROW = Math.sqrt(3) / 2

  /**
   * A cell as a single number, for use as a Set or Map key.
   *
   * Valid for q and r in [-1024, 3071], which covers any map this engine can
   * address: a 4000-unit world is about 89 cells wide, and the axial skew puts
   * q no lower than about -51.
   */
  static key (q: number, r: number): number {
    return (q + 1024) * 4096 + (r + 1024)
  }

  /**
   * The six neighbours, clockwise from east in screen space (y grows downward):
   * E, SE, SW, W, NW, NE.
   *
   * **The order is a wire contract.** A facing is sent as an index into this
   * array and a path as a sequence of them, so entries may never be reordered -
   * the same rule that governs `Player.skills` and `GameObject.fieldOrder`.
   */
  static DIRECTIONS: Vector[] = [
    new Vector(1, 0),
    new Vector(0, 1),
    new Vector(-1, 1),
    new Vector(-1, 0),
    new Vector(0, -1),
    new Vector(1, -1)
  ]

  /** Centre of a cell, in world units. */
  static toPosition (cell: Vector): Vector {
    return new Vector(
      Hex.SIZE * (cell.x + cell.y / 2),
      Hex.SIZE * Hex.ROW * cell.y
    )
  }

  /** The cell containing a world position. */
  static toCell (value: Vector): Vector {
    const r = value.y / (Hex.SIZE * Hex.ROW)
    const q = value.x / Hex.SIZE - r / 2
    return Hex.round(q, r)
  }

  /**
   * Nearest cell to a fractional axial coordinate.
   *
   * Rounds in cube space and then repairs whichever axis moved furthest, because
   * rounding q and r independently produces coordinates that are not on the grid
   * at all - it lands outside the cell roughly a third of the time.
   */
  static round (q: number, r: number): Vector {
    const y = -q - r

    let rq = Math.round(q)
    let ry = Math.round(y)
    let rr = Math.round(r)

    const dq = Math.abs(rq - q)
    const dy = Math.abs(ry - y)
    const dr = Math.abs(rr - r)

    if (dq > dy && dq > dr) rq = -ry - rr
    else if (dy > dr) ry = -rq - rr
    else rr = -rq - ry

    // `| 0` rather than the bare values: Math.round(-0.4) is -0, and -0 is not 0
    // to Object.is, to a Map key, or to a strict deep-equal. A cell that
    // sometimes carries a negative zero compares unequal to the identical cell
    // built any other way, which is exactly the kind of intermittent mismatch
    // that would break client/server path agreement at the origin.
    return new Vector(rq | 0, rr | 0)
  }

  /** The neighbour of `cell` in direction `index`, an index into DIRECTIONS. */
  static neighbour (cell: Vector, index: number): Vector {
    const d = Hex.DIRECTIONS[index]
    return new Vector(cell.x + d.x, cell.y + d.y)
  }

  /**
   * True if a cell's centre lies inside a square map of `size` units.
   *
   * Pathfinding needs this because nothing else stops a route leaving the map:
   * occupancy only knows about obstacles, and `Unit.update` clamps the position
   * to the map afterwards. A route that runs off the edge therefore looks
   * perfectly walkable to the search, and the unit ends up pressed against the
   * boundary aiming at a cell it can never reach - stuck, with no error anywhere.
   *
   * Scalar rather than going through `toPosition`, because this is called once
   * per neighbour inside the search loop and a Vector per call is exactly the
   * allocation the pathfinder is built to avoid.
   */
  static onMap (q: number, r: number, size: number): boolean {
    const y = Hex.SIZE * Hex.ROW * r
    if (y < 0 || y > size) return false
    const x = Hex.SIZE * (q + r / 2)
    return x >= 0 && x <= size
  }

  /**
   * Every cell on a map `size` units across, in one fixed order: rows top to
   * bottom, cells left to right. A consumed order: `hello.voids` is run-length
   * encoded over it, so both sides must walk it identically (this file is
   * mirrored). Bounds from the map's corners, padded by one; `onMap` trims.
   */
  static mapCells (size: number): Vector[] {
    const qMin = Hex.toCell(new Vector(0, size)).x - 1
    const qMax = Hex.toCell(new Vector(size, 0)).x + 1
    const rMax = Hex.toCell(new Vector(size, size)).y + 1
    const cells: Vector[] = []
    for (let r = -1; r <= rMax; r++) {
      for (let q = qMin; q <= qMax; q++) if (Hex.onMap(q, r, size)) cells.push(new Vector(q, r))
    }
    return cells
  }

    /** Steps between two cells. */
  static distance (a: Vector, b: Vector): number {
    const q = a.x - b.x
    const r = a.y - b.y
    return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2
  }

  /**
   * The nudge added to every point of a `line` before it is rounded, in axial
   * q and r (cube s gets -3e-6). Three different sizes, summing to zero in
   * cube space.
   *
   * A line that runs exactly along the edge between two cells samples points
   * that are an exact tie, and without it which cell wins would be decided by
   * `Math.round` rounding halves up and by the order of the comparisons in
   * `round` - an accident of the code rather than a rule. The nudge decides
   * every such tie the same way, toward where it points: the cell with the
   * lower cube s, and of two with equal s the one with the higher r. It is far
   * too small (millionths of a cell, against a margin of at least
   * 1 / (2 * distance) on a sample that is not a tie) to move anything else.
   * Pinned by hex.spec.ts.
   */
  static readonly LINE_NUDGE_Q = 1e-6
  static readonly LINE_NUDGE_R = 2e-6

  /**
   * The cells on the straight line from `from` through `toward`, `length`
   * steps long, `from` first: `length + 1` cells, and cell i is exactly i steps
   * from `from`. When `toward` is within `length` it is on the line at index
   * `Hex.distance(from, toward)`, and the line carries on past it in the same
   * direction. `toward` equal to `from` gives no direction, and returns `[from]`
   * alone.
   *
   * Standard hex line drawing: interpolate in cube space and round each sample
   * to its cell, with `LINE_NUDGE_*` to settle ties. `RangedAttack` hits the
   * first unit on these cells (decision #25) and the client draws its beam
   * over them, which is why it lives in this mirrored file: the two must pick
   * the same cells, ties included.
   *
   * The sample is `(toward - from) * i / n` rather than a precomputed step
   * times i, so the aimed cell's own sample is exact.
   */
  static line (from: Vector, toward: Vector, length: number): Vector[] {
    const n = Hex.distance(from, toward)
    const cells = [new Vector(from.x, from.y)]
    if (n === 0) return cells
    const dq = toward.x - from.x
    const dr = toward.y - from.y
    for (let i = 1; i <= length; i++) {
      cells.push(Hex.round(
        from.x + Hex.LINE_NUDGE_Q + (dq * i) / n,
        from.y + Hex.LINE_NUDGE_R + (dr * i) / n
      ))
    }
    return cells
  }

  /**
   * Index into DIRECTIONS for the step from `from` to `to`, or -1 if they are
   * not neighbours. This is how a facing is derived from a path.
   */
  static directionOf (from: Vector, to: Vector): number {
    const q = to.x - from.x
    const r = to.y - from.y
    for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
      if (Hex.DIRECTIONS[i].x === q && Hex.DIRECTIONS[i].y === r) return i
    }
    return -1
  }
}
