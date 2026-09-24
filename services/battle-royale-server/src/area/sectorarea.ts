import { type Unit } from '../objects/unit'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import World from '../objects/world'
import Area from './area'

/**
 * A cone of hex cells in front of its caster, re-evaluated on every test, so it
 * follows the caster's current cell and facing for its whole lifetime.
 */
export default class SectorArea extends Area {
  /**
   * Half the cone's opening: a cell is in the cone if its centre is within this
   * angle of the caster's facing, measured from the centre of the caster's cell.
   *
   * NOT A DESIGN SPEC. The balance pass gave cones as ±45° over a circular
   * radius; carrying that angle over onto cell centres is the coordinator's
   * reading (2026-09-24), not a value Dez proposed. Revisit with Dez.
   */
  static HALF_ANGLE = Math.PI / 4

  rings: number
  /** The same object as `target`, typed as the Unit it always is. */
  private readonly caster: Unit

  constructor (target: Unit, rings: number) {
    super(target)
    this.caster = target
    this.rings = rings
  }

  overlaps (value: Vector) {
    // `facing`, not `direction`: a stopped caster's direction is (0,0), whose
    // angle is 0, so a breath from a standstill always coned East, and a caster
    // who stopped mid-breath swung the cone East with them.
    return World.CELL_IN_CONE(
      Hex.toCell(this.caster.position),
      Hex.toCell(value),
      this.rings,
      this.caster.facing,
      SectorArea.HALF_ANGLE
    )
  }
}
