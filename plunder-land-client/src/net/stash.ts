import { BRING_LEVEL, GEAR_SLOTS, GEAR_TIERS, type GearInstance, type GearRoll, type GearTier, Q_MAX, STASH_MAX, STASH_SOFT, gearStatById } from '../utils/gear'
import { skillById } from '../utils/skills'

/**
 * The stash in the lobby (decision #49, task 49-4). Pixi-free, so the
 * server's specs run it (`gear/stashclient.spec.ts` there).
 *
 * The server sends `stash` (JSON) after `account` for a persisted account,
 * after a start that carried items, and after an extraction's (or a drain
 * cut-off's) settle, that one with `run`: `{ items: [{ id, tier, skill,
 * rolls: [[stat, q]] }], away, run?: { kept, full } }`. `items` are the rows
 * in the stash now; `away` counts rows out in a run (this one, another tab,
 * or awaiting a stale return). Never for an offline account, a death or a
 * failed settle. No view means no stash (offline, or a server from before it).
 *
 * The lobby picks up to two rows to bring on keys 3 and 4, sent as
 * `start_requested.bring` (`[id | null, id | null]`, entry 0 = key 3). The
 * pick is remembered per account in localStorage (`BRING_KEY`).
 */

/** A row id as the server writes it: a decimal bigint, as a string. */
export const ROW_ID = /^[0-9]{1,19}$/

/** One stashed row: its id and the item. */
export interface StashItem extends GearInstance {
  readonly id: string
}

/** What a run's settle did, on the `stash` that follows it. */
export interface StashRun {
  /** Rows now in the stash from this run (brought in and kept, picked up, found). */
  kept: number
  /** Found items the storage ceiling turned away (normal play never reaches it). */
  full: number
}

export interface StashView {
  items: StashItem[]
  away: number
  run?: StashRun
}

/** Which rows go on keys 3 and 4; null = nothing. */
export type BringPair = [string | null, string | null]

export const NO_BRING: Readonly<BringPair> = Object.freeze([null, null]) as Readonly<BringPair>

/** localStorage: `{ [account id]: BringPair }`. */
export const BRING_KEY = 'plunderland_bring'

/** What the lobby needs of localStorage; a failure means "not remembered". */
export interface BringStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * This connection's stash as last sent, and who wants to hear when it
 * changes (the lobby). Cleared on every (re)connect, like `ACCOUNT`.
 */
export const STASH: { view: StashView | undefined, listeners: Set<() => void> } = { view: undefined, listeners: new Set() }

/** Replace the stash view and tell the listeners. */
export function setStash (view: StashView | undefined): void {
  STASH.view = view
  // forEach, not for-of: the client's tsconfig targets ES5 for typechecking.
  STASH.listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // One broken listener must not stop the others.
    }
  })
}

function count (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * One row, or undefined for a malformed one or one this build can't show:
 * an unknown tier, or a skill neither 0 (a part) nor known here (an
 * item-only skill from a newer server, as `decodeGear`). Rolls of a stat this
 * build doesn't know are skipped; q is clamped to 0..1000.
 */
function itemOf (data: unknown): StashItem | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (typeof d.id !== 'string' || !ROW_ID.test(d.id)) return undefined
  const tier = count(d.tier)
  const skill = count(d.skill)
  if (tier === undefined || tier < 1 || tier > GEAR_TIERS || skill === undefined) return undefined
  if (skill !== 0 && skillById(skill) === undefined) return undefined
  if (!Array.isArray(d.rolls)) return undefined
  const rolls: GearRoll[] = []
  for (const roll of d.rolls) {
    if (!Array.isArray(roll)) return undefined
    const stat = count(roll[0])
    const q = count(roll[1])
    if (stat === undefined || q === undefined) return undefined
    if (gearStatById(stat) === undefined) continue
    rolls.push({ stat, q: Math.min(Q_MAX, q) })
  }
  return { id: d.id, tier: tier as GearTier, skill, rolls }
}

/**
 * A `stash` event, or undefined for a malformed one. A row this build can't
 * read is left out (it stays in the stash; the next client shows it), not a
 * reason to drop the whole view. At most `STASH_MAX` rows, each id once.
 */
export function onStash (data: unknown): StashView | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const away = count(d.away)
  if (!Array.isArray(d.items) || away === undefined) return undefined
  const items: StashItem[] = []
  const seen = new Set<string>()
  for (const raw of d.items) {
    if (items.length >= STASH_MAX) break
    const item = itemOf(raw)
    if (item === undefined || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  const view: StashView = { items, away }
  if (d.run !== undefined) {
    const run = d.run as Record<string, unknown> | null
    const kept = count(run?.kept)
    const full = count(run?.full)
    if (kept === undefined || full === undefined) return undefined
    view.run = { kept, full }
  }
  return view
}

/** Whether this account may bring gear in at `level` (the server checks it again). */
export function bringOpen (level: number): boolean {
  return level >= BRING_LEVEL
}

/** Every remembered pair, by account id; anything malformed reads as nothing remembered. */
export function parseBringMemory (raw: string | null): Record<string, BringPair> {
  if (raw === null) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const out: Record<string, BringPair> = {}
  for (const [account, pair] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(pair)) continue
    const at = (i: number): string | null => typeof pair[i] === 'string' && ROW_ID.test(pair[i]) ? pair[i] : null
    out[account] = [at(0), at(1)]
  }
  return out
}

