import { Sprite } from 'pixi.js'
import { Game } from '../../game'
import { ACCOUNT, applySaved } from '../../net/account'
import {
  LOADOUT_KEY, SKILL_KEYS, type Loadouts, canClear, clear, loadoutOf, mergeSaved, parseRemembered,
  parseSaved, rememberedIndex, skillLocked, swap, tabLabel, tabLocked, withLoadout
} from '../../net/loadout'
import { LOADOUT_SIZE, MAX_LOADOUTS, SKILL_LIST, skillById } from '../../utils/skills'
import { iconTexture } from '../../skills/catalog'

/** How long after the last change a loadout saves itself. */
const SAVE_DELAY_MS = 400
/** How long READY waits for a save in flight before it starts anyway. */
const SETTLE_MAX_MS = 4000

function el<K extends keyof HTMLElementTagNameMap> (tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className !== undefined) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

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
    // Not remembered past this page.
  }
}

/** Each skill's icon as a data URL, made once per page (`iconUrl`); '' while it is made or when it failed. */
const ICONS = new Map<number, string>()
let iconsLoading: Promise<void> | undefined

async function loadIcons (): Promise<void> {
  for (const info of SKILL_LIST) {
    const texture = iconTexture(info.id)
    if (texture === undefined || Game.RENDERER === undefined) {
      ICONS.set(info.id, '')
      continue
    }
    const sprite = new Sprite(texture)
    try {
      ICONS.set(info.id, await Game.RENDERER.extract.base64(sprite))
    } catch (e) {
      ICONS.set(info.id, '')
    }
    sprite.destroy()
  }
}

type Save = { robot: string, index: number, skills: number[] }

/**
 * The lobby's LOADOUT panel (decision #48 step 4; placeholder chrome like the
 * rest of the lobby, `lb-` classes): the robot's loadout tabs 1-4, its four
 * slots Q W E R, and all eight skills under them. Click a slot, then a skill,
 * to put it there (a skill in another slot swaps with it); EMPTY clears the
 * slot. Locked skills and tabs show the level that opens them. Nothing it
 * offers is a state `checkLoadout` refuses (`net/loadout.ts` does the moves).
 *
 * The selected tab is the loadout READY plays (`indexFor`), remembered per
 * robot in localStorage `plunderland_loadout`. Changes save themselves
 * `SAVE_DELAY_MS` after the last one (`save_loadout`), one at a time; the
 * server's answer (`loadout_saved`) is the truth and a refusal snaps the
 * panel back to it. With no account yet, or an offline one, it is read-only.
 */
export class LoadoutPanel {
  readonly root: HTMLDivElement
  private robot = 'peep'
  private readonly remembered: Record<string, number>
  private loadouts: Loadouts | undefined
  /** The slot box a picked skill goes into. */
  private slot = 0
  private pending: Save | undefined
  private inFlight: Save | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private statusText = ''
  private readonly tabs: HTMLDivElement
  private readonly slots: HTMLDivElement
  private readonly grid: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly onAccount = (): void => {
    // Never over an edit that hasn't been answered yet.
    if (this.pending !== undefined || this.inFlight !== undefined) return
    this.loadouts = ACCOUNT.info?.loadouts
    this.render()
  }

  private readonly onSaved = (data: unknown): void => { this.saved(data) }
  private settled: Array<() => void> = []
  private disposed = false

  constructor (onClose: () => void) {
    this.remembered = parseRemembered(readStorage(LOADOUT_KEY))
    this.loadouts = ACCOUNT.info?.loadouts
    this.root = el('div', 'lb-custom lb-loadout lb-hidden')
    const head = el('div', 'lb-customhead')
    const close = el('button', 'lb-close', '×')
    close.onclick = onClose
    head.append(el('span', undefined, 'LOADOUT'), close)
    this.tabs = el('div', 'lb-lo-tabs')
    this.slots = el('div', 'lb-lo-slots')
    this.grid = el('div', 'lb-lo-grid')
    this.status = el('div', 'lb-lo-status')
    const foot = el('div', 'lb-customfoot')
    const done = el('button', 'lb-done', 'DONE')
    done.onclick = onClose
    foot.append(this.status, done)
    this.root.append(head, this.tabs, this.slots, this.grid, foot)
    ACCOUNT.listeners.add(this.onAccount)
    Game.socket?.on('loadout_saved', this.onSaved)
    if (iconsLoading === undefined) iconsLoading = loadIcons()
    void iconsLoading.then(() => { if (!this.disposed) this.render() })
    this.render()
  }

  private get level (): number {
    return ACCOUNT.info?.standing?.level ?? 1
  }

  /** Saving needs an account the server has stored. */
  private get editable (): boolean {
    return ACCOUNT.info !== undefined && !ACCOUNT.info.offline
  }

  /** The loadout index READY plays for `robot`. */
  indexFor (robot: string): number {
    return rememberedIndex(this.remembered, robot, this.level)
  }

  setRobot (robot: string): void {
    this.robot = robot
    this.render()
  }

  private get current (): number[] {
    return loadoutOf(this.loadouts, this.robot, this.indexFor(this.robot))
  }

