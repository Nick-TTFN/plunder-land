import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import Consumable from '../objects/consumable'
import { GameObject, ObjectType } from '../objects/gameobject'
import { Unit } from '../objects/unit'
import { type Skill } from '../skills/skill'
import { Dash } from '../skills/dash'
import { MeleeAttack } from '../skills/meleeattack'
import { RangedAttack } from '../skills/rangedattack'
import { Defend } from '../skills/defend'
import { StoneWall } from '../skills/stonewall'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { IceBreath } from '../skills/icebreath'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { type Archetype, ARCHETYPES, LAYERS, PLAYER_SKILLS, buildSkills } from './archetypes'

/**
 * The archetype table's own rules (decision #23). What each unit does today
 * is pinned separately, by baseline.spec.ts.
 */

let hincrby: Array<[string, string, number]> = []

beforeEach(() => {
  const noop = (): void => {}
  hincrby = []
  Multiplayer.Instance = {
    create: noop,
    update: noop,
    destroy: noop,
    effect: noop,
    redis: {
      hincrby: async (hash: string, key: string, by: number) => { hincrby.push([hash, key, by]); return 0 }
    }
  } as unknown as Multiplayer

  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

const ALL: Archetype[] = Object.values(ARCHETYPES)

// --- skill order (design section 5) ------------------------------------------

test('PLAYER_SKILLS is the eight skills in wire order', () => {
  assert.deepEqual(
    PLAYER_SKILLS.map((s) => s.skill),
    [Dash, MeleeAttack, RangedAttack, Defend, StoneWall, ThrowFireball, Throwicicle, IceBreath]
  )
  // No overrides: a player's skills are the skills' own defaults.
  for (const spec of PLAYER_SKILLS) assert.deepEqual(Object.keys(spec), ['skill'])
})

test('every robot uses PLAYER_SKILLS itself, not a list of its own', () => {
  const robots = ALL.filter((a) => a.kind === 'robot')
  assert.ok(robots.length > 0)
  for (const robot of robots) {
    // By reference: an equal-looking copy is exactly what this forbids,
    // because the next edit to it would re-map the client's slots.
    assert.equal(robot.skills, PLAYER_SKILLS, `${robot.key} has its own skill list`)
  }
})

test('the client\'s Player.skills lists the same skills in the same order', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'plunder-land-client', 'src', 'objects', 'player.ts'), 'utf8')
  const match = /this\.skills = \[([\s\S]*?)\]/.exec(source)
  assert.ok(match !== null, 'could not find `this.skills = [...]` in the client player.ts')
  const client = Array.from(match[1].matchAll(/new (\w+)\(/g), (m) => m[1].toLowerCase())
  // Lower-cased: the client spells it ThrowIcicle, the server Throwicicle.
  assert.deepEqual(client, PLAYER_SKILLS.map((s) => s.skill.name.toLowerCase()))
})

test('a player\'s built skills are PLAYER_SKILLS, in order, owned by the player', () => {
  const player = new Player(1000, 2000, 0, 'p1')
  assert.deepEqual(player.skills.map((s) => s.constructor), PLAYER_SKILLS.map((s) => s.skill))
  for (const skill of player.skills) assert.equal(skill.owner, player)
})

// --- damage (watch item: Damage[undefined]) ---------------------------------

/** A skill class's per-level damage table, if it has one (read via `Skill.byLevel`). */
function levelTable (skill: unknown): number[] | undefined {
  const table = (skill as { Damage?: unknown }).Damage
  return Array.isArray(table) ? table : undefined
}

test('the level-indexed skills are the three that have a Damage table', () => {
  // If a fourth skill grows a level table, it has to be added to byLevel's
  // callers and this list, or the check below would not see it.
  const indexed = [Dash, MeleeAttack, RangedAttack, Defend, StoneWall, ThrowFireball, Throwicicle, IceBreath]
    .filter((c) => levelTable(c) !== undefined)
  assert.deepEqual(indexed, [ThrowFireball, Throwicicle, IceBreath])
})

test('no archetype can deal Damage[undefined]: a level-indexed skill has a level or an override', () => {
  for (const archetype of ALL) {
    for (const spec of archetype.skills) {
      const table = levelTable(spec.skill)
      if (table === undefined) continue
      const damage = spec.damage ?? table[archetype.level as number]
      assert.ok(Number.isFinite(damage),
        `${archetype.key}: ${spec.skill.name} damage is ${damage} (level ${archetype.level}, no override)`)
    }
  }
})

