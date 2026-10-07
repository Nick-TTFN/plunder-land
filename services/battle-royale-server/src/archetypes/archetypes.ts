import { type Unit } from '../objects/unit'
import { type Skill } from '../skills/skill'
import { type IAIRoutine } from '../ai/airoutine'
import GuardPosition from '../ai/guardposition'
import UseSkillOnTarget from '../ai/useskillontarget'
import ReactorBurst, { type ReactorBurstSpec } from '../mobskills/reactorburst'
import CoilField from '../mobskills/coilfield'
import { Dash } from '../skills/dash'
import { MeleeAttack } from '../skills/meleeattack'
import { RangedAttack } from '../skills/rangedattack'
import { Defend } from '../skills/defend'
import { StoneWall } from '../skills/stonewall'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { IceBreath } from '../skills/icebreath'
import { FireBreath } from '../skills/firebreath'
import { KilnLob } from '../mobskills/kilnlob'
import { Shockwave, ShockwaveRoutine } from '../mobskills/shockwave'
import { ARCHETYPE_INFO, type ArchetypeInfo, type Rarity } from '../utils/archetypes'
import { ITEM_INFO, type ItemInfo } from '../utils/items'
import { type SkillKey, skillById, SKILL_LIST } from '../utils/skills'
import { type GearInstance, type GearRoll, type GearTier, GEAR_STAT_LIST, Q_MAX, rollCount } from '../utils/gear'

/**
 * Every kind of unit, as data (decision #23, design `ideas/unit-archetypes-design.md`).
 *
 * A unit's stats, skills and AI come from its entry here and nowhere else:
 * `Unit`'s constructor applies the stats, and `buildSkills` / `buildRoutines`
 * turn the specs into instances. Routines and skills are specs rather than
 * instances so the table can be read, tested and diffed without constructing
 * anything.
 */

export type SkillClass = new (owner: Unit) => Skill

/**
 * A skill, with per-archetype overrides of its own defaults. An override left
 * out means the skill's usual value (`World.config.*`, its level table, its
 * constructor's cooldown).
 */
export interface SkillSpec {
  skill: SkillClass
  damage?: number
  cooldownMs?: number
  /**
   * Only for a skill that has a `range` (RangedAttack, in cells since
   * decision #25); anything else throws.
   */
  range?: number
}

/**
 * A guard's ranges are **rings** (hex-cells P1, decision #32): `h` is
 * `Hex.distance` between the unit's cell and the player's, and every test
 * includes its boundary. They were world units until 2026-09-25.
 */
export interface GuardSpec {
  kind: 'guard'
  /** A player at `h <= acquire` is noticed (the nearest, ties to the lowest id). */
  acquire: number
  /**
   * The target is kept while `h <= lose` and dropped at `h > lose`. (As units
   * this was the other way round: dropped at `>= lose`.)
   */
  lose: number
  idleSpeed: number
  chaseSpeed: number
  /** An idle unit walks to the centre of a random free cell within this many rings of home. */
  wander: number
  /** How long an empty scan blocks the next one, in ms. */
  refreshMs: number
  /**
   * While chasing, a target at `h <= standoff` is not closed on: the unit
   * stops where it is. 0 = never stop, which is how grunt and boss chase.
   * It does not back away from a target that walks up to it, unless it has
   * a `retreat` band.
   */
  standoff: number
  /**
   * Keep-distance band, in rings (#51, l1-4: the Kiln). While chasing, a
   * target at `h < min` is backed away from (`Unit.stepGoal.away`) until it
   * is `min` away; at `min <= h <= max` the unit holds; beyond `max` it closes
   * to `max`. With a band, `standoff` is not read. Greedy like every mob step:
   * it may stall against valleys and walls (#45, #51 Q16). Undefined: no band,
   * the plain `standoff` chase.
   */
  retreat?: { min: number, max: number }
}

export interface UseSkillOnTargetSpec {
  kind: 'useSkillOnTarget'
  /** Index into the archetype's `skills`. */
  skill: number
  /**
   * Fire only while the target is at most this many cells away, by
   * `Hex.distance` between the two units' cells. Undefined = fire at any
   * distance (the boss), which spends the cooldown on shots that cannot land.
   */
  withinCells?: number
}

/**
 * The Compactor's slam (#51 L1, `mobskills/shockwave.ts`): cast the skill at
 * index `skill`, a `Shockwave`, at the target once it is within `withinCells`,
 * and stand still from the cast to the impact.
 */
export interface ShockwaveSpec {
  kind: 'shockwave'
  skill: number
  withinCells: number
}

/**
 * The Coil's slowing field (decision #51, task l1-3; `mobskills/coilfield.ts`).
 * Every time is ms on the `Date.now()` clock and resolves at tick (250 ms)
 * resolution. The field's size is the mirrored `attack` disc's rings
 * (`ARCHETYPE_INFO.coil.attack`), which the client draws.
 */
export interface CoilFieldSpec {
  kind: 'coilField'
  /** `maxVelocity` multiplier on a slowed player (`FieldSlow`). */
  slow: number
  /** Gather + release of the approved clip: the tell, before the field is live. */
  tellMs: number
  /** How long the field is live after the tell: players on it are slowed every tick. */
  holdMs: number
  /** The clip's cool-down after the hold. The Coil stays planted through it. */
  coolMs: number
  /** How long a slow outlasts the hold. */
  tailMs: number
  /** Start to start: no new charge sooner than this after the last began. */
  cooldownMs: number
}

export type RoutineSpec = GuardSpec | UseSkillOnTargetSpec | ReactorBurstSpec | ShockwaveSpec | CoilFieldSpec