  private pickTab (index: number): void {
    if (tabLocked(index, this.level)) return
    this.remembered[this.robot] = index
    writeStorage(LOADOUT_KEY, JSON.stringify(this.remembered))
    this.render()
  }

  private change (skills: number[]): void {
    if (!this.editable) return
    const index = this.indexFor(this.robot)
    if (skills.every((id, i) => id === this.current[i])) return
    this.loadouts = withLoadout(this.loadouts, this.robot, index, skills)
    this.pending = { robot: this.robot, index, skills }
    this.statusText = 'SAVING'
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.flush() }, SAVE_DELAY_MS)
    this.render()
  }

  /** Send the newest unsaved state, unless a save is still being answered. */
  private flush (): void {
    this.timer = undefined
    if (this.inFlight !== undefined || this.pending === undefined) return
    if (Game.socket === undefined) return
    this.inFlight = this.pending
    this.pending = undefined
    Game.socket.emit('save_loadout', this.inFlight)
  }

  private saved (data: unknown): void {
    const answer = parseSaved(data)
    if (answer === undefined || this.inFlight === undefined) return
    const sent = this.inFlight
    this.inFlight = undefined
    if (answer.busy) {
      // Another save was still in flight (another tab's lobby on this socket
      // can't be, so this is a race): try the newest again shortly.
      if (this.pending === undefined) this.pending = sent
      this.timer = setTimeout(() => { this.flush() }, SAVE_DELAY_MS)
      return
    }
    applySaved(answer)
    if (this.pending !== undefined) {
      this.flush()
    } else {
      this.loadouts = mergeSaved(this.loadouts, answer)
      this.statusText = answer.ok ? 'SAVED' : 'NOT SAVED'
      this.render()
      this.resolveSettled()
    }
  }

  /**
   * Resolves once no save is waiting or in flight (a pending one is sent at
   * once), or after `SETTLE_MAX_MS`: READY waits on it, so a join doesn't
   * read the loadout from before the last change.
   */
  async settle (): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.flush()
    }
    if (this.pending === undefined && this.inFlight === undefined) return
    await new Promise<void>((resolve) => {
      this.settled.push(resolve)
      setTimeout(resolve, SETTLE_MAX_MS)
    })
  }

  private resolveSettled (): void {
    const waiting = this.settled
    this.settled = []
    waiting.forEach((resolve) => { resolve() })
  }

  private icon (id: number): HTMLElement {
    const url = ICONS.get(id)
    if (url === undefined || url === '') return el('span', 'lb-lo-icon', '?')
    const img = el('img', 'lb-lo-icon')
    img.src = url
    img.alt = ''
    return img
  }

  render (): void {
    const level = this.level
    const selected = this.indexFor(this.robot)
    const current = this.current
    const editable = this.editable

    this.tabs.replaceChildren()
    for (let i = 0; i < MAX_LOADOUTS; i++) {
      const locked = tabLocked(i, level)
      const b = el('button', i === selected ? 'lb-chip lb-sel' : 'lb-chip', tabLabel(i, level))
      b.disabled = locked
      b.onclick = () => { this.pickTab(i) }
      this.tabs.append(b)
    }

    this.slots.replaceChildren()
    for (let i = 0; i < LOADOUT_SIZE; i++) {
      const info = skillById(current[i])
      const b = el('button', i === this.slot ? 'lb-lo-slot lb-sel' : 'lb-lo-slot')
      b.append(el('span', 'lb-lo-key', SKILL_KEYS[i].toUpperCase()))
      if (info !== undefined) b.append(this.icon(info.id))
      b.append(el('span', 'lb-lo-name', info?.label.toUpperCase() ?? 'EMPTY'))
      b.onclick = () => { this.slot = i; this.render() }
      this.slots.append(b)
    }

    this.grid.replaceChildren()
    for (const info of SKILL_LIST) {
      const locked = skillLocked(info.id, level)
      const at = current.indexOf(info.id)
      const b = el('button', locked ? 'lb-lo-skill lb-lo-locked' : 'lb-lo-skill')
      b.append(this.icon(info.id), el('span', 'lb-lo-name', info.label.toUpperCase()))
      if (locked) b.append(el('span', 'lb-lo-badge', `LV ${info.unlockLevel}`))
      else if (at >= 0) b.append(el('span', 'lb-lo-badge lb-lo-on', SKILL_KEYS[at].toUpperCase()))
      b.disabled = locked || !editable
      b.onclick = () => { this.change(swap(current, this.slot, info.id, level)) }
      this.grid.append(b)
    }
    const empty = el('button', 'lb-lo-skill', 'EMPTY')
    empty.disabled = !editable || !canClear(current, this.slot)
    empty.onclick = () => { this.change(clear(current, this.slot)) }
    this.grid.append(empty)

    this.status.textContent = editable ? this.statusText : 'PLAY A RUN TO SAVE LOADOUTS'
  }

  dispose (): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    ACCOUNT.listeners.delete(this.onAccount)
    Game.socket?.off('loadout_saved', this.onSaved)
    this.resolveSettled()
    this.root.remove()
  }
}