test('a grunt has no level, so a level table gives it no finite damage without an override', () => {
  // The hazard the check above exists for, shown on a real grunt.
  const grunt = new Mob(1000, 2000, 0, ARCHETYPES.grunt)
  assert.equal(grunt.level, undefined)
  const [fireball] = buildSkills(grunt, { ...ARCHETYPES.grunt, skills: [{ skill: ThrowFireball }] })
  // undefined here, and NaN once `hit` multiplies it.
  assert.equal(Number.isFinite((fireball as unknown as { byLevel: (t: number[]) => number }).byLevel(ThrowFireball.Damage)), false)
  const [fixed] = buildSkills(grunt, { ...ARCHETYPES.grunt, skills: [{ skill: ThrowFireball, damage: 12 }] })
  assert.equal((fixed as unknown as { byLevel: (t: number[]) => number }).byLevel(ThrowFireball.Damage), 12)
})

// --- SkillSpec overrides ------------------------------------------------------

function skillsFor (overrides: Partial<Archetype>): Skill[] {
  const owner = new Mob(1000, 2000, 0, ARCHETYPES.grunt)
  return buildSkills(owner, { ...ARCHETYPES.grunt, ...overrides })
}

test('no override leaves the skill\'s own cooldown, damage and range', () => {
  const [ranged] = skillsFor({ skills: [{ skill: RangedAttack }] }) as RangedAttack[]
  assert.equal(ranged.cooldown, 750)
  assert.equal(ranged.damage, undefined)
  assert.equal(ranged.range, 8) // cells (decision #25)
})

test('cooldownMs, damage and range overrides are applied', () => {
  const [ranged] = skillsFor({ skills: [{ skill: RangedAttack, damage: 10, cooldownMs: 1500, range: 5 }] }) as RangedAttack[]
  assert.equal(ranged.cooldown, 1500)
  assert.equal(ranged.damage, 10)
  assert.equal(ranged.range, 5)
})

test('a damage override is what a shot actually deals', () => {
  const at = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))
  const shooter = new Mob(at.x, at.y, 0, ARCHETYPES.grunt)
  const [ranged] = buildSkills(shooter, { ...ARCHETYPES.grunt, skills: [{ skill: RangedAttack, damage: 7 }] })
  const target = new Unit(ObjectType.Mob, at.x + 3 * Hex.SIZE, at.y, 10, 0)
  target.hp = 100
  World.MOBS.push(shooter, target)
  assert.equal(ranged.execute(), true)
  assert.equal(target.hp, 93, `default ${World.config.ranged} dealt instead of the override`)
})

test('a range override on a skill with no range throws rather than being ignored', () => {
  assert.throws(() => skillsFor({ skills: [{ skill: MeleeAttack, range: 99 }] }), /no range/)
})

// --- pickup reach ---------------------------------------------------------------

// hex-cells P1, deliberate (decision #32): pickupReach is in rings from the
// player's cell, null = 0 (its own cell). It pinned a radius (the pickup's
// plus the body, or a fixed centre-to-centre distance) before.

/** Whether a player of `archetype` on a cell centre picks up a consumable on the centre of the cell `rings` east. */
function picksUpAt (archetype: Archetype, rings: number): boolean {
  World.CONSUMABLES.length = 0
  const home = Hex.toCell(new Vector(1000, 2000))
  const at = Hex.toPosition(home)
  const player = new Player(at.x, at.y, 0, 'picker', archetype)
  player.hp = 50 // so the pickup's heal is not what is being measured
  const drop = Hex.toPosition(new Vector(home.x + rings, home.y))
  World.CONSUMABLES.push(new Consumable(drop.x, drop.y, 0, 20 as never, 5))
  player.update(0.25)
  return World.CONSUMABLES.length === 0
}

// pickup-reach, deliberate (decision #42): every robot takes what is within a
// ring; it was its own cell only.
test('peep picks up within one ring', () => {
  assert.equal(ARCHETYPES.peep.pickupReach, 1)
  assert.equal(picksUpAt(ARCHETYPES.peep, 0), true, 'missed a pickup on its own cell')
  assert.equal(picksUpAt(ARCHETYPES.peep, 1), true, 'missed a pickup on the next cell')
  assert.equal(picksUpAt(ARCHETYPES.peep, 2), false, 'picked up from two cells away')
})

