import { ARCHETYPE_INFO, robotUnlocked } from '../../utils/archetypes'
import {
  type Finish, type FinishGroup, PALETTE, PATTERNS, colourById, lockFinish, patternById, swatchLevel
} from '../../utils/finishes'
import { LOADOUT_SLOTS, SKILL_LIST } from '../../utils/skills'
import { PICKABLE, type RosterEntry } from './roster'

/**
 * Robot and finish locks in the lobby (decision #48 step 5), pixi-free so the
 * server's specs run it (`progress/unlocks.spec.ts`). The unlock levels are on
 * the mirrored rows (`utils/archetypes.ts`, `utils/finishes.ts`), which the
 * server's join locks with too, so what the lobby sends is what the server
 * plays; the server's lock is the backstop for a forged or stale client.
 *
 * The stored robot and finish are the player's **wish**; what is shown, drawn
 * and sent is the wish as the account's level allows it. A wish is never
 * narrowed in storage by a fallback (an outage, the account not yet
 * announced), so it comes back when the level does.
 */

/** A group's finish as one swatch: colour and pattern. */
export interface Swatch { colour: number, pattern: number }

/** A lock's badge and title. */
export const lockBadge = (level: number): string => `LV ${level}`
export const lockTitle = (level: number): string => `Unlocks at level ${level}`

/** The level a roster entry's robot opens at, or undefined if it isn't locked at `level`. */
export function robotLock (entry: RosterEntry, level: number): number | undefined {
  if (entry.robot === undefined || robotUnlocked(entry.robot, level)) return undefined
  return ARCHETYPE_INFO[entry.robot].unlockLevel ?? undefined
}

/** The pickable entries open at `level`, in roster order. Peep is always among them. */
export function unlockedEntries (level: number): RosterEntry[] {
  return PICKABLE.filter((e) => e.robot !== undefined && robotUnlocked(e.robot, level))
}

/** The robot shown for a stored wish: the wish if `level` has unlocked it, else Peep. */
export function shownRobot (wish: string | null, level: number): RosterEntry {
  return PICKABLE.find((e) => e.key === wish && e.robot !== undefined && robotUnlocked(e.robot, level)) ??
    PICKABLE.find((e) => e.robot === 'peep') as RosterEntry
}

/**
 * The robot shown after the level changes: the wish re-resolved if the player
 * hasn't picked in this lobby; else the pick, or Peep if it became locked.
 */
export function reshownRobot (picked: RosterEntry | undefined, wish: string | null, level: number): RosterEntry {
  return shownRobot(picked !== undefined ? picked.key : wish, level)
}

/**
 * What READY writes as the stored robot: the pick, when it is what is shown;
 * else nothing, and the stored wish stays (the player didn't pick here, or the
 * pick was locked again since and Peep is shown).
 */
export function robotToStore (picked: RosterEntry | undefined, shown: RosterEntry): string | undefined {
  return picked !== undefined && picked === shown ? picked.key : undefined
}

/** The unlocked entry `by` steps from `from` in roster order, wrapping; left/right and the dimmed neighbour. */
export function stepRobot (from: RosterEntry, by: number, level: number): RosterEntry {
  const open = unlockedEntries(level)
  const at = open.indexOf(from)
  if (at < 0) return open[0]
  return open[((at + by) % open.length + open.length) % open.length]
}

/** The finish shown, drawn and sent for a stored wish. */
export function shownFinish (wish: Finish, level: number): Finish {
  return lockFinish(wish, level)
}

/** The wish after painting `group` with `s`; the other groups' wishes are kept, locked or not. */
export function paintWish (wish: Finish, group: FinishGroup, s: Swatch): Finish {
  return Object.freeze({ ...wish, [group]: Object.freeze({ colour: s.colour, pattern: s.pattern }) })
}

/** MIX, a colour: the shown pattern of that group kept (never a hidden locked one). */
export function mixColour (wish: Finish, level: number, group: FinishGroup, colour: number): Finish {
  return paintWish(wish, group, { colour, pattern: shownFinish(wish, level)[group].pattern })
}

