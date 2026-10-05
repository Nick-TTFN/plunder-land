import { skillById } from './skills'

/**
 * Gear (decision #49, `ideas/skill-items-and-stash.md`): skill items and
 * parts. A skill item grants one of the existing skills on key 3 or 4 plus 1-2
 * small stat rolls; a part has no skill and no rolls and exists to be merged.
 *
 * **Mirrored in the client at the same path and the two copies must stay byte
 * identical**, like `skills.ts`. `mirror.spec.ts` fails if they drift.
 *
 * **Deviation from the spec's split, on purpose (49-1):** the spec put the
 * roll ranges in the server half. They are here because the client must print
 * an item's values and compute its skill's cooldown. A range retune therefore
 * needs both deploys, client first, like `unlockLevel`. The drop tables stay
 * on the server (`LAYERS[].gear` in `archetypes/archetypes.ts`).
 *
 * **Stat ids are append-only**, like field indices: never reuse or renumber
 * one. They are stored in the stash and sent on the wire.
 *
 * An instance stores roll **qualities**, never values: `rollValue` reads the
 * value from the table at use, so a retune moves every stashed item, as the
 * XP curve re-levels everyone.
 */

/** Item slots a player equips: keys 3 and 4, which are inventory slots 2 and 3. */
export const GEAR_SLOTS = 2
/** The 0-based inventory slot of gear slot 0 (key 3). Gear slot i is inventory slot `GEAR_FIRST_SLOT + i`. */
export const GEAR_FIRST_SLOT = 2
/** Items carried in a run but not usable (found with no free slot): kept on extraction, dropped on death. */
export const GEAR_BAG = 4
/**
 * The stash size the lobby shows (spec section 4). Above it the stash shows
 * the overflow and asks the player to merge or scrap; extraction never loses
 * an item (Nick 2026-10-05, #49).
 */
export const STASH_SOFT = 12
/**
 * A storage ceiling nobody should reach, not a design cap: it only bounds
 * database rows (Nick 2026-10-05, #49).
 */
export const STASH_MAX = 100
/** The account level from which stashed gear may be brought into a run (spec Q4). */
export const BRING_LEVEL = 3
/** Tiers 1 to 3. T3 is never found, only merged. */
export const GEAR_TIERS = 3
/** Quality is an integer 0..`Q_MAX` everywhere (DB, JSON, binary), never a float. */
export const Q_MAX = 1000

export type GearTier = 1 | 2 | 3

/** One stat roll: a stat id and its quality, an integer 0..1000. */
export interface GearRoll {
  readonly stat: number
  readonly q: number
}

/**
 * One item. `skill` is a `utils/skills.ts` id, 0 for a part. A part has no
 * rolls; tier 1 has 1 roll, tiers 2 and 3 have 2, on different stats.
 * `rowId` is the stash row it came from (lineage): server only, never on the
 * wire, never encoded by `encodeGear`.
 */
export interface GearInstance {
  readonly tier: GearTier
  readonly skill: number
  readonly rolls: readonly GearRoll[]
  readonly rowId?: string
}

export type GearStatKey = 'hp' | 'armor' | 'speed' | 'damage' | 'reach' | 'cooldown'

/** A roll's range at one tier, `[min, max]`; null where the stat can't roll at that tier. */
export type GearRange = readonly [number, number] | null

export interface GearStat {
  readonly id: number
  readonly key: GearStatKey
  /** What the lobby and the HUD print (placeholder copy). */
  readonly label: string
  /** Per tier, T1 first. */
  readonly ranges: readonly [GearRange, GearRange, GearRange]
  /**
   * Most the bonus can be, summed over both slots; null = no cap (the
   * cooldown roll, which applies only to its own item's skill and never sums).
   */
  readonly cap: number | null
}

/**
 * Spec section 1's table (judgement values, Dez; accepted by Nick 2026-10-04).
 * - hp, armor, speed: percent of the robot's own base.
 * - damage: added to the robot's `damageScale` (through `Skill.dealt`).
 * - reach: rings added to pickup reach; the effective reach is capped at 2,
 *   and a robot whose base is already 2 or more (Magnet's 3) is untouched
 *   (`effectiveReach`).
 * - cooldown: percent off **this item's own skill**, never global.
 */
