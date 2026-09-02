import { Container, Graphics, type IDestroyOptions, Point } from 'pixi.js'
import { Game } from '../../game'
import { Vector } from '../../utils/vector'

export class Joystick extends Container {
  radius: number
  fore: Graphics
  pointerDown: boolean = false
  constructor (radius: number) {
    super()
    this.eventMode = 'static'
    this.radius = radius
    const back = new Graphics()
      .beginFill('0xA39171', 0.4)
      .drawCircle(0, 0, this.radius)
      .endFill()
    back.alpha = 0.5
    this.addChild(back)

    this.fore = new Graphics()
      .beginFill(0)
      .drawCircle(0, 0, radius / 4)
      .endFill()
    this.fore.alpha = 0.5
    this.addChild(this.fore)

    this.on('pointerdown', this.onPointerDown.bind(this))
    this.on('pointermove', this.onPointerMove.bind(this))
    this.on('pointerup', this.onPointerUp.bind(this))
    this.on('mouseupoutside', this.onPointerUp.bind(this))
  }

  onPointerDown (event: Event): void {
    this.pointerDown = true
    event.stopPropagation()
  }

  // figure out the event type
  onPointerMove (event: { data: { global: { x: number, y: number } }, stopPropagation: () => void }): void {
    // Game.PLAYER is set to `undefined` on death, never null, so the original
    // `=== null` test could never fire and the stick kept steering a corpse.
    if (Game.PLAYER == null) return

    if (this.pointerDown) {
      const global = this.toGlobal(new Point(0, 0))
      const dx = event.data.global.x - global.x
      const dy = event.data.global.y - global.y

      const data = new Vector(dx, dy).normalised()
      // Held locally and sampled at the server's cadence, rather than emitted
      // once per pointermove against a reader that runs once a tick.
      Game.LOCAL.setDirection(data.x, data.y)

      const dir = data.multiply(this.radius)
      const point = data.rotateBy(Math.PI / 2).multiply(this.radius / 4)

      this.fore
        .clear()
        .moveTo(dir.x, dir.y)
        .beginFill(0)
        .lineTo(point.x, point.y)
        .arc(0, 0, this.radius / 4, point.getAngle(), point.getAngle() + Math.PI)
        .closePath()
        .endFill()

      event.stopPropagation()
    }
  }

  onPointerUp (): void {
    this.pointerDown = false
    // Releasing the stick previously sent nothing at all, so the player kept
    // running in the last direction until the next pointer event.
    Game.LOCAL.setDirection(0, 0)

    this.fore
      .clear()
      .beginFill(0)
      .drawCircle(0, 0, this.radius / 4)
      .endFill()
  }

  destroy (options?: boolean | IDestroyOptions | undefined): void {
    this.off('pointerdown')
    this.off('pointermove')
    this.off('pointerup')
    this.off('mouseupoutside')
  }
}