/**
 * The redis `stats-<player>` hash keys a kill of this unit increments, besides
 * `kills`. A consumed boundary (`/stats`, `Multiplayer.getLeaderboard`): keys
 * are added, never renamed or removed.
 *
 * - `mobKills`: every mob kill.
 * - `commonKills` .. `legendaryKills` (decision #51, L1): killing blows by the
 *   mob's `rarity`, one key per rarity.
 * - `bossKills`: **frozen since L1.** Only the retired boss row credits it,
 *   and no layer spawns that any more, so it stops growing; it is kept
 *   readable, not renamed (renames are removals). The epic and legendary NPCs
 *   count under their rarity key instead.
 */
export type KillStat = 'mobKills' | 'bossKills' | 'commonKills' | 'rareKills' | 'epicKills' | 'legendaryKills'

/**
 * `id`, `key`, `kind`, `passesObstacles`, `vision`, `rangedCells`, `rarity`
 * and `attack` come from the mirrored `utils/archetypes.ts`, which the client
 * shares: each entry below spreads its `ARCHETYPE_INFO` row first and must not
 * set those itself (wire.spec.ts checks it). `id` is the `archetype` wire field.
 */
export interface Archetype extends ArchetypeInfo {
  maxHp: number
  /**
   * The armor pool (#16): `max` points that absorb damage before hp, refilled
   * at `refillPerSec` once `delayMs` has passed without a damaging hit
   * (Unit.hit, Unit.refillArmor). `max` 0 = no pool, and then the unit sends no
   * armor fields at all.
   */
  armor: { max: number, refillPerSec: number, delayMs: number }
  /**
   * `maxVelocity` at construction, u/s. For a mob it is overwritten by its
   * guard's idle or chase speed on the first update, before it ever moves, so
   * it is never walked at - but it is what the unit has until then.
   */
  speed: number
  /**
   * One multiplier on all the damage its skills deal (`Skill.dealt`;
   * robot-select, #42). Robots take it from the mirror; mobs are 1.
   */
  damageScale: number
  /**
   * How big the unit is drawn: the wire's `radius` field. An integer up to
   * 127, since it goes on the wire as one byte. No gameplay rule reads it
   * since hex-cells P1-P3 (decision #31): every rule reads cells. It was the
   * collider radius.
   */
  body: number
  /**
   * Level at spawn, for skills that index a table by `owner.level`. Undefined
   * means no level at all (the grunt): such an archetype must give every
   * level-indexed skill a `damage` override (archetypes.spec.ts checks it).
   *
   * A player's goes through `setLevel` before its create record. A mob's is
   * set **after** its create record is built, which is how the boss has always
   * done it: its create carries no level byte, and the level follows as a
   * delta. Setting it earlier would add a field to the record.
   */
  level?: number
  /**
   * Rings from the unit's cell within which it picks up loot and items. null
   * means 0, its own cell (decision #32). It was a centre-to-centre distance,
   * with null the pickup's radius plus the body.
   */
  pickupReach: number | null
  /** Loot carried at spawn. */
  loot: number
  /**
   * Damage dealt by touching a player, at most once per `cooldownMs`.
   * `rings` is how close touching is: a live player within that many rings
   * of the unit's cell (`Mob.touch`), and a chasing guard never stops
   * further off than it (`GuardPosition.chaseStop`). 1 for every mob,
   * adjacent or the same cell (decision #32, applied in hex-cells P2). It
   * was the bodies overlapping, which push-out held at exactly touching.
   */
  contact: { damage: number, cooldownMs: number, rings: number }
  /**
   * Stats keys a kill of this unit counts toward. The keys are a consumed
   * boundary (redis hashes) and keep today's names. A boss kill counts as both
   * a mob kill and a boss kill, because `Boss` extended `Mob` and the old test
   * was two `instanceof`s. An NPC counts `mobKills` and its rarity's key
   * (`npcKillStats`), never `bossKills`.
   */
  killStats: KillStat[]
  /**
   * The gear a kill of this unit rolls for (decision #51, `MOB_GEAR_ROLLS`
   * by its rarity, `mobGearRolls`); null drops none (robots, the retired
   * grunt, gunner and boss, and the Broodling). Required, so a new row has to
   * say which: a forgotten one would drop nothing and say nothing.
   */
  gearRolls: MobGearRolls | null
  skills: SkillSpec[]
  routines: RoutineSpec[]
}

/**
 * Every skill a player can equip, by its mirrored key (`utils/skills.ts`,
 * decision #48 step 4), with any overrides of its own defaults (none today).
 * By key, so a missing or extra skill is a type error. A player's skills are
 * built from its kit (`buildKit`), never from its robot's row: a robot
 * carries no skills. archetypes.spec.ts checks that every id has an entry
 * here and the same class in the client's `skills/catalog.ts`.
 */
export const SKILL_SPECS: Readonly<Record<SkillKey, SkillSpec>> = Object.freeze({
  dash: Object.freeze({ skill: Dash }),
  melee: Object.freeze({ skill: MeleeAttack }),
  ranged: Object.freeze({ skill: RangedAttack }),
  defend: Object.freeze({ skill: Defend }),
  stoneWall: Object.freeze({ skill: StoneWall }),
  fireball: Object.freeze({ skill: ThrowFireball }),
  icicle: Object.freeze({ skill: Throwicicle }),
  iceBreath: Object.freeze({ skill: IceBreath })
})

/**
 * The GuardPosition shared by grunt and boss. Rings, decision #32 (Dez's
 * `ideas/hex-ring-values.md`, accepted 2026-09-25): noticed at 4 (median 183
 * units walking straight in, against 200 before), dropped beyond 5 (median
 * 225, against 250), wander 1 ring (7 goals, against home +/- 30 units).
 */
const GUARD: GuardSpec = Object.freeze({
  kind: 'guard',
  acquire: 4,
  lose: 5,
  idleSpeed: 30,
  chaseSpeed: 100,
  wander: 1,
  refreshMs: 2000,
  standoff: 0
})

const NO_ARMOR = Object.freeze({ max: 0, refillPerSec: 0, delayMs: 0 })

