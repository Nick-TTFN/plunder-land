import { type Unit } from '../objects/unit'
import { type Skill } from '../skills/skill'
import { type IAIRoutine } from './findnearestconsumable'
import { Hex } from '../utils/hex'

export default class UseSkillOnTarget implements IAIRoutine {
  skill: Skill
  owner: Unit
  constructor (owner: Unit, skill: Skill) {
    this.owner = owner
    this.skill = skill
  }

  update (dt: number) {
    if (this.owner.target != null) {
      // Aim at the target's cell, the same message a player's click sends
      // (decision #21). A target on the mob's own cell falls back to facing.
      this.skill.execute(Hex.toCell(this.owner.target.position))
    }
  }
}