/** The pair remembered for `account` in `storage`; none on any failure. */
export function rememberedBring (storage: BringStorage | undefined, account: string | undefined): BringPair {
  if (account === undefined) return [null, null]
  let raw: string | null = null
  try {
    raw = storage?.getItem(BRING_KEY) ?? null
  } catch {
    raw = null
  }
  const pair = parseBringMemory(raw)[account]
  return pair === undefined ? [null, null] : [pair[0], pair[1]]
}

/** Remember `pair` for `account`, keeping the other accounts' pairs. A failure is "not remembered". */
export function rememberBring (storage: BringStorage | undefined, account: string, pair: BringPair): void {
  try {
    const all = parseBringMemory(storage?.getItem(BRING_KEY) ?? null)
    all[account] = [pair[0], pair[1]]
    storage?.setItem(BRING_KEY, JSON.stringify(all))
  } catch {
    // Not remembered past this page.
  }
}

/** The item a row id names in `view`, if it is in the stash now. */
export function stashItem (view: StashView | undefined, id: string | null): StashItem | undefined {
  if (id === null || view === undefined) return undefined
  for (const item of view.items) if (item.id === id) return item
  return undefined
}

/**
 * The pair as the lobby shows and sends it: an id the latest view doesn't
 * list as a skill item in the stash is dropped silently (merged, scrapped,
 * lost in a death, or a part). With no view, nothing.
 *
 * The remembered pair itself keeps such an id: a row out in a run is not in
 * `items`, and comes back with the same id when the run extracts, so the
 * player's pick holds across runs instead of being cleared by every carry.
 */
export function shownBring (pair: Readonly<BringPair>, view: StashView | undefined): BringPair {
  const ok = (id: string | null): string | null => {
    const item = stashItem(view, id)
    return item !== undefined && item.skill !== 0 ? id : null
  }
  const first = ok(pair[0])
  const second = ok(pair[1])
  return [first, second === first ? null : second]
}

/**
 * `start_requested.bring`, or undefined when there is nothing to send: no
 * view (offline, or a server from before the stash), a level below
 * `BRING_LEVEL`, or both slots empty.
 */
export function bringToSend (pair: Readonly<BringPair>, view: StashView | undefined, level: number): BringPair | undefined {
  if (view === undefined || !bringOpen(level)) return undefined
  const shown = shownBring(pair, view)
  return shown[0] === null && shown[1] === null ? undefined : shown
}

/**
 * `id` onto key `slot` (0 = key 3). If it was on the other key it moves (the
 * same row can't be brought twice); null empties the slot.
 */
export function placeBring (pair: Readonly<BringPair>, slot: number, id: string | null): BringPair {
  const out: BringPair = [pair[0], pair[1]]
  if (slot < 0 || slot >= GEAR_SLOTS) return out
  if (id !== null) {
    for (let i = 0; i < GEAR_SLOTS; i++) if (out[i] === id) out[i] = null
  }
  out[slot] = id
  return out
}

/** Which key a row is brought on (0 = key 3), or -1. */
export function bringSlotOf (pair: Readonly<BringPair>, id: string): number {
  return pair[0] === id ? 0 : pair[1] === id ? 1 : -1
}

/**
 * "IN KIT": a skill item whose skill is already in the loadout (`kit`, Q W E
 * R) or on the other brought key. Either key then fires the same skill and
 * shares its cooldown (spec Q7). A part never is.
 */
export function inKit (item: GearInstance, kit: readonly number[], other: GearInstance | undefined): boolean {
  if (item.skill === 0) return false
  return kit.includes(item.skill) || (other !== undefined && other.skill === item.skill)
}

/** The stash's count line, e.g. `5 / 12`, and `· 2 AWAY` while rows are out in a run. */
export function stashCount (view: StashView): string {
  const away = view.away > 0 ? ` · ${view.away} AWAY` : ''
  return `${view.items.length} / ${STASH_SOFT}${away}`
}

/**
 * From `STASH_SOFT` (12) items: extraction still keeps everything (Nick
 * 2026-10-05, #49), but the stash asks to be thinned. Undefined below it.
 */
