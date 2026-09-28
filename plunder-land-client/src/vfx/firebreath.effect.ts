import TWEEN from '@tweenjs/tween.js'
import AnimationClip from '../animation/animationclip'
import { type GameObject } from '../objects/gameobject'
import { type Vector } from '../utils/vector'
import { FIRE_BREATH_RINGS } from './cells'
import { playBreath } from './breath'

/**
 * The `CONE_CELLS` wedge, 4 rings (decision #20), lit for the breath's
 * lifetime, with flames thrown out to its cells: the arena's flame particle,
 * which runs birth to dissipation once over its flight.
 */
export class FireBreathEffect {
  constructor (owner: GameObject, lifetime: number, aimCell?: Vector) {
    playBreath(owner, lifetime, aimCell, FIRE_BREATH_RINGS, 0xff7a1a, (layer, from, to, duration) => {
      const flame = new AnimationClip('fx/flame')
      // Its frames spread over the flight, so it has burnt out on arrival.
      flame.animationSpeed = flame.totalFrames / (duration / 1000 * 60)
      flame.x = from.x
      flame.y = from.y
      flame.zIndex = to.y + 1
      flame.scale.set(0.8)
      layer.addChild(flame)
      flame.play()
      new TWEEN.Tween(flame.scale).to({ x: 1.4, y: 1.4 }, duration).start()
      new TWEEN.Tween(flame)
        .to({ x: to.x, y: to.y }, duration)
        .onComplete(() => {
          flame.parent?.removeChild(flame)
          flame.destroy()
        })
        .start()
    })
  }
}
