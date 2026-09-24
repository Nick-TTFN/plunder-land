import { type Unit } from '../objects/unit'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import World from '../objects/world'
import Area from './area'

/**
 * A cone of hex cells in front of its caster, re-evaluated on every test, so it
 * follows the caster's current cell and facing for its whole lifetime.
 *
 * The cone is `World.CONE_CELLS`: a neighbour expansion along the caster's
 * facing snapped to one of the six hex directions (decision #20).
 */
export default class SectorArea extends Area {
  /** Readonly because the cell cache below is not keyed on it. */
  readonly rings: number
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

  constructor (target: Unit, rings: number) {
    super(target)
    this.caster = target
    this.rings = rings
  }

  overlaps (value: Vector) {
    const cell = Hex.toCell(value)
    return this.currentCells().has(Hex.key(cell.x, cell.y))
  }

  private currentCells (): Set<number> {
    const origin = Hex.toCell(this.caster.position)
    const originKey = Hex.key(origin.x, origin.y)
    // `facing`, not `direction`: a stopped caster's direction is (0,0), whose
    // angle is 0, so a breath from a standstill always coned East, and a caster
    // who stopped mid-breath swung the cone East with them.
    const direction = World.FACING_INDEX(this.caster.facing)
    if (originKey !== this.cellsOrigin || direction !== this.cellsDirection) {
      this.cells = new Set(World.CONE_CELLS(origin, direction, this.rings).map((c) => Hex.key(c.x, c.y)))
      this.cellsOrigin = originKey
      this.cellsDirection = direction
    }
    return this.cells
  }
}
