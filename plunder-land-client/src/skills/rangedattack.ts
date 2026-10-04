import { type GameObject } from '../objects/gameobject'
import { type Aimed, Skill } from './skill'
import { Texture } from 'pixi.js'
import Unit from '../objects/unit'
import { Hex } from '../utils/hex'
import { RangedAttackEffect } from '../vfx/rangedattack.effect'

export class RangedAttack extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Ranged Attack'
    this.uiTexture = Texture.from('ui/skill_shoot.png')
    this.cooldown = 0.75 // mirrors the server's 750 ms
    this.aims = true
  }

  execute (aim?: Aimed): void {
    super.execute(aim)
    // The eye starts charging on the press, not on the server's effect a round
    // trip later; the effect then doesn't restart it (RobotSprite.RETRIGGER_S)
    // and fires the beam when this charge does (`RangedAttackEffect.holdMs`).
    // A press the server refuses leaves a charge with no beam; the skill card's
    // own cooldown keeps that rare.
    if (this.owner instanceof Unit) {
      const cell = Skill.cellOf(aim)
      if (this.owner.playAction('shoot', cell !== undefined ? Hex.toPosition(cell) : undefined)) RangedAttackEffect.pressed(this.owner)
    }
    // 'player/shoot/shot' is not in the atlas either; same story as Defend.
  }
}
