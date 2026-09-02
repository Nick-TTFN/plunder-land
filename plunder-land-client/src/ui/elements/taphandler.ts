import { Container, Graphics } from 'pixi.js'
import { Timer } from './timer'

export class TapHandler extends Container {
  cooldown: number | undefined
  lock: Timer | undefined
  callback: () => void
  constructor (callback: () => void, cooldown?: number, width?: number, height?: number, color?: number) {
    super()
    this.eventMode = 'static'
    if (cooldown !== undefined) { this.cooldown = cooldown }

    if (width !== undefined && height !== undefined && color !== 0x00000000) {
      const g = new Graphics()
        .beginFill(color ?? 0x000000)
        .drawRect(-width / 2, -height / 2, width, height)
        .endFill()
      g.alpha = 0.2
      this.addChild(g)
    }

    this.callback = callback

    this.on('pointerup', this.onPointerDown.bind(this))
  }

  onPointerDown (e: { data: { button: number, pointerType: string } }): void {
    if (e.data.button !== 0 && e.data.pointerType !== 'touch') { return }

    this.invoke()
  }

  invoke (): void {
    if ((this.lock?.parent) != null) { return }

    this.callback()

    if (this.cooldown !== undefined) {
      this.lock = new Timer(this.cooldown, 20)
      this.addChild(this.lock)
    }
  }
}
