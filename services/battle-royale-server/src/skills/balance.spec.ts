import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph anywhere but multiplayer leaves
// GameObject undefined, so go in the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Player from '../objects/player'
import Mob from '../objects/mob'
import Boss from '../objects/boss'
import { Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import GuardPosition from '../ai/guardposition'
import { RangedAttack } from './rangedattack'
import { IceBreath } from './icebreath'
import { FireBreath } from './firebreath'
import { Throwicicle } from './throwicicle'
import { MeleeAttack } from './meleeattack'
import { ThrowFireball } from './throwfireball'
import Slowdown from '../buffs/slowdown'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Behaviour changes from the balance pass (decision #16): N4, a ranged shot
 * stops at the first unit on its line; N1, hitting a mob makes it turn on you.
 */

const DT = 0.25

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop
  } as unknown as Multiplayer

  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
})

/** A player who has never moved, so every aimed skill goes East. */
function shooterAt (x: number, y: number): Player {
  const player = new Player(x, y, 0, 'shooter')
  World.PLAYERS.push(player)
  return player
}

function guardOf (unit: Unit): GuardPosition {
  const routine = unit.routines.find((r) => r instanceof GuardPosition)
  assert.ok(routine !== undefined, 'unit has no GuardPosition')
  return routine as GuardPosition
}

/** One tick in `World.update`'s order. */
function tick (): void {
  for (const player of World.PLAYERS) player.update(DT)
  for (const area of World.AREA_EFFECT) area.update(DT)
  for (const mob of World.MOBS) mob.update(DT)
  for (const obj of World.OBSTACLES) {
    if (obj.type === ObjectType.Throwable) obj.update(DT)
  }
}

/** Mock setTimeout: breaths, mob cooldowns and projectiles all schedule one. */
function mockTimers (t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout'] })
}

// --- N4 ---------------------------------------------------------------------

test('a ranged shot at two units in a line hits only the nearer one', () => {
  const player = shooterAt(1000, 2000)
  // Pushed far first, so a shot that took the first unit in list order rather
  // than the nearest one on the line would hit the wrong one.
  const far = new Unit(ObjectType.Mob, 1000 + 6 * Hex.SIZE, 2000, 10, 0)
  const near = new Unit(ObjectType.Mob, 1000 + 3 * Hex.SIZE, 2000, 10, 0)
  far.hp = near.hp = 100
  World.MOBS.push(far, near)

  assert.equal(new RangedAttack(player).execute(), true, 'ranged refused to cast')

  assert.equal(near.hp, 100 - World.config.ranged, 'the nearer unit was not hit')
  assert.equal(far.hp, 100, 'the shot went through the nearer unit')
})

test('a ranged shot reaches eight cells and no further', () => {
  const player = shooterAt(1000, 2000)
  const outside = new Unit(ObjectType.Mob, 1000 + 9 * Hex.SIZE, 2000, 10, 0)
  outside.hp = 100
  World.MOBS.push(outside)

  assert.equal(new RangedAttack(player).execute(), true)
  assert.equal(outside.hp, 100, 'hit a unit nine cells out')

  // Added only now, so it cannot have shielded the unit above.
  const inside = new Unit(ObjectType.Mob, 1000 + 7.5 * Hex.SIZE, 2000, 10, 0)
  inside.hp = 100
  World.MOBS.push(inside)
  assert.equal(new RangedAttack(player).execute(), true) // a fresh skill: no cooldown
  assert.equal(inside.hp, 100 - World.config.ranged, 'missed a unit 7.5 cells out')
})

// --- N1 ---------------------------------------------------------------------

test('a boss hit from range turns on the shooter and chases them', (t) => {
  mockTimers(t)
  const player = shooterAt(1000, 2000)
  // Six cells: beyond the 200-unit acquire distance and the 250-unit lose
  // distance, inside the 360-unit ranged range.
  const boss = new Boss(1000 + 6 * Hex.SIZE, 2000, 0)
  World.MOBS.push(boss)

  tick() // the boss looks around, finds nothing in 200 units, and idles
  assert.equal(boss.target, undefined, 'the boss saw the player without being hit')
  const idleX = boss.position.x

  assert.equal(new RangedAttack(player).execute(), true)
  assert.equal(boss.hp, boss.maxHP() - World.config.ranged, 'the shot missed the boss')
  assert.equal(boss.target, player, 'the boss did not turn on the shooter')

  for (let i = 0; i < 4; i++) {
    tick()
    t.mock.timers.tick(DT * 1000)
  }

  assert.equal(boss.target, player, 'the boss gave up on a shooter it could still reach')
  assert.ok(boss.position.x < idleX - Hex.SIZE,
    `the boss did not close in: x ${idleX.toFixed(1)} -> ${boss.position.x.toFixed(1)}`)
  assert.equal(boss.maxVelocity, GuardPosition.CHASE_SPEED)
})

