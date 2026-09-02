import { Texture, Point, Sprite } from 'pixi.js'
import { Vector } from '../utils/vector'
import TWEEN from '@tweenjs/tween.js'
import { Game } from '../game'
import { Throwable } from './throwable'

// todo remove and generalise to throwable
export class Icicle extends Throwable {
  maxVelocity: number
  constructor () {
    super()// Texture.from("UI/controls/icicle.png"));
    this.anchor = new Point(0.5, 0.5)
    this.scale = new Point(0.5, 0.5)
    this.maxVelocity = 300
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

  dispose (): void {
    for (let i = 0; i < 10; i++) {
      const parent = this.parent
      setTimeout(() => {
        const snowflake = new Sprite(Texture.from('UI/snowflake.png'))
        snowflake.x = this.x + 100 * (Math.random() - 0.5)
        snowflake.y = this.y + 100 * (Math.random() - 0.5)

        new TWEEN.Tween(snowflake.scale)
          .to({ x: 0, y: 0 }, 550)
          .onStart(() => {
            parent.addChild(snowflake)
          })
          .onComplete(() => {
            snowflake.parent.removeChild(snowflake)
          })
          .start()
        return snowflake
      }, 300 * Math.random())
    }

    if (Game.FIREBALLS.includes(this)) { Game.FIREBALLS.splice(Game.FIREBALLS.indexOf(this), 1) }

    // super.destroy();
    this.parent?.removeChild(this)
  }
}
