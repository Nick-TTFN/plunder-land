import { Container, Graphics, Text } from 'pixi.js'
import { THEME } from '../theme'

/**
 * A HUD panel in the mockup's style: a dark rounded box with a thin border
 * and an optional title with a rule under it. Drawn with `Graphics` until the
 * art pass (decision #36) gives it a frame.
 *
 * The background takes pointer events, so a click on a panel lands on the
 * panel and not on the world under it (`Game.onPointerDown` only walks the
 * player for presses whose target is the stage itself).
 *
 * Content goes in `body`, laid out from (0, 0) by the owner, which then calls
 * `fit()` (or `resize`) so the box wraps it.
 */
export class Panel extends Container {
  readonly body = new Container()
  private readonly _bg = new Graphics()
  private readonly _title: Text | undefined
  private readonly _right: Text | undefined
  private _w = 0
  private _h = 0

  constructor (title?: string, right?: string) {
    super()
    this._bg.eventMode = 'static'
    this.addChild(this._bg)
    if (title !== undefined) {
      this._title = Panel.text(title, THEME.titleSize, THEME.text)
      this._title.x = THEME.pad
      this._title.y = THEME.pad - 2
      this.addChild(this._title)
    }
    if (right !== undefined) {
      this._right = Panel.text(right, THEME.smallSize, THEME.muted)
      this._right.anchor.set(1, 0)
      this.addChild(this._right)
    }
    this.body.x = THEME.pad
    this.body.y = this.headerHeight
    this.addChild(this.body)
  }

  /** Where the body starts: under the title and its rule, or at the padding. */
  get headerHeight (): number {
    return this._title === undefined ? THEME.pad : THEME.pad + THEME.titleSize + 16
  }

  /** Size the box to wrap `body`, at least `minWidth` wide. */
  fit (minWidth = 0): void {
    const bounds = this.body.getLocalBounds()
    const width = Math.max(minWidth, bounds.x + bounds.width + 2 * THEME.pad, (this._title?.width ?? 0) + (this._right?.width ?? 0) + 3 * THEME.pad)
    this.resize(width, this.headerHeight + bounds.y + bounds.height + THEME.pad)
  }

  resize (width: number, height: number): void {
    if (width === this._w && height === this._h) return
    this._w = width
    this._h = height
    const g = this._bg
    g.clear()
      .beginFill(THEME.panelFill, THEME.panelAlpha)
      .lineStyle(1, THEME.panelBorder, 1)
      .drawRoundedRect(0, 0, width, height, THEME.panelRadius)
      .endFill()
    if (this._title !== undefined) {
      const y = this.headerHeight - 8
      g.lineStyle(1, THEME.rule, 1).moveTo(THEME.pad, y).lineTo(width - THEME.pad, y)
    }
    g.lineStyle(0)
    if (this._right !== undefined) {
      this._right.x = width - THEME.pad
      this._right.y = THEME.pad + 3
    }
  }

  /** Recolour the title (the run-summary card's outcome). */
  setTitleColour (fill: number): void {
    if (this._title !== undefined) this._title.style.fill = fill
  }

  get panelWidth (): number { return this._w }
  get panelHeight (): number { return this._h }

  /** A Text in the HUD font. Make it once and change `.text`: each Text owns a canvas texture. */
  static text (value: string, size: number, fill: number): Text {
    return new Text(value, { fontFamily: THEME.font, fontSize: size, fill })
  }
}

/**
 * A horizontal bar: a track and a fill, `setValue(current, max)`. Redraws
 * only when the value changes.
 */
export class Bar extends Graphics {
  private _ratio = -1

  constructor (private readonly _barW: number, private readonly _barH: number, private readonly _colour: number) {
    super()
    this.setValue(0, 1)
  }

  setValue (current: number, max: number): void {
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0
    if (ratio === this._ratio) return
    this._ratio = ratio
    this.clear()
      .beginFill(THEME.barTrack)
      .drawRoundedRect(0, 0, this._barW, this._barH, this._barH / 2)
      .endFill()
    if (ratio > 0) {
      this.beginFill(this._colour)
        .drawRoundedRect(0, 0, Math.max(this._barH, this._barW * ratio), this._barH, this._barH / 2)
        .endFill()
    }
  }
}
