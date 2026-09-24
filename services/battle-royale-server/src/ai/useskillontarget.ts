import { type Unit } from '../objects/unit'
import { type Skill } from '../skills/skill'
import { type IAIRoutine } from './findnearestconsumable'
import { Hex } from '../utils/hex'

export default class UseSkillOnTarget implements IAIRoutine {
  skill: Skill
  owner: Unit
  /** See `UseSkillOnTargetSpec.withinCells`. Undefined = any distance. */
  withinCells: number | undefined
  constructor (owner: Unit, skill: Skill, withinCells?: number) {
    this.owner = owner
    this.skill = skill
    this.withinCells = withinCells
  }

  update (dt: number) {
    if (this.owner.target != null) {
      // Out of range: hold fire, so the cooldown is not spent on a shot that
      // cannot land. Checked before `execute`, which is what starts it.
      if (
        this.withinCells !== undefined &&
        Hex.distance(Hex.toCell(this.owner.position), Hex.toCell(this.owner.target.position)) > this.withinCells
      ) return

      // Aim at the target's cell, the same message a player's click sends
      // (decision #21). A target on the mob's own cell falls back to facing.
      this.skill.execute(Hex.toCell(this.owner.target.position))
    }
  }
}
