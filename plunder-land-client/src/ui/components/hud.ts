import { Container } from 'pixi.js'
import { MiniMap } from './minimap'
import { type Skill } from '../../skills/skill'
import { StatusPanel } from './statuspanel'
import { RunClock } from './runclock'
import { SkillPanel, type SkillCard } from './skillpanel'
import { LayersPanel, FogLegend } from './layerspanel'
import { Leaderboard } from './leaderboard'
import { Game } from '../../game'
import { SETTINGS, normaliseKey } from '../../net/settings'
import { SettingsPanel } from '../settings/settingspanel'

const MINIMAP = 200

/**
 * The HUD, laid out as the mockup (hud-rebuild, M2): the status panel top
 * left, the run clock top centre, the leaderboard top right with the minimap
 * under it (decision #36: the minimap stays), skills bottom left, and the
 * layers panel bottom right with the fog legend above it. Placeholder look
 * throughout (`ui/theme.ts`, `Panel`) until the art pass.
 *
 * Everything scales together with the window (`HUD.scale`), down to half
 * size, and the skill cards wrap into rows to leave room for the layers
 * panel, so it stays usable at phone width. The leaderboard is added to the
 * stage by index.ts, not here, because it also shows between runs; its
 * position still comes from here once a HUD exists.
 */
export class HUD extends Container {
  static Instance: HUD | undefined
  static MARGIN = 16

  controlsMap = new Map<string, SkillCard>()
  map: MiniMap | undefined
  status: StatusPanel | undefined
  clock: RunClock | undefined
  skills: SkillPanel | undefined
  layers: LayersPanel | undefined
  readonly legend = new FogLegend()

  constructor () {
    super()
    HUD.Instance = this
    this.addChild(this.legend)
    window.addEventListener('keydown', this.onKeyDown.bind(this), false)
    window.addEventListener('resize', this.updateLayout.bind(this))
    this.updateLayout()
  }

  /** 1 at 1600 x 900 and up, down to 0.5 on small screens. */
  static scale (): number {
    return Math.max(0.5, Math.min(1, window.innerWidth / 1600, window.innerHeight / 900))
  }

  setupGameUI (): void {
    this.map = new MiniMap(MINIMAP, MINIMAP, 0.3)
    this.addChild(this.map)
    this.updateLayout()
  }

  /** The run's own player exists: status, clock and layers for this run. */
  setupStats (): void {
    if (this.status === undefined) {
      this.status = new StatusPanel()
      this.addChild(this.status)
    }
    if (this.clock === undefined) {
      this.clock = new RunClock()
      this.addChild(this.clock)
    }
    this.clock.start()
    if (this.layers === undefined) {
      this.layers = new LayersPanel()
      this.addChild(this.layers)
    }
    this.layers.reset()
    this.updateLayout()
  }

  /** Kept for game.ts's callers: the status panel reads the player every frame. */
  updateStats (_data: unknown): void {
    this.status?.update()
  }

  /** The inventory lives in the status panel (`setupStats`). */
  setupInventory (): void {}

  updateInventory (counts: number[]): void {
    this.status?.inventory.update(counts)
  }

  /**
   * One card per slot, `keys[i]` on slot i (`slotsFor`): Q W E R for a kit,
   * Q to I in the legacy fallback. An empty slot's key binds nothing, and
   * neither does any key past the kit.
   */
  setupSkills (value: Array<Skill | null>, keys: readonly string[]): void {
    if (this.skills !== undefined) this.removeChild(this.skills)
    this.skills = new SkillPanel(value, keys)
    this.controlsMap.clear()
    for (const card of this.skills.cards) if (card.skill !== null) this.controlsMap.set(card.key, card)
    this.addChild(this.skills)
    this.updateLayout()
  }

