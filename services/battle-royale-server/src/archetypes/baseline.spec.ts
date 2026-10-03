import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph anywhere but multiplayer leaves
// GameObject undefined, so go in the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { ARCHETYPES, buildKit } from './archetypes'
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
import { Hex } from '../utils/hex'

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
// loot-wire-overflow, deliberate: loot goes out as `loot32`, a uint32; the old
// uint16 index 5 is never written. lootwire.spec.ts pins the index (20).
const LOOT = (v: number): number[] => [GameObject.fieldOrder.indexOf('loot32'), v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
const TAG = (v: number): number[] => [6, v & 0xff]
const TO = (v: number): number[] => [7, v & 0xff]
const RADIUS = (v: number): number[] => [8, v]
const MAXVEL = (v: number): number[] => [10, Math.floor(v / 10)]
const NAME = (s: string): number[] => [11, ...Buffer.from(s), 0]
const MAXHP = (v: number): number[] => [12, ...u16(v)]
const FACING = (v: number): number[] => [13, v]
const ARMOR = (v: number): number[] => [14, ...u16(v)]
const MAXARMOR = (v: number): number[] => [15, ...u16(v)]
const ARCHETYPE = (v: number): number[] => [16, v]
// run-summary-card, deliberate: a player's kills this run, uint16 at 21.
const KILLS = (v: number): number[] => [21, ...u16(v)]
const INVENTORY = (...counts: number[]): number[] => [18, counts.length, ...counts]
// robot-finishes: the default finish (mint), counted: head cream zebra, body and limbs mint plain.
const FINISH_MINT = [23, 6, 2, 1, 1, 0, 1, 0]

test('the byte helpers use today\'s field indices', () => {
  assert.deepEqual(
    GameObject.fieldOrder,
    ['id', 'type', 'position', 'hp', 'level', 'loot', 'tag', 'to', 'radius',
      'lifetime', 'maxVelocity', 'name', 'maxHp', 'facing',
      // unit-archetypes step 3 (the armor pool), deliberate: appended.
      'armor', 'maxArmor',
      // Step 4 (archetype id on the wire), deliberate: appended.
      'archetype',
      // usable-items, deliberate: an item pickup's kind and a player's
      // inventory, appended.
      'item', 'inventory',
      // extract-channel (progress byte), deliberate: appended.
      'extractProgress',
      // loot-wire-overflow, deliberate: carried loot as a uint32, appended.
      'loot32',
      // run-summary-card, deliberate: a player's kills this run, appended.
      'kills',
      // arena art pass, deliberate: a projectile's kind, appended.
      'projectile',
      // robot-finishes, deliberate: a player's finish, appended.
      'finish',
      // pickup-reach, deliberate: who took a pickup, appended.
      'collector']
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
  // Step 3 (the armor pool), deliberate: was a flat 0, now a full pool of 50.
  assert.equal(player.armor, 50)
  assert.equal(player.maxArmor, 50)
  assert.equal(player.damageReduction, 0)
  assert.deepEqual(player.routines, [])

  player.update(DT)
  assert.equal(player.maxVelocity, 140)
  assert.equal(player.armor, 50)
  assert.equal(player.hp, 100)
  assert.equal(player.maxHp, 100)
  assert.equal(player.radius, 14)
})

// Changed on purpose by loadouts (decision #48 step 4): a player no longer has
// all eight; its 4 slots come from its kit, the start kit by default. The
// cooldowns of the other five are still pinned, through a kit that holds them.
test('player: the start kit by default, in its slots, with the same cooldowns as before', () => {
  const player = makePlayer(X, Y)
  assert.deepEqual(
    player.skills.map((s) => s === null ? null : [s.constructor, s.cooldown]),
    [
      [Dash, 2000],
      [MeleeAttack, 1000],
      [RangedAttack, 750],
      null
    ]
  )
  for (const skill of player.skills) if (skill !== null) assert.equal(skill.owner, player)
  const rest = buildKit(player, [4, 5, 6, 7]).concat(buildKit(player, [8, 0, 0, 0]))
  assert.deepEqual(
    rest.filter((s) => s !== null).map((s) => [s?.constructor, s?.cooldown]),
    [
      [Defend, 8000],
      [StoneWall, 6000],
      [ThrowFireball, 4000],
      [Throwicicle, 4000],
      [IceBreath, 3000]
    ]
  )
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
    // player-names, deliberate: a player who gave no name is sent as its id's
    // callsign (Player.callsign('p1')), no longer as the id itself.
    ...RADIUS(14), ...NAME('GEAR-59'), ...MAXHP(100), ...FACING(0),
    // Step 3 (the armor pool), deliberate: the pool goes on the end.
    ...ARMOR(50), ...MAXARMOR(50),
    // Step 4, deliberate: then the archetype id (peep = 1).
    ...ARCHETYPE(1),
    // robot-finishes, deliberate: the finish goes on the end, the default here.
    ...FINISH_MINT
  ]
  assert.deepEqual(createRecordOf(player).bytes, expectedCreate)
  assert.deepEqual(bytesOf(player, player.allFields), expectedCreate)

  // What the joining player gets for itself (Multiplayer.admit).
  assert.deepEqual(bytesOf(player, player.allFieldsOwn), [
    ...ID(1), ...TYPE(4), ...POS(X, Y), ...HP(100), ...LEVEL(1), ...LOOT(0), ...TAG(0),
    ...TO(0), ...RADIUS(14), ...MAXVEL(140), ...MAXHP(100),
    // Steps 3 and 4, deliberate, as above.
    ...ARMOR(50), ...MAXARMOR(50), ...ARCHETYPE(1),
    // usable-items, deliberate: the owner's own inventory, five empty slots.
    ...INVENTORY(0, 0, 0, 0, 0),
    // run-summary-card, deliberate: the run's kills, starting at 0.
    ...KILLS(0),
    // robot-finishes, deliberate: the finish, as in everyone's create.
    ...FINISH_MINT
  ])
})

// --- Guard behaviour, shared by grunt and boss ------------------------------------

/**
 * The centre of the cell `rings` east of the cell under (X, Y), along the q
 * axis, so exactly `rings` from it by `Hex.distance`.
 */
const cellsEast = (rings: number): Vector => {
  const home = Hex.toCell(new Vector(X, Y))
  return Hex.toPosition(new Vector(home.x + rings, home.y))
}

/**
 * GuardPosition as it behaves today, by placement rather than by reading its
 * statics: notices a player 4 rings away (not 5), keeps it at 5 rings (drops
 * it at 6), idles at 30 and chases at 100, rescans an empty neighbourhood only
 * after more than 2000 ms, and wanders to the centre of a cell of home's
 * 1-ring patch.
 *
 * hex-cells P1, deliberate (decision #32, Nick's OK): acquire, lose and
 * wander are rings. This pinned acquire at 199 yes / 200 no, lose at 249
 * kept / 250 dropped, and the wander goals at home + (-30, -30) and
 * (+29, +29).
 */
function pinGuard (t: TestContext, make: (x: number, y: number) => Unit): void {
  mockDate(t)

  // Speed: idle 30 after one update; 100 once it has a target.
  const idle = addMob(make)
  assert.equal(idle.maxVelocity, 100, 'speed at construction, before the guard runs')
  idle.update(DT)
  assert.equal(idle.maxVelocity, 30, 'idle speed')
  World.MOBS.length = 0

  // Acquire: 4 rings yes, 5 no. (Was 199 yes, 200 no.)
  for (const [rings, expected] of [[4, true], [5, false]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const mob = addMob(make)
    const at = cellsEast(rings)
    const player = addPlayer(at.x, at.y)
    mob.update(DT)
    assert.equal(mob.target === player, expected, `acquired at ${rings} rings`)
    assert.equal(mob.maxVelocity, expected ? 100 : 30, `speed after a scan at ${rings} rings`)
  }

  // Lose: 5 rings kept, 6 dropped. (Was 249 kept, 250 dropped.) Tested before
  // the unit moves in its update.
  for (const [rings, kept] of [[5, true], [6, false]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const mob = addMob(make)
    const player = addPlayer(X + 100, Y)
    mob.update(DT)
    assert.equal(mob.target, player)
    player.position = cellsEast(rings)
    mob.update(DT)
    assert.equal(mob.target === player, kept, `target kept at ${rings} rings`)
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

  // Wander goals: the first and last cells of home's 1-ring patch, and home is
  // the spawn point's cell. (Was the box corners home + (-30, -30) and
  // home + (+29, +29).)
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  const wanderer = addMob(make)
  t.mock.method(Math, 'random', () => 0)
  wanderer.update(DT)
  const west = cellsEast(-1)
  assert.deepEqual([wanderGoal(wanderer)?.x, wanderGoal(wanderer)?.y], [west.x, west.y])
  clearWanderGoal(wanderer)
  t.mock.method(Math, 'random', () => 0.99999)
  wanderer.update(DT)
  const east = cellsEast(1)
  assert.deepEqual([wanderGoal(wanderer)?.x, wanderGoal(wanderer)?.y], [east.x, east.y])
}

/**
 * A unit next to a player on one update: the contact hit, the range it lands
 * at, and the cooldown before the next hit.
 *
 * hex-cells P2, deliberate (decision #32, Nick's OK): contact is within 1 ring
 * of the player (the archetype's `contact.rings`), and nothing is pushed apart. This
 * pinned the bodies overlapping, and the player pushed out to exactly
 * radius + radius from the mob.
 */
function pinContact (t: TestContext, make: (x: number, y: number) => Unit, damage: number): void {
  mockDate(t)
  const mob = addMob(make)
  const player = addPlayer(X + 30, Y)
  // Step 3: an emptied pool, so hp still measures the mob's damage. The pool
  // itself is armor.spec.ts's; the assertions below are unchanged.
  player.armor = 0

  mob.update(DT)
  assert.equal(player.hp, 100 - damage, 'first contact hit')
  const rings = Hex.distance(mob.cell, player.cell)
  assert.ok(rings <= 1, `hit from ${rings} rings`)

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

test('grunt: guard behaviour (acquire 4 rings, lose 5 rings, speeds 30/100, refresh 2000, wander 1 ring)', (t) => {
  pinGuard(t, makeGrunt)
})

test('grunt: contact damage 10, cooldown 1000 ms, within 1 ring', (t) => {
  pinContact(t, makeGrunt, 10)
})

test('grunt: create record bytes', () => {
  const mob = makeGrunt(X, Y)
  const expected = [
    ...ID(1), ...TYPE(32), ...POS(X, Y), ...HP(50), ...TAG(0), ...TO(0),
    ...RADIUS(30), ...MAXHP(50), ...FACING(0),
    // Step 4 (archetype id on the wire), deliberate: grunt = 6.
    ...ARCHETYPE(6)
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

test('boss: guard behaviour (acquire 4 rings, lose 5 rings, speeds 30/100, refresh 2000, wander 1 ring)', (t) => {
  pinGuard(t, makeBoss)
})

test('boss: contact damage 30, cooldown 1000 ms, within 1 ring', (t) => {
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
    ...RADIUS(BOSS_CREATE_RADIUS), ...MAXHP(300), ...FACING(0),
    // Step 4, deliberate: boss = 7.
    ...ARCHETYPE(7)
  ])
})

test('boss: a later join\'s snapshot (allFields) bytes', () => {
  const boss = makeBoss(X, Y)
  assert.deepEqual(bytesOf(boss, boss.allFields), [
    ...ID(1), ...TYPE(32), ...POS(X, Y), ...HP(300), ...LEVEL(0), ...TAG(0), ...TO(0),
    ...RADIUS(40), ...MAXHP(300), ...FACING(0),
    // Step 4, deliberate: boss = 7.
    ...ARCHETYPE(7)
  ])
})

test('units stand where they are built (no random spawn in this spec)', () => {
  for (const unit of [makePlayer(X, Y), makeGrunt(X, Y), makeBoss(X, Y)]) {
    assert.deepEqual([unit.position.x, unit.position.y, unit.tag], [X, Y, 0])
  }
})