/** A mirrored row's lob range (`attack`, kind `lob`). Anything else is a table error. */
function lobRangeOf (info: ArchetypeInfo): number {
  if (info.attack?.kind !== 'lob') throw new Error(`${info.key}: a lob needs attack kind 'lob' in utils/archetypes.ts`)
  return info.attack.range
}

/** A mirrored row's `rangedCells`, for a RangedAttack override. Null there is a table error. */
function rangedCellsOf (info: ArchetypeInfo): number {
  if (info.rangedCells === null) throw new Error(`${info.key}: RangedAttack needs rangedCells in utils/archetypes.ts`)
  return info.rangedCells
}

/**
 * A robot's row. What the lobby shows comes from the mirror (`stats`,
 * robot-select #42), so it is written down once; the rest every robot shares.
 */
function robot (info: ArchetypeInfo): Archetype {
  const stats = info.stats
  if (stats === null) throw new Error(`${info.key}: a robot needs stats in utils/archetypes.ts`)
  return {
    ...info,
    maxHp: stats.maxHp,
    // balance-pass §1 (#16): refilling 12/s after 4 s without damage.
    armor: Object.freeze({ max: stats.armor, refillPerSec: 12, delayMs: 4000 }),
    speed: stats.speed,
    damageScale: stats.damageScale,
    // Pinned rather than derived from HP (it was 2 * sqrt(maxHP)). Drawing
    // only since hex-cells P1-P3; it used to size pickup reach, the fireball's
    // spawn point and the ranged hit.
    body: 14,
    level: 1,
    // pickup-reach (#42): every robot takes loot and items within a ring,
    // Magnet within 3.
    pickupReach: stats.pickupReach,
    loot: 0,
    // A player touches nothing: no routine chases with it and nothing calls
    // `Mob.touch` on a player.
    contact: { damage: 0, cooldownMs: 0, rings: 0 },
    killStats: [],
    gearRolls: null,
    // A player's skills come from its kit (`buildKit`, #48 step 4), not its robot.
    skills: [],
    routines: []
  }
}

const peep: Archetype = robot(ARCHETYPE_INFO.peep)
const periscope: Archetype = robot(ARCHETYPE_INFO.periscope)
const magnet: Archetype = robot(ARCHETYPE_INFO.magnet)
const hopper: Archetype = robot(ARCHETYPE_INFO.hopper)
const waddle: Archetype = robot(ARCHETYPE_INFO.waddle)

const grunt: Archetype = {
  ...ARCHETYPE_INFO.grunt,
  damageScale: 1,
  maxHp: 50,
  armor: NO_ARMOR,
  speed: 100,
  body: 30,
  pickupReach: null,
  loot: 50,
  contact: { damage: 10, cooldownMs: 1000, rings: 1 },
  killStats: ['mobKills'],
  gearRolls: null,
  skills: [],
  routines: [GUARD]
}

const boss: Archetype = {
  ...ARCHETYPE_INFO.boss,
  damageScale: 1,
  maxHp: 300,
  armor: NO_ARMOR,
  speed: 100,
  body: 40,
  // Read by nothing the boss casts today (FireBreath takes World.config.fire);
  // kept because it is on the wire (a join snapshot carries it).
  level: 0,
  pickupReach: null,
  loot: 500,
  contact: { damage: 30, cooldownMs: 1000, rings: 1 },
  killStats: ['mobKills', 'bossKills'],
  gearRolls: null,
  skills: [{ skill: FireBreath }],
  // Guard first: it picks the target that UseSkillOnTarget breathes at.
  routines: [GUARD, { kind: 'useSkillOnTarget', skill: 0 }]
}

/**
 * Holds range and shoots (design section 1, decision #23). Deals no contact
 * damage: `Mob.onCollideWithPlayer` returns before anything when
 * `contact.damage` is 0.
 */
const gunner: Archetype = {
  ...ARCHETYPE_INFO.gunner,
  damageScale: 1,
  maxHp: 40,
  armor: NO_ARMOR,
  // Dead, like grunt and boss's 100 (the guard sets 30 or 80 before the first
  // move). Set to the chase speed, which is the pattern those two follow; the
  // design has no speed column for mobs.
  speed: 80,
  body: 24,
  pickupReach: null,
  loot: 75,
  // No damage, but `rings` still floors its chase stop (its standoff 5 is
  // what decides it).
  contact: { damage: 0, cooldownMs: 0, rings: 1 },
  killStats: ['mobKills'],
  gearRolls: null,
  // Range 6 cells, the same as `withinCells` below, so every target it fires
  // at is on its line's reach (decision #25; it was 300 units, #24). Read from
  // the mirrored row, which is also what the client draws the beam at.
  skills: [{ skill: RangedAttack, damage: 10, cooldownMs: 1500, range: rangedCellsOf(ARCHETYPE_INFO.gunner) }],
  routines: [
    // Rings, decision #32: noticed at 6 (every acquired target is inside its
    // 6-cell shot), dropped beyond 7. Was 270 / 315 units.
    Object.freeze({
      kind: 'guard',
      acquire: 6,
      lose: 7,
      idleSpeed: 30,
      chaseSpeed: 80,
      wander: 1,
      refreshMs: 2000,
      // 5 cells, so a target stepping back one cell is still inside the
      // 6-cell range (#23 Q3 counted it as 5 cells; it was 225 units).
      // Provisional: Dez retunes after a playtest.
      standoff: 5
    }),
    { kind: 'useSkillOnTarget', skill: 0, withinCells: 6 }
  ]
}

/**
 * A mirrored row's disc `attack` rings, for an NPC whose attack is a disc
 * round itself (the Reactor's burst, the Coil's field). Anything else is a
 * table error.
 */
function discRingsOf (info: ArchetypeInfo): number {
  if (info.attack?.kind !== 'disc') throw new Error(`${info.key}: needs a disc attack in utils/archetypes.ts`)
  return info.attack.rings
}