export function stashWarning (view: StashView): string | undefined {
  if (view.items.length < STASH_SOFT) return undefined
  return 'STASH FULL · EXTRACTION STILL KEEPS EVERYTHING · MERGE OR SCRAP SOON'
}

/** The tone of a run card line, as `xpLine`'s. */
export type GearTone = 'pending' | 'muted' | 'text' | 'loot' | 'danger'

/**
 * The run card's gear row (decision #49): label, value and tone.
 *
 * - A death (or a disconnect): everything carried is dropped, LOST.
 * - An extraction offline: nothing can be kept, LOST.
 * - An extraction carrying nothing: KEPT 0 at once (the server sends no
 *   settle for it).
 * - Otherwise the settle's `stash` with `run` says KEPT n; STASH FULL only
 *   when the ceiling turned some away. It can land before or after the own
 *   destroy; until it does, `...`; after `PROGRESS_WAIT_MS` without it,
 *   UNAVAILABLE (a failed settle sends nothing; its rows come back later).
 */
export function gearLine (extracted: boolean, carried: number, offline: boolean, run: StashRun | undefined, waited: boolean): [string, string, GearTone] {
  if (!extracted || offline) return ['GEAR LOST', String(carried), carried === 0 ? 'text' : 'danger']
  if (run !== undefined) {
    if (run.full > 0) return ['STASH FULL', `KEPT ${run.kept} · LOST ${run.full}`, 'danger']
    return ['GEAR KEPT', String(run.kept), run.kept === 0 ? 'text' : 'loot']
  }
  if (carried === 0) return ['GEAR KEPT', '0', 'text']
  if (waited) return ['GEAR KEPT', 'UNAVAILABLE', 'muted']
  return ['GEAR KEPT', '...', 'pending']
}

/*
 * Merge and scrap (decision #49 spec section 5, task 49-5). The server's
 * messages, all JSON:
 *
 * - `merge { ids: [3 row ids], keep?: id | null }` -> `merged { ok, item?,
 *   reason? }`, then a fresh `stash` (not after `busy`, nor after a refusal
 *   made before the store: malformed, no account yet).
 * - `scrap { id }` -> `scrapped { id, ok, reason? }`, then a fresh `stash`.
 *
 * The rules mirror the server's `mergeOutcome` (`gear/merge.ts`): 3 stashed
 * rows of one tier; any skill item among them makes a skill item of the next
 * tier keeping one input's skill (`keep`, default the first skill item);
 * three parts make the next tier (T3 parts stay T3, always a skill item);
 * a T3 merge with a skill item is refused (there is no tier 4). The server
 * decides; this only keeps the button honest. No odds are copied here: the
 * chances are the server's tunable (`PART_MERGE_SKILL_CHANCE`).
 *
 * An ad-gated reroll of the result (Q11) is OPEN and not built; the result
 * card keeps an actions row where one could go.
 */

/** Inputs a merge takes. */
export const MERGE_INPUTS = 3

/** Why a merge or scrap was refused, as the server says it. */
export type StashEditReason = 'busy' | 'invalid' | 'store'

/** A `merged` answer. */
export type MergedAnswer = { ok: true, item: StashItem } | { ok: false, reason: StashEditReason }

/** A `scrapped` answer. */
export interface ScrappedAnswer {
  id: string | null
  ok: boolean
  reason?: StashEditReason
}

function reasonOf (value: unknown): StashEditReason | undefined {
  return value === 'busy' || value === 'invalid' || value === 'store' ? value : undefined
}

/**
 * A `merged` event, or undefined for a malformed one. A refusal with a
 * reason this build doesn't know reads as `store` (something went wrong
 * server-side; the stash that may follow is the truth). An ok answer whose
 * item this build can't show is undefined: the following `stash` still lands.
 */
export function onMerged (data: unknown): MergedAnswer | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (d.ok === true) {
    const item = itemOf(d.item)
    return item === undefined ? undefined : { ok: true, item }
  }
  if (d.ok === false) return { ok: false, reason: reasonOf(d.reason) ?? 'store' }
  return undefined
}

/** A `scrapped` event, or undefined for a malformed one. */
export function onScrapped (data: unknown): ScrappedAnswer | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (typeof d.ok !== 'boolean') return undefined
  const id = typeof d.id === 'string' ? d.id : null
  if (d.ok) return { id, ok: true }
  return { id, ok: false, reason: reasonOf(d.reason) ?? 'store' }
}

/**
 * Tap `id` in or out of the merge pick. At most `MERGE_INPUTS`: a fourth tap
 * changes nothing (drop one first). Order is kept: it is the order sent.
 */
export function toggleMergePick (picked: readonly string[], id: string): string[] {
  if (picked.includes(id)) return picked.filter((p) => p !== id)
  if (picked.length >= MERGE_INPUTS) return [...picked]
  return [...picked, id]
}

