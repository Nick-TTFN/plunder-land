import TWEEN from '@tweenjs/tween.js'
import { Graphics } from 'pixi.js'
import { type GameObject } from '../objects/gameobject'

/**
 * A shield ring around the defender for the skill's lifetime.
 *
 * Drawn, not a sprite: it loaded a texture named shield.png, which is in
 * neither atlas, so pixi fetched `/shield.png` as a URL, got a 404, and the
 * failed load was an uncaught error on every Defend press - the dev server's
 * full-screen overlay, a silent console error in production. Swap in real art
 * once it exists (listed in CLAUDE.md "Skills"); `textures.spec.ts` on the
 * server fails if a sprite name is not in an atlas.
 */
export class DefendEffect {
  constructor (owner: GameObject, lifetime: number) {
    const radius = owner.radius * 2.5
    const shield = new Graphics()
    shield.lineStyle(3, 0x9fd4ff, 0.9)
    shield.beginFill(0x9fd4ff, 0.18)
    shield.drawCircle(0, 0, radius)
    shield.endFill()
    shield.y = -owner.radius * 0.5
    shield.scale.set(0)
    shield.alpha = 0
    owner.addChild(shield)

    new TWEEN.Tween(shield.scale).to({ x: 1, y: 1 }, 300).start()
    new TWEEN.Tween(shield).to({ alpha: 1 }, 300).start()

    setTimeout(() => {
      shield.parent?.removeChild(shield)
      shield.destroy()
    }, lifetime)
  }
}