/** The stats keys a kill of an NPC of `rarity` credits: every mob kill, and its rarity's. */
export function npcKillStats (rarity: Rarity | null): KillStat[] {
  if (rarity === null) throw new Error('an NPC needs a rarity in utils/archetypes.ts')
  return ['mobKills', `${rarity}Kills`]
}

/**
 * What a kill of one mob rarity rolls (decision #51 drops, Dez's table in
 * `ideas/npc-roster.md` "Drop table by mob rarity", ACCEPTED by Nick
 * 2026-10-07). Each roll succeeds at `MOB_GEAR_CHANCE` on its own and gives
 * one item, so a kill can drop several.
 */
export interface MobGearRolls {
  /** Rolls at T1 (Common), T2 (Rare) and T3 (Epic). No T4: Legendary is merge only. */
  readonly rolls: readonly [number, number, number]
  /**
   * The tier whose rolls are always skill items (the mob's own tier, Rare and
   * up: the headline roll); null for Common, whose rolls all go by the
   * layer's `mobMix`.
   */
  readonly skillTier: GearTier | null
}

/** Every mob gear roll's chance, whatever the mob or layer (#51: flat 4%; depth pays through which mobs live there). */
export const MOB_GEAR_CHANCE = 0.04

/**
 * Rolls per mob rarity: a mob rolls once at its own tier, twice the tier
 * below, four times the one below that. The Legendary Brood's own-tier roll
 * becomes a third Epic roll (T4 is never found): 8 / 4 / 3, all 3 Epic rolls
 * skill items. Items per kill 0.04 / 0.12 / 0.28 / 0.60 (derived). The
 * Broodling is Common but drops nothing (its row sets null).
 */
export const MOB_GEAR_ROLLS: Readonly<Record<Rarity, MobGearRolls>> = Object.freeze({
  common: Object.freeze({ rolls: Object.freeze([1, 0, 0]) as readonly [number, number, number], skillTier: null }),
  rare: Object.freeze({ rolls: Object.freeze([2, 1, 0]) as readonly [number, number, number], skillTier: 2 as GearTier }),
  epic: Object.freeze({ rolls: Object.freeze([4, 2, 1]) as readonly [number, number, number], skillTier: 3 as GearTier }),
  legendary: Object.freeze({ rolls: Object.freeze([8, 4, 3]) as readonly [number, number, number], skillTier: 3 as GearTier })
})

/**
 * The gear rolls of a mob of `rarity`, the one place an NPC row reads its
 * drops from its rarity (`MOB_GEAR_ROLLS`).
 */
export function mobGearRolls (rarity: Rarity | null): MobGearRolls {
  if (rarity === null) throw new Error('an NPC needs a rarity in utils/archetypes.ts')
  return MOB_GEAR_ROLLS[rarity]
}

/**
 * **PROVISIONAL (l1-0)**: every server-only NPC number in one place, from
 * Dez's l1-0 table (`ideas/npc-numbers.md`, PROPOSED 2026-10-07, not yet
 * accepted by Nick). The client-shared ones (`rangedCells`, attack cells) are
 * `NPC_SHARED` in the mirrored `utils/archetypes.ts`. `loot` is not
 * provisional (Nick, #51 L1 plan calls, before the layer multiplier). `body`
 * is the drawn radius, sized by the roster's size column against the grunt's
 * 30 (not from l1-0).
 *
 * Each guard is `GuardSpec` (rings). Contact is 0 for every NPC but the
 * Reactor (l1-0): until l1-7 adds its attacks, Brood and Broodling chase
 * and deal no damage. The Compactor slams (l1-6). The Coil deals none by
 * design; it slows (`coilField`, l1-3). The Kiln keeps l1-0's 5-6 band
 * (`GuardSpec.retreat`) and lobs (l1-4); the Brood stands off at 5, the
 * band's low edge, until l1-7.
 */
