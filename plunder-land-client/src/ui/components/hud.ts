import { Circle, Container, Graphics } from 'pixi.js'
import { MiniMap } from './minimap'
import { type Skill } from '../../skills/skill'
import { StatusPanel } from './statuspanel'
import { RunClock } from './runclock'
import { SkillPanel, type SkillCard } from './skillpanel'
import { LayersPanel, LayerBadge, FogLegend } from './layerspanel'
import { Leaderboard } from './leaderboard'
import { Game } from '../../game'
import { SETTINGS, normaliseKey } from '../../net/settings'
import { SettingsPanel } from '../settings/settingspanel'
import { type GearInstance } from '../../utils/gear'
import { Session } from '../../net/session'
import { Aim } from '../../skills/aim'
import { RangedAttack } from '../../skills/rangedattack'
import { Joystick, type Rect } from './joystick'
import { INPUT_MODE } from '../../input/inputmode'
import { SAFE_AREA, refreshSafeArea } from '../safearea'
import { RadialCluster, RADIAL } from './radial'
import { THEME } from '../theme'
import { installRotatePrompt } from '../rotateprompt'
import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from '../fullscreen'
import { fullscreenButtonShown } from '../../net/portal'
import { PORTAL } from '../../config'

const MINIMAP = 200

/** The minimap's largest side on a phone, CSS px (mobile-4; about 80, Claude's default in #59). */
const MINIMAP_PHONE = 80

/**
 * The smallest HUD text on a touch phone, CSS px (g2-4): `HUD.scale` never goes
 * below what puts `THEME.smallSize` text at this size. 10 because it is the
 * layer badge's size, which Nick accepted on his phone (2026-11-05), and
 * CrazyGames' QA judges legibility at DPR 1; the old 0.5 floor put the
 * smallest text at 6.5 px.
 */
export const PHONE_TEXT_FLOOR = 10

/**
 * A touch phone's right side splits by the visible height (Nick, 2026-11-13,
 * decision #62 addendum: "minimap should use up to 1/3rd right top area while
 * controls would take up to 2/3 bottom right"): the minimap and what sits with
 * it in the top third, the radial cluster in the bottom two thirds, scaled
 * down to fit them. This is the share for the top.
 */
const TOP_SHARE = 1 / 3

/**
 * The run header's scale on a touch phone (status panel, clock and latency,
 * and the leaderboard opened from the clock): Nick, 2026-11-13, on the g2-4
 * after shots, "header typography definitely can be smaller. like -30% at
 * least", so 30% under the `PHONE_TEXT_FLOOR` scale (10/13 = 0.77). Its
 * smallest text is about 7 px: Nick's call, overriding the floor for the
 * header only. A desktop-mode window of phone size (CrazyGames' 800x450,
 * 821x462 and 907x510 frames, judged for legibility at DPR 1) uses `MOUSE_PHONE_SCALE`.
 */
export const TOUCH_PHONE_HEADER_SCALE = 0.54

/**
 * The whole HUD's scale in a phone-size window played with a mouse, which
 * includes CrazyGames' desktop frames 800x450, 821x462 and 907x510 (Nick,
 * 2026-11-13, option B, decision #62 addendum): between the old 0.5 and the
 * touch floor's 0.77, panels about 25% smaller than at 0.77 and text about
 * 8-10 px (13 px text at 8.1, 16 px at 9.9).
 */
export const MOUSE_PHONE_SCALE = 0.62

/** The settings button's side, CSS px, never `HUD.scale`d (mobile-4). */
const GEAR = 40

/**
 * The on-screen settings button (decision #59, mobile-4): a cog, top right,
 * in a run, on touch and desktop alike (Nick, 2026-11-04). A tap opens or
 * closes `SettingsPanel` as Escape does; Escape still works. A press on it
 * is never the stage's, so it never moves the robot or starts the stick.
 * Drawn, not a sprite: no sheet has a cog.
 */
