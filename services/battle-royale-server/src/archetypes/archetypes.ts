import { type Unit } from '../objects/unit'
import { type Skill } from '../skills/skill'
import { type IAIRoutine } from '../ai/findnearestconsumable'
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

export interface GuardSpec {
  kind: 'guard'
  /** A player nearer than this (strictly) is noticed. */
  acquire: number
  /** A target this far away (or further) is dropped. */
  lose: number
  idleSpeed: number
  chaseSpeed: number
  /** An idle unit wanders to home + RangeInt(-wander, wander) on each axis. */
  wander: number
  /** How long an empty scan blocks the next one, in ms. */
  refreshMs: number
  /**
   * While chasing, a target nearer than this (strictly) is not closed on: the
   * unit stops where it is. 0 = never stop, which is how grunt and boss chase.
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
  /** Collider radius. An integer up to 127: it goes on the wire as one byte. */
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
  /** Centre to centre. null = today's reach, the consumable's radius plus the body. */
  pickupReach: number | null
  /** Loot carried at spawn. */
  loot: number
  /** Damage dealt by touching a player, at most once per `cooldownMs`. */
  contact: { damage: number, cooldownMs: number }
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

/** Today's GuardPosition, shared by grunt and boss. */
const GUARD: GuardSpec = Object.freeze({
  kind: 'guard',
  acquire: 200,
  lose: 250,
  idleSpeed: 30,
  chaseSpeed: 100,
  wander: 30,
  refreshMs: 2000,
  standoff: 0
})

const NO_ARMOR = Object.freeze({ max: 0, refillPerSec: 0, delayMs: 0 })

/** A mirrored row's `rangedCells`, for a RangedAttack override. Null there is a table error. */
function rangedCellsOf (info: ArchetypeInfo): number {
  if (info.rangedCells === null) throw new Error(`${info.key}: RangedAttack needs rangedCells in utils/archetypes.ts`)
  return info.rangedCells
}

const peep: Archetype = {
  ...ARCHETYPE_INFO.peep,
  maxHp: 100,
  // balance-pass §1 (#16): 50, refilling 12/s after 4 s without damage.
  armor: Object.freeze({ max: 50, refillPerSec: 12, delayMs: 4000 }),
  speed: 140,
  // Pinned rather than derived from HP (it was 2 * sqrt(maxHP)): a bigger body
  // widens pickup reach, moves the fireball spawn point and widens the ranged
  // hit. Keep it under Hex.SIZE / 2 so a unit fits beside a rock.
  body: 14,
  level: 1,
  pickupReach: null,
  loot: 0,
  contact: { damage: 0, cooldownMs: 0 },
  killStats: [],
  skills: PLAYER_SKILLS as SkillSpec[],
  routines: []
}

const grunt: Archetype = {
  ...ARCHETYPE_INFO.grunt,
  maxHp: 50,
  armor: NO_ARMOR,
  speed: 100,
  body: 30,
  pickupReach: null,
  loot: 50,
  contact: { damage: 10, cooldownMs: 1000 },
  killStats: ['mobKills'],
  skills: [],
  routines: [GUARD]
}

const boss: Archetype = {
  ...ARCHETYPE_INFO.boss,
  maxHp: 300,
  armor: NO_ARMOR,
  speed: 100,
  body: 40,
  // Read by nothing the boss casts today (FireBreath takes World.config.fire);
  // kept because it is on the wire (a join snapshot carries it).
  level: 0,
  pickupReach: null,
  loot: 500,
  contact: { damage: 30, cooldownMs: 1000 },
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
  maxHp: 40,
  armor: NO_ARMOR,
  // Dead, like grunt and boss's 100 (the guard sets 30 or 80 before the first
  // move). Set to the chase speed, which is the pattern those two follow; the
  // design has no speed column for mobs.
  speed: 80,
  body: 24,
  pickupReach: null,
  loot: 75,
  contact: { damage: 0, cooldownMs: 0 },
  killStats: ['mobKills'],
  // Range 6 cells, the same as `withinCells` below, so every target it fires
  // at is on its line's reach (decision #25; it was 300 units, #24). Read from
  // the mirrored row, which is also what the client draws the beam at.
  skills: [{ skill: RangedAttack, damage: 10, cooldownMs: 1500, range: rangedCellsOf(ARCHETYPE_INFO.gunner) }],
  routines: [
    Object.freeze({
      kind: 'guard',
      acquire: 270,
      lose: 315,
      idleSpeed: 30,
      chaseSpeed: 80,
      wander: 30,
      refreshMs: 2000,
      // 5 cells, so a target stepping back one cell is still inside the
      // 6-cell range. Provisional (decision #23 Q3): Dez retunes after a playtest.
      standoff: 225
    }),
    { kind: 'useSkillOnTarget', skill: 0, withinCells: 6 }
  ]
}

export const ARCHETYPES = Object.freeze({ peep, grunt, boss, gunner })

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
  /** World rocks only: not StoneWall stones, portals or exits. */
  rocks: number
  /** Natural pickups only. Death drops are uncapped and expire on their own. */
  naturalLoot: number
  exits: number
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
    rocks: 136,
    naturalLoot: 150,
    exits: 4,
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
    rocks: 136,
    naturalLoot: 150,
    exits: 4,
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
    rocks: 136,
    naturalLoot: 150,
    exits: 4,
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
        return new GuardPosition(owner, spec)
      case 'useSkillOnTarget': {
        const skill = skills[spec.skill]
        if (skill === undefined) throw new Error(`${archetype.key}: no skill at index ${spec.skill}`)
        return new UseSkillOnTarget(owner, skill, spec.withinCells)
      }
    }
    throw new Error(`${archetype.key}: unknown routine ${(spec as { kind: string }).kind}`)
  })
}