const NPC_NUMBERS = Object.freeze({
  crawler: {
    maxHp: 35,
    body: 22,
    loot: 25,
    contact: 0,
    shot: { damage: 8, cooldownMs: 2000 },
    guard: { acquire: 5, lose: 6, chaseSpeed: 90, standoff: 4 }
  },
  compactor: { maxHp: 60, body: 30, loot: 50, contact: 0, guard: { acquire: 4, lose: 5, chaseSpeed: 100, standoff: 0 } },
  /**
   * The Compactor's Shockwave (l1-6): 35 to each player on the line (its
   * length is `NPC_SHARED.compactorLine`, mirrored), knocked back 2 cells,
   * cast within 2 rings, every 3600 ms (the strike clip), the hit 1215 ms
   * after the cast (the clip's impact frame; it lands on the tick after, 1250).
   */
  compactorShockwave: { damage: 35, cooldownMs: 3600, withinCells: 2, knockback: 2, impactMs: 1215 },
  // Band 5-6 (l1-0 Q1, not the roster's 7-9), lob 30 on a 1-ring blast
  // after 1250 ms (Q2), every 3500 ms, cast within 7 cells (the mirrored
  // `attack.range`). `standoff` is unread with a band; set to its top.
  kiln: {
    maxHp: 80,
    body: 30,
    loot: 100,
    contact: 0,
    lob: { damage: 30, cooldownMs: 3500, flightMs: 1250 },
    guard: { acquire: 7, lose: 9, chaseSpeed: 70, standoff: 6, retreat: { min: 5, max: 6 } }
  },
  // Standoff is the field's rings (l1-3, l1-0's "2 (its field)"): it hangs
  // at the edge of its own field, so whoever it chases is inside it.
  coil: { maxHp: 70, body: 32, loot: 75, contact: 0, guard: { acquire: 5, lose: 6, chaseSpeed: 90, standoff: discRingsOf(ARCHETYPE_INFO.coil) } },
  /**
   * The Coil's field (l1-3). Slow x0.6, tail 500 and cooldown 6000 (start to
   * start) are l1-0's. Tell, hold and cool are the approved clip's
   * (`codex_output/npc-refinements/coil-v4/tools/coil.mjs` `pose`, charge
   * mode: gather 0-1.2 s, release 1.2-1.5, hold 1.5-3.0, cool 3.0-3.7).
   */
  coilField: Object.freeze({ slow: 0.6, tellMs: 1500, holdMs: 1500, coolMs: 700, tailMs: 500, cooldownMs: 6000 }),
  reactor: { maxHp: 360, body: 40, loot: 500, contact: 15, guard: { acquire: 5, lose: 6, chaseSpeed: 110, standoff: 0 } },
  /**
   * The Reactor's burst (l1-5): plants within 2 rings, 25 to each player on
   * the disc at each of the release's 4 pulses (100 to one who stays),
   * cooldown 2000 ms after the settle. The disc's rings are the mirror's
   * `attack` (`NPC_SHARED.reactorBurst`). The three timings are not l1-0's:
   * they are the approved Reactor clip's (`codex_output/npc-refinements/
   * reactor-v6/rig/activate.json`, decision #51 addenda): 1 s activate, 1 s
   * release, 0.35 s settle (0.5 s on the server at 250 ms ticks).
   */
  reactorBurst: { plantRings: 2, damage: 25, pulses: 4, cooldownMs: 2000, activateMs: 1000, releaseMs: 1000, settleMs: 350 },
  brood: { maxHp: 400, body: 40, loot: 800, contact: 0, guard: { acquire: 7, lose: 9, chaseSpeed: 60, standoff: 5 } },
  // Any hit sets it off (l1-7). Drops nothing, pays nothing (#51). Idle speed:
  // l1-0 gives none (it is never idle once l1-7 spawns it); 30 like the rest.
  broodling: { maxHp: 1, body: 16, loot: 0, contact: 0, guard: { acquire: 8, lose: 10, chaseSpeed: 130, standoff: 0 } },
  /** Every NPC guard's idle speed, wander and refresh (today's). */
  idleSpeed: 30,
  wander: 1,
  refreshMs: 2000,
  /** Crawlers per pack, by share (sums to 1). */
  packSizes: Object.freeze([
    Object.freeze({ count: 2, share: 0.35 }),
    Object.freeze({ count: 3, share: 0.40 }),
    Object.freeze({ count: 4, share: 0.25 })
  ]),
  /** Per layer, top first: packs, Coil escort share, and the single NPCs. */
  layers: Object.freeze([
    { packs: 5, escortShare: 0, compactor: 8, kiln: 0, reactor: 0, brood: 0 },
    { packs: 5, escortShare: 0.6, compactor: 7, kiln: 4, reactor: 2, brood: 0 },
    { packs: 5, escortShare: 1, compactor: 4, kiln: 6, reactor: 2, brood: 1 }
  ])
})

type NpcNumbers = typeof NPC_NUMBERS.compactor & { guard: { retreat?: { min: number, max: number } } }

/**
 * An NPC row from its numbers: a guard and contact only. What Coil, Brood and
 * Broodling are until their own attacks land (l1-3, l1-7); the Crawler adds
 * its shot, the Compactor its slam (l1-6), the Kiln its lob (l1-4) and the
 * Reactor its burst (l1-5).
 */
function npc (info: ArchetypeInfo, n: NpcNumbers): Archetype {
  const guard: GuardSpec = Object.freeze({
    kind: 'guard',
    ...n.guard,
    idleSpeed: NPC_NUMBERS.idleSpeed,
    wander: NPC_NUMBERS.wander,
    refreshMs: NPC_NUMBERS.refreshMs
  })
  return {
    ...info,
    damageScale: 1,
    maxHp: n.maxHp,
    armor: NO_ARMOR,
    // Overwritten by the guard before the first move, as the grunt's is.
    speed: n.guard.chaseSpeed,
    body: n.body,
    pickupReach: null,
    loot: n.loot,
    // `rings` also floors the chase stop, as the gunner's does with no damage.
    contact: { damage: n.contact, cooldownMs: n.contact > 0 ? 1000 : 0, rings: 1 },
    killStats: npcKillStats(info.rarity),
    gearRolls: mobGearRolls(info.rarity),
    skills: [],
    routines: [guard]
  }
}

/** Ranged fodder in packs, the gunner's pattern (#51): holds at its standoff and shoots. */
const crawlerBase = npc(ARCHETYPE_INFO.crawler, NPC_NUMBERS.crawler)
const crawler: Archetype = {
  ...crawlerBase,
  skills: [{ skill: RangedAttack, ...NPC_NUMBERS.crawler.shot, range: rangedCellsOf(ARCHETYPE_INFO.crawler) }],
  // Guard first: it picks the target the shot fires at.
  routines: [
    ...crawlerBase.routines,
    { kind: 'useSkillOnTarget', skill: 0, withinCells: rangedCellsOf(ARCHETYPE_INFO.crawler) }
  ]
}
/** The Compactor's Shockwave with its numbers: a `SkillClass` is built from its owner alone. */
class CompactorsShockwave extends Shockwave {
  constructor (owner: Unit) {
    super(owner, NPC_NUMBERS.compactorShockwave)
  }
}

/**
 * Melee chaser (#51, the grunt's role): no contact damage; it slams a line
 * of cells toward its target, hurting and knocking back players (l1-6).
 */
const compactorBase = npc(ARCHETYPE_INFO.compactor, NPC_NUMBERS.compactor)
const compactor: Archetype = {
  ...compactorBase,
  skills: [{ skill: CompactorsShockwave }],
  // Guard first: it picks the target, and the slam's hold overrides its step goal.
  routines: [
    ...compactorBase.routines,
    { kind: 'shockwave', skill: 0, withinCells: NPC_NUMBERS.compactorShockwave.withinCells }
  ]
}
/** The Kiln's lob with its numbers: a `SkillClass` is built from its owner alone. */
class KilnsLob extends KilnLob {
  constructor (owner: Unit) {
    super(owner, NPC_NUMBERS.kiln.lob)
  }
}

