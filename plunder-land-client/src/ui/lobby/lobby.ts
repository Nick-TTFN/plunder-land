import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { inviteUrl, type Invite, JOIN_KEY, makeCode, parseStoredInvite, PARTY_KEY, readInvite, withoutInvite } from './party'
import { RobotSprite } from '../../robots/robotsprite'
import { ROBOT_RIGS } from '../../robots/robotrig'
import { Game } from '../../game'
import {
  type Finish, type FinishGroup, FINISH_GROUPS, FINISH_PRESETS, PALETTE, PATTERNS,
  colourById, finishFromBytes, finishToBytes, patternById
} from '../../utils/finishes'
import { PICKABLE, ROSTER, STAT_BARS, type RosterEntry } from './roster'
import { LOBBY_CSS } from './lobbystyle'
import { ACCOUNT, TOKEN_KEY, localTokenStorage } from '../../net/account'
import { lastNotice, SEASON, type SeasonView, seasonLine } from '../../net/season'
import { ENERGY, energyLine, outOfPlays } from '../../net/energy'
import { SettingsPanel } from '../settings/settingspanel'
import { clearFull, fullLine, retryDue } from '../../net/full'
import { LoadoutPanel } from './loadoutpanel'
import { StashPanel } from './stashpanel'
import { type BringPair, STASH, markStashSeen, newStashCount, stashCount } from '../../net/stash'
import { loadoutOf } from '../../net/loadout'
import { SKILL_LIST, loadoutSlotsAt } from '../../utils/skills'
import {
  type Swatch, colourLock, journeyEnd, journeyStop, lockBadge, lockTitle, mixColour, mixPattern, paintWish, patternLock,
  reshownRobot, robotLock, robotToStore, shownFinish, shownRobot, stepRobot, swatchLock
} from './locks'

const ID_KEY = 'plunderland_player_id'
const NAME_KEY = 'plunderland_player_name'
const FINISH_KEY = 'plunderland_player_finish'
const ROBOT_KEY = 'plunderland_player_robot'

/** The server's cap (`Player.NAME_MAX`), as a typing limit; the server cuts whatever arrives. */
const NAME_MAX = 16

/** localStorage can throw (private windows, blocked site data); a failure means "not remembered". */
function readStorage (key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch (e) {
    return null
  }
}

function writeStorage (key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    // Not remembered past this page; the join goes ahead.
  }
}

/** sessionStorage, as `readStorage`/`writeStorage`: a failure means "not remembered". */
function readSession (key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch (e) {
    return null
  }
}

function writeSession (key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch (e) {
    // Not remembered past this page.
  }
}

/** The id when storage is unavailable, kept for the page so a reconnect keeps the callsign. */
let _pageId: string | undefined

const genRanHex = (size: number): string => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

/** `finish` as its wire bytes, `robot` an archetype key, `bring` the stash rows for keys 3 and 4 (49-4), undefined for none. */
export type LobbyStart = (playerId: string, name: string, finish: number[], robot: string, party: string, loadout: number, bring: BringPair | undefined) => Promise<void>

/** The lobby's phone layout starts at this width or under (`lobbystyle.ts`'s 760 px query). */
const PHONE_MAX = 760
/** The desktop grid's comfortable width: narrower windows zoom it rather than squeeze it. */
const FIT_WIDTH = 1100
/** The smallest zoom `fit` applies; a shorter window scrolls from there. */
const FIT_MIN = { desktop: 0.6, phone: 0.75 } as const

/** How many levels the journey strip shows at once. */
const JOURNEY_SHOWN = 5
const JOURNEY_WORD = { bot: 'Bot', skill: 'Skill', reward: 'Reward' } as const

/** The lobby's four panels, one open at a time. */
type Panel = 'paint' | 'pick' | 'loadout' | 'stash'
const PANELS: readonly Panel[] = ['paint', 'pick', 'loadout', 'stash']

