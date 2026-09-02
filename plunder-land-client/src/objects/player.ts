import { Point } from 'pixi.js'
import { Dash } from '../skills/dash'
import { MeleeAttack } from '../skills/meleeattack'
import { type RangedAttack } from '../skills/rangedattack'
import { type Defend } from '../skills/defend'
import { AnimationStates } from '../animation/animationstates'
import Unit from './unit'

export default class Player extends Unit {
  skills: Array<Defend | Dash | MeleeAttack | RangedAttack>

  constructor () {
    super()

    this.skills = [
    //   new Defend(this),q
      new Dash(this),
      new MeleeAttack(this)
    //   new RangedAttack(this),
    ]
    for (let i = 0; i < this.skills.length; i++) this.skills[i].index = i
  }

  initAnimation (): void {
    this.runAnimation = 'player/run/run'
    this.idleAnimation = 'player/idle/idle'

    this.animation = new AnimationStates(
      this.idleAnimation,
      0.2,
      new Point(0.5, 1)
    )
    this.animation.addClip(this.runAnimation, 0.2, new Point(0.5, 1), true)
    this.animation.addClip('player/melee_1/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/melee_2/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/melee_3/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/melee_4/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/die/die', 0.1, new Point(0.36, 1))
    this.animation.play()
    this.addChild(this.animation)
  }

  dispose (): void {
    if ((this.hp ?? 0) <= 0) {
      this.animation?.playClip('player/die/die')
      this.animation?.setDefault(undefined)
    }

    if (this.progressBar != null) { this.removeChild(this.progressBar.graphics) }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    setTimeout(() => {
      // A removed PIXI object has `parent === null`, which passed the old
      // `!== undefined` test and then threw on the line below.
      if (self.parent != null) self.parent.removeChild(self)
    }, 1700)

    this.killed = true
  }
}
