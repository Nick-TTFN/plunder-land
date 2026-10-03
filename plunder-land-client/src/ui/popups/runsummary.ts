import { Container, Graphics, type Text } from 'pixi.js'
import { Panel } from '../components/panel'
import { THEME, two } from '../theme'
import { HUD } from '../components/hud'
import { ACCOUNT, PROGRESS_WAIT_MS, type ProgressInfo, xpLine } from '../../net/account'

/** How a run ended, from the own player's destroy record. */
export type RunOutcome = 'extracted' | 'dead'

/**
 * What the end-of-run card shows (run-summary-card, M2, decision #16 Q16).
 * Everything is client-side except `kills`, which the server sends as field
 * `kills` (21). Loot is the carried loot at the end: banked on an extraction,
 * lost on a death (it scatters on the ground). The client's loot is the
 * server's `loot32`, so it is the banked figure, not an estimate.
 *
 * `start` at the own create; `layer` and `kills` as they change; `finish` at
 * the own destroy; `setProgress` when the server's `progress` lands (decision
 * #48 step 3), which can be just before the own destroy or a database round
 * trip after it.
 */
export class RunRecord {
  startedAt = 0
  /** The XP this run earned, once the server has written it. */
  progress: ProgressInfo | undefined
  /** The open card's, to show the XP when it lands. */
  onProgress: ((progress: ProgressInfo) => void) | undefined
  /** Deepest layer reached, as a layer number (1 = layer 01). */
  deepest = 0
  kills = 0
  loot = 0
  robot = ''
  durationMs = 0

  start (robot: string | undefined, now: number = performance.now()): void {
    this.startedAt = now
    this.deepest = 0
    this.kills = 0
    this.loot = 0
    this.durationMs = 0
    this.robot = (robot ?? 'robot').toUpperCase()
    this.progress = undefined
  }

  setProgress (progress: ProgressInfo): void {
    this.progress = progress
    this.onProgress?.(progress)
  }

  /** The player is on layer number `n` (undefined: a tag this client wasn't told about). */
  layer (n: number | undefined): void {
    if (n !== undefined && n > this.deepest) this.deepest = n
  }

  finish (loot: number, now: number = performance.now()): void {
    this.loot = loot
    this.durationMs = Math.max(0, now - this.startedAt)
  }

  /** mm:ss, as the run clock writes it. */
  get time (): string {
    const s = Math.floor(this.durationMs / 1000)
    return `${two(Math.floor(s / 60))}:${two(s % 60)}`
  }
}

const WIDTH = 360
const ROW = 30

/**
 * The end-of-run card: outcome, time, loot banked or lost, kills, deepest
 * layer and robot, and a button (or Enter / Space) to go again. Replaces the
 * "Win!" / "Game Over" text. Shown through `Game.popups`, which centres it and
 * drops it on a reconnect. Placeholder look, the HUD's panel kit
 * (decision #36). A shareable image is later work.
 */
export class RunSummaryCard extends Container {
  private readonly _panel: Panel
  private readonly _onKey: (e: KeyboardEvent) => void
  private readonly _onResize: () => void
  private _done = false
  private _watch: Container | undefined
  private _xp: Text | undefined
  private _wait: ReturnType<typeof setTimeout> | undefined

