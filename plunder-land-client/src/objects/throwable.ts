import { Assets, Texture, AnimatedSprite, Point } from 'pixi.js'
import { Vector } from '../utils/vector'
import AnimationClip from '../animation/animationclip'
import TWEEN from '@tweenjs/tween.js'
import { Game } from '../game'

export class Throwable extends AnimatedSprite {
  maxVelocity: number
  direction: Vector | undefined
  constructor () {
    const sheet = Assets.get('./res/atlas.json')
    const tex = new Array<Texture>()
    for (const frame of sheet.data.animations['fireball/fireball']) { tex.push(Texture.from(frame)) }
    super(tex, true)
    this.anchor = new Point(0.5, 0.5)
    this.scale = new Point(1.5, 1.5)
    this.animationSpeed = 0.5
    this.maxVelocity = 300
    this.play()
  }

  setDirection (x: number, y: number): void {
    this.direction = new Vector(x, y).normalised()
  }

  setMoveTarget (value: Vector): void {
    this.x = value.x
    this.y = value.y
  }

  moveToTarget (dt: number): void {
    // rotate
    if (this.direction?.y !== undefined) {
      const angleDiff = this.direction.getAngleTo(this.rotation)
      this.rotation += angleDiff

      const pos = this.direction
        .normalised()
        .multiply(dt * this.maxVelocity)
        .addCoords(this.x, this.y)
      this.x = pos.x
      this.y = pos.y
    }
  }

  DEBUG_DRAW_COLLIDER (): void {}

  destroy (): void {
    for (let i = 0; i < 10; i++) {
      const parent = this.parent
      setTimeout(() => {
        const expl = new AnimationClip('explosion/expl')
        expl.x = this.x + 50 * (Math.random() - 0.5)
        expl.y = this.y + 50 * (Math.random() - 0.5)

        new TWEEN.Tween(expl.scale)
          .to({ x: 0, y: 0 }, 550)
          .onStart(() => {
            parent.addChild(expl)
            expl.play()
          })
          .onComplete(() => {
            expl.parent.removeChild(expl)
          })
          .start()
        return expl
      }, 300 * Math.random())
    }

    if (Game.FIREBALLS.includes(this)) { Game.FIREBALLS.splice(Game.FIREBALLS.indexOf(this), 1) }

    // super.destroy();
    this.parent?.removeChild(this)
  }
}
