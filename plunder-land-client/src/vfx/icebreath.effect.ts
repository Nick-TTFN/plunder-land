import TWEEN from '@tweenjs/tween.js'
import { Sprite, Texture } from 'pixi.js'
import { type GameObject } from '../objects/gameobject'
import { type Vector } from '../utils/vector'
import { ICE_BREATH_RINGS } from './cells'
import { playBreath } from './breath'

/**
 * The `CONE_CELLS` wedge, 3 rings (decision #20), lit for the breath's
 * lifetime, with snowflakes blown out to its cells. See FireBreathEffect.
 */
export class IceBreathEffect {
  constructor (owner: GameObject, lifetime: number, aimCell?: Vector) {
    playBreath(owner, lifetime, aimCell, ICE_BREATH_RINGS, 0x7fd8ff, (layer, from, to, duration) => {
      // The arena's snowflake; its motion is code's (INTEGRATION.md).
      const snowflake = new Sprite(Texture.from('fx/snowflake.png'))
      snowflake.rotation = Math.random() * Math.PI
      snowflake.x = from.x
      snowflake.y = from.y
      snowflake.zIndex = to.y + 1
      snowflake.scale.set(0.3)
      layer.addChild(snowflake)

      new TWEEN.Tween(snowflake.scale).to({ x: 1.2, y: 1.2 }, duration).start()
      new TWEEN.Tween(snowflake).to({ rotation: snowflake.rotation + Math.PI }, duration).start()
      new TWEEN.Tween(snowflake)
        .to({ alpha: 0.2, x: to.x, y: to.y }, duration)
        .onComplete(() => {
          snowflake.parent?.removeChild(snowflake)
          snowflake.destroy()
        })
        .start()
    })
  }
}
