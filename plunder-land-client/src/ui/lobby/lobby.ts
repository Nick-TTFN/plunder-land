import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from '../fullscreen'
import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { INPUT_MODE } from '../../input/inputmode'
import { inviteUrl, type Invite, JOIN_KEY, makeCode, parseStoredInvite, PARTY_KEY, readInvite, runParty, withoutInvite } from './party'
import { RobotSprite } from '../../robots/robotsprite'
import { ROBOT_RIGS } from '../../robots/robotrig'
import { Game } from '../../game'
import {
  type Finish, type FinishGroup, FINISH_GROUPS, FINISH_PRESETS, PALETTE, PATTERNS,
  colourById, finishFromBytes, finishToBytes, patternById
} from '../../utils/finishes'
import { PICKABLE, ROSTER, STAT_BARS, type RosterEntry } from './roster'
import { LOBBY_CSS } from './lobbystyle'
import { ACCOUNT, type AccountInfo, TOKEN_KEY, localTokenStorage } from '../../net/account'
import { callsign } from '../../utils/callsign'
import { lastNotice, SEASON, type SeasonView, seasonLine } from '../../net/season'
import { adOffer, clockOf, ENERGY, energyLine, outOfPlays } from '../../net/energy'
import { SettingsPanel } from '../settings/settingspanel'
import { clearFull, fullLine, retryDue } from '../../net/full'
import { LoadoutPanel } from './loadoutpanel'
import { StashPanel } from './stashpanel'
import { type BringPair, STASH, markStashSeen, newStashCount, stashCount } from '../../net/stash'
import { loadoutOf } from '../../net/loadout'
import { SKILL_LIST, loadoutSlotsAt } from '../../utils/skills'
import { Sfx } from '../../audio/sfx'
import { BUILD, PORTAL } from '../../config'
import { fullscreenButtonShown, invitesShown, privacyUrl } from '../../net/portal'
import { PORTAL_JOINS, PORTAL_ROOM, PORTAL_SDK } from '../../portal'
import { inviteParamsFor } from '../../portal/room'
import type { PortalUser } from '../../portal/adapter'
import { LINK, RELOGIN, loginButtonShown, shownName } from '../../portal/identity'
import { OFFLINE_LINE } from '../../portal/platform'
import { NOTICE_LINK, NOTICE_TEXT, markPrivacyNoticeSeen, privacyNoticeShown } from '../../portal/notice'
import { AD_BUTTON_TEXT, GRANT_TIMEOUT_MS, grantAnswerOf, refillNote, watchForPlays } from '../../portal/adrefill'
import {
  type Swatch, colourLock, journeyEnd, journeyStop, lockBadge, lockTitle, mixColour, mixPattern, paintWish, patternLock,
  reshownRobot, robotLock, robotToStore, shownFinish, shownRobot, stepRobot, swatchLock
} from './locks'

const ID_KEY = 'plunderland_player_id'
/** Where the lobby kept the name it used to send; removed on sight (decision #62, g2-9: no typed names). */
const NAME_KEY = 'plunderland_player_name'
const FINISH_KEY = 'plunderland_player_finish'
const ROBOT_KEY = 'plunderland_player_robot'

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

