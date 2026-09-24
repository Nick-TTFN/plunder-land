import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph anywhere but multiplayer leaves
// GameObject undefined, so go in the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { ARCHETYPES } from './archetypes'
import { GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
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
import { Vector } from '../utils/vector'

/**
 * unit-archetypes, step 0(a): today's Player, Mob (grunt) and Boss, pinned
 * before any of their stats move into an archetype table (decision #23).
 *
 * **Step 1 must leave every assertion here passing, with exactly one
 * exception:** `BOSS_CREATE_RADIUS` below, 30 today, becomes 40. Today the
 * boss's create record is built inside Mob's constructor, before Boss sets its
 * radius, so it goes out grunt-sized and the 40 follows as a delta (design
 * section 2, decision #23 Q5). Any other failure after step 1 is a behaviour
 * change.
 *
 * Step 1 deletes the `Boss` class and moves the stats, so construction has to
 * change. That is confined to the "Construction and internals" block below:
 * step 1 may edit those lines (and the imports they need), and nothing else.
 * Everything else asserts behaviour or wire bytes rather than the names of
 * statics, which is why acquire/lose/refresh distances are tested by placing a
 * player rather than by reading `GuardPosition.TARGET_AQUIRE_DISTANCE`.
 *
 * Units are built directly, never through `new World()` or its spawner, so
 * nothing here depends on a random map. Left out on purpose, because it is
 * random today:
 * - spawn position and plane (the spawner's `getUnobstructedPosition` and
 *   `TAGS[RangeInt]`): every unit here stands at a fixed point on tag 0;
 * - where an idle unit wanders: pinned only as the wander box's corners, by
 *   stubbing `Math.random` to its extremes, not as a path;
 * - ids in a real world depend on spawn order; here the counter is reset.
 */

/** STEP 1 FLIPS THIS to 40 (decision #23 Q5). The only expected difference. */
const BOSS_CREATE_RADIUS = 40

// --- Construction and internals: the only lines step 1 may edit ------------------

const makePlayer = (x: number, y: number, name = 'p1'): Player => new Player(x, y, 0, name)
const makeGrunt = (x: number, y: number): Unit => new Mob(x, y, 0, ARCHETYPES.grunt)
const makeBoss = (x: number, y: number): Unit => new Mob(x, y, 0, ARCHETYPES.boss)
/** The point an idle guard is walking to. */
const wanderGoal = (unit: Unit): Vector | undefined =>
  (unit.routines.find((r) => r instanceof GuardPosition) as GuardPosition).moveTarget
const clearWanderGoal = (unit: Unit): void => {
  (unit.routines.find((r) => r instanceof GuardPosition) as GuardPosition).moveTarget = undefined
}

// ---------------------------------------------------------------------------------

const DT = 0.25
const X = 1000
const Y = 2000

/** What `Multiplayer.create` was handed, captured at the moment of the call. */
let created: Array<{ obj: GameObject, fields: Record<string, unknown>, bytes: number[] }> = []
/** `Multiplayer.effect` calls: [type, originator]. */
let effects: Array<[number, GameObject]> = []

beforeEach(() => {
  const noop = (): void => {}
  created = []
  effects = []
  Multiplayer.Instance = {
    // The real `create` serialises at call time, so the stub must too: the
    // boss's radius changes after this runs.
    create: (obj: GameObject) => {
      created.push({
        obj,
        fields: { ...(obj.serialise(obj.allFields) as Record<string, unknown>) },
        bytes: [...(obj.serialiseBinary(obj.allFields) as Buffer)]
      })
    },
    update: noop,
    destroy: noop,
    effect: (type: number, obj: GameObject) => { effects.push([type, obj]) }
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
  GameObject.id = 0
  GameObject.FreedIDs.length = 0
})

function createRecordOf (obj: GameObject): { fields: Record<string, unknown>, bytes: number[] } {
  const found = created.filter((c) => c.obj === obj)
  assert.equal(found.length, 1, 'expected exactly one create record for this object')
  return found[0]
}

function bytesOf (obj: GameObject, fields: Set<string>): number[] {
  return [...(obj.serialiseBinary(fields) as Buffer)]
}

function mockDate (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

/** Move the mocked clock and run what fell due, as `World.update` does first. */
function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function addPlayer (x: number, y: number, name = 'p1'): Player {
  const player = makePlayer(x, y, name)
  World.PLAYERS.push(player)
  return player
}

function addMob (make: (x: number, y: number) => Unit): Unit {
  const mob = make(X, Y)
  World.MOBS.push(mob)
  return mob
}

// Byte helpers, spelled out so a failing diff can be read field by field:
// [field index][payload], field indices from GameObject.fieldOrder.
const u16 = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff]
const ID = (v: number): number[] => [0, ...u16(v)]
const TYPE = (v: number): number[] => [1, v]
const POS = (x: number, y: number): number[] => [2, ...u16(x), ...u16(y)]
const HP = (v: number): number[] => [3, ...u16(v)]
const LEVEL = (v: number): number[] => [4, v]
const LOOT = (v: number): number[] => [5, ...u16(v)]
const TAG = (v: number): number[] => [6, v & 0xff]
const TO = (v: number): number[] => [7, v & 0xff]
const RADIUS = (v: number): number[] => [8, v]
const MAXVEL = (v: number): number[] => [10, Math.floor(v / 10)]
const NAME = (s: string): number[] => [11, ...Buffer.from(s), 0]
const MAXHP = (v: number): number[] => [12, ...u16(v)]
const FACING = (v: number): number[] => [13, v]

test('the byte helpers use today\'s field indices', () => {
  assert.deepEqual(
    GameObject.fieldOrder,
    ['id', 'type', 'position', 'hp', 'level', 'loot', 'tag', 'to', 'radius',
      'lifetime', 'maxVelocity', 'name', 'maxHp', 'facing']
  )
})

// --- Player ---------------------------------------------------------------------

test('player: stats at construction and after one update', () => {
  const player = addPlayer(X, Y)

  assert.equal(player.type, ObjectType.Player)
  assert.equal(player.maxHp, 100)
  assert.equal(player.hp, 100)
  assert.equal(player.radius, 14)
  assert.equal(player.level, 1)
  assert.equal(player.loot, 0)
  assert.equal(player.maxVelocity, 140)
  assert.equal(player.armor, 0)
  assert.equal(player.damageReduction, 0)
  assert.deepEqual(player.routines, [])

  player.update(DT)
  assert.equal(player.maxVelocity, 140)
  assert.equal(player.hp, 100)
  assert.equal(player.maxHp, 100)
  assert.equal(player.radius, 14)
})

test('player: the eight skills, in wire order, with their cooldowns', () => {
  const player = makePlayer(X, Y)
  assert.deepEqual(
    player.skills.map((s) => [s.constructor, s.cooldown]),
    [
      [Dash, 2000],
      [MeleeAttack, 1000],
      [RangedAttack, 750],
      [Defend, 8000],
      [StoneWall, 6000],
      [ThrowFireball, 4000],
      [Throwicicle, 4000],
      [IceBreath, 3000]
    ]
  )
  for (const skill of player.skills) assert.equal(skill.owner, player)
})

test('player: no contact damage, to a mob or another player', () => {
  const player = addPlayer(X, Y)
  World.MOBS.push(makeGrunt(X + 30, Y))
  const other = addPlayer(X - 20, Y, 'p2')

  player.update(DT)
  assert.equal(World.MOBS[0].hp, 50)
  assert.equal(other.hp, 100)
})

test('player: create record (allFields) and create_own (allFieldsOwn) bytes', () => {
  const player = makePlayer(X, Y)

  const expectedCreate = [
    ...ID(1), ...TYPE(4), ...POS(X, Y), ...HP(100), ...LEVEL(1), ...TAG(0), ...TO(0),
    ...RADIUS(14), ...NAME('p1'), ...MAXHP(100), ...FACING(0)
  ]
  assert.deepEqual(createRecordOf(player).bytes, expectedCreate)
  assert.deepEqual(bytesOf(player, player.allFields), expectedCreate)

  // What the joining player gets for itself (Multiplayer.admit).
  assert.deepEqual(bytesOf(player, player.allFieldsOwn), [
    ...ID(1), ...TYPE(4), ...POS(X, Y), ...HP(100), ...LEVEL(1), ...LOOT(0), ...TAG(0),
    ...TO(0), ...RADIUS(14), ...MAXVEL(140), ...MAXHP(100)
  ])
})

// --- Guard behaviour, shared by grunt and boss ------------------------------------

/**
 * GuardPosition as it behaves today, by placement rather than by reading its
 * statics: notices a player under 200 (not at 200), drops it at 250 (not at
 * 249), idles at 30 and chases at 100, rescans an empty neighbourhood only
 * after more than 2000 ms, and wanders to home +/- [-30, 29] on each axis.
 */
function pinGuard (t: TestContext, make: (x: number, y: number) => Unit): void {
  mockDate(t)

  // Speed: idle 30 after one update; 100 once it has a target.
  const idle = addMob(make)
  assert.equal(idle.maxVelocity, 100, 'speed at construction, before the guard runs')
  idle.update(DT)
  assert.equal(idle.maxVelocity, 30, 'idle speed')
  World.MOBS.length = 0

  // Acquire: 199 yes, 200 no.
  for (const [distance, expected] of [[199, true], [200, false]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const mob = addMob(make)
    const player = addPlayer(X + distance, Y)
    mob.update(DT)
    assert.equal(mob.target === player, expected, `acquired at ${distance}`)
    assert.equal(mob.maxVelocity, expected ? 100 : 30, `speed after a scan at ${distance}`)
  }

  // Lose: 249 kept, 250 dropped. Tested before the unit moves in its update.
  for (const [distance, kept] of [[249, true], [250, false]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const mob = addMob(make)
    const player = addPlayer(X + 100, Y)
    mob.update(DT)
    assert.equal(mob.target, player)
    player.position = mob.position.add(new Vector(distance, 0))
    mob.update(DT)
    assert.equal(mob.target === player, kept, `target kept at ${distance}`)
  }

  // Refresh: an empty scan at t0 blocks the next until strictly after t0 + 2000.
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  const scanner = addMob(make)
  scanner.update(DT) // scans, finds nobody
  const late = addPlayer(X + 100, Y)
  advance(t, 2000)
  scanner.update(DT)
  assert.equal(scanner.target, undefined, 'rescanned at exactly 2000 ms')
  advance(t, 1)
  scanner.update(DT)
  assert.equal(scanner.target, late, 'no rescan at 2001 ms')

  // Wander box corners, and home is the spawn point.
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  const wanderer = addMob(make)
  t.mock.method(Math, 'random', () => 0)
  wanderer.update(DT)
  assert.deepEqual([wanderGoal(wanderer)?.x, wanderGoal(wanderer)?.y], [X - 30, Y - 30])
  clearWanderGoal(wanderer)
  t.mock.method(Math, 'random', () => 0.99999)
  wanderer.update(DT)
  assert.deepEqual([wanderGoal(wanderer)?.x, wanderGoal(wanderer)?.y], [X + 29, Y + 29])
}

/**
 * A unit next to a player on one update: the contact hit, the spacing it is
 * pushed out to, and the cooldown before the next hit.
 */
function pinContact (t: TestContext, make: (x: number, y: number) => Unit, damage: number): void {
  mockDate(t)
  const mob = addMob(make)
  const player = addPlayer(X + 30, Y)

  mob.update(DT)
  assert.equal(player.hp, 100 - damage, 'first contact hit')
  const spacing = player.position.sub(mob.position).getMagnitude()
  assert.ok(Math.abs(spacing - (mob.radius + player.radius)) < 1e-9, `spacing ${spacing}`)

  advance(t, 999)
  mob.update(DT)
  assert.equal(player.hp, 100 - damage, 'hit again inside the 1000 ms cooldown')

  advance(t, 1)
  mob.update(DT)
  assert.equal(player.hp, 100 - 2 * damage, 'the second hit did not land at 1000 ms')
}

// --- Grunt (Mob) ----------------------------------------------------------------

test('grunt: stats at construction and after one update', () => {
  const mob = addMob(makeGrunt)
  assert.equal(mob.type, ObjectType.Mob)
  assert.equal(mob.maxHp, 50)
  assert.equal(mob.hp, 50)
  assert.equal(mob.radius, 30)
  assert.equal(mob.loot, 50)
  assert.equal(mob.level, undefined)
  assert.equal(mob.armor, 0)
  assert.equal((mob as unknown as { skills?: unknown }).skills, undefined)

  mob.update(DT)
  assert.equal(mob.hp, 50)
  assert.equal(mob.maxHp, 50)
  assert.equal(mob.radius, 30)
})

test('grunt: one GuardPosition, and nothing else', () => {
  const mob = makeGrunt(X, Y)
  assert.deepEqual(mob.routines.map((r) => r.constructor), [GuardPosition])
})

test('grunt: guard behaviour (acquire 200, lose 250, speeds 30/100, refresh 2000, wander 30)', (t) => {
  pinGuard(t, makeGrunt)
})

test('grunt: contact damage 10, cooldown 1000 ms, spacing radius + radius', (t) => {
  pinContact(t, makeGrunt, 10)
})

test('grunt: create record bytes', () => {
  const mob = makeGrunt(X, Y)
  const expected = [
    ...ID(1), ...TYPE(32), ...POS(X, Y), ...HP(50), ...TAG(0), ...TO(0),
    ...RADIUS(30), ...MAXHP(50), ...FACING(0)
  ]
  assert.deepEqual(createRecordOf(mob).bytes, expected)
  // A later join's snapshot of the same unmoved grunt is the same bytes.
  assert.deepEqual(bytesOf(mob, mob.allFields), expected)
})

// --- Boss -----------------------------------------------------------------------

test('boss: stats at construction and after one update', () => {
  const boss = addMob(makeBoss)
  assert.equal(boss.type, ObjectType.Mob)
  assert.equal(boss.maxHp, 300)
  assert.equal(boss.hp, 300)
  assert.equal(boss.radius, 40)
  assert.equal(boss.loot, 500)
  assert.equal(boss.level, 0)
  assert.equal(boss.armor, 0)
  assert.equal((boss as unknown as { skills?: unknown }).skills, undefined)

  boss.update(DT)
  assert.equal(boss.hp, 300)
  assert.equal(boss.maxHp, 300)
  assert.equal(boss.radius, 40)
})

test('boss: GuardPosition then UseSkillOnTarget(FireBreath, 3000 ms)', () => {
  const boss = makeBoss(X, Y)
  assert.deepEqual(boss.routines.map((r) => r.constructor), [GuardPosition, UseSkillOnTarget])
  const use = boss.routines[1] as UseSkillOnTarget
  assert.equal(use.owner, boss)
  assert.equal(use.skill.constructor, FireBreath)
  assert.equal(use.skill.owner, boss)
  assert.equal(use.skill.cooldown, 3000)
})

test('boss: breathes (effect 0) on a target, then not again until 3000 ms', (t) => {
  mockDate(t)
  const boss = addMob(makeBoss)
  addPlayer(X + 150, Y)

  boss.update(DT)
  assert.deepEqual(effects, [[0, boss]])
  advance(t, 2999)
  boss.update(DT)
  assert.equal(effects.length, 1, 'breathed again inside 3000 ms')
  advance(t, 1)
  boss.update(DT)
  assert.equal(effects.length, 2, 'did not breathe again at 3000 ms')
})

test('boss: guard behaviour (acquire 200, lose 250, speeds 30/100, refresh 2000, wander 30)', (t) => {
  pinGuard(t, makeBoss)
})

test('boss: contact damage 30, cooldown 1000 ms, spacing radius + radius', (t) => {
  pinContact(t, makeBoss, 30)
})

test(`boss: create record goes out with radius ${BOSS_CREATE_RADIUS} (STEP 1 FLIPS THIS: 30 -> 40)`, () => {
  const boss = makeBoss(X, Y)
  const record = createRecordOf(boss)

  // THE assertion step 1 changes, and the only one. See BOSS_CREATE_RADIUS.
  assert.equal(record.fields.radius, BOSS_CREATE_RADIUS,
    'boss create-record radius: 30 before unit-archetypes step 1, 40 after (decision #23 Q5)')

  // Everything else in the record stays. No level: Boss sets it after the create.
  assert.deepEqual(record.bytes, [
    ...ID(1), ...TYPE(32), ...POS(X, Y), ...HP(300), ...TAG(0), ...TO(0),
    ...RADIUS(BOSS_CREATE_RADIUS), ...MAXHP(300), ...FACING(0)
  ])
})

test('boss: a later join\'s snapshot (allFields) bytes', () => {
  const boss = makeBoss(X, Y)
  assert.deepEqual(bytesOf(boss, boss.allFields), [
    ...ID(1), ...TYPE(32), ...POS(X, Y), ...HP(300), ...LEVEL(0), ...TAG(0), ...TO(0),
    ...RADIUS(40), ...MAXHP(300), ...FACING(0)
  ])
})

test('units stand where they are built (no random spawn in this spec)', () => {
  for (const unit of [makePlayer(X, Y), makeGrunt(X, Y), makeBoss(X, Y)]) {
    assert.deepEqual([unit.position.x, unit.position.y, unit.tag], [X, Y, 0])
  }
})