/** MIX, a pattern: the shown colour of that group kept. */
export function mixPattern (wish: Finish, level: number, group: FinishGroup, pattern: number): Finish {
  return paintWish(wish, group, { colour: shownFinish(wish, level)[group].colour, pattern })
}

/** The level a preset swatch opens at, or undefined if it is open at `level`. */
export function swatchLock (s: Swatch, level: number): number | undefined {
  const at = swatchLevel(s.colour, s.pattern)
  return at !== undefined && at > level ? at : undefined
}

/** The level a MIX colour opens at, or undefined if it is open at `level`. */
export function colourLock (id: number, level: number): number | undefined {
  const at = colourById(id)?.unlockLevel
  return at !== undefined && at > level ? at : undefined
}

/** The level a MIX pattern opens at, or undefined if it is open at `level`. */
export function patternLock (id: number, level: number): number | undefined {
  const at = patternById(id)?.unlockLevel
  return at !== undefined && at > level ? at : undefined
}

/**
 * What opened between account levels `from` (exclusive) and `to` (inclusive),
 * for the run card's level-up line: robots, skills, loadout slots, colours
 * and patterns, in that order, read from the same mirrored rows the locks
 * use. Empty when nothing opened (or `to <= from`).
 */
export function unlockedBetween (from: number, to: number): string[] {
  const opened = (level: number | null | undefined): boolean => level != null && level > from && level <= to
  const out: string[] = []
  for (const entry of PICKABLE) if (entry.robot !== undefined && opened(ARCHETYPE_INFO[entry.robot].unlockLevel)) out.push(entry.name)
  for (const skill of SKILL_LIST) if (opened(skill.unlockLevel)) out.push(skill.label.toUpperCase())
  for (const row of LOADOUT_SLOTS) if (opened(row.level)) out.push(`LOADOUT ${row.slots}`)
  for (const colour of PALETTE) if (opened(colour.unlockLevel)) out.push(colour.label)
  for (const pattern of PATTERNS) if (opened(pattern.unlockLevel)) out.push(pattern.label)
  return out
}

/** What a journey stop is named after: a robot first, then a skill or loadout slot, then a colour or pattern. */
export type JourneyKind = 'bot' | 'skill' | 'reward'

/** One level on the lobby's journey strip, and what opens at it. */
export interface JourneyStop {
  readonly level: number
  /** Undefined when nothing opens at this level. */
  readonly kind: JourneyKind | undefined
  /** The robot's key when a robot opens here (its still is the stop's icon). */
  readonly robot: string | undefined
  /** Everything that opens here, worded as the run card's level-up line. */
  readonly names: string[]
}

/** The stop for `level`, from the same mirrored rows as the locks and `unlockedBetween`. */
export function journeyStop (level: number): JourneyStop {
  const robot = PICKABLE.find((e) => e.robot !== undefined && ARCHETYPE_INFO[e.robot].unlockLevel === level)
  const skill = SKILL_LIST.some((s) => s.unlockLevel === level) || LOADOUT_SLOTS.some((r) => r.level === level)
  const reward = PALETTE.some((c) => c.unlockLevel === level) || PATTERNS.some((p) => p.unlockLevel === level)
  const kind = robot !== undefined ? 'bot' : skill ? 'skill' : reward ? 'reward' : undefined
  return { level, kind, robot: robot?.robot, names: unlockedBetween(level - 1, level) }
}

/** The last level anything opens at: where the journey strip stops scrolling. */
export function journeyEnd (): number {
  let end = 1
  for (const entry of PICKABLE) if (entry.robot !== undefined) end = Math.max(end, ARCHETYPE_INFO[entry.robot].unlockLevel ?? 1)
  for (const skill of SKILL_LIST) end = Math.max(end, skill.unlockLevel)
  for (const row of LOADOUT_SLOTS) end = Math.max(end, row.level)
  for (const colour of PALETTE) end = Math.max(end, colour.unlockLevel)
  for (const pattern of PATTERNS) end = Math.max(end, pattern.unlockLevel)
  return end
}
