import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { GameObject } from '../objects/gameobject'
import { Unit } from '../objects/unit'
import { Defend } from '../skills/defend'
import { ARCHETYPES } from './archetypes'

/**
 * unit-archetypes step 3: the armor pool (design section 3, decision #16,
 * balance-pass §1). A peep has 50 points that take damage before hp, after
 * Defend's reduction. The pool refills at 12/s once 4 s have passed since the
 * last hit that did damage, in whole points, whatever the tick's measured `dt`.
 * Mobs have no pool and send no armor fields.
 */

const DT = 0.25
const X = 1000
const Y = 2000

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop
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

function mockDate (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

/** Move the mocked clock and run what fell due, as `World.update` does first. */
function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function addPlayer (): Player {
  const player = new Player(X, Y, 0, 'p1')
  World.PLAYERS.push(player)
  return player
}

/** One tick of `ms`: the clock moves first, then the unit updates with that dt. */
function tick (t: TestContext, unit: Unit, ms: number): void {
  advance(t, ms)
  unit.update(ms / 1000)
}

// --- the table ------------------------------------------------------------------

test('armor: peep has a pool of 50, 12/s after 4000 ms; mobs have none', () => {
  assert.deepEqual({ ...ARCHETYPES.peep.armor }, { max: 50, refillPerSec: 12, delayMs: 4000 })
  for (const key of ['grunt', 'boss', 'gunner'] as const) {
    assert.equal(ARCHETYPES[key].armor.max, 0, `${key} has a pool`)
  }
})

test('armor: a player starts full; a mob has 0/0 and no armor fields in its records', () => {
  const player = addPlayer()
  assert.deepEqual([player.armor, player.maxArmor], [50, 50])
  for (const set of [player.allFields, player.allFieldsOwn]) {
    assert.ok(set.has('armor') && set.has('maxArmor'))
  }

  for (const archetype of [ARCHETYPES.grunt, ARCHETYPES.boss, ARCHETYPES.gunner]) {
    const mob = new Mob(X, Y, 0, archetype)
    assert.deepEqual([mob.armor, mob.maxArmor], [0, 0])
    for (const set of [mob.allFields, mob.allFieldsOwn]) {
      assert.equal(set.has('armor') || set.has('maxArmor'), false, `${archetype.key} sends armor`)
    }
  }
})

test('armor: every field a player can snapshot is in fieldOrder, armor at 14 and maxArmor at 15', () => {
  const player = addPlayer()
  for (const field of [...player.allFields, ...player.allFieldsOwn]) {
    assert.ok(GameObject.fieldOrder.includes(field), `${field} is not in fieldOrder`)
  }
  assert.equal(GameObject.fieldOrder.indexOf('armor'), 14)
  assert.equal(GameObject.fieldOrder.indexOf('maxArmor'), 15)

  player.armor = 300
  const bytes = player.serialiseBinary(new Set(['armor', 'maxArmor']))
  assert.ok(bytes !== null)
  // [0 id][uint16 id][14][uint16 300][15][uint16 50]
  assert.deepEqual([...bytes.subarray(3)], [14, 1, 44, 15, 0, 50])
})

// --- dirty tracking (the shadowed-accessor trap) --------------------------------

test('armor: no unit has an own `armor` property shadowing GameObject\'s accessor', () => {
  const player = addPlayer()
  const mob = new Mob(X, Y, 0, ARCHETYPES.grunt)
  const bare = new Unit(32, X, Y, 10, 0)
  for (const unit of [player, mob, bare]) {
    assert.equal(Object.prototype.hasOwnProperty.call(unit, 'armor'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(unit, 'maxArmor'), false)
  }
})

test('armor: a hit and a refill both mark armor dirty', (t) => {
  mockDate(t)
  const player = addPlayer()
  player.dirtyFields.clear()

  player.hit(10)
  assert.ok(player.dirtyFields.has('armor'), 'a hit on the pool was not marked dirty')

  advance(t, 4000)
  player.dirtyFields.clear()
  player.update(DT)
  assert.equal(player.armor, 43)
  assert.ok(player.dirtyFields.has('armor'), 'a refill was not marked dirty')
})

// --- the order: Defend, armor, hp -----------------------------------------------

test('armor: absorbs damage before hp, and hp takes only what is left over', () => {
  const player = addPlayer()

  player.hit(30)
  assert.deepEqual([player.armor, player.hp], [20, 100])
  player.hit(30)
  assert.deepEqual([player.armor, player.hp], [0, 90], 'the overflow past the pool did not reach hp')
  player.hit(10)
  assert.deepEqual([player.armor, player.hp], [0, 80])
})

test('armor: effective hp is 150; the player dies only once pool and hp are both gone', () => {
  const player = addPlayer()
  assert.equal(player.hit(149), false)
  assert.deepEqual([player.armor, player.hp, player.destroyed], [0, 1, false])
  assert.equal(player.hit(1), true)
  assert.equal(player.destroyed, true)
})

test('armor: Defend halves the hit before the pool takes it', (t) => {
  mockDate(t)
  const player = addPlayer()
  const defend = player.skills.find((s) => s instanceof Defend)
  assert.ok(defend !== undefined)
  assert.equal(defend.execute(), true)
  assert.equal(player.damageReduction, 0.5)

  player.hit(15) // floor(7.5) = 7, all from the pool
  assert.deepEqual([player.armor, player.hp], [43, 100])

  // 3 left in the pool. Defend first: 20 -> 10, 3 absorbed, 7 to hp.
  // (Armor first would be 20 - 3 = 17, halved to 8.)
  player.armor = 3
  player.hit(20)
  assert.deepEqual([player.armor, player.hp], [0, 93])
})

// --- the refill -----------------------------------------------------------------

test('armor: no refill for 4000 ms after a hit, then 12/s', (t) => {
  mockDate(t)
  const player = addPlayer()
  player.hit(30)
  assert.equal(player.armor, 20)

  // 15 ticks of 250 ms: 3750 ms, still inside the delay.
  for (let i = 0; i < 15; i++) tick(t, player, 250)
  assert.equal(player.armor, 20, 'refilled inside the 4000 ms delay')

  tick(t, player, 249) // 3999 ms
  assert.equal(player.armor, 20, 'refilled at 3999 ms')

  tick(t, player, 1) // 4000 ms: refills by this tick's dt, 12 * 0.001, so nothing whole yet
  assert.equal(player.armor, 20)
  tick(t, player, 250) // + 3.012
  assert.equal(player.armor, 23)
  tick(t, player, 250)
  assert.equal(player.armor, 26)
})

test('armor: refills at exactly 12/s in whole points under a jittered dt, and stops at the max', (t) => {
  mockDate(t)
  const player = addPlayer()
  player.hit(50)
  assert.equal(player.armor, 0)
  advance(t, 4000)

  // A fixed jittered sequence, mean well off 250 ms, so "+3 a tick" drifts.
  const jitter = [262, 297, 231, 318, 276, 244, 305, 289, 253, 311, 268, 239]
  let elapsed = 0
  let step = 0
  while (player.armor < 50) {
    const ms = jitter[step++ % jitter.length]
    tick(t, player, ms)
    elapsed += ms / 1000
    assert.ok(Number.isInteger(player.armor), `armor ${player.armor} is not a whole number`)
    const exact = 12 * elapsed
    if (player.armor < 50) {
      assert.ok(player.armor <= exact + 1e-9 && player.armor > exact - 1,
        `armor ${player.armor} after ${elapsed.toFixed(3)} s; 12/s says ${exact.toFixed(3)}`)
    }
    assert.ok(step < 100, 'never refilled')
  }
  assert.equal(player.armor, 50)
  // 50 at 12/s is 4.17 s.
  assert.ok(elapsed >= 50 / 12 && elapsed < 50 / 12 + 0.32, `took ${elapsed} s`)

  for (let i = 0; i < 8; i++) tick(t, player, jitter[i])
  assert.equal(player.armor, 50, 'went past the max')
})

test('armor: a hit that does damage during the delay or the refill restarts the delay', (t) => {
  mockDate(t)
  const player = addPlayer()
  player.hit(40)

  advance(t, 3000)
  player.hit(1) // does damage: the delay restarts from here
  assert.equal(player.armor, 9)

  tick(t, player, 3999 - 250)
  tick(t, player, 250) // 3999 ms after the second hit
  assert.equal(player.armor, 9, 'the second hit did not restart the delay')

  tick(t, player, 251)
  tick(t, player, 250)
  assert.ok(player.armor > 9)

  const before = player.armor
  player.hit(1)
  tick(t, player, 250)
  assert.equal(player.armor, before - 1, 'a hit during the refill did not stop it')
})

test('armor: a damaging hit drops the refill\'s carried fraction, so each refill starts from zero', (t) => {
  mockDate(t)
  const player = addPlayer()
  player.hit(10)
  advance(t, 4000)
  tick(t, player, 150) // 1.8: one point added, 0.8 carried
  assert.equal(player.armor, 41)

  player.hit(1)
  assert.equal(player.armor, 40)
  advance(t, 4000)
  tick(t, player, 50) // 0.6 from zero; with the 0.8 kept it would be 1.4
  assert.equal(player.armor, 40, 'the carry from before the hit was kept')
})

test('armor: a hit floored to zero does not restart the delay', (t) => {
  mockDate(t)
  const player = addPlayer()
  player.hit(30)

  advance(t, 3900)
  player.damageReduction = 0.5
  player.hit(1) // floor(0.5) = 0
  assert.deepEqual([player.armor, player.hp], [20, 100])

  // 4000 ms after the hit that did damage: the refill runs, 1.2 then 3.0
  // (plus the 0.2 carried), so 20 + 1 + 3.
  tick(t, player, 100)
  tick(t, player, 250)
  assert.equal(player.armor, 24, 'a zero-damage hit held the refill off')
})

test('armor: area damage in the same tick holds the refill off before it runs', (t) => {
  mockDate(t)
  const player = addPlayer()
  player.hit(30)
  advance(t, 4000)

  // A stand-in for a breath: hits everything on the plane for 1 a tick.
  World.AREA_EFFECT.push({
    tag: 0,
    target: undefined,
    overlaps: () => true,
    getEffect: () => 1
  } as unknown as (typeof World.AREA_EFFECT)[number])

  player.update(DT)
  assert.equal(player.armor, 19, 'refilled in the tick a breath landed')
})

test('armor: a bare unit (no archetype) takes damage straight to hp and never refills', (t) => {
  mockDate(t)
  const unit = new Unit(32, X, Y, 10, 0)
  unit.hp = 50
  unit.maxVelocity = 0
  unit.hit(10)
  assert.deepEqual([unit.armor, unit.hp], [0, 40])
  advance(t, 10_000)
  unit.update(DT)
  assert.equal(unit.armor, 0)
})

// --- mobs are unchanged ---------------------------------------------------------

test('armor: mobs take damage straight to hp, as before', () => {
  for (const [archetype, hp] of [[ARCHETYPES.grunt, 50], [ARCHETYPES.boss, 300], [ARCHETYPES.gunner, 40]] as const) {
    const mob = new Mob(X, Y, 0, archetype)
    mob.dirtyFields.clear()
    mob.hit(12)
    assert.deepEqual([mob.armor, mob.hp], [0, hp - 12], archetype.key)
    assert.equal(mob.dirtyFields.has('armor'), false, `${archetype.key}: armor marked dirty`)
    mob.damageReduction = 0.5
    mob.hit(12)
    assert.equal(mob.hp, hp - 18, `${archetype.key}: Defend-style reduction`)
  }
})
