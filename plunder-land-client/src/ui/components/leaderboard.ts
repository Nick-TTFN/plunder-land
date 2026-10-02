import { Graphics, type Text } from 'pixi.js'
import { Standing, type StandingRow, pickShown } from './standings'
import { Panel } from './panel'
import { THEME, two } from '../theme'
import { HUD } from './hud'

// Where they lived before the decoder moved to standings.ts; game.ts imports them from here.
export { Standing, decodeStanding, type StandingRow } from './standings'

const STATUS_LABEL: Record<number, string> = {
  [Standing.ACTIVE]: 'ACTIVE',
  [Standing.EXTRACTED]: 'EXTRACTED',
  [Standing.DEAD]: 'DEAD'
}
const STATUS_COLOUR: Record<number, number> = {
  [Standing.ACTIVE]: THEME.armor,
  [Standing.EXTRACTED]: THEME.accent,
  [Standing.DEAD]: THEME.danger
}

/** How many rows the board shows before your own. */
const TOP = 5
const ROW_H = 38
const COL = { rank: 0, name: 70, loot: 300, status: 330 }
const WIDTH = 480

interface RowTexts { rank: Text, name: Text, loot: Text, status: Text, dot: Graphics }

/**
 * The mockup's top-right LEADERBOARD, "THIS RUN": the world's players ranked
 * by the loot they carry, the top five plus your own row, highlighted. Fed by
 * the server's `standings` event (`Game.onStandings`).
 *
 * Its Text objects are made once and reused: a pixi Text owns a canvas
 * texture, and making fresh ones every second would leak them.
 */
export class Leaderboard extends Panel {
  static Instance: Leaderboard | undefined

  private readonly _rows: RowTexts[] = []
  private readonly _highlight = new Graphics()
  private readonly _gap: Text
  private readonly _footer: Text

  constructor () {
    super('LEADERBOARD', 'THIS RUN')
    Leaderboard.Instance = this

    this.body.addChild(this._highlight)
    const header = (label: string, x: number, right = false): void => {
      const t = Panel.text(label, THEME.smallSize, THEME.muted)
      t.x = x
      if (right) t.anchor.set(1, 0)
      this.body.addChild(t)
    }
    header('RANK', COL.rank)
    header('PLAYER', COL.name)
    header('LOOT', COL.loot, true)
    header('STATUS', COL.status)

    // TOP rows, and one more for your own when it is below them.
    for (let i = 0; i < TOP + 1; i++) {
      const row: RowTexts = {
        rank: Panel.text('', THEME.bodySize + 2, THEME.text),
        name: Panel.text('', THEME.bodySize, THEME.text),
        loot: Panel.text('', THEME.bodySize, THEME.text),
        status: Panel.text('', THEME.bodySize, THEME.text),
        dot: new Graphics()
      }
      row.loot.anchor.set(1, 0)
      row.rank.x = COL.rank
      row.name.x = COL.name
      row.loot.x = COL.loot
      row.status.x = COL.status + 20
      row.dot.x = COL.status + 6
      this.body.addChild(row.rank, row.name, row.loot, row.status, row.dot)
      this._rows.push(row)
    }
    this._gap = Panel.text('...', THEME.bodySize, THEME.muted)
    this._footer = Panel.text('Ranked by loot collected', THEME.smallSize, THEME.muted)
    this.body.addChild(this._gap, this._footer)

    this.setStandings([], undefined)
    window.addEventListener('resize', this.onResize.bind(this))
  }

  /**
   * `rows` in the server's order, which is the ranking; `ownId` is the local
   * player's object id. Which rows show, and with what rank: `pickShown`.
   */
  setStandings (rows: StandingRow[], ownId: number | undefined): void {
    const { shown, own, ownBelow } = pickShown(rows, ownId, TOP)
    let y = 28
    this._highlight.clear()
    this._gap.visible = false
    this._rows.forEach((texts, i) => {
      const entry = shown[i]
      const visible = entry !== undefined
      for (const t of [texts.rank, texts.name, texts.loot, texts.status, texts.dot]) t.visible = visible
      if (!visible) return
      if (ownBelow && i === shown.length - 1) {
        this._gap.visible = true
        this._gap.x = COL.name
        this._gap.y = y - 8
        y += 16
      }
      const isOwn = entry.row === own
      const finished = entry.row.status !== Standing.ACTIVE
      const colour = STATUS_COLOUR[entry.row.status] ?? THEME.muted
      texts.rank.text = two(entry.rank)
      texts.rank.style.fill = entry.rank === 1 ? THEME.loot : THEME.text
      // Bots look like players but are marked here (decision #47).
      texts.name.text = entry.row.bot ? `${entry.row.name} · BOT` : entry.row.name
      texts.name.style.fill = isOwn ? THEME.accent : THEME.text
      texts.name.alpha = finished ? 0.6 : 1
      texts.loot.text = entry.row.loot.toLocaleString('en-US')
      texts.status.text = STATUS_LABEL[entry.row.status] ?? '?'
      texts.status.style.fill = colour
      texts.dot.clear().beginFill(colour).drawCircle(0, 9, 5).endFill()
      for (const t of [texts.rank, texts.name, texts.loot, texts.status]) t.y = y
      texts.dot.y = y
      if (isOwn) {
        this._highlight
          .beginFill(THEME.accent, 0.12).drawRect(-THEME.pad, y - 8, WIDTH, ROW_H - 4).endFill()
          .beginFill(THEME.accent, 1).drawRect(-THEME.pad, y - 8, 3, ROW_H - 4).endFill()
      }
      y += ROW_H
    })
    this._footer.y = y + (shown.length === 0 ? 0 : -2)
    this.fit(WIDTH)
    this.onResize()
  }

  /** Placed by the HUD, which knows what else is on screen; alone at the top right before one exists. */
  onResize (): void {
    if (HUD.Instance !== undefined) {
      HUD.Instance.updateLayout()
      return
    }
    const scale = HUD.scale()
    this.scale.set(scale, scale)
    this.x = window.innerWidth - this.panelWidth * scale - HUD.MARGIN
    this.y = HUD.MARGIN
  }
}
