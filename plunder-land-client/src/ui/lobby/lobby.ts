import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { RobotSprite } from '../../robots/robotsprite'
import { ROBOT_RIGS } from '../../robots/robotrig'
import { Game } from '../../game'
import {
  type Finish, type FinishGroup, FINISH_GROUPS, FINISH_PRESETS, PALETTE, PATTERNS,
  colourById, finishFromBytes, finishToBytes, patternById
} from '../../utils/finishes'
import { PICKABLE, ROSTER, STAT_BARS, type RosterEntry } from './roster'
import { LOBBY_CSS } from './lobbystyle'

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

/** The id when storage is unavailable, kept for the page so a reconnect keeps the callsign. */
let _pageId: string | undefined

const genRanHex = (size: number): string => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

/** `finish` as its wire bytes, `robot` an archetype key. */
export type LobbyStart = (playerId: string, name: string, finish: number[], robot: string) => Promise<void>

/** A group's finish as one swatch: colour and pattern. */
interface Swatch { colour: number, pattern: number }

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
 * Locked robots (no art yet) show as cards that can't be picked. The choice of
 * robot, finish and name is remembered in localStorage.
 *
 * Keys: left/right switch robot, E opens and closes customize, Enter is READY
 * UP. Keys typed into the name field are the field's.
 */
export default class Lobby extends Container {
  private readonly playerId: string
  private index: number
  private finish: Finish
  private mixMode = false
  private started = false

  private readonly backdrop = new Sprite()
  private readonly platform = new Graphics()
  private robot: RobotSprite | undefined
  private neighbour: RobotSprite | undefined
  private readonly stage = new Container()

  private readonly root: HTMLDivElement
  private readonly nameInput: HTMLInputElement
  private readonly plate: HTMLDivElement
  private readonly prev: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly kindLine: HTMLDivElement
  private readonly nameLine: HTMLDivElement
  private readonly tagline: HTMLDivElement
  private readonly cards: HTMLButtonElement[] = []
  private readonly statRows: Array<{ fill: HTMLDivElement, value: HTMLSpanElement }> = []
  private readonly customize: HTMLDivElement
  private readonly rows: Partial<Record<FinishGroup, { current: HTMLSpanElement, swatches: HTMLDivElement }>> = {}
  private readonly mixButton: HTMLButtonElement

  private readonly onKey = (e: KeyboardEvent): void => { this.key(e) }
  private readonly onResize = (): void => { this.layout() }
  private readonly onMove = (e: PointerEvent): void => { this.lookAt(e.clientX, e.clientY) }

