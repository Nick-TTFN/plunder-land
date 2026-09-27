import { Container, Graphics, type Text } from 'pixi.js'
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
  private readonly _badges: Array<{ tag: number, frame: Graphics, mark: Text, name: Text }> = []
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
      this.body.addChild(frame, mark, name)
      this._badges.push({ tag, frame, mark, name })
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
    })
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
