import { Point } from 'pixi.js'
import Unit from './unit'
import { AnimationStates } from '../animation/animationstates'
import { lookFor } from './archetypesprites'

export default class Mob extends Unit {
  initAnimation (): void {
    const look = lookFor('mob', this.archetype)
    this.runAnimation = look.run

    this.animation = new AnimationStates(
      this.runAnimation,
      0.1,
      new Point(0.5, 1)
    )
    if (look.tint !== undefined) this.animation.tint = look.tint
    this.animation.play()
    this.addChild(this.animation)

    const targetScale = (this.radius * 3) / 64
    this.animation.scale = new Point(targetScale, targetScale)
  }
}
