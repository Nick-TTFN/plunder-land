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
import { type GearInstance, GEAR_SLOTS } from '../../utils/gear'
import { Session } from '../../net/session'
import { Aim } from '../../skills/aim'
import { RangedAttack } from '../../skills/rangedattack'
import { Joystick, type Rect } from './joystick'
import { INPUT_MODE } from '../../input/inputmode'
import { SAFE_AREA, refreshSafeArea } from '../safearea'
import { RadialCluster } from './radial'

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
  /** The left-thumb joystick (decision #59, mobile-2): shown in touch mode during a run. */
  readonly joystick = new Joystick()
  /**
   * The right-thumb skill and item buttons (decision #59, mobile-3): shown in
   * touch mode during a run, in place of the skill row and the status panel's
   * inventory, which stay alive (hidden) and do the casting.
   */
  readonly radial = new RadialCluster()

  constructor () {
    super()
    HUD.Instance = this
    // First, so every panel draws over it.
    this.addChild(this.joystick)
    this.addChild(this.legend)
    this.addChild(this.radial)
    // Controls follow touch mode (input/inputmode.ts), so a switch re-lays the HUD.
    // The safe-area insets are re-read only here, on a resize and a mode
    // change (getComputedStyle; updateLayout also runs on every standings update).
    INPUT_MODE.listeners.add(() => { refreshSafeArea(); this.updateLayout() })
    window.addEventListener('keydown', this.onKeyDown.bind(this), false)
    window.addEventListener('resize', () => { refreshSafeArea(); this.updateLayout() })
    refreshSafeArea()
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
      // On a phone the leaderboard opens and closes from the clock.
      this.clock.eventMode = 'static'
      this.clock.on('pointertap', () => { this.toggleBoard() })
      this.addChild(this.clock)
    }
    this.clock.start()
    if (this.layers === undefined) {
      this.layers = new LayersPanel()
      this.addChild(this.layers)
    }
    this.layers.reset()
    this.bindRadial()
    this.updateLayout()
  }

  /** The radial's buttons follow this run's cards and inventory. */
  private bindRadial (): void {
    this.radial.bind(this.skills?.cards, this.status?.inventory)
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

  /** The run's kit skill ids, for which gear is a duplicate (`setupGear`). */
  private _kit: readonly number[] = []

  /**
   * A new run's gear (decision #49): keys 3 and 4 and the bag live in the
   * inventory, which `setupStats` made afresh. `kit` is the run's 4 skill ids.
   */
  setupGear (kit: readonly number[]): void {
    this._kit = kit
    this.status?.inventory.updateGear([], kit)
    this.bindRadial()
    this.radial.setBag([], kit)
    this.updateLayout()
  }

  /** The own player's `carried` field: the gear slots and the bag. */
  updateGear (carried: ReadonlyArray<GearInstance | null>): void {
    this.status?.inventory.updateGear(carried, this._kit)
    this.radial.setBag(carried.slice(GEAR_SLOTS), this._kit)
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
    this.bindRadial()
    this.updateLayout()
  }

  /**
   * A phone (either side under 520 px): the leaderboard is hidden until the
   * clock is tapped, and the fog legend isn't drawn, so the robot and the
   * ground round it stay in view. Touch controls, L9 (Claude's layout).
   */
  static phone (): boolean {
    return Math.min(window.innerWidth, window.innerHeight) < 520
  }

  /** On a phone, whether the clock's tap has the leaderboard open. */
  boardOpen = false

  toggleBoard (): void {
    if (!HUD.phone()) return
    this.boardOpen = !this.boardOpen
    this.updateLayout()
  }

  updateLayout (): void {
    const s = HUD.scale()
    const m = HUD.MARGIN
    const W = window.innerWidth
    const H = window.innerHeight
    const phone = HUD.phone()
    // Touch mode in a run (decision #59): the radial has the skills and the
    // inventory, so the skill row is hidden and the status panel drops its
    // inventory (both stay alive: they do the casting and hold the keys).
    const touchRun = INPUT_MODE.touch && this.status !== undefined
    this.status?.setInventoryShown(!touchRun)
    this.legend.renderable = !phone
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
    if (board !== undefined) board.visible = !phone || this.boardOpen
    if (board !== undefined && board.visible) {
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

    // The joystick's zone: the left 45% of the screen, under the top HUD band
    // (the status panel; the clock is centred or in the right corner), inside
    // the safe area. Its ghost rests bottom left. Nothing pressable sits in
    // it in touch mode (the radial keeps out of it); a press on a panel would
    // hit the panel, never the stage, so it would never start the stick.
    const statusBottom = this.status !== undefined ? m + this.status.panelHeight * s : 0
    const top = Math.max(SAFE_AREA.top, statusBottom)
    const left = SAFE_AREA.left
    const bottom = H - SAFE_AREA.bottom
    const zone: Rect = { x: left, y: top, width: Math.max(0, W * 0.45 - left), height: Math.max(0, bottom - top) }

    // Bottom: skills on the left, layers on the right with the fog legend
    // above it. When the skills would need more than two rows beside the
    // layers panel (a phone), the layers panel stacks above the skills instead
    // and the skills get the full width. In touch mode, the radial instead.
    const lw = this.layers !== undefined ? this.layers.panelWidth * s : 0
    let stacked = false
    if (this.skills !== undefined) this.skills.visible = !touchRun
    if (touchRun) {
      this.layoutTouch(s, m, W, H, clockBottom === 0 && this.clock !== undefined ? m + this.clock.panelHeight * s : 0, statusRight, zone)
    } else {
      this.radial.layout(zone, [], false)
      if (this.skills !== undefined) {
        this.skills.wrap(Math.max(200, (W - lw - 3 * m) / s))
        stacked = this.skills.rows > 2
        if (stacked) this.skills.wrap((W - 2 * m) / s)
        place(this.skills, m, H - this.skills.panelHeight * s - m)
      }
      if (this.layers !== undefined) {
        const layersBottom = stacked && this.skills !== undefined ? this.skills.y - m : H - m
        place(this.layers, W - lw - m, layersBottom - this.layers.panelHeight * s)
        // Local bounds, not `width`: `width` already includes the scale `place`
        // set last time, so multiplying by `s` again pushed the legend off the
        // right edge on any screen smaller than 1600 x 900.
        place(this.legend, W - this.legend.getLocalBounds().width * s - m, this.layers.y - 40 * s)
      }
    }

    this.joystick.layout(zone, left + Joystick.INSET, bottom - Joystick.INSET, touchRun)
  }

  /**
   * Touch mode's bottom and centre (mobile-3): the radial cluster bottom right
   * inside the safe area, and the layers panel (with the fog legend under it)
   * at the top centre under a centred clock, out of the radial's way (mobile-4
   * turns it into a badge on a phone). `clockBottom` is a centred clock's
   * bottom edge, or 0; `zone` the joystick's, which the radial keeps out of.
   */
  private layoutTouch (s: number, m: number, W: number, H: number, clockBottom: number, statusRight: number, zone: Rect): void {
    const place = (c: Container, x: number, y: number): void => {
      c.scale.set(s, s)
      c.x = Math.round(x)
      c.y = Math.round(y)
    }
    if (this.layers !== undefined) {
      const lw = this.layers.panelWidth * s
      place(this.layers, Math.max(statusRight + m, (W - lw) / 2), Math.max(SAFE_AREA.top, clockBottom) + m)
      const legendW = this.legend.getLocalBounds().width * s
      place(this.legend, Math.max(statusRight + m, (W - legendW) / 2), this.layers.y + this.layers.panelHeight * s + 8 * s)
    }
    const avoid: Rect[] = [zone]
    const board = Leaderboard.Instance
    for (const c of [this.status, this.clock, this.map, this.layers, board?.visible === true ? board : undefined, this.legend.visible && this.legend.renderable ? this.legend : undefined]) {
      if (c === undefined) continue
      const b = c.getBounds()
      avoid.push({ x: b.x, y: b.y, width: b.width, height: b.height })
    }
    this.radial.layout(
      { x: SAFE_AREA.left, y: SAFE_AREA.top, width: W - SAFE_AREA.left - SAFE_AREA.right, height: H - SAFE_AREA.top - SAFE_AREA.bottom },
      avoid,
      true
    )
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
    this.status?.inventory.tick(performance.now())
    this.clock?.update()
    // First-run tutorial hint: the ranged card pulses while auto-aim has a
    // target (the first rock onwards), so the first press is the right one.
    const hint = Session.firstRun && Aim.target !== undefined
    this.skills?.update(performance.now(), hint ? (skill) => skill instanceof RangedAttack : undefined)
    // After the cards: the radial draws their cooldowns and hint as they now stand.
    this.radial.update(performance.now())
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
    this.bindRadial()
    this.updateLayout()
  }
}
