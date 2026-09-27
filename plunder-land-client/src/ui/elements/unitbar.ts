import { Graphics } from 'pixi.js'

/**
 * The health bar over a unit (world-markers, M2): a fixed width whatever the
 * unit's max hp, which used to be the bar's width in pixels (a boss's was
 * 300 px). A hit shows the lost part in white for a moment before it goes.
 * Placeholder look until the art pass (decision #36).
 */
export class UnitBar extends Graphics {
  static HEIGHT = 5
  private _ratio = 1
  private _lost = 0
  private _timeoutId: ReturnType<typeof setTimeout> | undefined

  constructor (private readonly _barW: number, private _colour: number) {
    super()
    this.eventMode = 'none'
    this.x = -_barW / 2
    this.redraw()
  }

  set colour (value: number) {
    if (value === this._colour) return
    this._colour = value
    this.redraw()
  }

  setValue (ratio: number): void {
    const next = Math.max(0, Math.min(1, ratio))
    if (next === this._ratio) return
    // A drop flashes; a heal just fills.
    this._lost = next < this._ratio ? this._ratio - next : 0
    this._ratio = next
    this.redraw()
    if (this._timeoutId !== undefined) clearTimeout(this._timeoutId)
    if (this._lost > 0) {
      this._timeoutId = setTimeout(() => {
        this._lost = 0
        this._timeoutId = undefined
        if (!this.destroyed) this.redraw()
      }, 300)
    }
  }

  private redraw (): void {
    const w = this._barW
    const h = UnitBar.HEIGHT
    this.clear()
      .beginFill(0x05080C, 0.85)
      .drawRect(-1, -1, w + 2, h + 2)
      .endFill()
    const filled = Math.round((w * this._ratio))
    if (filled > 0) this.beginFill(this._colour).drawRect(0, 0, filled, h).endFill()
    const lost = Math.round(w * this._lost)
    if (lost > 0) this.beginFill(0xFFFFFF, 0.9).drawRect(filled, 0, Math.min(lost, w - filled), h).endFill()
  }
}
