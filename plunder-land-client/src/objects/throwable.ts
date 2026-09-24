import { Assets, Texture, AnimatedSprite, Point } from 'pixi.js'
import { Vector } from '../utils/vector'
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

  dispose (): void {
    // The burst is the server's blast effect now (BlastEffect), drawn on the
    // cells the blast damaged. The explosions scattered here were centred on
    // the last position this client had, a tick behind the hit, and would have
    // played on top of it about a cell and a half away.
    if (Game.FIREBALLS.includes(this)) { Game.FIREBALLS.splice(Game.FIREBALLS.indexOf(this), 1) }

    // super.destroy();
    this.parent?.removeChild(this)
  }
}
