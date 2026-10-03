import { LOADOUT_SIZE, MAX_LOADOUTS, START_KIT, checkLoadout, loadoutLevel, loadoutSlotsAt, skillById } from '../utils/skills'

/**
 * Skill loadouts on the client (decision #48 step 4). Pixi-free, so the
 * server's specs run it against the server's own bytes.
 *
 * The server builds each run's 4 skills from the account's saved loadout,
 * checked against the account level at the join, and tells the client which
 * they are in `hello.skills` (`Session.skills`). Slot i of that list is what
 * key i sends: the `skill` message's slot is an index into those 4.
 */

/** The HUD's keys for the 4 slots. */
export const SKILL_KEYS: readonly string[] = ['q', 'w', 'e', 'r']

/**
 * A server from before loadouts sends no `hello.skills` and indexes its own
 * eight skills in this order, on these keys: today's game exactly. **Delete
 * both in the release after loadouts ship.**
 */
export const LEGACY_SLOTS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8]
export const LEGACY_KEYS: readonly string[] = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i']

/**
 * The HUD's slots: the skill id in each (0 = empty) and its key. Slot i sends
 * index i. With no kit from the server, the legacy eight.
 */
export function slotsFor (skills: readonly number[] | undefined): { ids: number[], keys: string[] } {
  if (skills === undefined) return { ids: [...LEGACY_SLOTS], keys: [...LEGACY_KEYS] }
  return { ids: skills.slice(0, LOADOUT_SIZE), keys: SKILL_KEYS.slice(0, Math.min(LOADOUT_SIZE, skills.length)) }
}

/** `hello.skills`: `LOADOUT_SIZE` whole numbers, else undefined (a server from before loadouts). */
export function helloSkills (value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== LOADOUT_SIZE) return undefined
  if (!value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) return undefined
  return [...value] as number[]
}

/** Each robot's saved loadouts as the server last said, by robot key and loadout index. */
export type Loadouts = Record<string, number[][]>

/**
 * `account.loadouts` (`{ [robot]: number[][] }`), or undefined when absent or
 * malformed. Entries that aren't 4 whole numbers are dropped (read as the
 * start kit by `loadoutOf`).
 */
export function parseLoadouts (data: unknown): Loadouts | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const out: Loadouts = {}
  for (const robot of Object.keys(data)) {
    const list = (data as Record<string, unknown>)[robot]
    if (!Array.isArray(list)) continue
    out[robot] = list.slice(0, MAX_LOADOUTS).map((skills) => helloSkills(skills) ?? [...START_KIT])
  }
  return out
}

/** The loadout at (robot, index): what was saved, else the start kit. A fresh copy. */
export function loadoutOf (loadouts: Loadouts | undefined, robot: string, index: number): number[] {
  const saved = loadouts?.[robot]?.[index]
  return saved !== undefined ? [...saved] : [...START_KIT]
}

/** `loadouts` with (robot, index) set to `skills`; the others untouched. */
export function withLoadout (loadouts: Loadouts | undefined, robot: string, index: number, skills: readonly number[]): Loadouts {
  const out: Loadouts = { ...(loadouts ?? {}) }
  const list = [...(out[robot] ?? [])]
  while (list.length < index) list.push([...START_KIT])
  list[index] = [...skills]
  out[robot] = list
  return out
}

/** Whether loadout tab `index` (0-based) is still locked for an account of `level`. */
export function tabLocked (index: number, level: number): boolean {
  return index >= loadoutSlotsAt(level)
}

/** A tab's caption: its number, or `LV n` while locked. */
export function tabLabel (index: number, level: number): string {
  return tabLocked(index, level) ? `LV ${loadoutLevel(index) ?? '?'}` : String(index + 1)
}

/** Whether skill `id` is still locked for an account of `level`. */
export function skillLocked (id: number, level: number): boolean {
  const info = skillById(id)
  return info === undefined || info.unlockLevel > level
}

/**
 * Put skill `id` in `slot`. A skill already in another slot swaps with
 * whatever `slot` held. A move `checkLoadout` would refuse (a locked or
 * unknown skill, a slot out of range) changes nothing: the original comes back.
 */
export function swap (loadout: readonly number[], slot: number, id: number, level: number): number[] {
  if (!Number.isInteger(slot) || slot < 0 || slot >= LOADOUT_SIZE) return [...loadout]
  const out = [...loadout]
  const from = out.indexOf(id)
  if (from >= 0) out[from] = out[slot]
  out[slot] = id
  return checkLoadout(out, level) ?? [...loadout]
}

/** Whether `slot` can be emptied: it holds a skill, and another slot does too. */
export function canClear (loadout: readonly number[], slot: number): boolean {
  if (loadout[slot] === undefined || loadout[slot] === 0) return false
  return loadout.some((id, i) => i !== slot && id !== 0)
}

/** `slot` emptied, or the loadout unchanged when `canClear` says no. */
export function clear (loadout: readonly number[], slot: number): number[] {
  if (!canClear(loadout, slot)) return [...loadout]
  const out = [...loadout]
  out[slot] = 0
  return out
}

/** localStorage key: the loadout index READY plays, per robot (`{ [robot]: index }`). */
export const LOADOUT_KEY = 'plunderland_loadout'

/** The stored `{ [robot]: index }`; anything malformed is dropped. */
export function parseRemembered (raw: string | null): Record<string, number> {
  if (raw === null) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const out: Record<string, number> = {}
  for (const robot of Object.keys(data)) {
    const index = (data as Record<string, unknown>)[robot]
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_LOADOUTS) out[robot] = index
  }
  return out
}

/** The remembered loadout index for `robot`, or 0 when none or it is locked at `level`. */
export function rememberedIndex (remembered: Record<string, number>, robot: string, level: number): number {
  const index = remembered[robot]
  return index !== undefined && !tabLocked(index, level) ? index : 0
}

/** A `loadout_saved` answer. */
export interface SavedAnswer {
  robot: string
  index: number
  ok: boolean
  busy: boolean
  skills: number[]
}

/** `loadout_saved { robot, index, ok, skills, busy? }`, or undefined for a malformed one. */
export function parseSaved (data: unknown): SavedAnswer | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { robot, index, ok, skills, busy } = data as Record<string, unknown>
  if (typeof robot !== 'string' || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined
  const kit = helloSkills(skills)
  if (kit === undefined) return undefined
  return { robot, index, ok: ok === true, busy: busy === true, skills: kit }
}

/**
 * Apply a `loadout_saved` answer: the server's `skills` become what is shown
 * for that loadout (on a refusal or failure, what it really holds, so the
 * lobby snaps back). A `busy` answer says nothing about what is stored and
 * changes nothing; the lobby sends its newest state again.
 */
export function mergeSaved (loadouts: Loadouts | undefined, answer: SavedAnswer): Loadouts {
  if (answer.busy) return { ...(loadouts ?? {}) }
  return withLoadout(loadouts, answer.robot, answer.index, answer.skills)
}