/** Inline line icons (24 px box, `currentColor`), so the chrome needs no art. */
const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const ICON = {
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  right: svg('<path d="m9 6 6 6-6 6"/>'),
  bolt: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  bars: svg('<path d="M6 20v-6M12 20V8M18 20V4"/>'),
  box: svg('<path d="m21 8-9-5-9 5v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
  trophy: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  bot: svg('<rect x="5" y="8" width="14" height="11" rx="5"/><circle cx="10" cy="13" r="1.5"/><circle cx="14" cy="13" r="1.5"/><path d="M12 8V4"/>'),
  check: svg('<path d="m5 12 5 5 9-10"/>')
}

/**
 * The CSS for a swatch: the palette colour with the pattern drawn over it in
 * CSS, an approximation of the baked art for a 40 px chip (placeholder look,
 * like the rest of this screen's chrome).
 */
function swatchBackground (s: Swatch): string {
  const rgb = colourById(s.colour)?.rgb ?? [255, 255, 255]
  const base = `rgb(${rgb.join(',')})`
  switch (patternById(s.pattern)?.key) {
    case 'zebra':
      return `repeating-linear-gradient(55deg, rgba(18,18,18,.92) 0 4px, transparent 4px 10px), ${base}`
    case 'checker':
      return `conic-gradient(rgba(18,18,18,.92) 25%, transparent 0 50%, rgba(18,18,18,.92) 0 75%, transparent 0) 0 0 / 12px 12px, ${base}`
    case 'camo':
      return 'radial-gradient(circle at 28% 30%, rgba(30,36,24,.45) 0 22%, transparent 23%),' +
        'radial-gradient(circle at 72% 62%, rgba(30,36,24,.45) 0 20%, transparent 21%),' +
        'radial-gradient(circle at 40% 82%, rgba(235,235,215,.35) 0 14%, transparent 15%),' +
        `radial-gradient(circle at 80% 18%, rgba(235,235,215,.35) 0 12%, transparent 13%), ${base}`
    default:
      return base
  }
}

function swatchName (s: Swatch): string {
  const colour = colourById(s.colour)?.label ?? ''
  const pattern = patternById(s.pattern)
  const title = (t: string): string => t.charAt(0) + t.slice(1).toLowerCase()
  return pattern === undefined || pattern.key === 'none' ? title(colour) : `${title(pattern.label)} \u00B7 ${title(colour)}`
}

/** The ready-made swatches for a group: each preset's finish for it, once each, in preset order. */
function presetSwatches (group: FinishGroup): Swatch[] {
  const out: Swatch[] = []
  for (const preset of FINISH_PRESETS) {
    const s = preset.finish[group]
    if (!out.some((o) => o.colour === s.colour && o.pattern === s.pattern)) out.push({ colour: s.colour, pattern: s.pattern })
  }
  return out
}

function el<K extends keyof HTMLElementTagNameMap> (tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className !== undefined) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * The lobby (lobby-rework, decision #42; mockup `ideas/lobby-mockup-2026-09-30.png`
 * in the project memory): choose a robot, see its stats, paint it, name it,
 * READY UP. Replaces the enter popup.
 *
 * Two layers. Pixi, in this container at the screen's centre (PopupManager
 * keeps it there): the backdrop, the platform glow, the chosen robot large and
 * the next one dimmed, because robots are drawn by their rigs. DOM over the
 * canvas, for everything you press or type: placeholder chrome (CSS in
 * `lobbystyle.ts`) until the screen gets its art. The hangar background in the
 * mockup is art and is not here.
 *
 * Robots, colours and patterns the account's level hasn't opened (#48 step 5,
 * `locks.ts`) show disabled with an `LV n` badge; the remembered robot and
 * finish are the player's wish, shown and sent as the level allows. The choice
 * of robot, finish and name is remembered in localStorage.
 *
 * Keys: left/right switch robot, E opens and closes customize, L the skill
 * loadouts (`loadoutpanel.ts`, decision #48 step 4), S the stash and the
 * gear brought in (`stashpanel.ts`, decision #49), Enter is READY UP. Keys typed into the name field are the field's.
 */
export default class Lobby extends Container {
  private readonly playerId: string
  private index: number
  /**
   * The stored finish and robot are the player's wish (#48 step 5): what is
   * shown, drawn and sent is the wish as the account's level allows it
   * (`locks.ts`). `picked` is the robot the player chose in this lobby, if any;
   * only then does READY overwrite the stored robot.
   */
  private finish: Finish
  private readonly robotWish: string | null
  private picked: RosterEntry | undefined
  private mixMode = false
  private started = false
  /** This browser's party code, and the invite this tab was opened with (party.ts). */
  private readonly ownParty: string
  private invite: Invite | undefined
  private readonly inviteButton: HTMLButtonElement
  private readonly joinBanner: HTMLDivElement
  private readonly fullBanner: HTMLDivElement
  private readonly fullTimer: ReturnType<typeof setInterval>
  private fullShown: string | undefined = '-'

  private readonly backdrop = new Sprite()
  private readonly platform = new Graphics()
  private robot: RobotSprite | undefined
  private neighbour: RobotSprite | undefined
  private readonly stage = new Container()
  private readonly previewLayer = new Container()
  private readonly previewClip = new Graphics()
  private readonly preview: HTMLDivElement
  private readonly content: HTMLDivElement
  /** The header and the grid, measured by `fit`. */
  private readonly top: HTMLElement
  private readonly main: HTMLElement
  /** The zoom `fit` last applied (1: none). */
  private zoom = 1
  private readonly layoutObserver = new ResizeObserver(() => { this.layout() })
  /**
   * `fit` changes the sizes a ResizeObserver reports, so it never runs inside
   * one's callback (that is a "ResizeObserver loop" error on window.onerror):
   * a change of the grid's size schedules it for the next frame instead. A
   * fit that lands on the same zoom changes nothing, so it settles.
   */
  private fitFrame = 0
  private readonly fitObserver = new ResizeObserver(() => {
    if (this.fitFrame !== 0) return
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0
      this.fit()
      this.layout()
    })
  })
  private readonly onScroll = (): void => { this.layoutPreview() }

  private readonly root: HTMLDivElement
  private readonly nameInput: HTMLInputElement
  private readonly kindLine: HTMLDivElement
  private readonly nameLine: HTMLDivElement
  private readonly tagline: HTMLDivElement
  private readonly cards: HTMLButtonElement[] = []
  private readonly statRows: Array<{ fill: HTMLDivElement, value: HTMLSpanElement }> = []
  /** STATS & PAINT: the stat bars over the customize rows. */
  private readonly customize: HTMLDivElement
  /** CHANGE SCAVENGER: the robot cards and the chosen one's tagline. */
  private readonly picker: HTMLDivElement
  /** The action rows' status lines and dots (Skills, Stats & paint, Stash). */
  private readonly rowStatus: Record<'skills' | 'paint' | 'stash', { text: HTMLSpanElement, dot: HTMLSpanElement }>
  /** Each robot's still (`renderThumbnails`), for the journey's robot stops. */
  private readonly thumbs = new Map<string, string>()
  /** The first level the journey strip shows; follows the account's level until an arrow moves it. */
  private journeyFrom = 1
  private journeyMoved = false
  private readonly journeyStops: HTMLDivElement
  private readonly journeyPrev: HTMLButtonElement
  private readonly journeyNext: HTMLButtonElement
  private readonly rows: Partial<Record<FinishGroup, { current: HTMLSpanElement, swatches: HTMLDivElement }>> = {}
  private readonly mixButton: HTMLButtonElement
  /** The skill loadouts (decision #48 step 4); one of it and customize is open at a time. */
  private readonly loadout: LoadoutPanel
  /** The stash and the gear brought on keys 3 and 4 (decision #49, 49-4); one panel open at a time. */
  private readonly stash: StashPanel

  private readonly onKey = (e: KeyboardEvent): void => { this.key(e) }
  private readonly onResize = (): void => { this.fit(); this.layout() }
  private readonly onMove = (e: PointerEvent): void => { this.lookAt(e.clientX, e.clientY) }
  private readonly onAccount = (): void => { this.renderLevel(); this.applyLevel(); this.renderRows() }
  /** `teardown` ran: it can be reached twice (`destroy` also emits `removed`). */
  private tornDown = false
  /** The progression block (decision #48 step 3): level heading, XP bar and its two lines. */
  private readonly levelHeading: HTMLDivElement
  private readonly xpBar: HTMLDivElement
  private readonly xpFill: HTMLDivElement
  private readonly xpLine: HTMLSpanElement
  private readonly xpToGo: HTMLSpanElement
  private readonly onStash = (): void => { this.stashChanged() }
  /** The season row (decision #48 step 6), and the last payout's notice in it. */
  private readonly season: HTMLElement
  private readonly seasonText: HTMLDivElement
  private readonly seasonNotice: HTMLDivElement
  /** The view whose notice was decided, and that notice: shown for this lobby, marked seen once. */
  private noticeFor: SeasonView | undefined
  private notice: string | undefined
  private readonly onSeason = (): void => { this.renderSeason() }
  /** Re-renders the season countdown once a minute. */
  private readonly seasonTimer: ReturnType<typeof setInterval>
  /**
   * READY, and the plays left under it (decision #48 step 7): with none left
   * it is disabled until the next comes back. The server decides all the
   * same (`start_refused`); this only saves a press that would be refused.
   */
  private readonly readyButton: HTMLButtonElement
  private readonly playsLine: HTMLSpanElement
  private readonly onEnergy = (): void => { this.renderEnergy() }
  /** Re-renders the plays countdown every 10 s, so READY comes back within seconds of the play. */
  private readonly energyTimer: ReturnType<typeof setInterval>

  constructor (private readonly start: LobbyStart) {
    super()
    this.playerId = Lobby.loadId()
    this.finish = finishFromBytes(Lobby.loadJson(FINISH_KEY))
    this.robotWish = readStorage(ROBOT_KEY)
    this.index = PICKABLE.indexOf(shownRobot(this.robotWish, this.accountLevel))
    this.ownParty = Lobby.loadParty()
    this.invite = Lobby.loadInvite()

    this.previewLayer.addChild(this.platform, this.stage)
    this.previewLayer.mask = this.previewClip
    this.addChild(this.backdrop, this.previewLayer, this.previewClip)

    Lobby.injectStyle()
    this.root = el('div', 'lb')

    // Header: brand, tabs, INVITE and settings; under 760 px the last two
    // (and PRIVACY) fold into the menu button's dropdown.
    const top = this.top = el('header', 'lb-top')
    top.innerHTML = `
      <div class="lb-brand"><span class="lb-logo"></span>PLUNDERLAND</div>
      <nav class="lb-tabs"><span class="lb-tab lb-on">Lobby</span><span class="lb-tab lb-off" title="Coming soon">Collection</span></nav>`
    const topActions = el('div', 'lb-topactions')
    // Invites (decision #47): the link puts a friend in this player's world.
    this.inviteButton = el('button', 'lb-invite', 'Invite')
    this.inviteButton.title = 'Copy a link that puts a friend in your world'
    this.inviteButton.onclick = () => { this.closeMenu(); this.copyInvite() }
    // Settings (L3): key bindings and graphics, a panel over the lobby.
    const settings = el('button', 'lb-invite lb-settings')
    settings.innerHTML = `${ICON.gear}<span class="lb-menu-label">Settings</span>`
    settings.title = 'Settings'
    settings.setAttribute('aria-label', 'Settings')
    settings.onclick = () => { this.closeMenu(); SettingsPanel.show() }
    // Portals ask for it, and it is what the game collects (decision #46).
    const privacy = (className: string): HTMLAnchorElement =>
      Object.assign(el('a', className), { href: '/privacy', target: '_blank', rel: 'noopener', textContent: 'Privacy' })
    topActions.append(this.inviteButton, settings, privacy('lb-privacy lb-menu-only'))
    const menu = el('button', 'lb-menu')
    menu.innerHTML = ICON.menu
    menu.setAttribute('aria-label', 'Menu')
    menu.onclick = () => { this.root.classList.toggle('lb-menu-open') }
    top.append(topActions, menu)

    // Hero: the canvas robot fits the measured preview slot; its name and the picker under it.
    const hero = el('div', 'lb-hero')
    this.preview = el('div', 'lb-preview')
    const plate = el('div', 'lb-plate')
    this.nameLine = el('div', 'lb-robot')
    this.kindLine = el('div', 'lb-kind')
    const change = el('button', 'lb-change')
    change.innerHTML = `Change scavenger ${ICON.down}`
    change.onclick = () => { this.toggle('pick') }
    plate.append(this.nameLine, this.kindLine, change)
    hero.append(this.preview, plate)

    // The callsign, sent with READY and remembered.
    const callsign = el('label', 'lb-callsign')
    callsign.append(el('span', 'lb-dot'))
    this.nameInput = el('input', 'lb-name')
    this.nameInput.maxLength = NAME_MAX
    this.nameInput.placeholder = 'NAME'
    this.nameInput.autocomplete = 'off'
    this.nameInput.spellcheck = false
    this.nameInput.value = readStorage(NAME_KEY) ?? ''
    this.nameInput.setAttribute('aria-label', 'Your name')
    callsign.append(this.nameInput, el('span', 'lb-pencil', '\u270E'))

    // Progression: the account's level and XP (decision #48 step 3).
    const progress = el('section', 'lb-progress')
    this.levelHeading = el('div', 'lb-levelhead')
    this.xpBar = el('div', 'lb-xpbar')
    this.xpFill = el('div', 'lb-xpfill')
    this.xpBar.append(this.xpFill)
    const xpRow = el('div', 'lb-xprow')
    this.xpLine = el('span')
    this.xpToGo = el('span')
    xpRow.append(this.xpLine, this.xpToGo)
    progress.append(el('div', 'lb-eyebrow', 'Your progression'), this.levelHeading, this.xpBar, xpRow)

    // Journey: what opens at each level, from the mirrored unlock rows (`journeyStop`).
    const journey = el('section', 'lb-journey')
    const strip = el('div', 'lb-jstrip')
    this.journeyPrev = el('button', 'lb-jarrow', '\u2039')
    this.journeyNext = el('button', 'lb-jarrow', '\u203A')
    this.journeyPrev.setAttribute('aria-label', 'Earlier levels')
    this.journeyNext.setAttribute('aria-label', 'Later levels')
    this.journeyPrev.onclick = () => { this.moveJourney(-1) }
    this.journeyNext.onclick = () => { this.moveJourney(1) }
    this.journeyStops = el('div', 'lb-jstops')
    strip.append(this.journeyPrev, this.journeyStops, this.journeyNext)
    journey.append(el('div', 'lb-eyebrow', 'Your journey'), strip)

    // The three panels, as rows: Skills (the loadout), Stats & paint, Stash.
    const rows = el('section', 'lb-acts')
    const row = (key: 'skills' | 'paint' | 'stash', icon: string, label: string, verb: string, hotkey: string, open: () => void): { text: HTMLSpanElement, dot: HTMLSpanElement } => {
      const b = el('button', 'lb-act')
      b.title = `${label} (${hotkey})`
      const dot = el('span', 'lb-actdot')
      const text = el('span', 'lb-acttext')
      const words = el('span', 'lb-actwords')
      const status = el('span', 'lb-actstatus')
      status.append(dot, text)
      words.append(el('span', 'lb-actlabel', label), status)
      const icn = el('span', 'lb-acticon')
      icn.innerHTML = icon
      const chev = el('span', 'lb-actchev')
      chev.innerHTML = ICON.right
      b.append(icn, words, el('span', 'lb-actverb', verb), chev)
      b.onclick = open
      rows.append(b)
      return { text, dot }
    }
    this.rowStatus = {
      skills: row('skills', ICON.bolt, 'Skills', 'Equip', 'L', () => { this.toggle('loadout') }),
      paint: row('paint', ICON.bars, 'Stats & paint', 'Paint', 'E', () => { this.toggle('paint') }),
      stash: row('stash', ICON.box, 'Stash', 'View', 'S', () => { this.toggle('stash') })
    }

    this.season = el('section', 'lb-season')
    const trophy = el('span', 'lb-acticon')
    trophy.innerHTML = ICON.trophy
    const seasonWords = el('div', 'lb-seasonwords')
    this.seasonNotice = el('div', 'lb-season-notice')
    this.seasonText = el('div', 'lb-season-line')
    seasonWords.append(el('div', 'lb-actlabel', 'Season standings'), this.seasonText, this.seasonNotice)
    this.season.append(trophy, seasonWords)
    SEASON.listeners.add(this.onSeason)
    this.seasonTimer = setInterval(this.onSeason, 60_000)

    this.joinBanner = el('div', 'lb-join')
    this.renderJoin()
    // Server full (burst-capacity, net/full.ts): a countdown, then READY by itself.
    this.fullBanner = el('div', 'lb-join lb-full')
    this.fullTimer = setInterval(() => { this.renderFull() }, 250)
    this.renderFull()

    const ready = this.readyButton = el('button', 'lb-ready')
    ready.innerHTML = `Ready up ${ICON.right}`
    ready.onclick = () => { this.ready() }
    this.playsLine = el('span', 'lb-ready-sub')
    const action = el('div', 'lb-action')
    action.append(this.joinBanner, this.fullBanner, ready, this.playsLine, privacy('lb-privacy lb-desk-only'))

    // STATS & PAINT: the stat bars read from the mirrored `stats`, then the paint rows.
    this.customize = el('div', 'lb-custom lb-hidden')
    const head = el('div', 'lb-customhead')
    const close = el('button', 'lb-close', '\u00D7')
    close.onclick = () => { this.toggle(undefined) }
    head.append(el('span', undefined, 'STATS & PAINT'), close)
    const stats = el('div', 'lb-stats')
    for (const bar of STAT_BARS) {
      const statRow = el('div', 'lb-stat')
      const track = el('div', 'lb-track')
      const fill = el('div', 'lb-fill')
      track.append(fill)
      const value = el('span', 'lb-value')
      statRow.append(el('span', 'lb-label', bar.label), track, value)
      stats.append(statRow)
      this.statRows.push({ fill, value })
    }
    this.customize.append(head, stats)
    for (const group of FINISH_GROUPS) {
      const paintRow = el('div', 'lb-row')
      const title = el('div', 'lb-rowtitle')
      const current = el('span', 'lb-current')
      title.append(el('span', undefined, group.toUpperCase()), current)
      const swatches = el('div', 'lb-swatches')
      paintRow.append(title, swatches)
      this.customize.append(paintRow)
      this.rows[group] = { current, swatches }
    }
    const foot = el('div', 'lb-customfoot')
    this.mixButton = el('button', 'lb-mix')
    this.mixButton.onclick = () => { this.mixMode = !this.mixMode; this.renderCustomize() }
    const done = el('button', 'lb-done', 'DONE')
    done.onclick = () => { this.toggle(undefined) }
    foot.append(this.mixButton, done)
    this.customize.append(foot)

    // CHANGE SCAVENGER: the robot cards (stills rendered from the rigs), locked ones badged.
    this.picker = el('div', 'lb-custom lb-picker lb-hidden')
    const pickHead = el('div', 'lb-customhead')
    const pickClose = el('button', 'lb-close', '\u00D7')
    pickClose.onclick = () => { this.toggle(undefined) }
    pickHead.append(el('span', undefined, 'SCAVENGERS'), pickClose)
    const cards = el('div', 'lb-cards')
    for (const entry of ROSTER) {
      const card = el('button', entry.robot === undefined ? 'lb-card lb-locked' : 'lb-card')
      card.append(el('div', 'lb-thumb'), el('div', 'lb-cardname', entry.name))
      if (entry.robot === undefined) {
        card.disabled = true
        card.title = 'Coming soon'
        card.append(el('div', 'lb-soon', 'SOON'))
      } else {
        // Its lock badge, shown by `renderCards` while the level hasn't opened it.
        card.append(el('div', 'lb-soon lb-hidden'))
        card.onclick = () => { this.pick(entry) }
      }
      cards.append(card)
      this.cards.push(card)
    }
    this.tagline = el('div', 'lb-tagline')
    const pickFoot = el('div', 'lb-customfoot')
    const pickDone = el('button', 'lb-done', 'DONE')
    pickDone.onclick = () => { this.toggle(undefined) }
    pickFoot.append(el('span', 'lb-lo-status', '\u2190 \u2192 to switch'), pickDone)
    this.picker.append(pickHead, cards, this.tagline, pickFoot)
    this.renderCards()

    this.loadout = new LoadoutPanel(() => { this.toggle(undefined) })
    // The kit IN KIT marks are read against: the loadout READY plays.
    this.stash = new StashPanel(() => { this.toggle(undefined) }, () => {
      const robot = this.entry.robot ?? 'peep'
      return loadoutOf(ACCOUNT.info?.loadouts, robot, this.loadout.indexFor(robot))
    })

    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.ready()
    })

    // One grid: the hero spans the left column on desktop; under 760 px it all
    // stacks (progression, journey, hero, rows) and READY sticks to the bottom.
    this.content = el('div', 'lb-content')
    const main = this.main = el('main', 'lb-main')
    main.append(hero, callsign, progress, journey, rows, this.season, action)
    this.content.append(main)
    this.root.append(top, this.content, this.customize, this.picker, this.loadout.root, this.stash.root)
    this.content.addEventListener('scroll', this.onScroll)
    document.body.append(this.root)
    // The account is announced on connect, which may be before or after this.
    ACCOUNT.listeners.add(this.onAccount)
    STASH.listeners.add(this.onStash)
    ENERGY.listeners.add(this.onEnergy)
    this.energyTimer = setInterval(this.onEnergy, 10_000)
    this.layoutObserver.observe(this.preview)
    this.layoutObserver.observe(this.content)
    // Its height changes with what it shows (the season row, banners): `fit` measures again.
    this.fitObserver.observe(this.main)
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('pointermove', this.onMove)
    // Every way out: removed from the popups (READY, a reconnect's
    // removeChildren), and `destroy`, which emits no `removed` when the lobby
    // was never parented or was already taken off.
    this.on('removed', this.teardown, this)
    this.on('destroyed', this.teardown, this)

    void this.renderThumbnails()
    this.select(this.index)
    this.renderCustomize()
    this.renderLevel()
    this.renderSeason()
    this.renderEnergy()
    this.fit()
    this.layout()
  }

  // --------------------------------------------------------------- state

  /**
   * The id this browser made for itself before guest accounts (decision #48).
   * The server no longer plays under it (the account's id is used); it is
   * still sent for one release, because an older server refuses a start
   * without one. Remove it, and `genRanHex`, in the release after.
   */
  private static loadId (): string {
    let id = readStorage(ID_KEY)
    if (id === null || id === '') {
      id = _pageId ?? genRanHex(6)
      writeStorage(ID_KEY, id)
    }
    _pageId = id
    return id
  }

  /** Whether this browser holds an account token (`TOKEN_KEY`); storage that throws holds none. */
  private static hasToken (): boolean {
    return (readStorage(TOKEN_KEY) ?? '') !== ''
  }

  private static loadParty (): string {
    const stored = readStorage(PARTY_KEY)
    if (stored !== null && /^[0-9a-z]{6,12}$/.test(stored)) return stored
    const code = makeCode()
    writeStorage(PARTY_KEY, code)
    return code
  }

  /**
   * The invite in the address, which then leaves it (so a reload or a shared
   * screenshot doesn't carry it) and stays for the tab; else the tab's last.
   */
  private static loadInvite (): Invite | undefined {
    const fromUrl = readInvite(window.location.search)
    if (fromUrl !== undefined) {
      writeSession(JOIN_KEY, JSON.stringify(fromUrl))
      try {
        window.history.replaceState(null, '', window.location.pathname + withoutInvite(window.location.search))
      } catch (e) {
        // The address keeps it; harmless.
      }
      return fromUrl
    }
    return parseStoredInvite(readSession(JOIN_KEY))
  }

  /** The code this player's runs carry: the inviter's, else its own. */
  private get party (): string {
    return this.invite?.code ?? this.ownParty
  }

  /** The server-full countdown; at zero, READY as if pressed (the player can cancel with the cross). */
  private renderFull (): void {
    const now = performance.now()
    if (retryDue(now) && !this.started && !this.tornDown && Game.socket?.connected === true) {
      this.ready()
      return
    }
    const line = fullLine(now)
    if (line === this.fullShown) return
    this.fullShown = line
    this.fullBanner.replaceChildren()
    this.fullBanner.style.display = line === undefined ? 'none' : ''
    if (line === undefined) return
    this.fullBanner.append(el('span', 'lb-join-text', line))
    const cancel = el('button', 'lb-join-x', '\u2715')
    cancel.title = 'Stop retrying'
    cancel.onclick = () => {
      clearFull()
      this.renderFull()
    }
    this.fullBanner.append(cancel)
  }

  private renderJoin (): void {
    this.joinBanner.replaceChildren()
    this.joinBanner.style.display = this.invite === undefined ? 'none' : ''
    if (this.invite === undefined) return
    const who = this.invite.from === '' ? 'A FRIEND' : this.invite.from
    // textContent: the name came from a link.
    this.joinBanner.append(el('span', 'lb-join-text', `JOINING ${who.toUpperCase()}'S WORLD`))
    const cancel = el('button', 'lb-join-x', '\u2715')
    cancel.title = 'Play in any world instead'
    cancel.onclick = () => {
      this.invite = undefined
      writeSession(JOIN_KEY, null)
      this.renderJoin()
    }
    this.joinBanner.append(cancel)
  }

  private copyInvite (): void {
    const url = inviteUrl(window.location.origin, window.location.pathname, window.location.search, this.party, this.nameInput.value.trim())
    const done = (label: string): void => {
      this.inviteButton.textContent = label
      setTimeout(() => { this.inviteButton.textContent = 'INVITE' }, 2000)
    }
    const fallback = (): void => { window.prompt('Send this link to a friend:', url) }
    if (navigator.clipboard?.writeText === undefined) {
      fallback()
      return
    }
    navigator.clipboard.writeText(url).then(() => { done('LINK COPIED') }, fallback)
  }

  private static loadJson (key: string): unknown {
    try {
      const raw = readStorage(key)
      return raw === null ? undefined : JSON.parse(raw)
    } catch (e) {
      return undefined
    }
  }

  private get entry (): RosterEntry {
    return PICKABLE[this.index]
  }

  /** The account's level, 1 offline or before the server says (as `LoadoutPanel.level`, and the server's offline lock). */
  private get accountLevel (): number {
    return ACCOUNT.info?.standing?.level ?? 1
  }

  /** Left/right: over the robots the level has opened only. */
  private step (by: number): void {
    const next = stepRobot(this.entry, by, this.accountLevel)
    // Nothing to step to (level 1, or before the account arrives): not a
    // pick, or READY would store Peep over the player's wish (48-5 review).
    if (next === this.entry) return
    this.pick(next)
  }

  /** The player chose `entry` (a card, left/right); a locked one is ignored. */
  private pick (entry: RosterEntry): void {
    if (robotLock(entry, this.accountLevel) !== undefined) return
    this.picked = entry
    this.select(PICKABLE.indexOf(entry))
  }

  /**
   * The level changed (the account or a run's progress landed while the lobby
   * is open): the shown robot re-resolved (the stored wish if the player hasn't
   * picked here, else the pick, Peep if it became locked), and the cards,
   * customize and robots drawn again with the finish the level allows.
   */
  private applyLevel (): void {
    if (this.tornDown) return
    const level = this.accountLevel
    const shown = reshownRobot(this.picked, this.robotWish, level)
    this.renderCards()
    this.renderCustomize()
    this.select(PICKABLE.indexOf(shown))
    void this.renderThumbnails()
  }

  /** Cards of robots the level hasn't opened: disabled, `lb-locked`, an `LV n` badge. */
  private renderCards (): void {
    const level = this.accountLevel
    ROSTER.forEach((entry, i) => {
      if (entry.robot === undefined) return
      const card = this.cards[i]
      const badge = card.querySelector('.lb-soon') as HTMLDivElement
      const lock = robotLock(entry, level)
      card.disabled = lock !== undefined
      card.classList.toggle('lb-locked', lock !== undefined)
      card.title = lock !== undefined ? lockTitle(lock) : ''
      badge.classList.toggle('lb-hidden', lock === undefined)
      badge.textContent = lock !== undefined ? lockBadge(lock) : ''
    })
  }

  private select (index: number): void {
    if (index < 0 || index >= PICKABLE.length) return
    this.index = index
    const entry = this.entry
    this.kindLine.textContent = entry.kind
    this.nameLine.textContent = entry.name.charAt(0) + entry.name.slice(1).toLowerCase()
    this.tagline.textContent = entry.tagline
    ROSTER.forEach((r, i) => { this.cards[i].classList.toggle('lb-picked', r === entry) })
    STAT_BARS.forEach((bar, i) => {
      const v = bar.value(entry)
      this.statRows[i].fill.style.width = v === null ? '0%' : `${Math.min(100, 100 * v / bar.top)}%`
      this.statRows[i].value.textContent = v === null ? '-' : bar.text(v)
    })
    this.loadout.setRobot(entry.robot ?? 'peep')
    // `select` runs once from the constructor before the stash panel exists.
    this.stash?.render()
    this.renderRows()
    this.buildRobots()
  }

  /** The finish shown, drawn and sent: the wish as the level allows it. */
  private get shownFinish (): Finish {
    return shownFinish(this.finish, this.accountLevel)
  }

  /** A new wish; the robots wear what the level allows of it. */
  private setFinish (finish: Finish): void {
    this.finish = finish
    this.robot?.setFinish(this.shownFinish)
    this.neighbour?.setFinish(this.shownFinish)
    this.renderCustomize()
    this.renderRows()
  }

  /** The panel element for each of the four (one open at a time). */
  private panelOf (panel: Panel): HTMLDivElement {
    switch (panel) {
      case 'paint': return this.customize
      case 'pick': return this.picker
      case 'loadout': return this.loadout.root
      case 'stash': return this.stash.root
    }
  }

  /** Open `panel` (closing the others), or close it if it is open; undefined closes them all. */
  private toggle (panel: Panel | undefined): void {
    const show = panel !== undefined && this.panelOf(panel).classList.contains('lb-hidden')
    for (const p of PANELS) this.panelOf(p).classList.toggle('lb-hidden', !(show && p === panel))
    this.root.classList.toggle('lb-editing', show)
    this.closeMenu()
    // The loadout may have changed since: the IN KIT marks follow it.
    if (show && panel === 'stash') this.stash.opened()
    this.stashChanged()
    this.renderRows()
  }

  private closeMenu (): void {
    this.root.classList.remove('lb-menu-open')
  }

  private ready (): void {
    // Enter and a click can both land; a second start would register every
    // socket listener twice.
    if (this.started) return
    // No play left (Enter bypasses the disabled button).
    if (outOfPlays(ENERGY.view, Date.now() - ENERGY.receivedAt)) return
    this.started = true
    const name = this.nameInput.value.trim()
    // An empty name is remembered too, so clearing the field sticks.
    writeStorage(NAME_KEY, name)
    // The wishes are stored; what is sent is what is shown (#48 step 5). The
    // robot is stored only if picked here, so a fallback to Peep (an outage,
    // the account not yet announced) never overwrites a stored Waddle.
    writeStorage(FINISH_KEY, JSON.stringify(finishToBytes(this.finish)))
    const store = robotToStore(this.picked, this.entry)
    if (store !== undefined) writeStorage(ROBOT_KEY, store)
    const sent = finishToBytes(this.shownFinish)
    const robot = this.entry.robot ?? 'peep'
    const loadout = this.loadout.indexFor(robot)
    // Gear from the stash for keys 3 and 4 (49-4): what the panel shows, if
    // the level allows; the server carries what it can and says so in `carried`.
    const bring = this.stash.bring()
    // A loadout change still saving goes first (at most `SETTLE_MAX_MS`), or
    // the join would play the loadout from before it.
    void this.loadout.settle().then(() => {
      // Taken down meanwhile (a reconnect clears the popups): no start.
      if (this.tornDown) return
      void this.start(this.playerId, name, sent, robot, this.party, loadout, bring)
      this.parent?.removeChild(this)
    })
  }

  private key (e: KeyboardEvent): void {
    // The settings panel takes every key while it is open.
    if (this.started || !this.visible || SettingsPanel.open !== undefined) return
    const typing = e.target === this.nameInput
    let handled = true
    if (e.key === 'Enter') this.ready()
    else if (typing) handled = false
    else if (e.key === 'ArrowLeft') this.step(-1)
    else if (e.key === 'ArrowRight') this.step(1)
    else if (e.key === 'e' || e.key === 'E') this.toggle('paint')
    else if (e.key === 'l' || e.key === 'L') this.toggle('loadout')
    else if (e.key === 's' || e.key === 'S') this.toggle('stash')
    else if (e.key === 'c' || e.key === 'C') this.toggle('pick')
    else if (e.key === 'Escape') this.toggle(undefined)
    else handled = false
    // Skill keys are bound on window: nothing typed here is game input.
    e.stopImmediatePropagation()
    if (handled) e.preventDefault()
  }

  // ----------------------------------------------------------- customize

  private renderCustomize (): void {
    this.mixButton.textContent = this.mixMode ? 'PRESETS' : 'MIX COLOUR + PATTERN'
    const level = this.accountLevel
    const shown = this.shownFinish
    for (const group of FINISH_GROUPS) {
      const row = this.rows[group]
      if (row === undefined) continue
      // What is shown, never a hidden locked part of the wish (#48 step 5).
      const now = shown[group]
      row.current.textContent = swatchName(now)
      row.swatches.replaceChildren()
      if (!this.mixMode) {
        for (const s of presetSwatches(group)) {
          const b = this.swatchButton(s, s.colour === now.colour && s.pattern === now.pattern, () => { this.paint(group, s) })
          Lobby.lock(b, swatchLock(s, level))
          row.swatches.append(b)
        }
      } else {
        const colours = el('div', 'lb-colours')
        for (const c of PALETTE) {
          const s = { colour: c.id, pattern: 0 }
          const b = this.swatchButton(s, c.id === now.colour, () => { this.setFinish(mixColour(this.finish, this.accountLevel, group, c.id)) })
          b.classList.add('lb-small')
          b.title = c.label
          Lobby.lock(b, colourLock(c.id, level))
          colours.append(b)
        }
        const patterns = el('div', 'lb-patterns')
        for (const p of PATTERNS) {
          const b = el('button', p.id === now.pattern ? 'lb-chip lb-sel' : 'lb-chip', p.label)
          b.onclick = () => { this.setFinish(mixPattern(this.finish, this.accountLevel, group, p.id)) }
          Lobby.lock(b, patternLock(p.id, level))
          patterns.append(b)
        }
        row.swatches.append(colours, patterns)
      }
    }
  }

  private swatchButton (s: Swatch, selected: boolean, onPick: () => void): HTMLButtonElement {
    const b = el('button', selected ? 'lb-swatch lb-sel' : 'lb-swatch')
    b.style.background = swatchBackground(s)
    b.title = swatchName(s)
    b.onclick = onPick
    return b
  }

  private paint (group: FinishGroup, s: Swatch): void {
    this.setFinish(paintWish(this.finish, group, s))
  }

  /**
   * A swatch or chip locked at `lock` (undefined: open): disabled, so it never
   * paints, titled with its level, and badged `LV n` (a chip in its text,
   * anything else in a span; `.lb-small .lb-lock` sizes it on MIX swatches).
   */
  private static lock (b: HTMLButtonElement, lock: number | undefined): void {
    if (lock === undefined) return
    b.disabled = true
    b.title = lockTitle(lock)
    b.classList.add('lb-locked')
    if (b.classList.contains('lb-chip')) b.textContent = `${b.textContent ?? ''} ${lockBadge(lock)}`
    else b.append(el('span', 'lb-lock', lockBadge(lock)))
  }

  // --------------------------------------------------------------- pixi

  /** The chosen robot large on the platform and the next one dimmed beside it. */
  private buildRobots (): void {
    for (const old of [this.robot, this.neighbour]) old?.destroy()
    this.robot = undefined
    this.neighbour = undefined
    const make = (entry: RosterEntry): RobotSprite | undefined => {
      const rig = entry.robot !== undefined ? ROBOT_RIGS[entry.robot] : undefined
      if (rig === undefined || !RobotSprite.ready(rig)) return undefined
      // Drawn several times its in-game size: the lobby sheet when it's there.
      const sprite = new RobotSprite(this, rig, RobotSprite.ready(rig, true))
      sprite.setFinish(this.shownFinish)
      return sprite
    }
    this.robot = make(this.entry)
    // The next robot the level has opened, if there is another.
    const next = stepRobot(this.entry, 1, this.accountLevel)
    if (next !== this.entry) this.neighbour = make(next)
    if (this.neighbour !== undefined) {
      this.neighbour.alpha = 0.35
      this.stage.addChild(this.neighbour)
    }
    if (this.robot !== undefined) this.stage.addChild(this.robot)
    this.layout()
  }

  private layout (): void {
    const box = this.preview?.getBoundingClientRect()
    // The glow sits behind the robot: the preview's centre, the screen's before it is laid out.
    const cx = box !== undefined && box.width > 0 ? (box.left + box.width / 2) / window.innerWidth : 0.5
    const cy = box !== undefined && box.height > 0 ? (box.top + box.height / 2) / window.innerHeight : 0.52
    this.paintBackdrop(window.innerWidth, window.innerHeight, cx, cy)
    this.layoutPreview()
  }

  /**
   * Scale the whole lobby (panels too) to the window: its natural height is
   * measured unzoomed (`lb-measure` lets the grid shrink to its content), and
   * the root is zoomed by window / natural, and on desktop by width /
   * `FIT_WIDTH` too, never above 1 or below `FIT_MIN` (past that it scrolls,
   * as it did before). The root is given the window's size divided by the
   * zoom, so it still covers the window. The canvas robot follows through
   * the preview's measured box (`getBoundingClientRect` reports zoomed sizes).
   */
  private fit (): void {
    if (this.tornDown || this.main === undefined) return
    const w = window.innerWidth
    const h = window.innerHeight
    const phone = w <= PHONE_MAX
    const style = this.root.style
    style.removeProperty('zoom')
    style.removeProperty('width')
    style.removeProperty('height')
    this.root.classList.add('lb-measure')
    const need = this.top.offsetHeight + this.main.offsetHeight
    this.root.classList.remove('lb-measure')
    // A few px of slack: zoomed sizes round, and a 3 px scroll is still a scroll.
    let zoom = Math.min(1, need > 0 ? h / (need + 8) : 1, phone ? 1 : w / FIT_WIDTH)
    zoom = Math.max(phone ? FIT_MIN.phone : FIT_MIN.desktop, zoom)
    this.zoom = zoom < 0.995 ? zoom : 1
    if (this.zoom === 1) return
    style.setProperty('zoom', String(this.zoom))
    style.width = `${w / this.zoom}px`
    style.height = `${h / this.zoom}px`
  }

  /** Fit the canvas art into the same flow layout as its DOM controls, including scrolling. */
  private layoutPreview (): void {
    if (this.preview === undefined || this.tornDown) return
    const w = window.innerWidth
    const h = window.innerHeight
    const box = this.preview.getBoundingClientRect()
    const viewport = this.content.getBoundingClientRect()
    const stand = this.robot?.standHeight ?? RobotSprite.PEEP_HEIGHT
    // Reserve room below the feet for the platform and beside it for the platform's glow.
    const scale = Math.max(0.1, Math.min(5.5, (box.height - 24) / (stand + 20), (box.width - 40) / 114))
    const x = box.left + box.width / 2 - w / 2
    const feetY = box.top + (box.height + stand * scale) / 2 - 10 * scale - h / 2
    const rx = 42 * scale
    const ry = 9 * scale
    const glow = this.platform
    glow.clear()
    glow.beginFill(0x0a1520, 0.9).drawEllipse(x, feetY + ry * 0.35, rx, ry).endFill()
    glow.lineStyle(Math.max(2, scale), 0x3de0d0, 0.55).drawEllipse(x, feetY + ry * 0.35, rx, ry)
    glow.lineStyle(0).beginFill(0x3de0d0, 0.10).drawEllipse(x, feetY + ry * 0.35, rx * 1.35, ry * 1.5).endFill()
    if (this.robot !== undefined) {
      this.robot.scale.set(scale)
      this.robot.position.set(x, feetY)
    }
    // A second floating robot has no reserved space in this layout; the roster previews it.
    if (this.neighbour !== undefined) this.neighbour.visible = false
    const top = Math.max(box.top, viewport.top)
    const bottom = Math.min(box.bottom, viewport.bottom)
    this.previewClip.clear().beginFill(0xffffff)
      .drawRect(box.left - w / 2, top - h / 2, box.width, Math.max(0, bottom - top)).endFill()
  }

  /** A dark radial backdrop over the whole screen, lit at (`cx`, `cy`) as fractions of it; drawn once per layout on a canvas. */
  private paintBackdrop (w: number, h: number, cx: number, cy: number): void {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w / 4))
    canvas.height = Math.max(1, Math.round(h / 4))
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const r = Math.max(canvas.width, canvas.height) * 0.6
    const g = ctx.createRadialGradient(canvas.width * cx, canvas.height * cy, 0, canvas.width * cx, canvas.height * cy, r)
    g.addColorStop(0, '#16314a')
    g.addColorStop(0.45, '#0b1726')
    g.addColorStop(1, '#04070d')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const old = this.backdrop.texture
    this.backdrop.texture = Texture.from(canvas)
    if (old !== Texture.EMPTY) old.destroy(true)
    this.backdrop.width = w
    this.backdrop.height = h
    this.backdrop.position.set(-w / 2, -h / 2)
  }

  /** The big robot looks at the pointer, as your robot does in play. */
  private lookAt (x: number, y: number): void {
    const robot = this.robot
    if (robot === undefined) return
    const at = robot.getGlobalPosition()
    const dx = x - at.x
    const dy = y - (at.y - robot.aimPx * robot.scale.y)
    if (Math.abs(dx) < 6) return
    robot.setAim(Math.atan2(-dy, Math.abs(dx)) * 180 / Math.PI, dx < 0 ? -1 : 1)
  }

  /** Each pickable robot's card gets a still of its rig in the current finish. */
  private async renderThumbnails (): Promise<void> {
    for (let i = 0; i < ROSTER.length; i++) {
      const entry = ROSTER[i]
      const thumb = this.cards[i].querySelector('.lb-thumb') as HTMLDivElement
      const rig = entry.robot !== undefined ? ROBOT_RIGS[entry.robot] : undefined
      if (rig === undefined || !RobotSprite.ready(rig) || Game.RENDERER === undefined) {
        thumb.textContent = '?'
        continue
      }
      const host = new Container()
      const sprite = new RobotSprite(host, rig, RobotSprite.ready(rig, true))
      sprite.setFinish(this.shownFinish)
      sprite.scale.set(2)
      sprite.update(0)
      host.addChild(sprite)
      try {
        const src = await Game.RENDERER.extract.base64(host)
        const img = el('img')
        img.src = src
        img.alt = entry.name
        thumb.replaceChildren(img)
        if (entry.robot !== undefined) this.thumbs.set(entry.robot, src)
      } catch (e) {
        thumb.textContent = '?'
      }
      sprite.destroy()
      host.destroy()
    }
    if (!this.tornDown) this.renderJourney()
  }

  /**
   * The progression block from the account's standing, and the journey under
   * it. Offline or before the server says, the heading says so and the bar is
   * hidden; the journey then reads level 1, as the locks do.
   */
  private renderLevel (): void {
    const standing = ACCOUNT.info?.standing
    // No token stored: the server makes the account on the first run and
    // announces none before it, so this is a new player at level 1.
    const fresh = ACCOUNT.info === undefined && !Lobby.hasToken()
    this.xpBar.hidden = standing === undefined && !fresh
    if (standing === undefined) {
      const offline = ACCOUNT.info?.offline === true
      this.levelHeading.textContent = offline ? 'Offline' : fresh ? 'Level 1' : 'Level \u2026'
      this.xpFill.style.width = '0%'
      this.xpLine.textContent = offline ? 'XP is saved when the server is back' : fresh ? 'Play a run to start earning XP' : ''
      this.xpToGo.textContent = ''
    } else {
      const into = standing.xp - standing.levelAt
      const span = Math.max(1, standing.nextAt - standing.levelAt)
      this.levelHeading.textContent = `Level ${standing.level}`
      this.xpFill.style.width = `${100 * Math.min(1, Math.max(0, into / span))}%`
      this.xpLine.textContent = `${into} / ${span} XP`
      this.xpToGo.textContent = `${Math.max(0, standing.nextAt - standing.xp)} XP to level ${standing.level + 1}`
    }
    if (!this.journeyMoved) this.journeyFrom = this.clampJourney(this.accountLevel)
    this.renderJourney()
  }

  /** The journey strip shows `JOURNEY_SHOWN` stops (CSS hides the last under 760 px). */
  private clampJourney (from: number): number {
    return Math.max(1, Math.min(from, journeyEnd() - JOURNEY_SHOWN + 1))
  }

  private moveJourney (by: number): void {
    this.journeyFrom = this.clampJourney(this.journeyFrom + by)
    this.journeyMoved = true
    this.renderJourney()
  }

  /**
   * One stop per level from `journeyFrom`: levels behind are ticked, the
   * account's is a ring with its number, levels ahead show what opens there
   * (the robot's still, a bolt, a box) with a lock, or only their number.
   */
  private renderJourney (): void {
    const level = this.accountLevel
    this.journeyStops.replaceChildren()
    for (let l = this.journeyFrom; l < this.journeyFrom + JOURNEY_SHOWN; l++) {
      const stop = journeyStop(l)
      const node = el('div', 'lb-jstop')
      const ring = el('div', 'lb-jring')
      if (l < level) {
        node.classList.add('lb-jdone')
        ring.innerHTML = ICON.check
      } else if (l === level) {
        node.classList.add('lb-jnow')
        ring.textContent = String(l)
      } else if (stop.kind === undefined) {
        node.classList.add('lb-jempty')
        ring.textContent = String(l)
      } else {
        const thumb = stop.robot !== undefined ? this.thumbs.get(stop.robot) : undefined
        if (thumb !== undefined) ring.append(Object.assign(el('img'), { src: thumb, alt: '' }))
        else ring.innerHTML = stop.kind === 'bot' ? ICON.bot : stop.kind === 'skill' ? ICON.bolt : ICON.box
        const lock = el('span', 'lb-jlock')
        lock.innerHTML = ICON.lock
        ring.append(lock)
      }
      node.title = stop.names.length > 0 ? `Level ${l}: ${stop.names.join(', ')}` : `Level ${l}`
      node.append(ring, el('div', 'lb-jlevel', `Lv ${l}`), el('div', 'lb-jkind', stop.kind === undefined ? '' : JOURNEY_WORD[stop.kind]))
      this.journeyStops.append(node)
    }
    this.journeyPrev.disabled = this.journeyFrom <= 1
    this.journeyNext.disabled = this.journeyFrom >= this.clampJourney(Number.MAX_SAFE_INTEGER)
  }

  /**
   * The action rows' status lines: the kit READY plays, the robot's first
   * three stats, the stash count and how much of it is new. Only the stash's
   * dot lights, and only for rows the panel hasn't shown.
   */
  private renderRows (): void {
    // Runs from `select` inside the constructor, before the panels exist.
    if (this.loadout === undefined || this.rowStatus === undefined) return
    const robot = this.entry.robot ?? 'peep'
    const index = this.loadout.indexFor(robot)
    const kit = loadoutOf(ACCOUNT.info?.loadouts, robot, index)
    const names = kit.map((id) => SKILL_LIST.find((s) => s.id === id)?.label).filter((n): n is string => n !== undefined)
    const prefix = loadoutSlotsAt(this.accountLevel) > 1 ? `Loadout ${index + 1}: ` : ''
    this.setRow('skills', prefix + (names.length > 0 ? names.join(', ') : 'Empty kit'), false)
    this.setRow('paint', STAT_BARS.slice(0, 3).map((bar) => {
      const v = bar.value(this.entry)
      return `${bar.label.charAt(0)}${bar.label.slice(1).toLowerCase()} ${v === null ? '-' : bar.text(v)}`
    }).join(' \u00B7 '), false)
    const view = STASH.view
    const fresh = newStashCount(localTokenStorage(), ACCOUNT.info?.id, view)
    this.setRow('stash', view === undefined ? 'Not loaded' : `${stashCount(view)}${fresh > 0 ? ` \u00B7 ${fresh} new` : ''}`, fresh > 0)
  }

  private setRow (key: 'skills' | 'paint' | 'stash', text: string, lit: boolean): void {
    this.rowStatus[key].text.textContent = text
    this.rowStatus[key].dot.hidden = !lit
  }

  /** The stash changed or its panel opened: what the open panel shows is seen. */
  private stashChanged (): void {
    if (this.tornDown || this.stash === undefined) return
    const view = STASH.view
    const account = ACCOUNT.info?.id
    if (view !== undefined && account !== undefined && !this.stash.root.classList.contains('lb-hidden')) {
      markStashSeen(localTokenStorage(), account, view)
    }
    this.renderRows()
  }

  /**
   * The season line from the last `season` view, with its countdown; hidden
   * with none. The last payout's notice shows in this lobby while this
   * browser hasn't shown that season's (`lastNotice` marks it shown).
   */
  private renderSeason (): void {
    const view = SEASON.view
    this.season.hidden = view === undefined
    if (view === undefined) return
    if (this.noticeFor !== view) {
      this.noticeFor = view
      this.notice = lastNotice(view, localTokenStorage()) ?? this.notice
    }
    this.seasonNotice.hidden = this.notice === undefined
    this.seasonNotice.textContent = this.notice ?? ''
    this.seasonText.textContent = seasonLine(view, Date.now() - SEASON.receivedAt)
  }

  /** The plays line under READY from the last energy view, counted forward; hidden with none (offline plays free). */
  private renderEnergy (): void {
    const view = ENERGY.view
    const elapsed = Date.now() - ENERGY.receivedAt
    this.playsLine.hidden = view === undefined
    this.playsLine.textContent = view === undefined ? '' : energyLine(view, elapsed)
    const out = outOfPlays(view, elapsed)
    this.readyButton.disabled = out
    this.readyButton.title = out ? 'A run costs a play; extracting gives it back' : ''
  }

  private teardown (): void {
    if (this.tornDown) return
    this.tornDown = true
    ACCOUNT.listeners.delete(this.onAccount)
    STASH.listeners.delete(this.onStash)
    SEASON.listeners.delete(this.onSeason)
    clearInterval(this.seasonTimer)
    ENERGY.listeners.delete(this.onEnergy)
    clearInterval(this.energyTimer)
    clearInterval(this.fullTimer)
    this.loadout.dispose()
    this.stash.dispose()
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('pointermove', this.onMove)
    this.layoutObserver.disconnect()
    this.fitObserver.disconnect()
    cancelAnimationFrame(this.fitFrame)
    this.content.removeEventListener('scroll', this.onScroll)
    this.root.remove()
    this.robot?.destroy()
    this.neighbour?.destroy()
    this.robot = undefined
    this.neighbour = undefined
  }

  private static injectStyle (): void {
    if (document.getElementById('lobby-style') !== null) return
    const style = el('style')
    style.id = 'lobby-style'
    style.textContent = LOBBY_CSS
    document.head.append(style)
  }
}