test('a fireball from range turns a boss on the thrower', (t) => {
  mockTimers(t)
  const player = shooterAt(1000, 2000)
  const boss = new Boss(1250, 2000, 0) // past the 200-unit acquire distance
  World.MOBS.push(boss)
  tick()
  assert.equal(boss.target, undefined)

  assert.equal(new ThrowFireball(player).execute(), true)
  for (let i = 0; i < 10 && boss.hp === boss.maxHP(); i++) {
    t.mock.timers.tick(DT * 1000)
    for (const obj of World.OBSTACLES) {
      if (obj.type === ObjectType.Throwable) obj.update(DT)
    }
  }
  assert.ok(boss.hp < boss.maxHP(), 'the fireball never hurt the boss')
  assert.equal(boss.target, player, 'the boss did not turn on the thrower')
  t.mock.timers.tick(5000)
})

test('a provoked mob still gives up on a shooter who backs well out of reach', (t) => {
  mockTimers(t)
  const player = shooterAt(1000, 2000)
  const mob = new Mob(1000 + 6 * Hex.SIZE, 2000, 0)
  World.MOBS.push(mob)
  tick()

  new RangedAttack(player).execute()
  assert.equal(mob.target, player)

  player.position = new Vector(1000 - 10 * Hex.SIZE, 2000)
  tick()
  assert.equal(mob.target, undefined, 'chased a shooter sixteen cells away')
})

test('a mob caught in another mob\'s breath does not turn on it', (t) => {
  mockTimers(t)
  const boss = new Boss(1000, 2000, 0)
  const grunt = new Mob(1000 + 2 * Hex.SIZE, 2000, 0)
  World.MOBS.push(boss, grunt)
  guardOf(grunt).targetAquiredAt = Date.now() // no looking around this tick

  assert.equal(new FireBreath(boss).execute(), true) // boss faces East by default
  grunt.update(DT)

  assert.ok(grunt.hp < grunt.maxHP(), 'the breath missed the grunt')
  assert.equal(grunt.target, undefined, 'the grunt turned on the boss')
  t.mock.timers.tick(1000)
})

test('a mob caught in a player\'s breath turns on the player', (t) => {
  mockTimers(t)
  const player = shooterAt(1000, 2000)
  const grunt = new Mob(1000 + 2 * Hex.SIZE, 2000, 0)
  World.MOBS.push(grunt)
  // Suppress looking around, so only the breath can give it a target.
  guardOf(grunt).targetAquiredAt = Date.now()

  assert.equal(new IceBreath(player).execute(), true)
  grunt.update(DT)

  assert.ok(grunt.hp < grunt.maxHP(), 'the breath missed the grunt')
  assert.equal(grunt.target, player, 'the grunt ignored the breath')
  t.mock.timers.tick(1000)
})

test('an icicle provokes an idle mob into a chase at half chase speed', (t) => {
  // The icicle provokes before it slows. The other way round, provoking
  // assigned chase speed over the slow and the mob ran at full speed.
  mockTimers(t)
  const player = shooterAt(1000, 2000)
  const mob = new Mob(1250, 2000, 0) // past the 200-unit acquire distance
  World.MOBS.push(mob)
  tick()
  assert.equal(mob.target, undefined)
  assert.equal(mob.maxVelocity, GuardPosition.IDLE_SPEED)

  assert.equal(new Throwicicle(player).execute(), true)
  for (let i = 0; i < 10 && mob.buffs.length === 0; i++) {
    t.mock.timers.tick(DT * 1000)
    for (const obj of World.OBSTACLES) {
      if (obj.type === ObjectType.Throwable) obj.update(DT)
    }
  }
  assert.equal(mob.buffs.length, 1, 'the icicle never hit the mob')
  assert.equal(mob.target, player, 'the icicle did not provoke the mob')
  assert.equal(mob.maxVelocity, GuardPosition.CHASE_SPEED / 2, 'the slow did not halve the chase')

  // Hitting it again while it already chases you must not undo the slow.
  assert.equal(new RangedAttack(player).execute(), true)
  assert.ok(mob.hp < mob.maxHP() - World.config.ranged, 'the follow-up shot missed')
  assert.equal(mob.maxVelocity, GuardPosition.CHASE_SPEED / 2, 'a second hit cancelled the slow')
  t.mock.timers.tick(5000)
})

