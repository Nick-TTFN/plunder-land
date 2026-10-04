import { type Aimed, Skill } from './skill'
import { Texture } from 'pixi.js'
import { type GameObject } from '../objects/gameobject'
import { Game } from '../game'

export class Dash extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Dash'
    this.uiTexture = Texture.from('ui/skill_dash.png')
    this.cooldown = 2
  }

  execute (aim?: Aimed): void {
    // Sent first, so the server has the press before the next input packet,
    // which carries a standing dash's new destination.
    super.execute(aim)

    // Predicted (decision #34): the same stretch of route at the same speed
    // as the server's `Unit.dash`, so a dash no longer shows as a correction.
    if (this.index !== undefined && this.owner === Game.PLAYER) Game.LOCAL.dash()

    if (this.owner.animation != null) {
      this.owner.animation.animationSpeed = 0.4

      setTimeout(() => {
        if (this.owner.animation != null) { this.owner.animation.animationSpeed = 0.2 }
      }, this.cooldown * 1000 / 2)
    }
  }
}