function removeStorage (key: string): void {
  try {
    localStorage.removeItem(key)
  } catch (e) {
    // Nothing to do: unreadable storage holds nothing we can reach.
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

/**
 * The player's own callsign as the server names the run (decision #62, g2-9;
 * the mirrored `utils/callsign.ts`): the account id's, offline too, since the
 * server plays an offline account under the id it announced. Undefined until
 * the account is announced.
 */
export function callsignLine (info: AccountInfo | undefined): string | undefined {
  return info === undefined ? undefined : callsign(info.id)
}

/** The id when storage is unavailable, kept for the page so a reconnect keeps the callsign. */
let _pageId: string | undefined

const genRanHex = (size: number): string => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

/** `finish` as its wire bytes, `robot` an archetype key, `bring` the stash rows for keys 3 and 4 (49-4), undefined for none. */
export type LobbyStart = (playerId: string, finish: number[], robot: string, party: string, loadout: number, bring: BringPair | undefined) => Promise<void>

/** The lobby's phone layout starts at this width or under (`lobbystyle.ts`'s 760 px query). */
const PHONE_MAX = 760
/** The desktop grid's comfortable width: narrower windows zoom it rather than squeeze it. */
const FIT_WIDTH = 1100
/**
 * The smallest zoom `fit` applies; a shorter window scrolls from there. A
 * phone on its side (landscape, 520 px tall or less) keeps the two-column
 * layout and zooms further to fit (Nick, 2026-11-05).
 */
const FIT_MIN = { desktop: 0.6, phone: 0.75, landscape: 0.45 } as const
/** At this height or under, a landscape window is a phone on its side (`lobbystyle.ts`'s 520 px query). */
const SHORT_MAX = 520

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
  // The rewarded refill's button (g2-6d): a video camera, so it is clear an ad plays.
  video: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10.5l6-3.5v10l-6-3.5z"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  collapse: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
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
  /** The player's own name as everyone else sees it: the callsign, or the server's name for a linked portal account (`shownName`). */
  private readonly callsign: HTMLLabelElement
  private readonly callsignText: HTMLSpanElement
  /** A portal user's picture beside the username (g2-6c); a DOM image, hidden until it loads. */
  private readonly avatar: HTMLImageElement
  /** The portal's signed-in user (g2-6c, Q1), once the SDK has said; null off a portal and for a guest. */
  private portalUser: PortalUser | null = null
  /** "Log in" for a portal guest (g2-6c, Q4): small, top right, opens the portal's login only on a click. */
  private readonly loginButton: HTMLButtonElement
  /** READY was pressed while the portal's link modal was open: it goes once the answer is sent (`LINK`). */
  private readyHeld = false
  private readonly kindLine: HTMLDivElement
  private readonly nameLine: HTMLDivElement
  private readonly tagline: HTMLDivElement
  private readonly cards: HTMLButtonElement[] = []
  private readonly statRows: Array<{ fill: HTMLDivElement, value: HTMLSpanElement }> = []
  /** STATS & PAINT: the stat bars over the customize rows. */
  private readonly customize: HTMLDivElement
  /** CHOOSE PLUNDERBOT: the robot cards and the chosen one's tagline. */
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
  private readonly onAccount = (): void => { this.renderLevel(); this.applyLevel(); this.renderRows(); this.renderCallsign() }
  /**
   * A friend's invite accepted on the portal while this lobby is up (g2-6e):
   * its runs carry the friend's code from the next READY. After READY it
   * waits in `PORTAL_JOINS` for the next lobby.
   */
  private readonly onPortalJoin = (code: string): void => {
    if (this.started || this.tornDown) return
    this.invite = this.portalInvite(code)
    writeSession(JOIN_KEY, this.invite === undefined ? null : JSON.stringify(this.invite))
    this.renderJoin()
  }
  /** The link modal opened or closed: a READY held meanwhile goes now. */
  private readonly onLink = (): void => {
    if (LINK.open !== undefined || !this.readyHeld || this.tornDown) return
    this.readyHeld = false
    this.ready()
  }
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
  /** In READY's place on an offline launch (g2-6f, `PORTAL_SDK.offline()`). */
  private readonly offlineLine: HTMLDivElement
  /**
   * The privacy notice for a new player (g2-6f, decision #62 Q6: everywhere),
   * under READY until this browser's first run starts (`portal/notice.ts`).
   * It carries the privacy link, so the plain one under READY hides meanwhile.
   */
  private readonly privacyNotice: HTMLDivElement
  private readonly noticeShown: boolean
  private readonly privacyLink: HTMLAnchorElement
  private readonly onEnergy = (): void => { this.renderEnergy() }
  /** The header's fullscreen button (g2-1), redrawn on every enter and leave (Esc included). */
  private readonly fullButton: HTMLButtonElement
  private readonly offFullscreen: () => void
  /** Re-renders the plays countdown every 10 s, so READY comes back within seconds of the play. */
  private readonly energyTimer: ReturnType<typeof setInterval>
  /**
   * The rewarded refill (g2-6d, decision #62: the only ad there is): a
   * button beside the plays line, only where the server offers it
   * (`energy.adRefill`, `adOffer`), with no play left; its note under it.
   */
  private readonly adRow: HTMLDivElement
  private readonly adButton: HTMLButtonElement
  private readonly adNote: HTMLSpanElement
  /** An ad (or the refill's answer) is pending: the button and READY wait, with a spinner. */
  private adPending = false
  /** The last click's note and until when it shows (`refillNote`). */
  private adNoteText: string | undefined
  private adNoteUntil = 0
  /** Re-renders the refill's "Next refill in" clock every second while it shows. */
  private readonly adTimer: ReturnType<typeof setInterval>
  private adClockShown = false

  constructor (private readonly start: LobbyStart) {
    super()
    this.playerId = Lobby.loadId()
    this.finish = finishFromBytes(Lobby.loadJson(FINISH_KEY))
    this.robotWish = readStorage(ROBOT_KEY)
    this.index = PICKABLE.indexOf(shownRobot(this.robotWish, this.accountLevel))
    this.ownParty = Lobby.loadParty()
    // A portal invite (g2-6e) brought this page, or came in during a run: it outranks the tab's last.
    const joined = PORTAL_JOINS.latest
    this.invite = joined === undefined ? Lobby.loadInvite() : this.portalInvite(joined)

    this.previewLayer.addChild(this.platform, this.stage)
    this.previewLayer.mask = this.previewClip
    this.addChild(this.backdrop, this.previewLayer, this.previewClip)

    Lobby.injectStyle()
    this.root = el('div', 'lb')

    // Header: brand, INVITE and settings; under 760 px the last two
    // (and PRIVACY) fold into the menu button's dropdown.
    const top = this.top = el('header', 'lb-top')
    top.innerHTML = `
      <div class="lb-brand"><img class="lb-wordmark" src="res/brand/plunderbots-wordmark.png" alt="Plunderbots"></div>`
    const topActions = el('div', 'lb-topactions')
    // Invites (decision #47): the link puts a friend in this player's world.
    this.inviteButton = el('button', 'lb-invite', 'Invite')
    this.inviteButton.title = 'Copy a link that puts a friend in your world'
    this.inviteButton.onclick = () => { this.closeMenu(); this.copyInvite() }
    this.renderInvite()
    // Settings (L3): key bindings and graphics, a panel over the lobby.
    const settings = el('button', 'lb-invite lb-settings')
    settings.innerHTML = `${ICON.gear}<span class="lb-menu-label">Settings</span>`
    settings.title = 'Settings'
    settings.setAttribute('aria-label', 'Settings')
    settings.onclick = () => { this.closeMenu(); SettingsPanel.show() }
    // Portals ask for it, and it is what the game collects (decision #46).
    const privacy = (className: string): HTMLAnchorElement =>
      Object.assign(el('a', className), { href: privacyUrl(PORTAL), target: '_blank', rel: 'noopener', textContent: 'Privacy' })
    // Fullscreen (Nick, 2026-11-05), on every device whose browser can and
    // where the portal allows it (g2-1, `fullscreenButtonShown`: not iPhone
    // Safari, not CrazyGames). The same toggle as the run's. Under 760 px it
    // folds into the menu with Settings.
    const full = this.fullButton = el('button', 'lb-invite lb-settings')
    full.onclick = () => { this.closeMenu(); toggleFullscreen() }
    this.renderFullscreen()
    this.offFullscreen = onFullscreenChange(() => { this.renderFullscreen() })
    // Log in (g2-6c, Q4): only for a portal guest where the portal has
    // accounts (`loginButtonShown`), hidden until the SDK has said. The game
    // never opens the portal's login by itself; a login reconnects (`RELOGIN`).
    const login = this.loginButton = el('button', 'lb-invite lb-login', 'Log in')
    login.title = 'Log in to keep your progress with your account'
    login.hidden = true
    login.onclick = () => { this.closeMenu(); void PORTAL_SDK.authPrompt() }
    topActions.append(login, this.inviteButton, full, settings, privacy('lb-privacy lb-menu-only'))
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
    change.innerHTML = `Choose Plunderbot ${ICON.down}`
    change.onclick = () => { this.toggle('pick') }
    plate.append(this.nameLine, this.kindLine, change)
    hero.append(this.preview, plate)

    // The callsign everyone sees (decision #62, g2-9): read-only, from the
    // account id. Nobody types a name; the one this lobby used to remember goes.
    removeStorage(NAME_KEY)
    const callsign = this.callsign = el('label', 'lb-callsign')
    this.callsignText = el('span', 'lb-name')
    const avatar = this.avatar = el('img', 'lb-avatar')
    avatar.alt = ''
    avatar.hidden = true
    // A picture from the portal's host: no referrer, and gone if it fails.
    avatar.referrerPolicy = 'no-referrer'
    avatar.onload = () => { avatar.hidden = avatar.getAttribute('src') === null }
    avatar.onerror = () => { avatar.hidden = true }
    callsign.append(el('span', 'lb-dot'), avatar, this.callsignText)
    this.renderCallsign()

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
    progress.append(el('div', 'lb-eyebrow', 'Progress'), this.levelHeading, this.xpBar, xpRow)

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
    journey.append(el('div', 'lb-eyebrow', 'Upcoming unlocks'), strip)

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
      paint: row('paint', ICON.bars, 'Stats & paint', 'Customize', 'E', () => { this.toggle('paint') }),
      stash: row('stash', ICON.box, 'Stash', 'Open', 'S', () => { this.toggle('stash') })
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
    ready.innerHTML = `Start run ${ICON.right}`
    ready.onclick = () => { this.ready() }
    this.playsLine = el('span', 'lb-ready-sub')
    // Rewarded refill (g2-6d): the plays line stays visible beside it, so not watching is as plain a choice.
    this.adButton = el('button', 'lb-adrefill')
    this.adButton.innerHTML = `${ICON.video}<span>${AD_BUTTON_TEXT}</span>`
    this.adButton.onclick = () => { this.watchAd() }
    this.adNote = el('span', 'lb-adnote')
    this.adRow = el('div', 'lb-adrow')
    this.adRow.append(this.adButton, this.adNote)
    this.adRow.hidden = true
    this.offlineLine = el('div', 'lb-offline', OFFLINE_LINE)
    this.offlineLine.hidden = true
    this.privacyNotice = el('div', 'lb-notice')
    this.privacyNotice.append(`${NOTICE_TEXT} `, Object.assign(el('a'), { href: privacyUrl(PORTAL), target: '_blank', rel: 'noopener', textContent: NOTICE_LINK }))
    this.noticeShown = privacyNoticeShown(localTokenStorage(), TOKEN_KEY)
    this.privacyNotice.hidden = !this.noticeShown
    this.privacyLink = privacy('lb-privacy lb-desk-only')
    this.privacyLink.hidden = this.noticeShown
    const action = el('div', 'lb-action')
    action.append(this.joinBanner, this.fullBanner, ready, this.offlineLine, this.playsLine, this.adRow, this.privacyNotice, this.privacyLink)

    // STATS & PAINT: the stat bars read from the mirrored `stats`, then the paint rows.
    this.customize = el('div', 'lb-custom lb-paint lb-hidden')
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
    // Two columns on a short landscape screen (g2-6f): the stats, then the
    // paint rows. Elsewhere the wrappers are `display: contents`.
    const statsCol = el('div', 'lb-pcol lb-pcol-a')
    statsCol.append(stats)
    const paintCol = el('div', 'lb-pcol lb-pcol-b')
    this.customize.append(head, statsCol, paintCol)
    for (const group of FINISH_GROUPS) {
      const paintRow = el('div', 'lb-row')
      const title = el('div', 'lb-rowtitle')
      const current = el('span', 'lb-current')
      title.append(el('span', undefined, group.toUpperCase()), current)
      const swatches = el('div', 'lb-swatches')
      paintRow.append(title, swatches)
      paintCol.append(paintRow)
      this.rows[group] = { current, swatches }
    }
    const foot = el('div', 'lb-customfoot')
    this.mixButton = el('button', 'lb-mix')
    this.mixButton.onclick = () => { this.mixMode = !this.mixMode; this.renderCustomize() }
    const done = el('button', 'lb-done', 'DONE')
    done.onclick = () => { this.toggle(undefined) }
    foot.append(this.mixButton, done)
    this.customize.append(foot)

    // CHOOSE PLUNDERBOT: the robot cards (stills rendered from the rigs), locked ones badged.
    this.picker = el('div', 'lb-custom lb-picker lb-hidden')
    const pickHead = el('div', 'lb-customhead')
    const pickClose = el('button', 'lb-close', '\u00D7')
    pickClose.onclick = () => { this.toggle(undefined) }
    pickHead.append(el('span', undefined, 'PLUNDERBOTS'), pickClose)
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

    // One grid: the hero spans the left column on desktop; under 760 px it all
    // stacks (progression, journey, hero, rows) and READY sticks to the bottom.
    this.content = el('div', 'lb-content')
    const main = this.main = el('main', 'lb-main')
    // Left: who plays (name, robot) and Start run; right: progression, inventory
    // and the season (Nick, 2026-11-05). Portrait phones flatten both into one column.
    const left = el('div', 'lb-left')
    left.append(callsign, hero, action)
    const right = el('div', 'lb-right')
    right.append(progress, journey, rows, this.season)
    main.append(left, right)
    this.content.append(main)
    // Which build this is (Nick, 2026-11-09): the commit, so a deploy can be checked by eye.
    const build = el('div', 'lb-build', BUILD)
    build.title = `Build ${BUILD}`
    this.root.append(top, this.content, this.customize, this.picker, this.loadout.root, this.stash.root, build)
    this.content.addEventListener('scroll', this.onScroll)
    document.body.append(this.root)
    // The account is announced on connect, which may be before or after this.
    ACCOUNT.listeners.add(this.onAccount)
    LINK.listeners.add(this.onLink)
    PORTAL_JOINS.listeners.add(this.onPortalJoin)
    STASH.listeners.add(this.onStash)
    ENERGY.listeners.add(this.onEnergy)
    this.energyTimer = setInterval(this.onEnergy, 10_000)
    this.adTimer = setInterval(() => { if (this.adClockShown || this.adNoteText !== undefined) this.renderEnergy() }, 1000)
    this.layoutObserver.observe(this.preview)
    this.layoutObserver.observe(this.content)
    // Its height changes with what it shows (the season row, banners): `fit` measures again.
    this.fitObserver.observe(this.main)
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)
    // A touch phone on its side gets its own unzoomed layout (`fit`, `lb-land`).
    INPUT_MODE.listeners.add(this.onResize)
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
    void this.loadPortalUser()
    // A portal login during the run reconnects now (`RELOGIN`); after this
    // constructor, since a reconnect takes this lobby down and makes another.
    setTimeout(() => { if (!this.tornDown && !this.started) RELOGIN.lobbyShown() }, 0)
  }

  /** The portal's user (g2-6c): the name pill's picture and the Log in button. Off a portal at once, null. */
  private async loadPortalUser (): Promise<void> {
    const user = await PORTAL_SDK.user()
    if (this.tornDown) return
    this.portalUser = user
    this.loginButton.hidden = !loginButtonShown(PORTAL_SDK, user) || PORTAL_SDK.offline()
    // The portal's invite link can be asked for now (g2-6e).
    this.renderInvite()
    // The SDK has settled (`user` waits for it): an offline launch shows here.
    this.renderEnergy()
    this.renderCallsign()
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

  /** The code this player's runs carry: the inviter's, else its own (also the portal's room, g2-6e). */
  private get party (): string {
    return runParty(this.invite, this.ownParty)
  }

  /** A portal invite's code as this lobby's invite (no name: the portal shows who invited); none for this browser's own code. */
  private portalInvite (code: string): Invite | undefined {
    return code === this.ownParty ? undefined : { code, from: '' }
  }

  /**
   * The portal's room (g2-6e, `portal/room.ts`): the code the next run
   * carries, joinable unless the server is refusing starts (`full`). Sent only
   * on a change, never offline; off CrazyGames it sends nothing.
   */
  private reportRoom (): void {
    if (this.tornDown) return
    PORTAL_ROOM.report(this.party, fullLine(performance.now()) === undefined)
  }

  /** INVITE: our own link on our site; on CrazyGames only theirs, once their SDK makes one (`invitesShown`). */
  private renderInvite (): void {
    const shown = invitesShown(PORTAL, PORTAL === 'crazygames' ? PORTAL_SDK.inviteLink(inviteParamsFor(this.party)) : null)
    this.inviteButton.style.display = shown ? '' : 'none'
  }

  /** The server-full countdown; at zero, READY as if pressed (the player can cancel with the cross). */
  private renderFull (): void {
    const now = performance.now()
    this.reportRoom()
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
    this.reportRoom()
    this.joinBanner.replaceChildren()
    this.joinBanner.style.display = this.invite === undefined ? 'none' : ''
    if (this.invite === undefined) return
    const who = this.invite.from === '' ? 'A FRIEND' : this.invite.from
    // A callsign or '' (party.ts `fromShown`); textContent all the same, it came from a link.
    this.joinBanner.append(el('span', 'lb-join-text', `JOIN ${who.toUpperCase()}'S WORLD`))
    const cancel = el('button', 'lb-join-x', '\u2715')
    cancel.title = 'Play in any world instead'
    cancel.onclick = () => {
      this.invite = undefined
      writeSession(JOIN_KEY, null)
      PORTAL_JOINS.clear()
      this.renderJoin()
    }
    this.joinBanner.append(cancel)
  }

  private copyInvite (): void {
    // On CrazyGames their link to their page (g2-6e), with the code only: CG
    // shows its friend who invited. None (offline, an SDK error): no button.
    const portalLink = PORTAL === 'crazygames' ? PORTAL_SDK.inviteLink(inviteParamsFor(this.party)) : null
    if (PORTAL === 'crazygames' && portalLink === null) {
      this.renderInvite()
      return
    }
    const url = portalLink ?? inviteUrl(window.location.origin, window.location.pathname, window.location.search, this.party, callsignLine(ACCOUNT.info) ?? '')
    const done = (label: string): void => {
      this.inviteButton.textContent = label
      setTimeout(() => { this.inviteButton.textContent = 'INVITE' }, 2000)
    }
    const fallback = (): void => { window.prompt('Send this link to a friend:', url) }
    if (navigator.clipboard?.writeText === undefined) {
      fallback()
      return
    }
    navigator.clipboard.writeText(url).then(() => { done('INVITE LINK COPIED') }, fallback)
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
    // The portal's link modal is open (g2-6c): a start now would decline the
    // link on the server, so it waits for the answer (`onLink`).
    if (LINK.open !== undefined) {
      this.readyHeld = true
      return
    }
    // No play left (Enter bypasses the disabled button), no server at all (an
    // offline launch), or a rewarded ad still playing or being answered.
    if (outOfPlays(ENERGY.view, Date.now() - ENERGY.receivedAt) || PORTAL_SDK.offline() || this.adPending) {
      Sfx.play('ui_error')
      return
    }
    this.started = true
    // The run starts: a new player's privacy notice has been seen (g2-6f).
    if (this.noticeShown) markPrivacyNoticeSeen(localTokenStorage())
    RELOGIN.lobbyLeft()
    Sfx.play('ready')
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
      void this.start(this.playerId, sent, robot, this.party, loadout, bring)
      this.parent?.removeChild(this)
    })
  }

  private key (e: KeyboardEvent): void {
    // The settings panel takes every key while it is open.
    if (this.started || !this.visible || SettingsPanel.open !== undefined) return
    let handled = true
    if (e.key === 'Enter') this.ready()
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
    // The one-column phone layout is portrait only (`lobbystyle.ts`).
    const phone = w <= PHONE_MAX && h >= w
    const short = !phone && w > h && h <= SHORT_MAX
    // A touch phone held sideways (g2-4, Nick: "ideally no scrolling ... i
    // expect it to fit on fullscreen landscape"): a compact layout of its own
    // (`.lb-land` in lobbystyle.ts) at zoom 1, so its text stays 10 px or more.
    // A mouse in the same window size (CrazyGames' small desktop frames)
    // keeps the zoomed desktop grid.
    const land = short && INPUT_MODE.touch
    this.root.classList.toggle('lb-land', land)
    const style = this.root.style
    style.removeProperty('zoom')
    style.removeProperty('--lb-z')
    style.removeProperty('width')
    style.removeProperty('height')
    this.root.classList.add('lb-measure')
    const need = this.top.offsetHeight + this.main.offsetHeight
    this.root.classList.remove('lb-measure')
    // A few px of slack: zoomed sizes round, and a 3 px scroll is still a scroll.
    let zoom = Math.min(1, need > 0 ? h / (need + 8) : 1, phone ? 1 : w / FIT_WIDTH)
    zoom = Math.max(phone ? FIT_MIN.phone : short ? FIT_MIN.landscape : FIT_MIN.desktop, zoom)
    this.zoom = land || zoom >= 0.995 ? 1 : zoom
    if (this.zoom === 1) return
    style.setProperty('zoom', String(this.zoom))
    // The safe-area insets divide by it (lobbystyle.ts, --lb-sl and friends).
    style.setProperty('--lb-z', String(this.zoom))
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
    glow.lineStyle(Math.max(2, scale), 0x33dbd3, 0.55).drawEllipse(x, feetY + ry * 0.35, rx, ry)
    glow.lineStyle(0).beginFill(0x33dbd3, 0.10).drawEllipse(x, feetY + ry * 0.35, rx * 1.35, ry * 1.5).endFill()
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
   * The name pill: the account's callsign, or for a linked portal account the
   * server's `name` and the user's picture (`shownName`, g2-6c, Q1); hidden until the server has
   * announced the account (a new player's comes with the first run).
   */
  private renderCallsign (): void {
    const shown = shownName(ACCOUNT.info, this.portalUser)
    this.callsign.hidden = shown === undefined
    this.callsignText.textContent = shown?.text ?? ''
    // A username keeps its case; a callsign is upper case.
    this.callsignText.classList.toggle('lb-portalname', shown?.portal === true)
    this.callsign.title = shown?.portal === true ? 'Your account name: what other players see' : 'Your callsign: what other players see'
    const avatar = shown?.avatar
    if (avatar === undefined) {
      this.avatar.removeAttribute('src')
      this.avatar.hidden = true
    } else if (this.avatar.getAttribute('src') !== avatar) {
      this.avatar.hidden = true
      this.avatar.src = avatar
    }
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
      this.xpLine.textContent = offline ? 'Progress isn\'t saved in offline mode' : fresh ? 'Play a run to start earning XP' : ''
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
    // An offline launch (g2-6f): no READY, no plays; the line says why.
    const offline = PORTAL_SDK.offline()
    this.readyButton.hidden = offline
    this.offlineLine.hidden = !offline
    this.playsLine.hidden = view === undefined || offline
    this.playsLine.textContent = view === undefined ? '' : energyLine(view, elapsed)
    const out = outOfPlays(view, elapsed)
    this.readyButton.disabled = out || this.adPending
    this.readyButton.title = out ? 'Each run uses 1 play. Extract to get it back.' : ''
    this.renderAd(offline ? { kind: 'none' } : adOffer(view, elapsed))
  }

  /**
   * The rewarded refill's row (g2-6d): the button where the server offers it
   * and ads can be asked for here; disabled with "Ads are blocked" behind an
   * ad blocker (no popup); hidden with "Next refill in mm:ss" while a limit
   * holds; a click's note for a few seconds after it. Hidden after an
   * `adsDisabled` answer (`adsAvailable`), off CrazyGames, on an offline
   * launch, and wherever the server sends no `adRefill`.
   */
  private renderAd (offer: ReturnType<typeof adOffer>): void {
    const blocked = PORTAL_SDK.adBlocked()
    const button = this.adPending || (offer.kind === 'button' && (blocked || PORTAL_SDK.adsAvailable()))
    if (this.adNoteText !== undefined && Date.now() >= this.adNoteUntil) this.adNoteText = undefined
    let note = this.adNoteText
    if (note === undefined && button && blocked && !this.adPending) note = 'Ads are blocked'
    this.adClockShown = note === undefined && offer.kind === 'wait'
    if (this.adClockShown && offer.kind === 'wait') note = `Next refill in ${clockOf(offer.inMs)}`
    this.adButton.hidden = !button
    this.adButton.disabled = this.adPending || blocked
    this.adButton.classList.toggle('lb-adwait', this.adPending)
    this.adNote.hidden = note === undefined
    this.adNote.textContent = note ?? ''
    this.adRow.hidden = this.adButton.hidden && this.adNote.hidden
  }

  /**
   * One click of the refill button: the ad through the adapter, its outcome
   * to the server for GA, and on `rewarded` only the request (`energy_ad`),
   * answered by the acknowledgement within `GRANT_TIMEOUT_MS`. The server's
   * `energy` updates the plays line (`index.ts`). One at a time; never in a
   * run (the lobby is gone then) and never while READY is on its way.
   */
  private watchAd (): void {
    if (this.adPending || this.started || PORTAL_SDK.adBlocked()) return
    this.adPending = true
    this.adNoteText = undefined
    this.renderEnergy()
    void watchForPlays({
      sdk: PORTAL_SDK,
      report: (result) => { Game.socket.emit('ad_result', { result }) },
      askGrant: async () => await new Promise((resolve) => {
        Game.socket.timeout(GRANT_TIMEOUT_MS).emit('energy_ad', {}, (err: unknown, data: unknown) => {
          resolve(err === null || err === undefined ? grantAnswerOf(data) : undefined)
        })
      })
    }).then((outcome) => {
      this.adPending = false
      if (this.tornDown) return
      this.adNoteText = refillNote(outcome)
      this.adNoteUntil = Date.now() + 6000
      this.renderEnergy()
    })
  }

  /**
   * The fullscreen button's visibility and icon, from the state now: corners
   * out to enter, in to leave, as the run's button (`hud.ts`). Visibility
   * reads no input mode (g2-1), so it needs no touch-mode listener.
   */
  private renderFullscreen (): void {
    const full = this.fullButton
    full.style.display = fullscreenButtonShown(PORTAL, fullscreenSupported()) ? '' : 'none'
    const label = isFullscreen() ? 'Exit fullscreen' : 'Fullscreen'
    full.innerHTML = `${isFullscreen() ? ICON.collapse : ICON.expand}<span class="lb-menu-label">${label}</span>`
    full.title = label
    full.setAttribute('aria-label', label)
  }

  private teardown (): void {
    if (this.tornDown) return
    this.tornDown = true
    this.offFullscreen()
    ACCOUNT.listeners.delete(this.onAccount)
    LINK.listeners.delete(this.onLink)
    PORTAL_JOINS.listeners.delete(this.onPortalJoin)
    RELOGIN.lobbyLeft()
    STASH.listeners.delete(this.onStash)
    SEASON.listeners.delete(this.onSeason)
    clearInterval(this.seasonTimer)
    ENERGY.listeners.delete(this.onEnergy)
    clearInterval(this.energyTimer)
    clearInterval(this.adTimer)
    clearInterval(this.fullTimer)
    this.loadout.dispose()
    this.stash.dispose()
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.onResize)
    INPUT_MODE.listeners.delete(this.onResize)
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
