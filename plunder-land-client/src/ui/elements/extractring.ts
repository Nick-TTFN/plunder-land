import { Graphics, type Container } from 'pixi.js'
import TWEEN from '@tweenjs/tween.js'
import { Session } from '../../net/session'

/**
 * The ring around a player who is extracting, filling clockwise from the top
 * as the server's `extractProgress` rises. Everyone in range sees it (#16 Q5),
 * the extracting player included.
 *
 * Drawn with Graphics, so it needs no sprite. Deliberately plain: the
 * mockup's "EXTRACT" ring belongs to `hud-rebuild` / `world-markers`.
 *
 * The server sends progress once a tick, so the arc eases to each new value
 * over one tick rather than jumping 5% at a time.
 */
export class ExtractRing extends Graphics {
  /** Largest progress value on the wire; 255 would be done and is never sent. */
  static FULL = 255

  private readonly _radius: number
  private readonly _shown = { value: 0 }
  private _tween: any

  constructor (radius: number) {
    super()
    this._radius = radius
  }

  /**
   * Show `progress` (the wire byte) on `unit`, creating the ring on the first
   * non-zero value and removing it on 0, which is how the server says the
   * player left the pad. A hit that cancels the channel while the player stays
   * on the pad usually arrives as a fall back to 1 rather than a 0, and the arc
   * eases back down to the start. A finished extraction needs nothing: the
   * unit is destroyed.
   */
  static show (unit: Container, progress: number, bodyRadius: number | undefined): void {
    let ring = unit.children.find((c): c is ExtractRing => c instanceof ExtractRing)

    if (progress <= 0) {
      if (ring !== undefined) {
        ring.stop()
        unit.removeChild(ring)
        ring.destroy()
      }
      return
    }

    if (ring === undefined) {
      // Outside a 50 px robot, whose collider is about 14.
      ring = new ExtractRing(Math.max(28, (bodyRadius ?? 14) * 2 + 4))
      // Under the sprite, like something on the ground.
      unit.addChildAt(ring, 0)
    }
    ring.setTarget(progress / ExtractRing.FULL)
  }

  setTarget (fraction: number): void {
    this.stop()
    this._tween = new TWEEN.Tween(this._shown)
      .to({ value: fraction }, Session.tickMs)
      .onUpdate(() => this.redraw())
      .start()
  }

  stop (): void {
    this._tween?.stop()
    this._tween = undefined
  }

  private redraw (): void {
    const r = this._radius
    const start = -Math.PI / 2
    this.clear()
    this.lineStyle(4, 0x000000, 0.35)
    this.drawCircle(0, 0, r)
    this.lineStyle(4, 0x7cf0a0, 1)
    this.moveTo(0, -r)
    this.arc(0, 0, r, start, start + Math.PI * 2 * this._shown.value)
  }
}