test('a slow wears off and gives back exactly what it took', () => {
  // Slowdown.applied used to be a field initialiser, which ran after Buff's
  // constructor had called start() and reset it, so stop() gave back nothing
  // and a slowed player stayed at half speed until they died.
  const player = shooterAt(1000, 2000)
  const speed = player.maxVelocity
  const slow = new Slowdown(player, 2000) // the icicle's own buff type
  player.addBuff(slow)
  assert.equal(player.maxVelocity, speed / 2)

  slow.endTime = Date.now() - 1 // expiry is read off Date.now()
  player.update(DT)

  assert.equal(player.buffs.length, 0)
  assert.equal(player.maxVelocity, speed, 'the slow never wore off')
})

// --- Cell-based areas ---------------------------------------------------------

/** Centre of the cell `dq` steps East of the cell under (1000, 2000). */
function cellCentre (dq: number, dr = 0): Vector {
  const base = Hex.toCell(new Vector(1000, 2000))
  return Hex.toPosition(new Vector(base.x + dq, base.y + dr))
}

function mobAt (at: Vector): Unit {
  const unit = new Unit(ObjectType.Mob, at.x, at.y, 10, 0)
  unit.hp = 1000
  World.MOBS.push(unit)
  return unit
}

test('FIND_IN_CELLS takes a unit by the cell under it, out to exactly N rings', () => {
  const origin = Hex.toCell(cellCentre(0))
  const inside = mobAt(cellCentre(2)) // ring 2 along an axis: 90 u
  const corner = mobAt(cellCentre(1, 1)) // ring 2 between axes: 78 u
  const outside = mobAt(cellCentre(3))
  // Near the edge of a ring-2 cell, 20 u from its centre: in by cell, although
  // at 110 u it is further out than the 90-unit circle the old test drew.
  const edge = mobAt(cellCentre(2).add(new Vector(20, 0)))
  assert.equal(Hex.distance(origin, Hex.toCell(edge.position)), 2, 'test setup: edge left its cell')

  const found = World.FIND_IN_CELLS(origin, 2, 0, ObjectType.Mob)
  assert.ok(found.includes(inside))
  assert.ok(found.includes(corner))
  assert.ok(found.includes(edge))
  assert.ok(!found.includes(outside), 'took a unit three rings out')
  assert.deepEqual(World.FIND_IN_CELLS(origin, 0, 0, ObjectType.Mob), [], 'ring 0 is the origin cell alone')
})

test('melee hits two rings around the caster and nothing in the third', () => {
  const player = shooterAt(cellCentre(0).x, cellCentre(0).y)
  const two = mobAt(cellCentre(-2))
  const three = mobAt(cellCentre(0, 3))

  assert.equal(new MeleeAttack(player).execute(), true)

  assert.ok(two.hp < 1000, 'missed a unit two cells away')
  assert.equal(three.hp, 1000, 'hit a unit three cells away')
  assert.equal(player.hp, player.maxHP(), 'the caster hit themselves')
})

test('IceBreath cones three rings ahead, not the fourth, not its own cell, not behind', (t) => {
  mockTimers(t)
  const at = cellCentre(0)
  const player = shooterAt(at.x, at.y) // never moved: faces East
  const own = mobAt(at.add(new Vector(10, 0))) // same cell as the caster
  const third = mobAt(cellCentre(3))
  const fourth = mobAt(cellCentre(4))
  const side = mobAt(cellCentre(0, 2)) // 60 degrees off East: outside +-45
  const behind = mobAt(cellCentre(-2))

  assert.equal(new IceBreath(player).execute(), true)
  tick()

  assert.ok(third.hp < 1000, 'missed the third ring straight ahead')
  assert.equal(fourth.hp, 1000, 'reached the fourth ring')
  assert.equal(own.hp, 1000, "hit a unit in the caster's own cell")
  assert.equal(side.hp, 1000, 'hit a cell 60 degrees off the facing')
  assert.equal(behind.hp, 1000, 'hit behind the caster')
  t.mock.timers.tick(1000)
})

