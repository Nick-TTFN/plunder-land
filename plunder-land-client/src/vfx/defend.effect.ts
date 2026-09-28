import TWEEN from '@tweenjs/tween.js'
import AnimationClip from '../animation/animationclip'
import { type GameObject } from '../objects/gameobject'

/**
 * A shield around the defender for the skill's lifetime: the arena's looping
 * hex shield (70 px, the size the drawn ring it replaces had around a player).
 * It scales with the defender's body, so a bigger unit gets a bigger shield.
 */
export class DefendEffect {
  constructor (owner: GameObject, lifetime: number) {
    const shield = new AnimationClip('fx/shield')
    // The art fits a peep (body 14); anything smaller keeps the art's size.
    const size = Math.max(1, owner.radius / 14)
    shield.y = -owner.radius * 0.5
    shield.scale.set(0)
    shield.alpha = 0
    owner.addChild(shield)
    shield.play()

    new TWEEN.Tween(shield.scale).to({ x: size, y: size }, 300).start()
    new TWEEN.Tween(shield).to({ alpha: 1 }, 300).start()

    setTimeout(() => {
      shield.parent?.removeChild(shield)
      shield.destroy()
    }, lifetime)
  }
}
