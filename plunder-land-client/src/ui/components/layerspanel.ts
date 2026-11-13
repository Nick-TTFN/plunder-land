import { Container, Graphics, Text } from 'pixi.js'
import { Panel } from './panel'
import { THEME, two } from '../theme'
import { Session } from '../../net/session'

const BADGE_R = 30
const SPACING = 130

/** A flat-topped hexagon of circumradius `r` centred on (0, 0). */
function hexagon (g: Graphics, r: number): Graphics {
  const points: number[] = []
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 3 * i
    points.push(r * Math.cos(a), r * Math.sin(a))
  }
  return g.drawPolygon(points)
}

/**
 * The mockup's bottom-right LAYERS panel: one hex badge per layer the server
 * lists (`hello.layers`, top first), joined by dots. The layer the player is
 * on is highlighted; a layer not yet visited this run shows "?", a visited one
 * its number. This is also the "you are on layer 0N" indicator
 * (three-ground-layers follow-up). `reset` starts a new run's visits.
 */
export class LayersPanel extends Panel {
  private readonly _badges: Array<{ tag: number, frame: Graphics, mark: Text, name: Text, tags: Text }> = []
  private readonly _visited = new Set<number>()
  private _current: number | undefined = NaN

  constructor () {
    super('LAYERS')
    const tags = Session.layers
    tags.forEach((tag, i) => {
      const x = BADGE_R + i * SPACING
      if (i > 0) {
        const link = new Graphics()
          .lineStyle(2, THEME.panelBorder, 1).moveTo(x - SPACING + BADGE_R + 6, BADGE_R).lineTo(x - BADGE_R - 6, BADGE_R)
          .lineStyle(0).beginFill(0x8A5CFF).drawCircle(x - SPACING / 2, BADGE_R, 7).endFill()
        this.body.addChild(link)
      }
      const frame = new Graphics()
      frame.x = x
      frame.y = BADGE_R
      const mark = Panel.text('?', THEME.titleSize + 4, THEME.muted)
      mark.anchor.set(0.5, 0.5)
      mark.x = x
      mark.y = BADGE_R
      const name = Panel.text(`LAYER ${two(i + 1)}`, THEME.smallSize, THEME.muted)
      name.anchor.set(0.5, 0)
      name.x = x
      name.y = BADGE_R * 2 + 8
      // The current layer's tags (Session.layerTags: "MOBS -50%", "NO PVP"),
      // one a line under its name. Fitted with two lines in, so the panel
      // keeps room for them whichever layer is current.
      const tags = Panel.text('MOBS -50%\nNO PVP', THEME.smallSize - 2, THEME.hp)
      tags.anchor.set(0.5, 0)
      tags.style.align = 'center'
      tags.x = x
      tags.y = name.y + name.height + 4
      this.body.addChild(frame, mark, name, tags)
      this._badges.push({ tag, frame, mark, name, tags })
    })
    this.fit()
    this.setCurrent(undefined)
  }

  reset (): void {
    this._visited.clear()
    this._current = NaN
    this.setCurrent(undefined)
  }

  /** The layer the player is on now, undefined between runs. */
  setCurrent (tag: number | undefined): void {
    if (tag === this._current) return
    this._current = tag
    if (tag !== undefined) this._visited.add(tag)
    this._badges.forEach((badge, i) => {
      const current = badge.tag === tag
      badge.frame.clear()
        .beginFill(current ? 0x0F3340 : 0x101A28, 1)
        .lineStyle(current ? 3 : 2, current ? THEME.accent : THEME.panelBorder, 1)
      hexagon(badge.frame, BADGE_R).endFill()
      badge.mark.text = this._visited.has(badge.tag) ? two(i + 1) : '?'
      badge.mark.style.fill = current ? THEME.accent : THEME.muted
      badge.name.style.fill = current ? THEME.accent : THEME.muted
      badge.tags.text = current ? Session.layerTags(badge.tag).join('\n') : ''
    })
  }
}

/**
 * The layers panel collapsed for a phone (decision #59, mobile-4): one line,
 * "LAYER 0N", the number being the current layer's place in `hello.layers`
 * (`Session.layers`, top first), as the panel numbers its badges; never a
 * hardcoded tag. "LAYER --" between runs or on a tag the server didn't list.
 */
export class LayerBadge extends Container {
  private readonly _text: Text
  private _current: number | undefined = NaN
  /** The widest the badge may be (`fitWidth`), CSS px; the tags line breaks one tag per line past it. */
  private _maxWidth = Infinity

  /** Plain text (Nick, 2026-11-05), at CSS size, with a dark outline so it reads over the minimap. */
  static readonly FONT = 10

  constructor () {
    super()
    this._text = new Text('LAYER --', { fontFamily: THEME.font, fontSize: LayerBadge.FONT, fill: THEME.accent, stroke: 0x04070D, strokeThickness: 3, align: 'right' })
    this.addChild(this._text)
    this.setCurrent(undefined)
  }

  get panelWidth (): number {
    return Math.ceil(this._text.width)
  }

  get panelHeight (): number {
    return Math.ceil(this._text.height)
  }

  /** The label for `tag`: its place in `Session.layers`, or "--". */
  static label (tag: number | undefined): string {
    const i = tag === undefined ? -1 : Session.layers.indexOf(tag)
    return i < 0 ? 'LAYER --' : `LAYER ${two(i + 1)}`
  }

  /**
   * The layer the player is on now, undefined between runs; its tags
   * (`Session.layerTags`) on a second line. True when the text changed, so
   * the HUD lays it out again (its size moved).
   */
  setCurrent (tag: number | undefined): boolean {
    if (tag === this._current) return false
    this._current = tag
    this.relabel()
    return true
  }

  /**
   * Keep the badge within `max` CSS px (g2-4: inside the phone's minimap, which
   * its one-line tags overflowed by 36 px): past it the tags go one per line.
   * The font stays at `FONT`.
   */
  fitWidth (max: number): void {
    if (max === this._maxWidth) return
    this._maxWidth = max
    this.relabel()
  }

  private relabel (): void {
    const tag = this._current
    const tags = Session.layerTags(tag)
    const label = LayerBadge.label(tag)
    this._text.text = tags.length > 0 ? `${label}\n${tags.join(' · ')}` : label
    if (tags.length > 1 && this._text.width > this._maxWidth) this._text.text = `${label}\n${tags.join('\n')}`
  }
}

/**
 * The mockup's fog legend: VISIBLE, EXPLORED, UNKNOWN swatches. Hidden until
 * `fog-of-war` lands and turns it on; the swatch colours are the fog's
 * placeholder tints, so change them together.
 */
export class FogLegend extends Container {
  constructor () {
    super()
    const entries: Array<[string, number, number]> = [
      ['VISIBLE', 0x6A7FA8, 1],
      ['EXPLORED', 0x3A4458, 1],
      ['UNKNOWN', 0x05080C, 1]
    ]
    let x = 0
    for (const [label, fill] of entries) {
      const swatch = new Graphics().beginFill(fill).lineStyle(1, THEME.panelBorder, 1)
      hexagon(swatch, 16).endFill()
      swatch.x = x + 16
      swatch.y = 16
      const text = Panel.text(label, THEME.smallSize, THEME.text)
      text.x = x + 40
      text.y = 8
      this.addChild(swatch, text)
      x += 40 + text.width + 26
    }
    this.visible = false
  }
}