export class SettingsButton extends Container {
  constructor () {
    super()
    const r = GEAR / 2
    const frame = new Graphics()
      .beginFill(0x101A28, 0.85)
      .lineStyle(1, THEME.panelBorder, 1)
      .drawCircle(r, r, r)
      .endFill()
    // Eight teeth round a ring, a hole in the middle.
    const points: number[] = []
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4
      for (const [da, radius] of [[-0.39, 9.5], [-0.22, 13], [0.22, 13], [0.39, 9.5]]) {
        points.push(r + Math.cos(a + da) * radius, r + Math.sin(a + da) * radius)
      }
    }
    const cog = new Graphics()
      .beginFill(THEME.text, 1).drawPolygon(points).endFill()
      .beginFill(0x101A28, 1).drawCircle(r, r, 4.5).endFill()
    this.addChild(frame, cog)
    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.hitArea = new Circle(r, r, r)
    this.on('pointertap', () => {
      // A touch's tap is followed by a synthetic click on whatever is under
      // the finger by then, which is the panel's backdrop, and a click on the
      // backdrop closes it: so the tap's own click is swallowed (measured in
      // headless Chrome with real touch events: the panel opened and closed
      // on one tap). A mouse's click lands on the canvas; swallowing it costs
      // nothing.
      swallowNextClick()
      SettingsPanel.toggle()
    })
  }
}

/**
 * The fullscreen button (Nick, 2026-11-05): beside the settings cog, in a run,
 * on every device where it is offered (`fullscreenButtonShown`: the browser
 * can, so never on an iPhone, and not on CrazyGames; g2-1). Corners pointing
 * out to enter, in to leave.
 */
export class FullscreenButton extends Container {
  private readonly _icon = new Graphics()

  constructor () {
    super()
    const r = GEAR / 2
    this.addChild(new Graphics()
      .beginFill(0x101A28, 0.85)
      .lineStyle(1, THEME.panelBorder, 1)
      .drawCircle(r, r, r)
      .endFill(), this._icon)
    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.hitArea = new Circle(r, r, r)
    // pointerup is a user gesture, which requestFullscreen needs.
    this.on('pointertap', () => { toggleFullscreen() })
    onFullscreenChange(() => { this.draw() })
    this.draw()
  }

  private draw (): void {
    const r = GEAR / 2
    const a = 7 // half the square the corners sit on
    const l = 5 // each corner's arm
    const out = !isFullscreen()
    const g = this._icon.clear().lineStyle(2, THEME.text, 1)
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = r + sx * a
      const cy = r + sy * a
      // Out: the corner's tip at (cx, cy), arms pointing back in. In: the tip pulled inward.
      const dx = out ? -sx * l : sx * l
      const dy = out ? -sy * l : sy * l
      const tx = out ? cx : cx - sx * l
      const ty = out ? cy : cy - sy * l
      g.moveTo(tx + dx, ty).lineTo(tx, ty).lineTo(tx, ty + dy)
    }
  }
}

