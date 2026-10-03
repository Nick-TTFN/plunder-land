/**
 * The player skills both sides must agree on, and the loadout rule (decision
 * #48 step 4): skills unlock by account level, a player equips 4 of them on
 * Q W E R per loadout, and the server maps a pressed slot to the skill in it.
 *
 * **Mirrored in the client at the same path and the two copies must stay byte
 * identical**, like `items.ts`. `mirror.spec.ts` fails if they drift. The
 * server's skill classes and overrides (`SKILL_SPECS` in
 * `archetypes/archetypes.ts`) and the client's (`skills/catalog.ts`) are keyed
 * by `SkillKey`, so a missing or extra key is a type error on either side.
 *
 * Only what both need goes here: the wire id, the key, the label the lobby
 * prints, and the account level that unlocks it (Dez's v1,
 * `ideas/meta-progression-numbers.md` section 3, accepted as a draft by Nick
 * on 2026-10-02). A retune of an unlock level needs both deploys, client
 * first; deployed apart, the lobby shows a lock the server doesn't enforce or
 * the other way round, and the server's answer always wins.
 *
 * **Ids are append-only**, like field indices: never reuse or renumber one.
 * 0 means an empty slot. **The ids happen to be the old `Player.skills` index
 * + 1. Nothing may compute one from the other**: the slot a client presses is
 * an index into that player's 4 (`hello.skills`), never an id.
 */

export type SkillKey = 'dash' | 'melee' | 'ranged' | 'defend' | 'stoneWall' | 'fireball' | 'icicle' | 'iceBreath'

export interface SkillInfo {
  readonly id: number
  readonly key: SkillKey
  /** What the lobby prints (placeholder copy, Nick's). */
  readonly label: string
  /** The account level (not `Unit.level`) at which it may be equipped. */
  readonly unlockLevel: number
}

export const SKILL_INFO: Readonly<Record<SkillKey, SkillInfo>> = Object.freeze({
  dash: Object.freeze({ id: 1, key: 'dash', label: 'Dash', unlockLevel: 1 }),
  melee: Object.freeze({ id: 2, key: 'melee', label: 'Melee Attack', unlockLevel: 1 }),
  ranged: Object.freeze({ id: 3, key: 'ranged', label: 'Ranged Attack', unlockLevel: 1 }),
  defend: Object.freeze({ id: 4, key: 'defend', label: 'Defend', unlockLevel: 2 }),
  stoneWall: Object.freeze({ id: 5, key: 'stoneWall', label: 'Stone Wall', unlockLevel: 6 }),
  fireball: Object.freeze({ id: 6, key: 'fireball', label: 'Throw Fireball', unlockLevel: 4 }),
  icicle: Object.freeze({ id: 7, key: 'icicle', label: 'Throw Icicle', unlockLevel: 9 }),
  iceBreath: Object.freeze({ id: 8, key: 'iceBreath', label: 'Ice Breath', unlockLevel: 11 })
})

/** Every skill, in id order. */
export const SKILL_LIST: readonly SkillInfo[] = Object.freeze(
  Object.keys(SKILL_INFO).map((key) => SKILL_INFO[key as SkillKey]).sort((a, b) => a.id - b.id)
)

/** Slots in a loadout: Q W E R. */
export const LOADOUT_SIZE = 4

/**
 * Every account's loadout until it saves one, and whatever a join falls back
 * to: Q Dash, W Melee, E Ranged, R empty. Today's order of the three, so Q, W
 * and E do what they did for everyone who has played; the empty R is Dez's
 * "free 4th slot until Defend at level 2".
 */
export const START_KIT: readonly number[] = Object.freeze([1, 2, 3, 0])

/** Loadouts per robot, by account level (Dez section 3). */
export const LOADOUT_SLOTS: ReadonlyArray<{ readonly level: number, readonly slots: number }> = Object.freeze([
  Object.freeze({ level: 1, slots: 1 }),
  Object.freeze({ level: 10, slots: 2 }),
  Object.freeze({ level: 15, slots: 3 }),
  Object.freeze({ level: 20, slots: 4 })
])

/** Most loadouts a robot can ever have: the last row of `LOADOUT_SLOTS`. */
export const MAX_LOADOUTS = LOADOUT_SLOTS[LOADOUT_SLOTS.length - 1].slots

/** How many loadouts per robot an account of `level` has (at least 1). */
export function loadoutSlotsAt (level: number): number {
  let slots = LOADOUT_SLOTS[0].slots
  for (const row of LOADOUT_SLOTS) if (level >= row.level) slots = row.slots
  return slots
}

/** The level at which a robot's loadout `index` (0-based) opens, or undefined past the table. */
export function loadoutLevel (index: number): number | undefined {
  for (const row of LOADOUT_SLOTS) if (row.slots > index) return row.level
  return undefined
}

/** The entry with this wire id, or undefined for 0 and for any id this build doesn't know. */
export function skillById (id: unknown): SkillInfo | undefined {
  if (typeof id !== 'number' || id === 0) return undefined
  for (const info of SKILL_LIST) if (info.id === id) return info
  return undefined
}

/**
 * **The one loadout rule**, used by the server at every save and every join
 * and by the lobby to grey things out. A fresh copy of `skills` if it is a
 * valid loadout for an account of `level`, else undefined. Valid: an array of
 * exactly `LOADOUT_SIZE` entries; each a whole number that is 0 or a known
 * id; each known id unlocked (`unlockLevel <= level`); no id twice; at least
 * one id that isn't 0.
 */
export function checkLoadout (skills: unknown, level: number): number[] | undefined {
  if (!Array.isArray(skills) || skills.length !== LOADOUT_SIZE) return undefined
  const out: number[] = []
  let equipped = 0
  for (const id of skills) {
    if (typeof id !== 'number' || !Number.isInteger(id)) return undefined
    if (id !== 0) {
      const info = skillById(id)
      if (info === undefined || info.unlockLevel > level) return undefined
      if (out.includes(id)) return undefined
      equipped++
    }
    out.push(id)
  }
  return equipped > 0 ? out : undefined
}