export const GEAR_STATS: Readonly<Record<GearStatKey, GearStat>> = Object.freeze({
  hp: Object.freeze({ id: 1, key: 'hp', label: 'Max HP %', ranges: Object.freeze([Object.freeze([4, 8]), Object.freeze([6, 12]), Object.freeze([10, 15])]), cap: 20 }),
  armor: Object.freeze({ id: 2, key: 'armor', label: 'Max armor %', ranges: Object.freeze([Object.freeze([8, 15]), Object.freeze([12, 25]), Object.freeze([20, 30])]), cap: 40 }),
  speed: Object.freeze({ id: 3, key: 'speed', label: 'Speed %', ranges: Object.freeze([Object.freeze([2, 4]), Object.freeze([3, 5]), Object.freeze([4, 6])]), cap: 7 }),
  damage: Object.freeze({ id: 4, key: 'damage', label: 'Damage', ranges: Object.freeze([Object.freeze([0.03, 0.05]), Object.freeze([0.04, 0.07]), Object.freeze([0.06, 0.10])]), cap: 0.12 }),
  reach: Object.freeze({ id: 5, key: 'reach', label: 'Pickup reach', ranges: Object.freeze([null, null, Object.freeze([1, 1])]), cap: 2 }),
  cooldown: Object.freeze({ id: 6, key: 'cooldown', label: 'Cooldown % (own skill)', ranges: Object.freeze([Object.freeze([5, 10]), Object.freeze([8, 15]), Object.freeze([12, 20])]), cap: null })
} as Record<GearStatKey, GearStat>)

/** Every stat, in id order. */
export const GEAR_STAT_LIST: readonly GearStat[] = Object.freeze(
  Object.keys(GEAR_STATS).map((key) => GEAR_STATS[key as GearStatKey]).sort((a, b) => a.id - b.id)
)

/** The stat with this id, or undefined for any id this build doesn't know. */
export function gearStatById (id: unknown): GearStat | undefined {
  if (typeof id !== 'number') return undefined
  for (const stat of GEAR_STAT_LIST) if (stat.id === id) return stat
  return undefined
}

/** Rolls on a skill item of `tier`: 1 at T1, 2 at T2 and T3. A part has none. */
export function rollCount (tier: number): number {
  return tier <= 1 ? 1 : 2
}

/**
 * A roll's value: `min + q / 1000 * (max - min)` from the stat's range at
 * `tier`. 0 for an unknown stat, a stat that can't roll at that tier, or a
 * tier outside 1-3. `q` is clamped to 0..1000.
 */
export function rollValue (stat: number, tier: number, q: number): number {
  const range = gearStatById(stat)?.ranges[tier - 1]
  if (range === undefined || range === null) return 0
  const quality = Math.max(0, Math.min(Q_MAX, q))
  // The ends exactly, so a max roll prints the table's number (0.06 + 0.04 is
  // not 0.1 in floating point).
  if (quality === Q_MAX) return range[1]
  return range[0] + quality / Q_MAX * (range[1] - range[0])
}

/** What equipped gear adds, summed over the slots and capped. Cooldown is not here: see `itemCooldownMs`. */
export interface GearEffect {
  /** Percent of the robot's base max HP. */
  readonly hpPct: number
  /** Percent of the robot's base max armor. */
  readonly armorPct: number
  /** Percent of the robot's base speed. */
  readonly speedPct: number
  /** Added to the robot's `damageScale`. */
  readonly damageScale: number
  /** Rings added to pickup reach, before `effectiveReach`'s cap. */
  readonly reach: number
}

export const NO_GEAR_EFFECT: GearEffect = Object.freeze({ hpPct: 0, armorPct: 0, speedPct: 0, damageScale: 0, reach: 0 })

/**
 * The summed, capped bonuses of the equipped `slots` (null or undefined =
 * empty). Parts give nothing; unknown stats are skipped; the cooldown roll
 * belongs to its own item's skill and is not summed.
 */