/** Eat the next `click` on the page within 500 ms, before anything sees it. */
function swallowNextClick (): void {
  const eat = (e: Event): void => {
    e.stopImmediatePropagation()
    e.preventDefault()
    done()
  }
  const done = (): void => {
    window.removeEventListener('click', eat, true)
    clearTimeout(timer)
  }
  window.addEventListener('click', eat, true)
  const timer = setTimeout(done, 500)
}

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
  /** The layers panel collapsed to one line, on a phone in a run (mobile-4). */
  badge: LayerBadge | undefined
  /** Top right in a run, touch and desktop (mobile-4). */
  readonly settings = new SettingsButton()
  readonly fullscreen = new FullscreenButton()
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
    this.settings.visible = false
    this.addChild(this.settings)
    this.fullscreen.visible = false
    this.addChild(this.fullscreen)
    // Portrait on a touch screen, lobby and run alike (mobile-4).
    installRotatePrompt()
    // Controls follow touch mode (input/inputmode.ts), so a switch re-lays the HUD.
    // The safe-area insets are re-read only here, on a resize and a mode
    // change (getComputedStyle; updateLayout also runs on every standings update).
    INPUT_MODE.listeners.add(() => { refreshSafeArea(); this.updateLayout() })
    window.addEventListener('keydown', this.onKeyDown.bind(this), false)
    window.addEventListener('resize', () => { refreshSafeArea(); this.updateLayout() })
    refreshSafeArea()
    this.updateLayout()
  }

  /**
   * 1 at 1600 x 900 and up, down to 0.5 on small screens. On a phone never
   * below what keeps the smallest text at `PHONE_TEXT_FLOOR` in touch mode
   * (g2-4), or below `MOUSE_PHONE_SCALE` with a mouse.
   */
  static scale (): number {
    const s = Math.max(0.5, Math.min(1, window.innerWidth / 1600, window.innerHeight / 900))
    if (!HUD.phone()) return s
    return Math.max(s, INPUT_MODE.touch ? Math.min(1, PHONE_TEXT_FLOOR / THEME.smallSize) : MOUSE_PHONE_SCALE)
  }

  /**
   * The header's scale (status panel, clock, leaderboard): `scale()`, except
   * on a touch phone, where it is `TOUCH_PHONE_HEADER_SCALE` (or more on a
   * screen big enough for more).
   */
  static headerScale (): number {
    if (!HUD.phone() || !INPUT_MODE.touch) return HUD.scale()
    return Math.max(TOUCH_PHONE_HEADER_SCALE, Math.min(1, window.innerWidth / 1600, window.innerHeight / 900))
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
    if (this.badge === undefined) {
      this.badge = new LayerBadge()
      this.addChild(this.badge)
    }
    this.badge.setCurrent(undefined)
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
    this.updateLayout()
  }

  /** The own player's `carried` field: the gear slots and the bag. */
  updateGear (carried: ReadonlyArray<GearInstance | null>): void {
    this.status?.inventory.updateGear(carried, this._kit)
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
    // The status panel, the clock and the board (`headerScale`).
    const hs = HUD.headerScale()
    const m = HUD.MARGIN
    const W = window.innerWidth
    const H = window.innerHeight
    const phone = HUD.phone()
    const inRun = this.status !== undefined
    // Touch mode in a run (decision #59): the radial has the skills and the
    // inventory, so the skill row is hidden and the status panel drops its
    // inventory (both stay alive: they do the casting and hold the keys).
    const touchRun = INPUT_MODE.touch && inRun
    // The fullscreen button, left of the settings button in a run (g2-1).
    const fullShown = inRun && fullscreenButtonShown(PORTAL, fullscreenSupported())
    // A phone (mobile-4): the status panel is the bars only, and the layers
    // panel is the one-line badge.
    this.status?.setCompact(phone)
    this.status?.setInventoryShown(!touchRun)
    if (this.layers !== undefined) this.layers.visible = !phone
    if (this.badge !== undefined) this.badge.visible = phone
    this.legend.renderable = !phone
    const place = (c: Container | undefined, x: number, y: number, k = s): void => {
      if (c === undefined) return
      c.scale.set(k, k)
      c.x = Math.round(x)
      c.y = Math.round(y)
    }
    // The screen's edges inside the safe area, less the margin. With no
    // insets (a desktop) these are the margins the HUD always used.
    const T = SAFE_AREA.top + m
    const L = SAFE_AREA.left + m
    const R = W - SAFE_AREA.right - m
    // The visible height and, on a phone, the top third's bottom edge (`TOP_SHARE`):
    // the minimap fits above it, the radial cluster below it.
    const visible = Math.max(0, H - SAFE_AREA.top - SAFE_AREA.bottom)
    const thirdLine = SAFE_AREA.top + visible * TOP_SHARE
    const mapSide = Math.max(40, Math.min(MINIMAP_PHONE, Math.floor(thirdLine - T - RADIAL.GAP)))

    place(this.status, L, T, hs)
    // Top centre, unless that runs into the status panel (a phone): then the
    // top right corner, left of the settings button in a run, and the board
    // goes under the status panel below.
    const statusRight = this.status !== undefined ? L + this.status.panelWidth * hs : 0
    let clockBottom = 0
    if (this.clock !== undefined) {
      const cw = this.clock.panelWidth * hs
      const centred = (W - cw) / 2
      // Cornered, it keeps left of the settings and fullscreen buttons (and a phone's minimap).
      const reserve = inRun ? GEAR + m + (fullShown ? GEAR + RADIAL.GAP : 0) + (phone && this.map !== undefined ? mapSide + RADIAL.GAP : 0) : 0
      place(this.clock, centred >= statusRight + m ? centred : R - cw - reserve, T, hs)
      clockBottom = centred >= statusRight + m ? 0 : T + this.clock.panelHeight * hs
    }

    // Top right: the leaderboard, and the minimap under it. On a screen too
    // narrow for the status panel and the board side by side, the board goes
    // under the status panel instead. The settings button sits left of a
    // board beside the clock, else in the corner.
    const board = Leaderboard.Instance
    let rightTop = Math.max(T, clockBottom + m)
    let gearX = R - GEAR
    if (board !== undefined) board.visible = !phone || this.boardOpen
    if (phone) {
      // The corner is the 80 px minimap's, with the settings button left of
      // it: both clear of the radial's BAG below (mobile-3's carry-over), and
      // the open bag row then finds room left of the minimap under the
      // button (the other way round, at 667 x 375 with insets, it had none).
      // A board opened from the clock hangs under them, right-aligned.
      if (this.map !== undefined) {
        const k = mapSide / MINIMAP
        this.map.scale.set(k, k)
        this.map.x = Math.round(R - mapSide)
        this.map.y = Math.round(T)
        gearX = this.map.x - RADIAL.GAP - GEAR
      }
      // Touch: the board opens under the status panel, clear of the radial
      // cluster (placed after the cluster, `placePhoneBoard`). Mouse: under the
      // minimap, right-aligned, as before.
      if (board !== undefined && board.visible && !touchRun) {
        board.scale.set(hs, hs)
        board.x = Math.round(R - board.panelWidth * hs)
        board.y = Math.round(T + Math.max(GEAR, this.map !== undefined ? mapSide : 0) + m)
      }
    } else {
      if (board !== undefined && board.visible) {
        const boardW = board.panelWidth * hs
        const beside = R - boardW >= statusRight + m && clockBottom === 0
        board.scale.set(hs, hs)
        board.x = Math.round(beside ? R - boardW : L)
        board.y = Math.round(beside ? T : (this.status !== undefined ? T + this.status.panelHeight * hs + m : T))
        rightTop = beside ? board.y + board.panelHeight * hs + m : rightTop
        if (beside) gearX = board.x - m - GEAR
      }
      if (this.map !== undefined) {
        this.map.scale.set(s, s)
        this.map.x = Math.round(R - MINIMAP * s)
        this.map.y = Math.round(rightTop)
      }
    }
    this.settings.visible = inRun
    this.settings.x = Math.round(gearX)
    this.settings.y = Math.round(T)
    this.fullscreen.visible = fullShown
    this.fullscreen.x = Math.round(gearX - RADIAL.GAP - GEAR)
    this.fullscreen.y = Math.round(T)

    // The phone's layer badge: a small pill in the minimap's bottom-right
    // corner, at CSS size (Nick, 2026-11-05). Under the clock if there is no
    // minimap.
    if (phone && this.badge !== undefined) {
      this.badge.scale.set(1, 1)
      if (this.map !== undefined) {
        // Inside the minimap (g2-4: its tags line stuck out 36 px to the left).
        this.badge.fitWidth(mapSide - 10)
        this.badge.x = Math.round(this.map.x + mapSide - this.badge.panelWidth - 5)
        this.badge.y = Math.round(this.map.y + mapSide - this.badge.panelHeight - 4)
      } else {
        const clockBelow = this.clock !== undefined ? this.clock.y + this.clock.panelHeight * hs : T
        this.badge.x = Math.round((W - this.badge.panelWidth) / 2)
        this.badge.y = Math.round(clockBelow + 8)
      }
    }

    // The joystick's zone: the left 45% of the screen, under the top HUD band
    // (the status panel; the clock is centred or in the right corner), inside
    // the safe area. Its ghost rests bottom left. Nothing pressable sits in
    // it in touch mode (the radial keeps out of it); a press on a panel would
    // hit the panel, never the stage, so it would never start the stick.
    const statusBottom = this.status !== undefined ? T + this.status.panelHeight * hs : 0
    const top = Math.max(SAFE_AREA.top, statusBottom)
    const left = SAFE_AREA.left
    const bottom = H - SAFE_AREA.bottom
    const zone: Rect = { x: left, y: top, width: Math.max(0, W * 0.45 - left), height: Math.max(0, bottom - top) }

    // Bottom: skills on the left, layers on the right with the fog legend
    // above it. When the skills would need more than two rows beside the
    // layers panel (a phone), the layers panel stacks above the skills instead
    // and the skills get the full width. In touch mode, the radial instead.
    const layers = this.layers !== undefined && this.layers.visible ? this.layers : undefined
    const lw = layers !== undefined ? layers.panelWidth * s : 0
    let stacked = false
    if (this.skills !== undefined) this.skills.visible = !touchRun
    if (touchRun) {
      this.layoutTouch(s, m, W, H, clockBottom === 0 && this.clock !== undefined ? T + this.clock.panelHeight * hs : 0, statusRight, zone, phone ? thirdLine : undefined)
      if (phone && board !== undefined && board.visible) this.placePhoneBoard(board, hs, L, this.status !== undefined ? T + this.status.panelHeight * hs + m : T)
    } else {
      this.radial.layout(zone, [], false)
      if (this.skills !== undefined) {
        this.skills.wrap(Math.max(200, (W - lw - 3 * m) / s))
        stacked = this.skills.rows > 2
        if (stacked) this.skills.wrap((W - 2 * m) / s)
        place(this.skills, m, H - this.skills.panelHeight * s - m)
      }
      if (layers !== undefined) {
        const layersBottom = stacked && this.skills !== undefined ? this.skills.y - m : H - m
        place(layers, W - lw - m, layersBottom - layers.panelHeight * s)
        // Local bounds, not `width`: `width` already includes the scale `place`
        // set last time, so multiplying by `s` again pushed the legend off the
        // right edge on any screen smaller than 1600 x 900.
        place(this.legend, W - this.legend.getLocalBounds().width * s - m, layers.y - 40 * s)
      }
    }

    this.joystick.layout(zone, left + Joystick.INSET, bottom - Joystick.INSET, touchRun)
  }

  /**
   * Touch mode's bottom and centre (mobile-3): the radial cluster bottom right
   * inside the safe area. Off a phone (a tablet) the layers panel, with the
   * fog legend under it, sits at the top centre under a centred clock, out of
   * the radial's way; on a phone the badge has its place (`updateLayout`).
   * `clockBottom` is a centred clock's bottom edge, or 0; `zone` the
   * joystick's, which the radial keeps out of.
   */
  private layoutTouch (s: number, m: number, W: number, H: number, clockBottom: number, statusRight: number, zone: Rect, thirdLine: number | undefined): void {
    const place = (c: Container, x: number, y: number): void => {
      c.scale.set(s, s)
      c.x = Math.round(x)
      c.y = Math.round(y)
    }
    const layers = this.layers?.visible === true ? this.layers : undefined
    const board = Leaderboard.Instance
    // A board beside the clock (a tablet) can reach the centre: the layers
    // panel and legend keep left of it (g2-4: they overlapped by 14 px).
    const boardLeft = board?.visible === true ? board.x - m : W
    if (layers !== undefined) {
      const lw = layers.panelWidth * s
      place(layers, Math.max(statusRight + m, Math.min((W - lw) / 2, boardLeft - lw)), Math.max(SAFE_AREA.top, clockBottom) + m)
      const legendW = this.legend.getLocalBounds().width * s
      place(this.legend, Math.max(statusRight + m, Math.min((W - legendW) / 2, boardLeft - legendW)), layers.y + layers.panelHeight * s + 8 * s)
    }
    const avoid: Rect[] = [zone]
    const badge = this.badge?.visible === true ? this.badge : undefined
    for (const c of [this.status, this.clock, this.map, layers, badge, this.settings, this.fullscreen.visible ? this.fullscreen : undefined, board?.visible === true ? board : undefined, this.legend.visible && this.legend.renderable ? this.legend : undefined]) {
      if (c === undefined) continue
      const b = c.getBounds()
      avoid.push({ x: b.x, y: b.y, width: b.width, height: b.height })
    }
    // The cluster's top may not rise above `top`: on a phone the top third's
    // line (Nick's split), elsewhere just under whatever sits top right. It
    // shrinks to fit rather than overlap (`RadialCluster.layout`).
    const bottom = H - SAFE_AREA.bottom
    let top = thirdLine ?? SAFE_AREA.top
    if (thirdLine === undefined) {
      for (const c of [this.map, this.settings, board?.visible === true && board.x > W / 2 ? board : undefined]) {
        if (c === undefined || !c.visible) continue
        const b = c.getBounds()
        top = Math.max(top, b.y + b.height)
      }
    }
    this.radial.layout(
      { x: SAFE_AREA.left, y: SAFE_AREA.top, width: W - SAFE_AREA.left - SAFE_AREA.right, height: H - SAFE_AREA.top - SAFE_AREA.bottom },
      avoid,
      true,
      RadialCluster.fitScale(bottom - top - RADIAL.GAP)
    )
  }

  /**
   * A phone's board in touch mode, opened from the clock: under the status
   * panel at the left, never over the radial cluster (g2-4: it covered the hot
   * slot at every phone size), shrunk if it would reach it.
   */
  private placePhoneBoard (board: Leaderboard, s: number, left: number, top: number): void {
    const limit = this.radial.visible ? this.radial.leftEdge() - RADIAL.GAP : window.innerWidth - SAFE_AREA.right - HUD.MARGIN
    const k = Math.min(s, Math.max(0.3, (limit - left) / board.panelWidth))
    board.scale.set(k, k)
    board.x = Math.round(left)
    board.y = Math.round(top)
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
    // A new layer can change the badge's size (its tags line): place it again.
    if (this.badge?.setCurrent(Game.PLAYER?.tag) === true) this.updateLayout()
  }

  clearGameUI (): void {
    for (const c of [this.map, this.status, this.clock, this.skills, this.layers, this.badge]) {
      if (c !== undefined) this.removeChild(c)
    }
    this.badge = undefined
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