/**
 * Artillery (#51, l1-4): keeps 5-6 cells off its target and lobs at its cell
 * within the lob's range (`mobskills/kilnlob.ts`).
 */
const kilnBase = npc(ARCHETYPE_INFO.kiln, NPC_NUMBERS.kiln)
const kiln: Archetype = {
  ...kilnBase,
  skills: [{ skill: KilnsLob }],
  // Guard first: it picks the target the lob is aimed at.
  routines: [
    ...kilnBase.routines,
    { kind: 'useSkillOnTarget', skill: 0, withinCells: lobRangeOf(ARCHETYPE_INFO.kiln) }
  ]
}

/** Charges in, plants, bursts (l1-5, `mobskills/reactorburst.ts`). Guard first: it picks the target and chases. */
const reactorBase = npc(ARCHETYPE_INFO.reactor, NPC_NUMBERS.reactor)
const reactor: Archetype = {
  ...reactorBase,
  routines: [
    ...reactorBase.routines,
    Object.freeze({ kind: 'reactorBurst', ...NPC_NUMBERS.reactorBurst, rings: discRingsOf(ARCHETYPE_INFO.reactor) })
  ]
}
/**
 * A Crawler pack's escort (#51; spawned only as one, `LayerPack.escort`): it
 * shares the pack's home and aggro (`MobPack`), chases to its field's edge
 * and slows every player on its field (`CoilField`, l1-3). No damage.
 */
const coilBase = npc(ARCHETYPE_INFO.coil, NPC_NUMBERS.coil)
const coil: Archetype = {
  ...coilBase,
  // Guard first: it picks the target whose distance starts a charge, and the
  // field then pins the Coil by clearing the step goal the guard just set.
  routines: [...coilBase.routines, Object.freeze({ kind: 'coilField' as const, ...NPC_NUMBERS.coilField })]
}
const brood: Archetype = npc(ARCHETYPE_INFO.brood, NPC_NUMBERS.brood)
// Common, but drops no gear (#51, Nick 2026-10-07): an endless stream, so the
// Brood's own rolls are the reward for killing the source.
const broodling: Archetype = { ...npc(ARCHETYPE_INFO.broodling, NPC_NUMBERS.broodling), gearRolls: null }

/**
 * A layer's mob entries from `NPC_NUMBERS.layers[i]`: the Crawler packs (with
 * a Coil escort where the share is above 0), then each single NPC with a
 * count above 0.
 */
function npcPopulation (i: number): LayerMobs[] {
  const p = NPC_NUMBERS.layers[i]
  const entries: LayerMobs[] = [
    p.escortShare > 0
      ? { pack: crawler, sizes: NPC_NUMBERS.packSizes, escort: coil, escortShare: p.escortShare, count: p.packs }
      : { pack: crawler, sizes: NPC_NUMBERS.packSizes, escortShare: 0, count: p.packs }
  ]
  for (const [archetype, count] of [[compactor, p.compactor], [kiln, p.kiln], [reactor, p.reactor], [brood, p.brood]] as const) {
    if (count > 0) entries.push({ archetype, count })
  }
  return entries
}

export const ARCHETYPES = Object.freeze({
  peep,
  periscope,
  magnet,
  hopper,
  waddle,
  grunt,
  boss,
  gunner,
  crawler,
  kiln,
  reactor,
  coil,
  compactor,
  brood,
  broodling
})

/**
 * What using an item does. **One case per behaviour, not per item**: a new item
 * that heals or blasts is a new row in `ITEMS` with its own numbers, and only a
 * new kind of behaviour needs code (`src/items/use.ts`).
 */
export type ItemUse =
  /** `amount` hp over `durationMs`, applied each tick in `Player.update`; ends on death. */
  | { kind: 'heal', amount: number, durationMs: number }
  /**
   * Thrown to a cell (the `aimRange` and `rings` of its `ItemInfo`); after
   * `fuseMs` every unit on the disc takes `damage`, the thrower included, and
   * every StoneWall stone on it is destroyed (`src/items/bomb.ts`).
   */
  | { kind: 'bomb', damage: number, fuseMs: number }

/**
 * A usable item (decision #12). `id`, `key`, `slot`, `label`, `aimRange` and
 * `rings` come from the mirrored `utils/items.ts`, spread first, like an
 * archetype's `ARCHETYPE_INFO` row.
 */
export interface Item extends ItemInfo {
  /** Most a player can carry. A pickup that would go over is left on the ground. */
  maxStack: number
  use: ItemUse
}

/**
 * Every usable item, as data. Values are the balance pass section 1 "Items"
 * (decision #16). Neither item has a cooldown there, so there is no cooldown
 * field: a medkit can't be used while one is healing, which is the only limit
 * the spec implies. Add one as a field here when an item needs it.
 */
export const ITEMS: Readonly<Record<ItemInfo['key'], Item>> = Object.freeze({
  // +40 HP over 2 s, which is 5 a tick at 250 ms. Max stack 3.
  medkit: Object.freeze({
    ...ITEM_INFO.medkit,
    maxStack: 3,
    use: Object.freeze({ kind: 'heal', amount: 40, durationMs: 2000 })
  }),
  // 60, no falloff, everyone on the disc including the thrower (N3). A 1500 ms
  // fuse telegraphed on the cells. Breaks StoneWall stones. Max stack 2.
  bomb: Object.freeze({
    ...ITEM_INFO.bomb,
    maxStack: 2,
    use: Object.freeze({ kind: 'bomb', damage: 60, fuseMs: 1500 })
  })
}) as Readonly<Record<ItemInfo['key'], Item>>

/** One entry of a layer's standing item population. */
export interface LayerItems {
  item: Item
  /** Natural pickups of this kind kept on the layer, replacing a taken one a tick. */
  count: number
}

/** A single-mob entry of a layer's standing population. */
export interface LayerSingle {
  archetype: Archetype
  /** How many the world keeps alive on this layer, replacing a dead one a tick. */
  count: number
}