  updateLayout (): void {
    const s = HUD.scale()
    const m = HUD.MARGIN
    const W = window.innerWidth
    const H = window.innerHeight
    const place = (c: Container | undefined, x: number, y: number): void => {
      if (c === undefined) return
      c.scale.set(s, s)
      c.x = Math.round(x)
      c.y = Math.round(y)
    }

    place(this.status, m, m)
    // Top centre, unless that runs into the status panel (a phone): then the
    // top right corner, and the board goes under the status panel below.
    const statusRight = this.status !== undefined ? m + this.status.panelWidth * s : 0
    let clockBottom = 0
    if (this.clock !== undefined) {
      const cw = this.clock.panelWidth * s
      const centred = (W - cw) / 2
      place(this.clock, centred >= statusRight + m ? centred : W - cw - m, m)
      clockBottom = centred >= statusRight + m ? 0 : m + this.clock.panelHeight * s
    }

    // Top right: the leaderboard, and the minimap under it. On a screen too
    // narrow for the status panel and the board side by side, the board goes
    // under the status panel instead.
    const board = Leaderboard.Instance
    let rightTop = Math.max(m, clockBottom + m)
    if (board !== undefined) {
      const boardW = board.panelWidth * s
      const beside = W - boardW - m >= statusRight + m && clockBottom === 0
      board.scale.set(s, s)
      board.x = Math.round(beside ? W - boardW - m : m)
      board.y = Math.round(beside ? m : (this.status !== undefined ? m + this.status.panelHeight * s + m : m))
      rightTop = beside ? board.y + board.panelHeight * s + m : rightTop
    }
    if (this.map !== undefined) {
      this.map.scale.set(s, s)
      this.map.x = Math.round(W - MINIMAP * s - m)
      this.map.y = Math.round(rightTop)
    }

    // Bottom: skills on the left, layers on the right with the fog legend
    // above it. When the skills would need more than two rows beside the
    // layers panel (a phone), the layers panel stacks above the skills instead
    // and the skills get the full width.
    const lw = this.layers !== undefined ? this.layers.panelWidth * s : 0
    let stacked = false
    if (this.skills !== undefined) {
      this.skills.wrap(Math.max(200, (W - lw - 3 * m) / s))
      stacked = this.skills.rows > 2
      if (stacked) this.skills.wrap((W - 2 * m) / s)
      place(this.skills, m, H - this.skills.panelHeight * s - m)
    }
    if (this.layers !== undefined) {
      const bottom = stacked && this.skills !== undefined ? this.skills.y - m : H - m
      place(this.layers, W - lw - m, bottom - this.layers.panelHeight * s)
      // Local bounds, not `width`: `width` already includes the scale `place`
      // set last time, so multiplying by `s` again pushed the legend off the
      // right edge on any screen smaller than 1600 x 900.
      place(this.legend, W - this.legend.getLocalBounds().width * s - m, this.layers.y - 40 * s)
    }
  }

  onKeyDown (e: { key: string }): void {
    // Escape opens and closes settings (`SettingsPanel`, which takes every key while open).
    if (e.key === 'Escape') {
      SettingsPanel.toggle()
      return
    }
    const key = normaliseKey(e.key)
    // The item keys (1-5 by default, settings), slot 0-4.
    const slot = SETTINGS.value.itemKeys.indexOf(key)
    if (slot >= 0) {
      this.status?.inventory.use(slot)
      return
    }
    this.invokeKeyBoundSkill(key)
  }

  /** New skill keys from settings, mid-run: each card takes its slot's key, cooldowns kept. */
  rekey (keys: readonly string[]): void {
    if (this.skills === undefined) return
    this.controlsMap.clear()
    this.skills.cards.forEach((card, i) => {
      if (keys[i] !== undefined) card.setKey(keys[i])
      if (card.skill !== null) this.controlsMap.set(card.key, card)
    })
  }

  invokeKeyBoundSkill (value: string): void {
    this.controlsMap.get(value)?.invoke()
  }

  update (dt: number): void {
    if (this.map != null) this.map.update(dt)
    this.status?.update()
    this.clock?.update()
    this.skills?.update(performance.now())
    this.layers?.setCurrent(Game.PLAYER?.tag)
  }

  clearGameUI (): void {
    for (const c of [this.map, this.status, this.clock, this.skills, this.layers]) {
      if (c !== undefined) this.removeChild(c)
    }
    this.map = undefined
    this.status = undefined
    this.clock = undefined
    this.skills = undefined
    this.layers = undefined
    this.controlsMap.clear()
  }
}