test('pickupReach null is still the unit\'s own cell', () => {
  const own = { ...ARCHETYPES.peep, pickupReach: null }
  assert.equal(picksUpAt(own, 0), true)
  assert.equal(picksUpAt(own, 1), false)
})

test('a fixed pickupReach is a ring count', () => {
  const magnet = { ...ARCHETYPES.peep, pickupReach: 2 }
  assert.equal(picksUpAt(magnet, 2), true)
  assert.equal(picksUpAt(magnet, 3), false)
})

// --- kill stats ---------------------------------------------------------------

async function statsForKilling (victim: GameObject): Promise<string[]> {
  const killer = new Player(1000, 2000, 0, 'killer')
  hincrby = []
  await killer.updateKillStats(victim)
  for (const [hash, , by] of hincrby) {
    assert.equal(hash, 'stats-killer')
    assert.equal(by, 1)
  }
  return hincrby.map(([, key]) => key)
}

test('kill stats keep today\'s redis keys: a boss counts as a mob kill and a boss kill', async () => {
  assert.deepEqual(await statsForKilling(new Mob(1000, 2000, 0, ARCHETYPES.grunt)), ['kills', 'mobKills'])
  assert.deepEqual(await statsForKilling(new Mob(1000, 2000, 0, ARCHETYPES.boss)), ['kills', 'mobKills', 'bossKills'])
  assert.deepEqual(await statsForKilling(new Mob(1000, 2000, 0, ARCHETYPES.gunner)), ['kills', 'mobKills'])
  assert.deepEqual(await statsForKilling(new Player(1000, 2000, 0, 'victim')), ['kills'])
  assert.deepEqual(await statsForKilling(new Unit(ObjectType.Mob, 1000, 2000, 10, 0)), ['kills'])
})

// --- spawner --------------------------------------------------------------------

// DELIBERATE CHANGE (decision #26, `three-ground-layers`): this pinned 5 bosses
// and 8 gunners world-wide with grunts filling the rest of 50 (37). The counts
// are now per layer, from LAYERS: grunts 22/18/14, gunners 0/8/14, bosses
// 0/2/3: 76 grunts and gunners (the balance pass's "76 overall") plus 5
// bosses, 81 units. The by-archetype replacement it checked still holds.
test('the spawner keeps each layer\'s mobs by archetype, as LAYERS says', () => {
  const world = new World(4000)
  // See "Things that are deliberate": no gates to carry anyone anywhere.
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  const count = (a: Archetype, tag: number): number =>
    World.MOBS.filter((m) => m.archetype === a && m.tag === tag).length
  const total = LAYERS.reduce((sum, l) => sum + l.mobs.reduce((s, m) => s + m.count, 0), 0)
  for (let i = 0; i < 400 && World.MOBS.length < total; i++) world.update(0.25)

  assert.equal(total, 81)
  assert.equal(World.MOBS.length, total)
  for (const layer of LAYERS) {
    for (const { archetype, count: want } of layer.mobs) {
      assert.equal(count(archetype, layer.tag), want, `${archetype.key} on layer ${layer.tag}`)
    }
  }
  for (const mob of World.MOBS) assert.ok(mob instanceof Mob)

  // A dead boss is replaced by a boss, not a grunt, on its own layer.
  const deep = LAYERS[2].tag
  const boss = World.MOBS.find((m) => m.archetype === ARCHETYPES.boss && m.tag === deep) as Mob
  boss.hit(10_000)
  for (let i = 0; i < 400 && count(ARCHETYPES.boss, deep) < 3; i++) world.update(0.25)
  assert.equal(count(ARCHETYPES.boss, deep), 3)
  assert.equal(World.MOBS.length, total)

  // Likewise a dead gunner.
  const gunner = World.MOBS.find((m) => m.archetype === ARCHETYPES.gunner && m.tag === deep) as Mob
  gunner.hit(10_000)
  for (let i = 0; i < 400 && count(ARCHETYPES.gunner, deep) < 14; i++) world.update(0.25)
  assert.equal(count(ARCHETYPES.gunner, deep), 14)
  assert.equal(World.MOBS.length, total)
})

test('World.config no longer carries unit stats', () => {
  assert.equal('hp' in World.config, false)
  assert.equal('damage' in World.config, false)
})
