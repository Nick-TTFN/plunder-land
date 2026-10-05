import { Sprite } from 'pixi.js'
import { Game } from '../../game'
import { ACCOUNT, localTokenStorage } from '../../net/account'
import { SKILL_KEYS } from '../../net/loadout'
import {
  type BringPair, MERGE_INPUTS, type MergeCheck, STASH, STASH_EDIT_WAIT_MS, type StashItem, bringOpen, bringSlotOf, bringToSend,
  inKit, keepChoices, mergeCheck, mergeHeading, mergeMessage, onMerged, onScrapped, placeBring, prunePicks, rememberBring,
  rememberedBring, shownBring, stashCount, stashEditMessage, stashItem, stashWarning, toggleMergePick
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
 * Each skill's icon as a data URL, made once per page; '' when it failed. The
 * same as `loadoutpanel.ts`'s, which keeps its own private (49-4's allowed
 * paths didn't include that file; one shared helper later).
 *
 * Started when the panel is built, as the loadout panel's are: in a
 * headless render (software GL, 2x) the eight extracts took several seconds,
 * so starting them only on the first open left the icons blank meanwhile. An
 * icon that failed is tried again at the next open; each finished pass draws
 * the panel again.
 */
const ICONS = new Map<number, string>()
let iconsLoading: Promise<void> | undefined

async function loadIcons (): Promise<void> {
  for (const info of SKILL_LIST) {
    if (ICONS.get(info.id) !== undefined && ICONS.get(info.id) !== '') continue
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

/** Browsing (bring, scrap), picking 3 to merge, or a merge's result. */
type Mode = 'browse' | 'merge' | 'result'

/** A merge or scrap sent and not answered yet, and what it was. */
type Pending = { kind: 'merge', inputs: StashItem[] } | { kind: 'scrap', item: StashItem }

/** A notice under the detail area: what just happened, or why it didn't. */
interface Notice {
  text: string
  bad: boolean
}

/**
 * The lobby's STASH panel (decision #49, task 49-4; placeholder chrome like
 * the rest of the lobby, `lb-` classes): the loadout's Q W E R beside the two
 * keys gear is brought on (3 and 4), a grid of `STASH_SOFT` (12) cells with
 * any overflow under it (up to `STASH_MAX`), and the picked item's card
 * (skill icon, tier, roll lines in plain words, IN KIT for a duplicate).
 *
 * Pick an item, then BRING ON 3 or 4; or pick an empty key, then an item.
 * Below `BRING_LEVEL` the keys are locked with an `LV 3` badge. Parts can't
 * be brought (they are for merging). The pick is remembered per account
 * (`net/stash.ts`) and READY sends it as `bring`; a row no longer in the
 * stash is dropped silently. The server decides what is carried; the run's
 * `carried` field shows it.
 *
 * MERGE (task 49-5) switches the grid to picking 3 of one tier; the detail
 * area shows the picks, which skill the result keeps when skill items are
 * among them, and why it can't merge yet (`mergeCheck`, the server's rules).
 * Its answer (`merged`) shows the result's card; the `stash` after it
 * redraws the grid. SCRAP is on the item card, behind a confirm (it gives
 * nothing back). One merge or scrap at a time, as the server allows; the
 * buttons wait for the answer, or `STASH_EDIT_WAIT_MS`.
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
  private readonly tools: HTMLDivElement
  private readonly notice: HTMLDivElement
  private readonly onChange = (): void => { this.render() }
  private disposed = false
  private mode: Mode = 'browse'
  private mergePicks: string[] = []
  private mergeKeep: string | null = null
  /** A merge's answer, while the result view shows it. */
  private result: { heading: string, item: StashItem } | undefined
  /** The item whose SCRAP is waiting for its confirm. */
  private scrapping: string | undefined
  private pending: Pending | undefined
  private pendingTimer: ReturnType<typeof setTimeout> | undefined
  private note: Notice | undefined
  private readonly onMergedEvent = (data: unknown): void => { this.merged(data) }
  private readonly onScrappedEvent = (data: unknown): void => { this.scrapped(data) }

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
    this.tools = el('div', 'lb-st-tools')
    this.grid = el('div', 'lb-st-grid')
    this.over = el('div', 'lb-st-over', `OVER ${STASH_SOFT}`)
    this.overGrid = el('div', 'lb-st-grid')
    this.detail = el('div', 'lb-st-detail')
    this.notice = el('div', 'lb-st-notice')
    this.status = el('div', 'lb-lo-status')
    const foot = el('div', 'lb-customfoot')
    const done = el('button', 'lb-done', 'DONE')
    done.onclick = onClose
    foot.append(this.status, done)
    this.root.append(head, this.kitRow, this.warn, this.tools, this.grid, this.over, this.overGrid, this.detail, this.notice, foot)
    ACCOUNT.listeners.add(this.onChange)
    STASH.listeners.add(this.onChange)
    Game.socket?.on('merged', this.onMergedEvent)
    Game.socket?.on('scrapped', this.onScrappedEvent)
    this.loadIcons()
    this.render()
  }

  /** The panel was opened: make any icon not made yet, and draw it. */
  opened (): void {
    this.loadIcons()
    this.render()
  }

  private loadIcons (): void {
    if (iconsLoading === undefined) {
      iconsLoading = loadIcons().then(() => {
        iconsLoading = undefined
        if (!this.disposed) this.render()
      })
    }
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
    if (this.mode !== 'browse') {
      // Picking for a merge (a tap on the grid from the result view starts a new one).
      // The picks hold still while a merge is in flight.
      if (this.pending?.kind === 'merge') return
      if (this.mode === 'result') this.startMerge()
      this.mergePicks = toggleMergePick(this.mergePicks, item.id)
      this.note = undefined
      this.render()
      return
    }
    if (this.scrapping !== item.id) this.scrapping = undefined
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
    const pickedAt = this.mode === 'merge' ? this.mergePicks.indexOf(item.id) : -1
    const focused = this.mode === 'browse' ? this.focus !== undefined && 'item' in this.focus && this.focus.item === item.id : pickedAt >= 0
    const b = el('button', focused ? 'lb-st-cell lb-sel' : 'lb-st-cell')
    b.style.borderColor = focused ? '' : css(tierTint(item.tier))
    b.append(this.icon(item.skill), el('span', 'lb-st-tier', `T${item.tier}`))
    const at = bringSlotOf(shown, item.id)
    if (at >= 0) b.append(el('span', 'lb-lo-badge lb-lo-on', String(3 + at)))
    if (pickedAt >= 0) b.append(el('span', 'lb-st-pickno', String(pickedAt + 1)))
    // Another tier than the first pick's: still tappable, but it can't join this merge.
    const first = this.mode === 'merge' ? stashItem(STASH.view, this.mergePicks[0] ?? null) : undefined
    if (pickedAt < 0 && first !== undefined && first.tier !== item.tier) b.classList.add('lb-st-dim')
    b.title = itemLines(item, this.duplicate(item, shown)).join('\n')
    b.onclick = () => { this.pick(item) }
    return b
  }

  render (): void {
    if (this.disposed) return
    const view = STASH.view
    // A fresh `stash` (or none: a reconnect) is the truth: picks it no longer
    // lists go, and an unanswered edit's answer won't come on a new connection.
    this.mergePicks = prunePicks(this.mergePicks, view)
    if (view === undefined) {
      this.clearPending()
      if (this.mode === 'merge') this.mode = 'browse'
    }
    if (this.scrapping !== undefined && stashItem(view, this.scrapping) === undefined) this.scrapping = undefined
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
        // Back to browsing: a key belongs to bring, not to a merge in progress.
        this.mode = 'browse'
        this.result = undefined
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

    this.renderTools()
    if (this.mode === 'merge') this.renderMerge()
    else if (this.mode === 'result') this.renderResult(shown, open)
    else this.renderDetail(shown, open)
    this.notice.hidden = this.note === undefined
    this.notice.textContent = this.note?.text ?? ''
    this.notice.classList.toggle('lb-st-bad', this.note?.bad === true)

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
    const actions = el('div', 'lb-st-actions')
    this.detail.append(actions)
    if (this.scrapping === item.id) {
      this.renderScrapConfirm(actions, item)
      return
    }
    const scrap = el('button', 'lb-chip lb-st-danger', 'SCRAP')
    scrap.disabled = this.pending !== undefined
    scrap.title = 'Delete this item. It gives nothing back.'
    scrap.onclick = () => {
      this.scrapping = item.id
      this.note = undefined
      this.render()
    }
    if (item.skill === 0) {
      actions.append(scrap)
      return
    }
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
    actions.append(scrap)
  }

  /** SCRAP's confirm, in place of the card's actions. */
  private renderScrapConfirm (actions: HTMLDivElement, item: StashItem): void {
    actions.classList.add('lb-st-confirm')
    actions.append(el('div', 'lb-st-ask', 'SCRAP THIS ITEM? IT GIVES NOTHING BACK.'))
    const yes = el('button', 'lb-chip lb-st-danger lb-st-yes', this.pending?.kind === 'scrap' ? 'SCRAPPING…' : 'SCRAP IT')
    yes.disabled = this.pending !== undefined
    yes.onclick = () => { this.sendScrap(item) }
    const no = el('button', 'lb-chip', 'KEEP IT')
    no.disabled = this.pending?.kind === 'scrap'
    no.onclick = () => {
      this.scrapping = undefined
      this.render()
    }
    actions.append(yes, no)
  }

  /** The MERGE toggle above the grid. */
  private renderTools (): void {
    this.tools.replaceChildren()
    const view = STASH.view
    const merging = this.mode === 'merge'
    const b = el('button', merging ? 'lb-chip lb-sel' : 'lb-chip', merging ? 'CANCEL MERGE' : 'MERGE')
    b.disabled = view === undefined || (!merging && view.items.length < MERGE_INPUTS) || this.pending?.kind === 'merge'
    b.title = 'Merge 3 items of one tier into 1 of the next'
    b.onclick = () => {
      if (merging) this.mode = 'browse'
      else this.startMerge()
      this.note = undefined
      this.render()
    }
    this.tools.append(b)
    if (merging) this.tools.append(el('span', 'lb-st-toolhint', `PICK ${MERGE_INPUTS} OF ONE TIER · ${this.mergePicks.length} / ${MERGE_INPUTS}`))
  }

  private startMerge (): void {
    this.mode = 'merge'
    this.mergePicks = []
    this.mergeKeep = null
    this.result = undefined
    this.scrapping = undefined
  }

  /** The merge tray: the 3 picks, the keep choice, why not yet, MERGE. */
  private renderMerge (): void {
    this.detail.replaceChildren()
    const view = STASH.view
    const check = mergeCheck(view, this.mergePicks, this.mergeKeep)
    const slots = el('div', 'lb-st-mslots')
    for (let i = 0; i < MERGE_INPUTS; i++) {
      const item = stashItem(view, this.mergePicks[i] ?? null)
      const slot = el('button', item === undefined ? 'lb-st-mslot lb-st-empty' : 'lb-st-mslot')
      if (item === undefined) {
        slot.disabled = true
        slot.append(el('span', 'lb-st-plus', '+'))
      } else {
        slot.style.borderColor = css(tierTint(item.tier))
        slot.append(this.icon(item.skill), el('span', 'lb-st-tier', `T${item.tier} ${this.shortName(item)}`))
        slot.title = 'Tap to take it out'
        slot.disabled = this.pending !== undefined
        slot.onclick = () => {
          this.mergePicks = toggleMergePick(this.mergePicks, item.id)
          this.render()
        }
      }
      slots.append(slot)
    }
    this.detail.append(slots)

    // Which skill the result keeps, when skill items are among the picks.
    if (check.ok && check.keep !== null) {
      const row = el('div', 'lb-st-keep')
      row.append(el('span', 'lb-st-keeplabel', 'RESULT KEEPS'))
      for (const choice of keepChoices(check.inputs)) {
        const chip = el('button', choice.id === check.keep ? 'lb-chip lb-sel' : 'lb-chip', this.shortName(choice))
        chip.disabled = this.pending !== undefined
        chip.onclick = () => {
          this.mergeKeep = choice.id
          this.render()
        }
        row.append(chip)
      }
      this.detail.append(row)
    }

    this.detail.append(el('div', check.ok ? 'lb-st-preview' : 'lb-st-preview lb-st-why', check.ok ? check.preview : check.reason))
    const actions = el('div', 'lb-st-actions')
    const go = el('button', 'lb-chip lb-st-go', this.pending?.kind === 'merge' ? 'MERGING…' : 'MERGE 3')
    go.disabled = !check.ok || this.pending !== undefined
    go.onclick = () => { if (check.ok) this.sendMerge(check) }
    const cancel = el('button', 'lb-chip', 'CANCEL')
    cancel.disabled = this.pending?.kind === 'merge'
    cancel.onclick = () => {
      this.mode = 'browse'
      this.note = undefined
      this.render()
    }
    actions.append(go, cancel)
    this.detail.append(actions)
  }

  /**
   * A merge's result: the heading (NEW, or SURPRISE when parts alone made a
   * skill item) and its card. The actions row is where an ad-gated reroll
   * could go (Q11, open, not built).
   */
  private renderResult (shown: BringPair, open: boolean): void {
    this.detail.replaceChildren()
    const result = this.result
    if (result === undefined) {
      this.mode = 'browse'
      this.renderDetail(shown, open)
      return
    }
    const surprise = result.heading.startsWith('SURPRISE')
    this.detail.append(el('div', surprise ? 'lb-st-result lb-st-surprise' : 'lb-st-result', result.heading))
    const card = el('div', 'lb-st-card')
    card.style.borderColor = css(tierTint(result.item.tier))
    const text = el('div', 'lb-st-lines')
    itemLines(result.item, this.duplicate(result.item, shown)).forEach((line, i) => { text.append(el('div', i === 0 ? 'lb-st-name' : undefined, line)) })
    card.append(this.icon(result.item.skill), text)
    this.detail.append(card)
    const actions = el('div', 'lb-st-actions')
    const ok = el('button', 'lb-chip lb-st-go', 'OK')
    ok.onclick = () => {
      this.mode = 'browse'
      this.focus = stashItem(STASH.view, result.item.id) !== undefined ? { item: result.item.id } : undefined
      this.result = undefined
      this.render()
    }
    const again = el('button', 'lb-chip', 'MERGE MORE')
    again.disabled = (STASH.view?.items.length ?? 0) < MERGE_INPUTS
    again.onclick = () => {
      this.startMerge()
      this.render()
    }
    actions.append(ok, again)
    this.detail.append(actions)
  }

  /** `PART`, or the skill's label, upper case. */
  private shortName (item: StashItem): string {
    return item.skill === 0 ? 'PART' : (skillById(item.skill)?.label ?? 'SKILL').toUpperCase()
  }

  private sendMerge (check: Extract<MergeCheck, { ok: true }>): void {
    if (this.pending !== undefined || Game.socket === undefined) return
    this.setPending({ kind: 'merge', inputs: check.inputs })
    this.note = undefined
    Game.socket.emit('merge', mergeMessage(check))
    this.render()
  }

  private sendScrap (item: StashItem): void {
    if (this.pending !== undefined || Game.socket === undefined) return
    this.setPending({ kind: 'scrap', item })
    this.note = undefined
    Game.socket.emit('scrap', { id: item.id })
    this.render()
  }

  private setPending (pending: Pending): void {
    this.clearPending()
    this.pending = pending
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined
      if (this.pending === undefined || this.disposed) return
      this.pending = undefined
      this.note = { text: 'NO ANSWER FROM THE SERVER · CHECK THE STASH AND TRY AGAIN', bad: true }
      this.render()
    }, STASH_EDIT_WAIT_MS)
  }

  private clearPending (): void {
    this.pending = undefined
    if (this.pendingTimer !== undefined) clearTimeout(this.pendingTimer)
    this.pendingTimer = undefined
  }

  /** `merged`: the result's card, or why not. The `stash` after it redraws the grid. */
  private merged (data: unknown): void {
    if (this.disposed) return
    const pending = this.pending
    if (pending?.kind !== 'merge') return
    const answer = onMerged(data)
    this.clearPending()
    if (answer === undefined) {
      this.note = { text: 'MERGE ANSWERED · CHECK THE STASH', bad: false }
      this.mode = 'browse'
    } else if (answer.ok) {
      this.result = { heading: mergeHeading(pending.inputs, answer.item), item: answer.item }
      this.mode = 'result'
      this.mergePicks = []
      this.mergeKeep = null
      this.note = undefined
    } else {
      this.note = { text: stashEditMessage('merge', answer.reason), bad: true }
    }
    this.render()
  }

  /** `scrapped`: the item is gone (the `stash` after it shows it), or why not. */
  private scrapped (data: unknown): void {
    if (this.disposed) return
    const pending = this.pending
    if (pending?.kind !== 'scrap') return
    const answer = onScrapped(data)
    // The server echoes the id it was sent (cut to 20 characters; ours are shorter).
    if (answer !== undefined && answer.id !== null && answer.id !== pending.item.id) return
    this.clearPending()
    this.scrapping = undefined
    if (answer === undefined) {
      this.note = { text: 'SCRAP ANSWERED · CHECK THE STASH', bad: false }
    } else if (answer.ok) {
      if (this.focus !== undefined && 'item' in this.focus && this.focus.item === pending.item.id) this.focus = undefined
      this.note = { text: `SCRAPPED T${pending.item.tier} ${this.shortName(pending.item)}`, bad: false }
    } else {
      this.note = { text: stashEditMessage('scrap', answer.reason ?? 'store'), bad: true }
    }
    this.render()
  }

  dispose (): void {
    if (this.disposed) return
    this.disposed = true
    ACCOUNT.listeners.delete(this.onChange)
    STASH.listeners.delete(this.onChange)
    Game.socket?.off('merged', this.onMergedEvent)
    Game.socket?.off('scrapped', this.onScrappedEvent)
    this.clearPending()
    this.root.remove()
  }
}