  constructor (private readonly start: LobbyStart) {
    super()
    this.playerId = Lobby.loadId()
    this.finish = finishFromBytes(Lobby.loadJson(FINISH_KEY))
    const remembered = readStorage(ROBOT_KEY)
    this.index = Math.max(0, PICKABLE.findIndex((r) => r.key === remembered))

    this.addChild(this.backdrop, this.platform, this.stage)

    Lobby.injectStyle()
    this.root = el('div', 'lb')
    this.root.innerHTML = `
      <header class="lb-top">
        <div class="lb-brand"><span class="lb-logo"></span>PLUNDERLAND</div>
        <nav class="lb-tabs"><span class="lb-tab lb-on">LOBBY</span><span class="lb-tab lb-off" title="Coming soon">COLLECTION</span></nav>
      </header>
      <div class="lb-heading"><h1>CHOOSE YOUR SCAVENGER</h1><p>Find your kind of curious.</p></div>`
    const pill = el('label', 'lb-pill')
    pill.append(el('span', 'lb-dot'))
    this.nameInput = el('input', 'lb-name')
    this.nameInput.maxLength = NAME_MAX
    this.nameInput.placeholder = 'NAME'
    this.nameInput.autocomplete = 'off'
    this.nameInput.spellcheck = false
    this.nameInput.value = readStorage(NAME_KEY) ?? ''
    pill.append(this.nameInput, el('span', 'lb-pencil', '\u270E'))
    this.root.append(pill)

    this.prev = el('button', 'lb-arrow lb-prev', '\u2039')
    this.next = el('button', 'lb-arrow lb-next', '\u203A')
    const prev = this.prev
    const next = this.next
    prev.onclick = () => { this.step(-1) }
    next.onclick = () => { this.step(1) }
    this.root.append(prev, next)

    const plate = this.plate = el('div', 'lb-plate')
    this.kindLine = el('div', 'lb-kind')
    const nameRow = el('div', 'lb-namerow')
    this.nameLine = el('div', 'lb-robot')
    const edit = el('button', 'lb-edit', '\u270E EDIT')
    edit.onclick = () => { this.toggleCustomize() }
    nameRow.append(this.nameLine, edit)
    this.tagline = el('div', 'lb-tagline')
    plate.append(this.kindLine, nameRow, this.tagline)
    this.root.append(plate)

    const stats = el('div', 'lb-stats')
    for (const bar of STAT_BARS) {
      const row = el('div', 'lb-stat')
      const track = el('div', 'lb-track')
      const fill = el('div', 'lb-fill')
      track.append(fill)
      const value = el('span', 'lb-value')
      row.append(el('span', 'lb-label', bar.label), track, value)
      stats.append(row)
      this.statRows.push({ fill, value })
    }
    this.root.append(stats)

    const cards = el('div', 'lb-cards')
    for (const entry of ROSTER) {
      const card = el('button', entry.robot === undefined ? 'lb-card lb-locked' : 'lb-card')
      card.append(el('div', 'lb-thumb'), el('div', 'lb-cardname', entry.name))
      if (entry.robot === undefined) {
        card.disabled = true
        card.title = 'Coming soon'
        card.append(el('div', 'lb-soon', 'SOON'))
      } else {
        card.onclick = () => { this.select(PICKABLE.indexOf(entry)) }
      }
      cards.append(card)
      this.cards.push(card)
    }
    this.root.append(cards)

    this.customize = el('div', 'lb-custom lb-hidden')
    const head = el('div', 'lb-customhead')
    const close = el('button', 'lb-close', '\u00D7')
    close.onclick = () => { this.toggleCustomize(false) }
    head.append(el('span', undefined, 'CUSTOMIZE'), close)
    this.customize.append(head)
    for (const group of FINISH_GROUPS) {
      const row = el('div', 'lb-row')
      const title = el('div', 'lb-rowtitle')
      const current = el('span', 'lb-current')
      title.append(el('span', undefined, group.toUpperCase()), current)
      const swatches = el('div', 'lb-swatches')
      row.append(title, swatches)
      this.customize.append(row)
      this.rows[group] = { current, swatches }
    }
    const foot = el('div', 'lb-customfoot')
    this.mixButton = el('button', 'lb-mix')
    this.mixButton.onclick = () => { this.mixMode = !this.mixMode; this.renderCustomize() }
    const done = el('button', 'lb-done', 'DONE')
    done.onclick = () => { this.toggleCustomize(false) }
    foot.append(this.mixButton, done)
    this.customize.append(foot)
    this.root.append(this.customize)

    const ready = el('button', 'lb-ready', 'READY UP \u203A')
    ready.onclick = () => { this.ready() }
    this.root.append(ready)
    this.root.append(Object.assign(el('div', 'lb-keys'), {
      innerHTML: '<kbd>&larr;</kbd><kbd>&rarr;</kbd> SWITCH <kbd>E</kbd> EDIT <kbd>ENTER</kbd> READY'
    }))

    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.ready()
    })

    document.body.append(this.root)
    window.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('pointermove', this.onMove)
    this.on('removed', this.teardown, this)

    void this.renderThumbnails()
    this.select(this.index)
    this.renderCustomize()
    this.layout()
  }

  // --------------------------------------------------------------- state

  private static loadId (): string {
    let id = readStorage(ID_KEY)
    if (id === null || id === '') {
      id = _pageId ?? genRanHex(6)
      writeStorage(ID_KEY, id)
    }
    _pageId = id
    return id
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

  private step (by: number): void {
    this.select((this.index + by + PICKABLE.length) % PICKABLE.length)
  }

  private select (index: number): void {
    if (index < 0 || index >= PICKABLE.length) return
    this.index = index
    const entry = this.entry
    this.kindLine.textContent = entry.kind
    this.nameLine.textContent = entry.name
    this.tagline.textContent = entry.tagline
    ROSTER.forEach((r, i) => { this.cards[i].classList.toggle('lb-picked', r === entry) })
    STAT_BARS.forEach((bar, i) => {
      const v = bar.value(entry)
      this.statRows[i].fill.style.width = v === null ? '0%' : `${Math.min(100, 100 * v / bar.top)}%`
      this.statRows[i].value.textContent = v === null ? '-' : bar.text(v)
    })
    this.buildRobots()
  }

  private setFinish (finish: Finish): void {
    this.finish = finish
    this.robot?.setFinish(finish)
    this.neighbour?.setFinish(finish)
    this.renderCustomize()
  }

  private toggleCustomize (open?: boolean): void {
    const show = open ?? this.customize.classList.contains('lb-hidden')
    this.customize.classList.toggle('lb-hidden', !show)
    this.root.classList.toggle('lb-editing', show)
  }

  private ready (): void {
    // Enter and a click can both land; a second start would register every
    // socket listener twice.
    if (this.started) return
    this.started = true
    const name = this.nameInput.value.trim()
    // An empty name is remembered too, so clearing the field sticks.
    writeStorage(NAME_KEY, name)
    writeStorage(FINISH_KEY, JSON.stringify(finishToBytes(this.finish)))
    writeStorage(ROBOT_KEY, this.entry.key)
    void this.start(this.playerId, name, finishToBytes(this.finish), this.entry.robot ?? 'peep')
    this.parent?.removeChild(this)
  }

  private key (e: KeyboardEvent): void {
    if (this.started || !this.visible) return
    const typing = e.target === this.nameInput
    let handled = true
    if (e.key === 'Enter') this.ready()
    else if (typing) handled = false
    else if (e.key === 'ArrowLeft') this.step(-1)
    else if (e.key === 'ArrowRight') this.step(1)
    else if (e.key === 'e' || e.key === 'E') this.toggleCustomize()
    else if (e.key === 'Escape') this.toggleCustomize(false)
    else handled = false
    // Skill keys are bound on window: nothing typed here is game input.
    e.stopImmediatePropagation()
    if (handled) e.preventDefault()
  }

  // ----------------------------------------------------------- customize

  private renderCustomize (): void {
    this.mixButton.textContent = this.mixMode ? 'PRESETS' : 'MIX COLOUR + PATTERN'
    for (const group of FINISH_GROUPS) {
      const row = this.rows[group]
      if (row === undefined) continue
      const now = this.finish[group]
      row.current.textContent = swatchName(now)
      row.swatches.replaceChildren()
      if (!this.mixMode) {
        for (const s of presetSwatches(group)) {
          row.swatches.append(this.swatchButton(s, s.colour === now.colour && s.pattern === now.pattern, () => { this.paint(group, s) }))
        }
      } else {
        const colours = el('div', 'lb-colours')
        for (const c of PALETTE) {
          const s = { colour: c.id, pattern: 0 }
          const b = this.swatchButton(s, c.id === now.colour, () => { this.paint(group, { colour: c.id, pattern: now.pattern }) })
          b.classList.add('lb-small')
          b.title = c.label
          colours.append(b)
        }
        const patterns = el('div', 'lb-patterns')
        for (const p of PATTERNS) {
          const b = el('button', p.id === now.pattern ? 'lb-chip lb-sel' : 'lb-chip', p.label)
          b.onclick = () => { this.paint(group, { colour: now.colour, pattern: p.id }) }
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
    this.setFinish({ ...this.finish, [group]: { colour: s.colour, pattern: s.pattern } })
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
      sprite.setFinish(this.finish)
      return sprite
    }
    this.robot = make(this.entry)
    if (PICKABLE.length > 1) this.neighbour = make(PICKABLE[(this.index + 1) % PICKABLE.length])
    if (this.neighbour !== undefined) {
      this.neighbour.alpha = 0.35
      this.stage.addChild(this.neighbour)
    }
    if (this.robot !== undefined) this.stage.addChild(this.robot)
    this.layout()
  }

  /** The size of the big robot: about a quarter of the screen's height, a fifth on a short one. */
  private scaleFor (h: number): number {
    return Math.max(2.2, Math.min(5.5, h * (h < 850 ? 0.20 : 0.24) / RobotSprite.PEEP_HEIGHT))
  }

  private layout (): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.paintBackdrop(w, h)
    const narrow = w < 720
    const scale = this.scaleFor(h) * (narrow ? 0.8 : 1)
    // On a phone the stats and cards take the lower half, so the robot stands higher.
    const feetY = h * (narrow ? -0.12 : -0.02)
    const glow = this.platform
    glow.clear()
    const rx = 42 * scale
    const ry = 9 * scale
    glow.beginFill(0x0a1520, 0.9).drawEllipse(0, feetY + ry * 0.35, rx, ry).endFill()
    glow.lineStyle(Math.max(2, scale), 0x3de0d0, 0.55).drawEllipse(0, feetY + ry * 0.35, rx, ry)
    glow.lineStyle(0).beginFill(0x3de0d0, 0.10).drawEllipse(0, feetY + ry * 0.35, rx * 1.35, ry * 1.5).endFill()
    if (this.robot !== undefined) {
      this.robot.scale.set(scale)
      this.robot.position.set(0, feetY)
    }
    // The DOM follows the robot: the name plate under the platform, the arrows
    // either side of its body. Coordinates here are from the screen's centre.
    const standPx = (this.robot?.standHeight ?? RobotSprite.PEEP_HEIGHT) * scale
    this.plate.style.top = `${Math.round(h / 2 + feetY + ry * 1.6 + 8)}px`
    const armsY = Math.round(h / 2 + feetY - standPx / 2 - 30)
    this.prev.style.top = this.next.style.top = `${armsY}px`
    this.prev.style.left = `${Math.round(w / 2 - rx - 70)}px`
    this.next.style.left = `${Math.round(w / 2 + rx + 10)}px`
    if (this.neighbour !== undefined) {
      this.neighbour.visible = !narrow
      this.neighbour.scale.set(scale * 0.62)
      this.neighbour.position.set(w * 0.30, feetY - 0.06 * h)
    }
  }

  /** A dark radial backdrop over the whole screen, drawn once per size on a canvas. */
  private paintBackdrop (w: number, h: number): void {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w / 4))
    canvas.height = Math.max(1, Math.round(h / 4))
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const g = ctx.createRadialGradient(canvas.width / 2, canvas.height * 0.52, 0, canvas.width / 2, canvas.height * 0.52, canvas.width * 0.7)
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

  /** The big robot aims its gun and eye at the pointer, as your robot does in play. */
  private lookAt (x: number, y: number): void {
    const robot = this.robot
    if (robot === undefined) return
    const at = robot.getGlobalPosition()
    const dx = x - at.x
    const dy = y - (at.y - robot.shoulderPx * robot.scale.y)
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
      sprite.setFinish(this.finish)
      sprite.scale.set(2)
      sprite.update(0)
      host.addChild(sprite)
      try {
        const src = await Game.RENDERER.extract.base64(host)
        const img = el('img')
        img.src = src
        img.alt = entry.name
        thumb.replaceChildren(img)
      } catch (e) {
        thumb.textContent = '?'
      }
      sprite.destroy()
      host.destroy()
    }
  }

  private teardown (): void {
    window.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('pointermove', this.onMove)
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
