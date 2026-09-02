import Mob from './mob'
import UseSkillOnTarget from '../ai/useskillontarget'
import { FireBreath } from '../skills/firebreath'

export default class Boss extends Mob {
  static Cooldown = 1000

  constructor (x: number, y: number, tag: number) {
    super(x, y, tag)
    this.radius = 40
    this.loot = 500
    this.level = 0

    this.addAIRoutine(new UseSkillOnTarget(this, new FireBreath(this)))
    // Mob's constructor already broadcast this object. Creating it again sent a
    // second packet for the same id carrying mob-sized values; the boss radius,
    // loot and level set above go out as a delta on the next tick instead.
  }

  maxHP () {
    return 250
  }

  getDamage () {
    return 40
  }
}