test('FireBreath cones four rings ahead and not the fifth', (t) => {
  mockTimers(t)
  const at = cellCentre(0)
  const boss = new Boss(at.x, at.y, 0)
  boss.routines.length = 0 // no AI: the test drives the breath
  World.MOBS.push(boss)
  const fourth = mobAt(cellCentre(4))
  const fifth = mobAt(cellCentre(5))

  assert.equal(new FireBreath(boss).execute(), true)
  tick()

  assert.equal(fourth.hp, 1000 - Math.floor(World.config.fire * DT), 'missed the fourth ring')
  assert.equal(fifth.hp, 1000, 'reached the fifth ring')
  t.mock.timers.tick(1000)
})

test('the breath cone follows the caster as they move', (t) => {
  mockTimers(t)
  const at = cellCentre(0)
  const player = shooterAt(at.x, at.y)
  const target = mobAt(cellCentre(5)) // out of reach at the cast

  assert.equal(new IceBreath(player).execute(), true)
  tick()
  assert.equal(target.hp, 1000, 'reached five rings at the cast')

  player.position = cellCentre(2)
  tick()
  assert.ok(target.hp < 1000, 'the cone stayed where it was cast')
  t.mock.timers.tick(1000)
})

for (const [name, make] of [
  ['fireball', (owner: Unit) => new ThrowFireball(owner)],
  ['icicle', (owner: Unit) => new Throwicicle(owner)]
] as const) {
  for (const kind of ['grunt', 'boss'] as const) {
    test(`a ${name} always damages the ${kind} it flies into`, (t) => {
      // Centred on the projectile, a 70-unit blast missed 40/300 grunts and
      // 80/300 bosses it had just hit: the projectile's collider reaches 50 + a
      // unit's radius. Centred on the struck unit's cell it cannot miss. The
      // sweep puts the target at every point across one tick of flight.
      const N = 75
      let damaged = 0
      for (let i = 0; i < N; i++) {
        World.OBSTACLES.length = 0
        World.PLAYERS.length = 0
        World.MOBS.length = 0
        const player = shooterAt(1000, 2000)
        const x = 1150 + i
        const mob = kind === 'grunt' ? new Mob(x, 2000, 0) : new Boss(x, 2000, 0)
        mob.routines.length = 0 // stand still
        World.MOBS.push(mob)

        t.mock.timers.enable({ apis: ['setTimeout'] })
        assert.equal(make(player).execute(), true)
        for (let k = 0; k < 10 && World.OBSTACLES.some((o) => !o.destroyed); k++) {
          t.mock.timers.tick(DT * 1000)
          for (const obj of World.OBSTACLES) {
            if (obj.type === ObjectType.Throwable && !obj.destroyed) obj.update(DT)
          }
        }
        if (mob.hp < mob.maxHP()) damaged++
        t.mock.timers.reset()
      }
      assert.equal(damaged, N, `damaged ${damaged}/${N}`)
    })
  }

  test(`a ${name} that runs out of lifetime bursts one ring around its own cell`, (t) => {
    mockTimers(t)
    const player = shooterAt(1000, 2000)
    assert.equal(make(player).execute(), true)
    const projectile = World.OBSTACLES.find((o) => o.type === ObjectType.Throwable)!
    // Park it on a known cell in empty space, then let its lifetime run out.
    const at = cellCentre(20)
    projectile.position = at
    projectile.direction = new Vector(0, 0)
    const neighbour = mobAt(cellCentre(20, -1))
    const twoOut = mobAt(cellCentre(22))

    t.mock.timers.tick(5000)

    assert.ok(projectile.destroyed)
    assert.ok(neighbour.hp < 1000, 'missed a unit next to where it expired')
    assert.equal(twoOut.hp, 1000, 'hit a unit two rings from where it expired')
  })
}
