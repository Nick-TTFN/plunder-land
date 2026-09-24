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
  /** Only for a skill that has a `range` (RangedAttack); anything else throws. */
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

export interface Archetype {
  /** Wire value once step 4 puts it on the wire. Append-only, never reused. */
  id: number
  key: string
  kind: 'robot' | 'mob'
  maxHp: number
  /**
   * The armor pool (#16). **Not read yet**: the pool is step 3. Until then every
   * unit's armor is `Unit.armor`, today's flat 0, and these are all zero.
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
  /** Fog radius, robots only. **Not read yet** (step 5); null = no fog, as today. */
  vision: number | null
  /** Loot carried at spawn. */
  loot: number
  /** Damage dealt by touching a player, at most once per `cooldownMs`. */
  contact: { damage: number, cooldownMs: number }
  /** Hopper (#15). **Not read yet** (step 6). */
  passesObstacles: boolean
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

const peep: Archetype = {
  id: 1,
  key: 'peep',
  kind: 'robot',
  maxHp: 100,
  armor: NO_ARMOR,
  speed: 140,
  // Pinned rather than derived from HP (it was 2 * sqrt(maxHP)): a bigger body
  // widens pickup reach, moves the fireball spawn point and widens the ranged
  // hit. Keep it under Hex.SIZE / 2 so a unit fits beside a rock.
  body: 14,
  level: 1,
  pickupReach: null,
  vision: null,
  loot: 0,
  contact: { damage: 0, cooldownMs: 0 },
  passesObstacles: false,
  killStats: [],
  skills: PLAYER_SKILLS as SkillSpec[],
  routines: []
}

const grunt: Archetype = {
  id: 6,
  key: 'grunt',
  kind: 'mob',
  maxHp: 50,
  armor: NO_ARMOR,
  speed: 100,
  body: 30,
  pickupReach: null,
  vision: null,
  loot: 50,
  contact: { damage: 10, cooldownMs: 1000 },
  passesObstacles: false,
  killStats: ['mobKills'],
  skills: [],
  routines: [GUARD]
}

const boss: Archetype = {
  id: 7,
  key: 'boss',
  kind: 'mob',
  maxHp: 300,
  armor: NO_ARMOR,
  speed: 100,
  body: 40,
  // Read by nothing the boss casts today (FireBreath takes World.config.fire);
  // kept because it is on the wire (a join snapshot carries it).
  level: 0,
  pickupReach: null,
  vision: null,
  loot: 500,
  contact: { damage: 30, cooldownMs: 1000 },
  passesObstacles: false,
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
  id: 8,
  key: 'gunner',
  kind: 'mob',
  maxHp: 40,
  armor: NO_ARMOR,
  // Dead, like grunt and boss's 100 (the guard sets 30 or 80 before the first
  // move). Set to the chase speed, which is the pattern those two follow; the
  // design has no speed column for mobs.
  speed: 80,
  body: 24,
  pickupReach: null,
  vision: null,
  loot: 75,
  contact: { damage: 0, cooldownMs: 0 },
  passesObstacles: false,
  killStats: ['mobKills'],
  // Range 300, not 270 (decision #24). `withinCells` counts cells, and a
  // target in a cell 6 away can stand up to ~293 units from a gunner on its
  // own cell centre (270 + the cell's far edge). At 270 the shot fell short.
  skills: [{ skill: RangedAttack, damage: 10, cooldownMs: 1500, range: 300 }],
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
