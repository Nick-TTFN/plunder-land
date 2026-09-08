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
   * step of movement. At the 140 u/s base speed and a 250 ms tick it is exactly
   * one cell per tick, which is why the existing tuning carries over.
   */
  static SIZE = 35

  /** sqrt(3)/2. The vertical spacing between rows is SIZE times this. */
  private static readonly ROW = Math.sqrt(3) / 2

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

  /** Steps between two cells. */
  static distance (a: Vector, b: Vector): number {
    const q = a.x - b.x
    const r = a.y - b.y
    return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2
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
