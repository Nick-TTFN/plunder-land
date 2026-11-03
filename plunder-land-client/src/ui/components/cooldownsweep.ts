import { Container, Graphics } from 'pixi.js'

/** The shade: dark, translucent, so the icon still reads underneath. */
const SHADE = 0x05080D
const SHADE_ALPHA = 0.62

/**
 * A radial cooldown over a whole button: a dark wedge for the time left,
 * starting at 12 o'clock and shrinking clockwise as the cooldown runs out,
 * clipped to the button's rounded rectangle. `set(1)` is fully covered,
 * `set(0)` (or less) hides it. Redraws only when the shown fraction changes
 * by a visible step.
 */
export class CooldownSweep extends Container {
  private readonly _wedge = new Graphics()
  private readonly _clip: Graphics
  private _shown = -1

  constructor (private readonly _w: number, private readonly _h: number, radius: number) {
    super()
    this.eventMode = 'none'
    this._clip = new Graphics().beginFill(0xFFFFFF, 1).drawRoundedRect(0, 0, _w, _h, radius).endFill()
    this.addChild(this._clip)
    this.addChild(this._wedge)
    this._wedge.mask = this._clip
    this.visible = false
  }

  /** The fraction of the cooldown left, 0..1. */
  set (left: number): void {
    const f = Math.max(0, Math.min(1, left))
    // ~1/300 of a turn: smooth, without redrawing every frame for nothing.
    const step = Math.round(f * 300) / 300
    if (step === this._shown) return
    this._shown = step
    this.visible = step > 0
    this._wedge.clear()
    if (step <= 0) return
    const cx = this._w / 2
    const cy = this._h / 2
    // Past every corner, so the wedge covers the whole rectangle.
    const r = Math.hypot(this._w, this._h)
    const start = -Math.PI / 2
    // What is left of the turn, from where the sweep has reached back to 12 o'clock.
    const from = start + (1 - step) * Math.PI * 2
    this._wedge.beginFill(SHADE, SHADE_ALPHA)
    if (step >= 1) {
      this._wedge.drawRect(0, 0, this._w, this._h)
    } else {
      this._wedge.moveTo(cx, cy)
      this._wedge.arc(cx, cy, r, from, start + Math.PI * 2)
      this._wedge.lineTo(cx, cy)
    }
    this._wedge.endFill()
  }
}
