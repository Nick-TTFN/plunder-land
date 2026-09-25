import { Graphics, Text } from 'pixi.js'

/** The status byte of a standings row. Mirrors the server's `Standing`. */
export enum Standing {
  ACTIVE = 0,
  EXTRACTED = 1,
  DEAD = 2
}

export interface StandingRow {
  id: number
  status: Standing
  loot: number
  name: string
}

/**
 * One `standings` record: `[uint16 id][uint8 status][uint32 loot][UTF-8 name][0]`,
 * big-endian (server `Multiplayer.buildStandings`). Anything after the NUL is a
 * field added later and is ignored. A record too short for its fixed part is
 * dropped.
 */
export function decodeStanding (record: Uint8Array): StandingRow | undefined {
  if (record.length < 7) return undefined
  let end = 7
  while (end < record.length && record[end] !== 0) end++
  return {
    id: (record[0] << 8) | record[1],
    status: record[2],
    loot: ((record[3] << 24) >>> 0) + (record[4] << 16) + (record[5] << 8) + record[6],
    name: new TextDecoder().decode(record.subarray(7, end))
  }
}

const FONT = 'Lilliput Steps'
const TEXT = 0xF2EEE3
const MUTED = 0xA8A294
const LOOT = 0xFFD34D
const STATUS_LABEL: Record<number, string> = {
  [Standing.ACTIVE]: 'ACTIVE',
  [Standing.EXTRACTED]: 'EXTRACTED',
  [Standing.DEAD]: 'DEAD'
}
const STATUS_COLOUR: Record<number, number> = {
  [Standing.ACTIVE]: 0x8FD694,
  [Standing.EXTRACTED]: 0x6EC6FF,
  [Standing.DEAD]: 0xFF6B6B
}

/** How many rows the board shows before your own. */
const TOP = 5
const PAD = 10
const GAP = 12
const TITLE_HEIGHT = 26
const ROW_HEIGHT = 20

interface RowTexts { rank: Text, name: Text, loot: Text, status: Text }

/**
 * "THIS RUN": the world's players ranked by the loot they carry, the top five
 * plus your own row, highlighted. Fed by the server's `standings` event about
 * once a second (`Game.onStandings`); it no longer polls `/stats`.
 *
 * Its Text objects are made once and reused: a pixi Text owns a canvas
 * texture, and making fresh ones every second would leak them.
 */
export class Leaderboard extends Graphics {
  static Instance: Leaderboard | undefined

  private readonly _title: Text
  private readonly _gap: Text
  private readonly _rows: RowTexts[] = []

  constructor () {
    super()
    Leaderboard.Instance = this

    this._title = this.text('THIS RUN', 18, TEXT)
    this._title.x = PAD
    this._title.y = 6
    this._gap = this.text('...', 16, MUTED)

    // TOP rows, and one more for your own when it is below them.
    for (let i = 0; i < TOP + 1; i++) {
      this._rows.push({
        rank: this.text('', 16, MUTED),
        name: this.text('', 16, TEXT),
        loot: this.text('', 16, LOOT),
        status: this.text('', 16, TEXT)
      })
    }
    this._rows.forEach((row) => { row.loot.anchor.set(1, 0) })

    this.setStandings([], undefined)

    window.addEventListener('resize', this.onResize.bind(this))
  }

  private text (value: string, size: number, fill: number): Text {
    const text = new Text(value, { fill, fontFamily: FONT, fontSize: size })
    text.anchor.set(0, 0)
    this.addChild(text)
    return text
  }

  /**
   * `rows` in the server's order, which is the ranking. `ownId` is the local
   * player's object id: the own row is the ACTIVE one with that id. Ids are
   * recycled, so a finished row can share it; a live one cannot.
   */
  setStandings (rows: StandingRow[], ownId: number | undefined): void {
    const ownIndex = ownId === undefined ? -1 : rows.findIndex((r) => r.id === ownId && r.status === Standing.ACTIVE)

    const shown: Array<{ rank: number, row: StandingRow }> = []
    rows.slice(0, TOP).forEach((row, i) => shown.push({ rank: i + 1, row }))
    const ownBelow = ownIndex >= TOP
    if (ownBelow) shown.push({ rank: ownIndex + 1, row: rows[ownIndex] })

    // Column widths from what is actually shown.
    let rankW = 0
    let nameW = 0
    let lootW = 0
    let statusW = 0
    this._rows.forEach((texts, i) => {
      const entry = shown[i]
      const visible = entry !== undefined
      for (const t of [texts.rank, texts.name, texts.loot, texts.status]) t.visible = visible
      if (!visible) return
      const finished = entry.row.status !== Standing.ACTIVE
      texts.rank.text = `${entry.rank}.`
      texts.name.text = entry.row.name
      texts.name.alpha = finished ? 0.65 : 1
      texts.loot.text = String(entry.row.loot)
      texts.status.text = STATUS_LABEL[entry.row.status] ?? '?'
      texts.status.style.fill = STATUS_COLOUR[entry.row.status] ?? MUTED
      rankW = Math.max(rankW, texts.rank.width)
      nameW = Math.max(nameW, texts.name.width)
      lootW = Math.max(lootW, texts.loot.width)
      statusW = Math.max(statusW, texts.status.width)
    })

    const nameX = PAD + rankW + 6
    const lootRight = nameX + nameW + GAP + lootW
    const statusX = lootRight + GAP
    const width = Math.max(statusX + statusW + PAD, this._title.width + 2 * PAD, 160)

    let y = TITLE_HEIGHT
    let highlightY: number | undefined
    this._gap.visible = false
    shown.forEach((entry, i) => {
      if (ownBelow && i === shown.length - 1) {
        this._gap.visible = true
        this._gap.x = PAD
        this._gap.y = y - 4
        y += ROW_HEIGHT - 6
      }
      const texts = this._rows[i]
      texts.rank.x = PAD
      texts.name.x = nameX
      texts.loot.x = lootRight
      texts.status.x = statusX
      for (const t of [texts.rank, texts.name, texts.loot, texts.status]) t.y = y
      if (entry.row === rows[ownIndex]) highlightY = y
      y += ROW_HEIGHT
    })
    const height = y + (shown.length === 0 ? 0 : 4)

    this.clear()
      .beginFill(0x14161C, 0.85)
      .lineStyle(1, 0x3A3F4B, 1)
      .drawRoundedRect(0, 0, width, height, 6)
      .endFill()
      .lineStyle(0)
    if (highlightY !== undefined) {
      this.beginFill(LOOT, 0.22)
        .drawRect(2, highlightY - 2, width - 4, ROW_HEIGHT)
        .endFill()
    }

    this.onResize()
  }

  onResize (): void {
    this.x = window.innerWidth - this.width - 10
    this.y = 10
  }
}
