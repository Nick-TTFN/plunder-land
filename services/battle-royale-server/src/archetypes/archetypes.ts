import { type Unit } from '../objects/unit'
import { type Skill } from '../skills/skill'
import { type IAIRoutine } from '../ai/airoutine'
import GuardPosition from '../ai/guardposition'
import UseSkillOnTarget from '../ai/useskillontarget'
import { Dash } from '../skills/dash'
import { MeleeAttack } from '../skills/meleeattack'
import { RangedAttack } from '../skills/rangedattack'
import { Defend } from '../skills/defend'
import { StoneWall } from '../skills/stonewall'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { IceBreath } from '../skills/icebreath'
import { FireBreath } from '../skills/firebreath'
import { ARCHETYPE_INFO, type ArchetypeInfo } from '../utils/archetypes'
import { ITEM_INFO, type ItemInfo } from '../utils/items'

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
   * It does not back away from a target that walks up to it.
   */
  standoff: number
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

export type RoutineSpec = GuardSpec | UseSkillOnTargetSpec

/** The redis `stats-<player>` hash keys a kill of this unit increments, besides `kills`. */
export type KillStat = 'mobKills' | 'bossKills'

/**
 * `id`, `key`, `kind`, `passesObstacles`, `vision` and `rangedCells` come from
 * the mirrored `utils/archetypes.ts`, which the client shares: each entry below
 * spreads its `ARCHETYPE_INFO` row first and must not set those six itself
 * (wire.spec.ts checks it). `id` is the `archetype` wire field.
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
   * was two `instanceof`s.
   */
  killStats: KillStat[]
  skills: SkillSpec[]
  routines: RoutineSpec[]
}

/**
 * The player's eight skills **in wire order**. The client sends the index of
 * the slot pressed and `Player.tryExecuteSkill` indexes straight into the
 * built list, so this order must match the client's `Player.skills` and the
 * HUD bar (CLAUDE.md, "Skills").
 *
 * **Every robot's `skills` is this constant, by reference.** No robot may list
 * its own until `skill-equip-or-unlock` decides how loadouts work; a per-robot
 * list would silently re-map the client's slots. archetypes.spec.ts enforces it.
 */
export const PLAYER_SKILLS: readonly SkillSpec[] = Object.freeze([
  { skill: Dash },
  { skill: MeleeAttack },
  { skill: RangedAttack },
  { skill: Defend },
  { skill: StoneWall },
  { skill: ThrowFireball },
  { skill: Throwicicle },
  { skill: IceBreath }
])

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
    skills: PLAYER_SKILLS as SkillSpec[],
    routines: []
  }
}

const peep: Archetype = robot(ARCHETYPE_INFO.peep)
const magnet: Archetype = robot(ARCHETYPE_INFO.magnet)

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

export const ARCHETYPES = Object.freeze({ peep, magnet, grunt, boss, gunner })

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

/** One entry of a layer's standing mob population. */
export interface LayerMobs {
  archetype: Archetype
  /** How many the world keeps alive on this layer, replacing the dead one a tick. */
  count: number
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
   * Applied to natural pickups and to the loot of every mob (grunt, gunner,
   * boss) spawned here, rounded to a whole number. Not to what a dead player
   * drops: that is their own haul.
   */
  lootMultiplier: number
  /**
   * The share of the layer's cells that are void: the valleys (`valleys.ts`),
   * carved once when the world is built. They replaced world rocks (tile art
   * pass, 2026-09-27).
   */
  voidShare: number
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
  /** Spawned in this order each tick, one of each that is short. */
  mobs: LayerMobs[]
  /**
   * Natural item pickups, topped up one of each short kind a tick. What a dead
   * player drops is on top and does not count (it expires on its own).
   */
  items: LayerItems[]
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
 * Rocks, loot cap, multiplier and mobs are #26's list. Grunts 22/18/14,
 * gunners 0/8/14, bosses 0/2/3 replace the world-wide 5 bosses and 8 gunners
 * with the rest grunts up to 50 (37 when all were up). That is 81 units where
 * there were 50: the balance pass's "76 overall" counts grunts and gunners only.
 *
 * Items are #26's provisional counts: medkits 8/10/12 and bombs 3/5/7.
 */
export const LAYERS: readonly LayerSpec[] = Object.freeze([
  {
    tag: 0,
    lootMultiplier: 1,
    voidShare: 1 / 3,
    naturalLoot: 150,
    exits: 4,
    extractMs: 5000,
    portalsUp: 0,
    portalsDown: 10,
    mobs: [
      { archetype: grunt, count: 22 },
      { archetype: gunner, count: 0 },
      { archetype: boss, count: 0 }
    ],
    items: [
      { item: ITEMS.medkit, count: 8 },
      { item: ITEMS.bomb, count: 3 }
    ]
  },
  {
    tag: -1,
    lootMultiplier: 1.75,
    voidShare: 1 / 3,
    naturalLoot: 150,
    exits: 4,
    extractMs: 7000,
    portalsUp: 5,
    portalsDown: 5,
    mobs: [
      { archetype: grunt, count: 18 },
      { archetype: gunner, count: 8 },
      { archetype: boss, count: 2 }
    ],
    items: [
      { item: ITEMS.medkit, count: 10 },
      { item: ITEMS.bomb, count: 5 }
    ]
  },
  {
    tag: -2,
    lootMultiplier: 3,
    voidShare: 1 / 3,
    naturalLoot: 150,
    exits: 4,
    extractMs: 9000,
    portalsUp: 10,
    portalsDown: 0,
    mobs: [
      { archetype: grunt, count: 14 },
      { archetype: gunner, count: 14 },
      { archetype: boss, count: 3 }
    ],
    items: [
      { item: ITEMS.medkit, count: 12 },
      { item: ITEMS.bomb, count: 7 }
    ]
  }
])

/** Build an archetype's skills for `owner`, in table order, with overrides applied. */
export function buildSkills (owner: Unit, archetype: Archetype): Skill[] {
  return archetype.skills.map((spec) => {
    const skill = new spec.skill(owner)
    if (spec.cooldownMs !== undefined) skill.cooldown = spec.cooldownMs
    if (spec.damage !== undefined) skill.damage = spec.damage
    if (spec.range !== undefined) {
      // A silently ignored range would read as a working override.
      if (typeof (skill as unknown as { range?: unknown }).range !== 'number') {
        throw new Error(`${archetype.key}: ${spec.skill.name} has no range to override`)
      }
      (skill as unknown as { range: number }).range = spec.range
    }
    return skill
  })
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
    }
    throw new Error(`${archetype.key}: unknown routine ${(spec as { kind: string }).kind}`)
  })
}
