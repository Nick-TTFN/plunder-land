import { Skill } from './skill'
import { ObjectType } from '../objects/gameobject'
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import { type Unit } from '../objects/unit'
import GuardPosition from '../ai/guardposition'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'

export class RangedAttack extends Skill {
  /**
   * A player's range, in cells: 8, base vision, so you can shoot only what you
   * see. It was 360 units, the same 8 cells by distance. An archetype
   * overrides it with `SkillSpec.range` (the gunner's is 6).
   */
  static RANGE_CELLS = 8

  /** Range in cells: how many steps the hex line runs past the caster's cell. */
  range: number

  constructor (owner) {
    super(owner, 750)
    this.range = RangedAttack.RANGE_CELLS
  }

  /**
   * The cells a shot covers (decision #25): the hex line from the caster's
   * cell through the aimed cell and on to `range` cells. No aim, or an aim at
   * the caster's own cell, runs it along the caster's hex facing,
   * `World.FACING_INDEX(facing)`, which is also what the effect record lets
   * the client fall back to.
   */
  static lineOf (owner: Unit, aimCell: Vector | undefined, range: number): Vector[] {
    const from = owner.cell
    const toward = Skill.isAimed(owner, aimCell)
      ? aimCell
      : Hex.neighbour(from, World.FACING_INDEX(owner.facing))
    return Hex.line(from, toward, range)
  }

  execute (aimCell?: Vector) {
    if (!super.execute()) return false

    // The first unit on the line's cells (decision #25), which stops the shot
    // (N4, decision #16). It used to test units' radii against the segment to
    // the aimed cell's centre, and about 29% of shots at a target 6 cells away
    // passed beside it.
    const first = World.FIRST_ON_LINE(
      RangedAttack.lineOf(this.owner, aimCell, this.range),
      this.owner.position,
      this.owner.tag,
      ObjectType.Player | ObjectType.Mob,
      this.owner
    )

    if (first !== undefined) {
      if (first.hit(this.dealt(this.damage ?? World.config.ranged))) this.owner.onKill(first)
      else GuardPosition.provoke(first, this.owner)
    }

    Multiplayer.Instance.effect(3, this.owner, 1, Skill.isAimed(this.owner, aimCell) ? aimCell : undefined)
    return true
  }
}
