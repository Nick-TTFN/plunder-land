import { Sprite } from 'pixi.js'
import { Game } from '../../game'
import { ACCOUNT, localTokenStorage } from '../../net/account'
import { SKILL_KEYS } from '../../net/loadout'
import {
  type BringPair, STASH, type StashItem, bringOpen, bringSlotOf, bringToSend, inKit, placeBring, rememberBring,
  rememberedBring, shownBring, stashCount, stashItem, stashWarning
} from '../../net/stash'
import { tierTint } from '../../objects/gearpickup'
import { iconTexture } from '../../skills/catalog'
import { itemLines } from '../components/gearpanel'
import { BRING_LEVEL, GEAR_SLOTS, STASH_SOFT } from '../../utils/gear'
import { SKILL_LIST, skillById } from '../../utils/skills'
import { lockBadge, lockTitle } from './locks'

function el<K extends keyof HTMLElementTagNameMap> (tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className !== undefined) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * Each skill's icon as a data URL, made once per page; '' while it is made or
 * when it failed. The same as `loadoutpanel.ts`'s, which keeps its own private
 * (49-4's allowed paths didn't include that file; one shared helper later).
 */
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

function css (colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`
}

/** What the detail area shows: an item, or an empty key waiting for one. */
type Focus = { item: string } | { slot: number } | undefined

/**
 * The lobby's STASH panel (decision #49, task 49-4; placeholder chrome like
 * the rest of the lobby, `lb-` classes): the loadout's Q W E R beside the two
 * keys gear is brought on (3 and 4), a grid of `STASH_SOFT` (12) cells with
 * any overflow under it (up to `STASH_MAX`), and the picked item's card
 * (skill icon, tier, roll lines in plain words, IN KIT for a duplicate).
 *
 * Pick an item, then BRING ON 3 or 4; or pick an empty key, then an item.
 * Below `BRING_LEVEL` the keys are locked with an `LV 3` badge. Parts can't
 * be brought (they are for merging, 49-5, which adds MERGE and SCRAP here).
 * The pick is remembered per account (`net/stash.ts`) and READY sends it as
 * `bring`; a row no longer in the stash is dropped silently. The server
 * decides what is carried; the run's `carried` field shows it.
 */
export class StashPanel {
  readonly root: HTMLDivElement
  private pair: BringPair = [null, null]
  private pairFor: string | undefined
  private focus: Focus
  private readonly count: HTMLSpanElement
  private readonly kitRow: HTMLDivElement
  private readonly warn: HTMLDivElement
  private readonly grid: HTMLDivElement
  private readonly over: HTMLDivElement
  private readonly overGrid: HTMLDivElement
  private readonly detail: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly onChange = (): void => { this.render() }
  private disposed = false

  /** `kit`: the loadout READY plays, Q W E R, for the IN KIT marks. */
  constructor (onClose: () => void, private readonly kit: () => number[]) {
    this.root = el('div', 'lb-custom lb-stash lb-hidden')
    const head = el('div', 'lb-customhead')
    const close = el('button', 'lb-close', '×')
    close.onclick = onClose
    const title = el('span', undefined, 'STASH')
    this.count = el('span', 'lb-st-count')
    title.append(this.count)
    head.append(title, close)
    this.kitRow = el('div', 'lb-st-kit')
    this.warn = el('div', 'lb-st-warn')
    this.grid = el('div', 'lb-st-grid')
    this.over = el('div', 'lb-st-over', `OVER ${STASH_SOFT}`)
    this.overGrid = el('div', 'lb-st-grid')
    this.detail = el('div', 'lb-st-detail')
    this.status = el('div', 'lb-lo-status')
    const foot = el('div', 'lb-customfoot')
    const done = el('button', 'lb-done', 'DONE')
    done.onclick = onClose
    foot.append(this.status, done)
    this.root.append(head, this.kitRow, this.warn, this.grid, this.over, this.overGrid, this.detail, foot)
    ACCOUNT.listeners.add(this.onChange)
    STASH.listeners.add(this.onChange)
    if (iconsLoading === undefined) iconsLoading = loadIcons()
    void iconsLoading.then(() => { if (!this.disposed) this.render() })
    this.render()
  }

  private get level (): number {
    return ACCOUNT.info?.standing?.level ?? 1
  }

  /** The pick, as remembered for the announced account (re-read when the account changes). */
  private get picked (): BringPair {
    const id = ACCOUNT.info?.offline === true ? undefined : ACCOUNT.info?.id
    if (id !== this.pairFor) {
      this.pairFor = id
      this.pair = rememberedBring(localTokenStorage(), id)
    }
    return this.pair
  }

  private setPair (pair: BringPair): void {
    this.pair = pair
    if (this.pairFor !== undefined) rememberBring(localTokenStorage(), this.pairFor, pair)
  }

  /** `start_requested.bring` for READY, or undefined (nothing picked, locked, no stash). */
  bring (): BringPair | undefined {
    return bringToSend(this.picked, STASH.view, this.level)
  }

  private icon (skill: number): HTMLElement {
    const url = skill === 0 ? undefined : ICONS.get(skill)
    // A part: a plain hex, as on the ground (`GearPickup`).
    if (url === undefined || url === '') return el('span', 'lb-lo-icon', skill === 0 ? '⬢' : '?')
    const img = el('img', 'lb-lo-icon')
    img.src = url
    img.alt = ''
    return img
  }

  /** Whether `item` is a duplicate: its skill is in the kit or on the other brought key. */
  private duplicate (item: StashItem, shown: BringPair): boolean {
    const view = STASH.view
    const other = shown.map((id) => id === item.id ? undefined : stashItem(view, id)).find((o) => o !== undefined && o.skill === item.skill)
    return inKit(item, this.kit(), other)
  }

  private pick (item: StashItem): void {
    const focus = this.focus
    // An empty key was waiting for an item: put it there.
    if (focus !== undefined && 'slot' in focus && item.skill !== 0 && bringOpen(this.level)) {
      this.setPair(placeBring(shownBring(this.picked, STASH.view), focus.slot, item.id))
    }
    this.focus = { item: item.id }
    this.render()
  }

  private cell (item: StashItem | undefined, shown: BringPair): HTMLButtonElement {
    if (item === undefined) {
      const empty = el('button', 'lb-st-cell lb-st-empty')
      empty.disabled = true
      return empty
    }
    const focused = this.focus !== undefined && 'item' in this.focus && this.focus.item === item.id
    const b = el('button', focused ? 'lb-st-cell lb-sel' : 'lb-st-cell')
    b.style.borderColor = focused ? '' : css(tierTint(item.tier))
    b.append(this.icon(item.skill), el('span', 'lb-st-tier', `T${item.tier}`))
    const at = bringSlotOf(shown, item.id)
    if (at >= 0) b.append(el('span', 'lb-lo-badge lb-lo-on', String(3 + at)))
    b.title = itemLines(item, this.duplicate(item, shown)).join('\n')
    b.onclick = () => { this.pick(item) }
    return b
  }

  render (): void {
    if (this.disposed) return
    const view = STASH.view
    const level = this.level
    const open = bringOpen(level)
    const shown = shownBring(this.picked, view)
    const kit = this.kit()
    this.count.textContent = view === undefined ? '' : `  ${stashCount(view)}`

    // Q W E R from the loadout, read-only, then the two keys gear goes on.
    this.kitRow.replaceChildren()
    for (let i = 0; i < SKILL_KEYS.length; i++) {
      const k = el('div', 'lb-st-key')
      k.append(el('span', 'lb-lo-key', SKILL_KEYS[i].toUpperCase()))
      if (kit[i] !== undefined && kit[i] !== 0) k.append(this.icon(kit[i]))
      k.title = skillById(kit[i])?.label ?? 'Empty'
      this.kitRow.append(k)
    }
    for (let slot = 0; slot < GEAR_SLOTS; slot++) {
      const item = stashItem(view, shown[slot])
      const focused = this.focus !== undefined && (('slot' in this.focus && this.focus.slot === slot) || ('item' in this.focus && item !== undefined && this.focus.item === item.id))
      const b = el('button', focused ? 'lb-st-key lb-st-bring lb-sel' : 'lb-st-key lb-st-bring')
      b.append(el('span', 'lb-lo-key', String(3 + slot)))
      if (!open) {
        b.disabled = true
        b.classList.add('lb-locked')
        b.title = lockTitle(BRING_LEVEL)
        b.append(el('span', 'lb-lock', lockBadge(BRING_LEVEL)))
      } else if (item !== undefined) {
        b.style.borderColor = focused ? '' : css(tierTint(item.tier))
        b.append(this.icon(item.skill))
        b.title = itemLines(item, this.duplicate(item, shown)).join('\n')
      } else {
        b.append(el('span', 'lb-st-plus', '+'))
        b.title = `Pick an item to bring on key ${3 + slot}`
      }
      b.disabled = !open || view === undefined
      b.onclick = () => {
        this.focus = item !== undefined ? { item: item.id } : { slot }
        this.render()
      }
      this.kitRow.append(b)
    }

    const warning = view === undefined ? undefined : stashWarning(view)
    this.warn.hidden = warning === undefined
    this.warn.textContent = warning ?? ''

    this.grid.replaceChildren()
    this.overGrid.replaceChildren()
    const items = view?.items ?? []
    for (let i = 0; i < STASH_SOFT; i++) this.grid.append(this.cell(items[i], shown))
    for (let i = STASH_SOFT; i < items.length; i++) this.overGrid.append(this.cell(items[i], shown))
    this.over.hidden = items.length <= STASH_SOFT
    this.overGrid.hidden = items.length <= STASH_SOFT

    this.renderDetail(shown, open)

    if (view === undefined) {
      this.status.textContent = ACCOUNT.info?.offline === true ? 'NO STASH OFFLINE' : 'EXTRACT WITH GEAR TO START A STASH'
    } else if (!open) {
      this.status.textContent = `BRING GEAR IN FROM LV ${BRING_LEVEL}`
    } else {
      this.status.textContent = view.away > 0 ? `${view.away} OUT IN A RUN` : ''
    }
  }

  /** The focused item's card and what can be done with it, or the empty key waiting for one. */
  private renderDetail (shown: BringPair, open: boolean): void {
    this.detail.replaceChildren()
    const focus = this.focus
    if (focus === undefined) {
      this.detail.append(el('div', 'lb-st-hint', STASH.view === undefined || STASH.view.items.length === 0 ? 'ITEMS YOU EXTRACT WITH LAND HERE' : 'PICK AN ITEM'))
      return
    }
    if ('slot' in focus) {
      this.detail.append(el('div', 'lb-st-hint', `PICK AN ITEM FOR KEY ${3 + focus.slot}`))
      return
    }
    const item = stashItem(STASH.view, focus.item)
    if (item === undefined) {
      this.focus = undefined
      this.renderDetail(shown, open)
      return
    }
    const card = el('div', 'lb-st-card')
    card.style.borderColor = css(tierTint(item.tier))
    const lines = itemLines(item, this.duplicate(item, shown))
    const text = el('div', 'lb-st-lines')
    lines.forEach((line, i) => { text.append(el('div', i === 0 ? 'lb-st-name' : undefined, line)) })
    card.append(this.icon(item.skill), text)
    this.detail.append(card)
    if (item.skill === 0) return
    const actions = el('div', 'lb-st-actions')
    const at = bringSlotOf(shown, item.id)
    for (let slot = 0; slot < GEAR_SLOTS; slot++) {
      const b = el('button', at === slot ? 'lb-chip lb-sel' : 'lb-chip', at === slot ? `ON KEY ${3 + slot}` : `BRING ON ${3 + slot}`)
      b.disabled = !open || at === slot
      b.onclick = () => {
        this.setPair(placeBring(shown, slot, item.id))
        this.render()
      }
      actions.append(b)
    }
    if (at >= 0) {
      const off = el('button', 'lb-chip', 'LEAVE IN STASH')
      off.onclick = () => {
        this.setPair(placeBring(shown, at, null))
        this.render()
      }
      actions.append(off)
    }
    this.detail.append(actions)
  }

  dispose (): void {
    if (this.disposed) return
    this.disposed = true
    ACCOUNT.listeners.delete(this.onChange)
    STASH.listeners.delete(this.onChange)
    this.root.remove()
  }
}