  /**
   * `onWatch`, on a death: a WATCH button that puts the card away to spectate
   * (decision #47), shown once there is someone to watch (`setWatchable`).
   */
  constructor (outcome: RunOutcome, run: RunRecord, private readonly _again: () => void, onWatch?: () => void) {
    super()
    const extracted = outcome === 'extracted'
    const panel = this._panel = new Panel(extracted ? 'EXTRACTED' : 'DESTROYED', 'RUN SUMMARY')

    const rows: Array<[string, string, number]> = [
      ['TIME', run.time, THEME.text],
      [extracted ? 'LOOT BANKED' : 'LOOT LOST', run.loot.toLocaleString('en-US'), run.loot === 0 ? THEME.text : extracted ? THEME.loot : THEME.danger],
      ['KILLS', String(run.kills), THEME.text],
      ['DEEPEST', run.deepest > 0 ? `LAYER ${two(run.deepest)}` : '-', THEME.text],
      ['ROBOT', run.robot, THEME.text],
      ['XP', '', THEME.text]
    ]
    const inner = WIDTH - 2 * THEME.pad
    rows.forEach(([label, value, colour], i) => {
      const l = Panel.text(label, THEME.bodySize, THEME.muted)
      l.y = i * ROW
      const v = Panel.text(value, THEME.bodySize, colour)
      v.anchor.set(1, 0)
      v.x = inner
      v.y = i * ROW
      panel.body.addChild(l, v)
      if (label === 'XP') this._xp = v
    })
    this.showXp(run, false)
    const onProgress = (): void => { this.showXp(run, false) }
    if (run.progress === undefined) {
      run.onProgress = onProgress
      this._wait = setTimeout(() => { this.showXp(run, true) }, PROGRESS_WAIT_MS)
    }

    const button = this.button('PLAY AGAIN', inner, () => { this.again() })
    button.y = rows.length * ROW + 12
    panel.body.addChild(button)
    if (onWatch !== undefined) {
      const watch = this._watch = this.button('WATCH', inner, onWatch, true)
      watch.y = button.y + 48
      panel.body.addChild(watch)
    }
    // Fitted with WATCH in place (pixi leaves invisible children out of the
    // bounds), so the panel has its room when it appears.
    panel.fit(WIDTH)
    if (this._watch !== undefined) this._watch.visible = false

    panel.setTitleColour(extracted ? THEME.accent : THEME.danger)

    panel.x = -panel.panelWidth / 2
    panel.y = -panel.panelHeight / 2
    this.addChild(panel)

    this._onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') this.again() }
    this._onResize = () => { this.scale.set(HUD.scale()) }
    this._onResize()
    window.addEventListener('keydown', this._onKey)
    window.addEventListener('resize', this._onResize)
    this.on('removed', () => {
      if (run.onProgress === onProgress) run.onProgress = undefined
      clearTimeout(this._wait)
      window.removeEventListener('keydown', this._onKey)
      window.removeEventListener('resize', this._onResize)
    })
  }

  private showXp (run: RunRecord, waited: boolean): void {
    const v = this._xp
    if (v === undefined) return
    const [text, tone] = xpLine(run.progress, waited, ACCOUNT.info?.offline === true)
    v.text = text
    v.style.fill = tone === 'accent' ? THEME.accent : tone === 'text' ? THEME.text : THEME.muted
    if (run.progress !== undefined) clearTimeout(this._wait)
  }

  /** Show WATCH once the server says whom this player spectates; hide it when nobody is left. */
  setWatchable (watchable: boolean): void {
    if (this._watch !== undefined) this._watch.visible = watchable
  }

  private button (label: string, width: number, onTap: () => void, quiet = false): Container {
    const button = new Container()
    const height = 40
    const bg = new Graphics()
      .beginFill(quiet ? 0x0B1A22 : 0x0F3340, 1)
      .lineStyle(quiet ? 1 : 2, quiet ? THEME.muted : THEME.accent, 1)
      .drawRoundedRect(0, 0, width, height, 6)
      .endFill()
    const text = Panel.text(label, THEME.bodySize, quiet ? THEME.text : THEME.accent)
    text.anchor.set(0.5, 0.5)
    text.x = width / 2
    text.y = height / 2
    button.addChild(bg, text)
    button.eventMode = 'static'
    button.cursor = 'pointer'
    button.on('pointertap', onTap)
    return button
  }

  /** PLAY AGAIN, from the card or the spectate bar. Once: a click and a key can both land. */
  again (): void {
    if (this._done) return
    this._done = true
    this.parent?.removeChild(this)
    this._again()
  }
}
