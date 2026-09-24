import TWEEN from '@tweenjs/tween.js'
import AnimationClip from '../animation/animationclip'
import { type GameObject } from '../objects/gameobject'
import { type Vector } from '../utils/vector'
import { FIRE_BREATH_RINGS } from './cells'
import { playBreath } from './breath'

/**
 * The `CONE_CELLS` wedge, 4 rings (decision #20), lit for the breath's
 * lifetime, with flames thrown out to its cells. It used to spray 50-300
 * units along `owner.direction`, which never reached the client, so it drew
 * nothing at all.
 */
export class FireBreathEffect {
  constructor (owner: GameObject, lifetime: number, aimCell?: Vector) {
    playBreath(owner, lifetime, aimCell, FIRE_BREATH_RINGS, 0xff7a1a, (layer, from, to, duration) => {
      const expl = new AnimationClip('explosion/expl')
      expl.x = from.x
      expl.y = from.y
      expl.zIndex = to.y + 1
      layer.addChild(expl)
      expl.play()
      new TWEEN.Tween(expl)
        .to({ x: to.x, y: to.y }, duration)
        .onComplete(() => {
          expl.parent?.removeChild(expl)
          expl.destroy()
        })
        .start()
    })
  }
}