/**
 * The pick as the latest view allows: ids no longer in the stash (merged,
 * scrapped, or carried out in a run) are dropped, order kept.
 */
export function prunePicks (picked: readonly string[], view: StashView | undefined): string[] {
  return picked.filter((id) => stashItem(view, id) !== undefined)
}

/** The skill-item inputs a result could keep: one per skill, first input first. */
export function keepChoices (inputs: readonly StashItem[]): StashItem[] {
  const out: StashItem[] = []
  for (const item of inputs) {
    if (item.skill !== 0 && !out.some((o) => o.skill === item.skill)) out.push(item)
  }
  return out
}

/** The keep that would be sent: `keep` if it is one of the skill inputs, else the first skill input; null with parts only. */
export function keepFor (inputs: readonly StashItem[], keep: string | null): string | null {
  const skilled = inputs.filter((item) => item.skill !== 0)
  if (skilled.length === 0) return null
  return skilled.some((item) => item.id === keep) ? keep : skilled[0].id
}

/** What the panel may send for the pick, or why not (a short line for the player). */
export type MergeCheck =
  | { ok: true, ids: string[], keep: string | null, inputs: StashItem[], preview: string }
  | { ok: false, reason: string }

/**
 * Whether `picked` can merge in `view`, with the line the panel shows: the
 * server's rules, so a refused merge is refused here first.
 */
export function mergeCheck (view: StashView | undefined, picked: readonly string[], keep: string | null): MergeCheck {
  if (view === undefined) return { ok: false, reason: 'NO STASH' }
  const inputs: StashItem[] = []
  for (const id of picked) {
    const item = stashItem(view, id)
    if (item !== undefined && !inputs.includes(item)) inputs.push(item)
  }
  if (inputs.length < MERGE_INPUTS) {
    const left = MERGE_INPUTS - inputs.length
    return { ok: false, reason: inputs.length === 0 ? 'PICK 3 ITEMS OF ONE TIER' : `PICK ${left} MORE OF THE SAME TIER` }
  }
  const tier = inputs[0].tier
  if (!inputs.every((item) => item.tier === tier)) return { ok: false, reason: 'ALL 3 MUST BE THE SAME TIER' }
  const chosen = keepFor(inputs, keep)
  if (chosen !== null) {
    if (tier >= GEAR_TIERS) return { ok: false, reason: `T${GEAR_TIERS} SKILL ITEMS CAN'T MERGE · ONLY T${GEAR_TIERS} PARTS` }
    const kept = stashItem(view, chosen)
    const name = (skillById(kept?.skill ?? 0)?.label ?? 'SKILL').toUpperCase()
    return { ok: true, ids: inputs.map((item) => item.id), keep: chosen, inputs, preview: `MAKES A T${tier + 1} ${name} · FRESH ROLLS` }
  }
  const preview = tier >= GEAR_TIERS
    ? `MAKES A T${GEAR_TIERS} SKILL ITEM · ALWAYS`
    : `MAKES A T${tier + 1} PART · OR, BY CHANCE, A SKILL ITEM`
  return { ok: true, ids: inputs.map((item) => item.id), keep: null, inputs, preview }
}

/**
 * The `merge` message for a check that passed. `keep` goes only when skill
 * items are among the inputs (the server refuses a keep with parts only).
 */
export function mergeMessage (check: Extract<MergeCheck, { ok: true }>): { ids: string[], keep?: string } {
  return check.keep === null ? { ids: [...check.ids] } : { ids: [...check.ids], keep: check.keep }
}

/**
 * The result card's heading: SURPRISE when parts alone made a skill item,
 * else NEW and what it is.
 */
export function mergeHeading (inputs: readonly GearInstance[], result: GearInstance): string {
  if (result.skill !== 0 && inputs.every((item) => item.skill === 0)) return 'SURPRISE: SKILL ITEM'
  const name = result.skill === 0 ? 'PART' : (skillById(result.skill)?.label ?? 'SKILL').toUpperCase()
  return `NEW: T${result.tier} ${name}`
}

/** A refused merge or scrap, in plain words. */
export function stashEditMessage (action: 'merge' | 'scrap', reason: StashEditReason): string {
  if (reason === 'busy') return 'STILL SAVING THE LAST CHANGE · TRY AGAIN IN A MOMENT'
  if (reason === 'invalid') return action === 'merge' ? 'THOSE ITEMS CAN\'T MERGE NOW · NOTHING CHANGED' : 'THAT ITEM CAN\'T BE SCRAPPED NOW · NOTHING CHANGED'
  // Not "nothing changed": a write the server's timeout gave up on may still land; the stash that follows is the truth.
  return 'COULDN\'T REACH THE STASH · TRY AGAIN LATER'
}

/** How long the panel waits for an answer before freeing its buttons (the server answers within its 3 s store timeout). */
export const STASH_EDIT_WAIT_MS = 8000
