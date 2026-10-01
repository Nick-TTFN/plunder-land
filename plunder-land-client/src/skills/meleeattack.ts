import { type GameObject } from '../objects/gameobject'
import { Skill } from './skill'
import { Texture } from 'pixi.js'
import Unit from '../objects/unit'

export class MeleeAttack extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Melee Attack'
    this.uiTexture = Texture.from('ui/skill_melee.png')
    this.cooldown = 1
  }

  execute () {
    super.execute()
    const rnd = Math.floor(Math.random() * 4) + 1
    this.owner.animation?.playClip(`player/melee_${rnd}/attack`)
    // At once, rather than on the server's effect a tick or so later, which
    // then doesn't restart it (RobotSprite.RETRIGGER_S).
    if (this.owner instanceof Unit) this.owner.playAction('swing')
  }
}