export function gearEffect (slots: ReadonlyArray<GearInstance | null | undefined>): GearEffect {
  const sum: Record<GearStatKey, number> = { hp: 0, armor: 0, speed: 0, damage: 0, reach: 0, cooldown: 0 }
  for (const item of slots) {
    if (item === null || item === undefined || item.skill === 0) continue
    for (const roll of item.rolls) {
      const stat = gearStatById(roll.stat)
      if (stat === undefined) continue
      sum[stat.key] += rollValue(roll.stat, item.tier, roll.q)
    }
  }
  const capped = (key: GearStatKey): number => {
    const cap = GEAR_STATS[key].cap
    return cap === null ? sum[key] : Math.min(cap, sum[key])
  }
  return Object.freeze({
    hpPct: capped('hp'),
    armorPct: capped('armor'),
    speedPct: capped('speed'),
    damageScale: capped('damage'),
    reach: capped('reach')
  })
}

/**
 * Pickup reach with gear: a robot whose base reach is 2 or more keeps it
 * (Magnet's 3 untouched); anyone else gets base + bonus, at most 2.
 */
export function effectiveReach (base: number, bonus: number): number {
  return base >= 2 ? base : Math.min(2, base + bonus)
}

/** Percent off its own skill's cooldown that an item rolled (0 for none, or a part). */
export function cooldownCut (item: GearInstance): number {
  if (item.skill === 0) return 0
  let cut = 0
  for (const roll of item.rolls) {
    if (roll.stat === GEAR_STATS.cooldown.id) cut += rollValue(roll.stat, item.tier, roll.q)
  }
  return cut
}

/**
 * Whether a **duplicate** item's cooldown roll shortens the shared skill's
 * cooldown. A duplicate is an item whose skill is already in the kit or in
 * the other gear slot: either key fires the same skill instance and shares
 * its cooldown (spec Q7). **False: it does not** (Nick 2026-10-05, #49 build
 * plan answer 1; the stingy baseline). Its other stats still count. Flipping
 * this is the whole change.
 */
export const DUPLICATE_CUTS_COOLDOWN = false

/**
 * The cooldown an item's skill runs at: `baseMs` less the item's own
 * cooldown roll, unless the item is a duplicate (`DUPLICATE_CUTS_COOLDOWN`),
 * in which case the shared skill keeps the cooldown it has. The client's card
 * shows the same number.
 */
export function itemCooldownMs (baseMs: number, item: GearInstance, duplicate: boolean): number {
  if (duplicate && !DUPLICATE_CUTS_COOLDOWN) return baseMs
  return baseMs * (1 - cooldownCut(item) / 100)
}

/**
 * One instance as bytes (the payload 49-2 puts inside fields 25 and 26):
 * `[uint8 tier][uint8 skill][uint8 rollCount]` then per roll
 * `[uint8 stat][uint16 q big-endian]`. `rowId` is never written.
 */
export function encodeGear (item: GearInstance): Uint8Array {
  const out = new Uint8Array(3 + 3 * item.rolls.length)
  out[0] = item.tier
  out[1] = item.skill
  out[2] = item.rolls.length
  let at = 3
  for (const roll of item.rolls) {
    const q = Math.max(0, Math.min(Q_MAX, Math.round(roll.q)))
    out[at] = roll.stat
    out[at + 1] = q >> 8
    out[at + 2] = q & 0xff
    at += 3
  }
  return out
}

/**
 * `encodeGear` read back, from `offset`. Bytes after the rolls are ignored
 * (a later version may append), and so are rolls of a stat id this build
 * doesn't know. Undefined if the buffer is too short for what it declares,
 * the tier is outside 1-3, or the skill is neither 0 nor an id this build
 * knows (an item-only skill from a newer server, spec Q14: an older reader
 * can't show or cast it). q is clamped to 0..1000.
 */
export function decodeGear (bytes: Uint8Array, offset: number = 0): GearInstance | undefined {
  if (bytes.length < offset + 3) return undefined
  const tier = bytes[offset]
  const skill = bytes[offset + 1]
  const count = bytes[offset + 2]
  if (tier < 1 || tier > GEAR_TIERS) return undefined
  if (skill !== 0 && skillById(skill) === undefined) return undefined
  if (bytes.length < offset + 3 + 3 * count) return undefined
  const rolls: GearRoll[] = []
  for (let i = 0; i < count; i++) {
    const at = offset + 3 + 3 * i
    const stat = bytes[at]
    if (gearStatById(stat) === undefined) continue
    rolls.push(Object.freeze({ stat, q: Math.min(Q_MAX, (bytes[at + 1] << 8) | bytes[at + 2]) }))
  }
  return Object.freeze({ tier: tier as GearTier, skill, rolls: Object.freeze(rolls) })
}