/**
 * A pack entry (decision #51, L1): `count` packs of `pack`, each of a size
 * drawn from `sizes`, spawned together on one free cell and its free
 * neighbours, sharing one home and one aggro (`Mob.pack`,
 * `GuardPosition.provoke`). With `escort`, a share `escortShare` of the packs
 * also gets one escort mob (a Coil, -1/-2 only, Q8), which is a member like the
 * rest. A pack counts as alive while any member lives, and is replaced (at most
 * one a tick) only once all are dead (Q11).
 */
export interface LayerPack {
  pack: Archetype
  /** How many of `pack` a spawn holds, by share (the shares sum to 1). */
  sizes: ReadonlyArray<{ readonly count: number, readonly share: number }>
  escort?: Archetype
  escortShare: number
  count: number
}

/** One entry of a layer's standing mob population: one archetype, or a pack. */
export type LayerMobs = LayerSingle | LayerPack

/** True for a pack entry. */
export function isPackEntry (entry: LayerMobs): entry is LayerPack {
  return 'pack' in entry
}

/** Shares of a gear pickup by kind and tier; each set sums to 1. */
export interface GearMix { part: number, t1: number, t2: number }

/**
 * A layer's gear drops (decision #49, spec `ideas/skill-items-and-stash.md`
 * section 3; all judgement, Dez). Read by 49-2 (caches and mob drops) and
 * 49-5. What a kill rolls is the mob's (`Archetype.gearRolls`, by rarity,
 * #51); the layer only decides part or skill item (`mobMix`). T4 is never
 * found, only merged; caches give T2 at most.
 */
export interface GearDrops {
  /** Natural caches standing on the layer. */
  caches: number
  /** How long after a cache is taken another one appears, in ms. */
  cacheRespawnMs: number
  /** What a cache holds: a part, a T1 skill item or a T2 skill item. */
  cacheMix: GearMix
  /**
   * A mob's item, part or skill item, for every roll but the mob's own-tier
   * roll on Rare and higher (`MobGearRolls.skillTier`), which is always a
   * skill item.
   */
  mobMix: { part: number, skill: number }
}

/**
 * A ground layer and everything the world keeps on it (decisions #3, #10, #16,
 * #26; numbers from `ideas/balance-pass.md` section 1).
 */
export interface LayerSpec {
  /**
   * The `tag` of everything on this layer. A signed byte on the wire. Clients
   * get the list in `hello.layers`, in `LAYERS` order, and must not hardcode it.
   */
  tag: number
  /**
   * Applied to natural pickups and to the loot of every mob spawned here, rounded to a whole number. Not to what a dead player
   * drops: that is their own haul.
   */
  lootMultiplier: number
  /**
   * The share of the layer's cells that are void: the valleys (`valleys.ts`),
   * carved once when the world is built. They replaced world rocks (tile art
   * pass, 2026-09-27).
   */
  voidShare: number
  /**
   * The share of the free ground (what the valleys leave) walled off in short
   * raised runs (`walls.ts`, decision #44): cover that blocks every robot but
   * Hopper, and every shot. Provisional, 2026-10-01.
   */
  wallShare: number
  /** Natural pickups only. Death drops are uncapped and expire on their own. */
  naturalLoot: number
  exits: number
  /**
   * How long a player must stay on one of this layer's exits to extract, in
   * ms (#16, #26: 5 / 7 / 9 s). Leaving the pad or taking damage starts it
   * over (`Player.channelExtract`).
   */
  extractMs: number
  /** Portals to the layer above. 0 on the top layer. */
  portalsUp: number
  /** Portals to the layer below. 0 on the bottom layer. */
  portalsDown: number
  /** Spawned in this order each tick: at most one mob, or one pack, per entry that is short. */
  mobs: LayerMobs[]
  /**
   * Natural item pickups, topped up one of each short kind a tick. What a dead
   * player drops is on top and does not count (it expires on its own).
   */
  items: LayerItems[]
  /** Gear caches and drops (decision #49). */
  gear: GearDrops
}

/**
 * **Every per-layer number is here and nowhere else**, top layer (01) first.
 *
 * Tags 0, -1, -2: depth is `-tag`, so the two tags the world already used keep
 * their order (0 was drawn above -1) and 1, which old clients drew as an
 * airborne plane, is never reused.
 *
 * Portals and exits keep today's density: 10 portals and 4 exits per layer, as
 * the two-layer world had (20 and 8). Layer 02 splits its 10 evenly between up
 * and down; every layer keeps its exits (#10).
 *
 * Rocks, loot cap and multiplier are #26's list. The mobs are the NPC roster
 * (decision #51, L1), counts **PROVISIONAL (l1-0)** in `NPC_NUMBERS.layers`:
 * layer 0 holds Crawler packs and Compactors only; Kiln and Reactor -1/-2;
 * the Brood -2 only; Coils only as pack escorts on -1/-2; Broodlings never
 * (the Brood releases them, l1-7). Grunt, gunner and boss are spawned by no
 * layer.
 *
 * Items are #26's provisional counts: medkits 8/10/12 and bombs 3/5/7.
 */
