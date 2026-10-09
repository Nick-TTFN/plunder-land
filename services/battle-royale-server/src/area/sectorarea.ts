import { type Unit } from '../objects/unit'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import World from '../objects/world'
import Area from './area'

/**
 * A cone of hex cells in front of its caster, re-evaluated on every test, so it
 * follows the caster's current cell for its whole lifetime.
 *
 * The cone is `World.CONE_CELLS`: a neighbour expansion along one of the six
 * hex directions (decision #20). An aimed breath fixes that direction when it
 * is cast and holds it (decision #21); an unaimed one follows the caster's
 * facing, snapped, on every evaluation.
 */
export default class SectorArea extends Area {
  /** Readonly because the cell cache below is not keyed on it. */
  readonly rings: number
  /**
   * The `Hex.DIRECTIONS` index the cone holds, or undefined to follow
   * `caster.facing`. Readonly for the same reason as `rings`: the cache is keyed
   * on the direction it resolves to, so a fixed one can never change under it.
   */
  readonly fixedDirection: number | undefined
  /** The same object as `target`, typed as the Unit it always is. */
  private readonly caster: Unit

  /**
   * The cone's cells as `Hex.key` values, for the origin cell and direction
   * they were built from. `overlaps` runs for every unit on every tick of the
   * breath, and the cone only changes when the caster changes cell or snapped
   * direction, so it is rebuilt then and nowhere else.
   */
  private cells = new Set<number>()
  private cellsOrigin = NaN
  private cellsDirection = -1

  constructor (target: Unit, rings: number, fixedDirection?: number) {
    super(target)
    this.caster = target
    this.rings = rings
    this.fixedDirection = fixedDirection
  }

  /**
   * The direction index a cone aimed at `aimCell` holds: the aim vector from
   * the caster's position to the cell's centre, snapped by `World.FACING_INDEX`
   * (so a halfway aim rounds clockwise, deterministically). Undefined for no aim
   * or an aim at the caster's own cell, which means "follow facing".
   */
  static aimIndex (caster: Unit, aimCell?: Vector): number | undefined {
    if (aimCell === undefined) return undefined
    const own = Hex.toCell(caster.position)
    if (own.x === aimCell.x && own.y === aimCell.y) return undefined
    return World.FACING_INDEX(Hex.toPosition(aimCell).sub(caster.position))
  }

  /**
   * The cell `rings` steps straight out from the caster's current cell along
   * the cone's direction: the far tip of the cone. This is what the effect
   * record carries for a breath. Any cell on that axis would name the
   * direction; the tip is used because it is far enough out that a client
   * which places the caster one cell off still snaps to the same direction
   * (one cell sideways at 3 rings turns the vector by under 20 degrees, and
   * snapping only changes past 30).
   */
  tipCell (): Vector {
    const origin = Hex.toCell(this.caster.position)
    const step = Hex.DIRECTIONS[this.currentDirection()]
    return new Vector(origin.x + step.x * this.rings, origin.y + step.y * this.rings)
  }

  /**
   * True if the cone covers the cell under `value`, or, with a bodied `unit`
   * (ring-footprint), any cell of its body: a breath hits the Reactor or the
   * Brood on any of its 7 cells. Both callers (`Unit.update`'s damage and
   * `GuardPosition`'s provoke) pass the unit, so the two agree.
   */
  overlaps (value: Vector, unit?: Unit) {
    const cell = Hex.toCell(value)
    const cells = this.currentCells()
    const rings = unit?.bodyRings ?? 0
    if (rings <= 0) return cells.has(Hex.key(cell.x, cell.y))
    let hit = false
    World.forKeysWithin(cell, rings, (key) => { if (cells.has(key)) hit = true })
    return hit
  }

  private currentDirection (): number {
    if (this.fixedDirection !== undefined) return this.fixedDirection
    // `facing`, not `direction`: a stopped caster's direction is (0,0), whose
    // angle is 0, so a breath from a standstill always coned East, and a caster
    // who stopped mid-breath swung the cone East with them.
    return World.FACING_INDEX(this.caster.facing)
  }

  private currentCells (): Set<number> {
    const origin = Hex.toCell(this.caster.position)
    const originKey = Hex.key(origin.x, origin.y)
    const direction = this.currentDirection()
    if (originKey !== this.cellsOrigin || direction !== this.cellsDirection) {
      this.cells = new Set(World.CONE_CELLS(origin, direction, this.rings).map((c) => Hex.key(c.x, c.y)))
      this.cellsOrigin = originKey
      this.cellsDirection = direction
    }
    return this.cells
  }
}