export const LAYERS: readonly LayerSpec[] = Object.freeze([
  {
    tag: 0,
    lootMultiplier: 1,
    voidShare: 1 / 3,
    wallShare: 0.06,
    naturalLoot: 150,
    exits: 4,
    extractMs: 5000,
    portalsUp: 0,
    portalsDown: 10,
    mobs: npcPopulation(0),
    items: [
      { item: ITEMS.medkit, count: 8 },
      { item: ITEMS.bomb, count: 3 }
    ],
    gear: {
      caches: 1,
      cacheRespawnMs: 180000,
      cacheMix: { part: 0.75, t1: 0.22, t2: 0.03 },
      mobMix: { part: 0.8, skill: 0.2 }
    }
  },
  {
    tag: -1,
    lootMultiplier: 1.75,
    voidShare: 1 / 3,
    wallShare: 0.06,
    naturalLoot: 150,
    exits: 4,
    extractMs: 7000,
    portalsUp: 5,
    portalsDown: 5,
    mobs: npcPopulation(1),
    items: [
      { item: ITEMS.medkit, count: 10 },
      { item: ITEMS.bomb, count: 5 }
    ],
    gear: {
      caches: 1,
      cacheRespawnMs: 120000,
      cacheMix: { part: 0.65, t1: 0.28, t2: 0.07 },
      mobMix: { part: 0.75, skill: 0.25 }
    }
  },
  {
    tag: -2,
    lootMultiplier: 3,
    voidShare: 1 / 3,
    wallShare: 0.06,
    naturalLoot: 150,
    exits: 4,
    extractMs: 9000,
    portalsUp: 10,
    portalsDown: 0,
    mobs: npcPopulation(2),
    items: [
      { item: ITEMS.medkit, count: 12 },
      { item: ITEMS.bomb, count: 7 }
    ],
    gear: {
      caches: 2,
      cacheRespawnMs: 90000,
      cacheMix: { part: 0.55, t1: 0.33, t2: 0.12 },
      mobMix: { part: 0.7, skill: 0.3 }
    }
  }
])

/** Build an archetype's skills for `owner`, in table order, with overrides applied. */
export function buildSkills (owner: Unit, archetype: Archetype): Skill[] {
  return archetype.skills.map((spec) => buildSkill(owner, spec, archetype.key))
}

/**
 * A player's skills from its kit (decision #48 step 4): slot i is the skill
 * whose mirrored id is `kit[i]`, or null for 0, with `SKILL_SPECS`'
 * overrides applied as `buildSkills` applies an archetype's. The kit was
 * checked before it got here (`progress/loadouts.ts` `kitFor`, or a bot's
 * fixed kit); an unknown id is a programming error and throws.
 */
export function buildKit (owner: Unit, kit: readonly number[]): Array<Skill | null> {
  return kit.map((id) => {
    if (id === 0) return null
    const info = skillById(id)
    if (info === undefined) throw new Error(`no skill with id ${id}`)
    return buildSkill(owner, SKILL_SPECS[info.key], info.key)
  })
}

/**
 * One player skill by its mirrored id, with `SKILL_SPECS`' overrides, as
 * `buildKit` builds each slot: a gear item's own skill (`Player.equipGear`).
 * An unknown id throws.
 */
export function buildSkillById (owner: Unit, id: number): Skill {
  const info = skillById(id)
  if (info === undefined) throw new Error(`no skill with id ${id}`)
  return buildSkill(owner, SKILL_SPECS[info.key], info.key)
}

/**
 * A fresh gear instance (decision #49, spec section 1), pure but for
 * `random` (0 <= r < 1, e.g. `Math.random`). A part has skill 0 and no
 * rolls. A skill item's skill is uniform over every `SKILL_LIST` id (level
 * locks don't apply: a found skill above your level is a tease, spec Q3); it
 * has `rollCount(tier)` rolls on different stats, drawn without repeats from
 * those rollable at the tier (so reach only at T3), each with q uniform over
 * the integers 0..1000. Used by 49-2 (drops) and 49-5 (merge).
 */
export function rollGear (tier: GearTier, kind: 'part' | 'skill', random: () => number): GearInstance {
  if (kind === 'part') return Object.freeze({ tier, skill: 0, rolls: Object.freeze([]) })
  const pick = (n: number): number => Math.min(n - 1, Math.floor(random() * n))
  const skill = SKILL_LIST[pick(SKILL_LIST.length)].id
  const pool = GEAR_STAT_LIST.filter((stat) => stat.ranges[tier - 1] !== null).map((stat) => stat.id)
  const rolls: GearRoll[] = []
  const count = Math.min(rollCount(tier), pool.length)
  for (let i = 0; i < count; i++) {
    const stat = pool.splice(pick(pool.length), 1)[0]
    rolls.push(Object.freeze({ stat, q: pick(Q_MAX + 1) }))
  }
  return Object.freeze({ tier, skill, rolls: Object.freeze(rolls) })
}

function buildSkill (owner: Unit, spec: SkillSpec, label: string): Skill {
  const skill = new spec.skill(owner)
  if (spec.cooldownMs !== undefined) skill.cooldown = spec.cooldownMs
  if (spec.damage !== undefined) skill.damage = spec.damage
  if (spec.range !== undefined) {
    // A silently ignored range would read as a working override.
    if (typeof (skill as unknown as { range?: unknown }).range !== 'number') {
      throw new Error(`${label}: ${spec.skill.name} has no range to override`)
    }
    (skill as unknown as { range: number }).range = spec.range
  }
  return skill
}

/** Build an archetype's AI routines for `owner`. `skills` is what `buildSkills` returned. */
export function buildRoutines (owner: Unit, archetype: Archetype, skills: Skill[]): IAIRoutine[] {
  return archetype.routines.map((spec) => {
    switch (spec.kind) {
      case 'guard':
        return new GuardPosition(owner, spec, archetype.contact.rings)
      case 'useSkillOnTarget': {
        const skill = skills[spec.skill]
        if (skill === undefined) throw new Error(`${archetype.key}: no skill at index ${spec.skill}`)
        return new UseSkillOnTarget(owner, skill, spec.withinCells)
      }
      case 'reactorBurst':
        return new ReactorBurst(owner, spec)
      case 'shockwave': {
        const skill = skills[spec.skill]
        if (!(skill instanceof Shockwave)) throw new Error(`${archetype.key}: no Shockwave at index ${spec.skill}`)
        return new ShockwaveRoutine(owner, skill, spec.withinCells)
      }
      case 'coilField':
        return new CoilField(owner, spec, discRingsOf(archetype))
    }
    throw new Error(`${archetype.key}: unknown routine ${(spec as { kind: string }).kind}`)
  })
}
