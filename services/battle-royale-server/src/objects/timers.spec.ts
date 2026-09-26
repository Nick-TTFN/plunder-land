import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import Mob from './mob'
import { ARCHETYPES } from '../archetypes/archetypes'
import { Unit } from './unit'
import { GameObject, ObjectType } from './gameobject'
import type Throwable from './throwable'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { Defend } from '../skills/defend'
import { IceBreath } from '../skills/icebreath'
import { FireBreath } from '../skills/firebreath'
import { StoneWall } from '../skills/stonewall'

/**
 * `Timers` replaced every world-mutating setTimeout (`move-timers-into-tick`).
 * These cover the three things that change was for: an expiry runs inside the
 * tick and cannot take it down, a timer goes with its owner, and a projectile's
 * lifetime no longer depends on its skill's cooldown being longer.
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
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
}

/** Move the clock and run what fell due, as `World.update` does first thing. */
function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function playerAt (x: number, y: number): Player {
  const player = new Player(x, y, 0, 'caster')
  World.PLAYERS.push(player)
  return player
}

function flyThrowables (): void {
  World.updateProjectiles(DT)
}

// --- the list itself ---------------------------------------------------------

test('timers run in due order, once, and not before they are due', (t) => {
  mockClock(t)
  const ran: string[] = []
  Timers.schedule(200, () => ran.push('b'))
  Timers.schedule(100, () => ran.push('a'))
  Timers.schedule(200, () => ran.push('c')) // same due as b: scheduling order

  advance(t, 99)
  assert.deepEqual(ran, [])
  advance(t, 101)
  assert.deepEqual(ran, ['a', 'b', 'c'])
  advance(t, 1000)
  assert.deepEqual(ran, ['a', 'b', 'c'])
  assert.equal(Timers.size, 0)
})

test('a timer cancelled by an earlier one in the same batch does not run', (t) => {
  mockClock(t)
  const ran: string[] = []
  const owner = {}
  Timers.schedule(10, () => { Timers.cancelOwner(owner) })
  Timers.schedule(10, () => ran.push('owned'), owner)
  advance(t, 10)
  assert.deepEqual(ran, [])
})

test('a timer scheduled while the list runs waits for a later run', (t) => {
  mockClock(t)
  const ran: string[] = []
  Timers.schedule(10, () => { Timers.schedule(0, () => ran.push('inner')) })
  advance(t, 10)
  assert.deepEqual(ran, [])
  advance(t, 0)
  assert.deepEqual(ran, ['inner'])
})

// --- inside the error boundary -----------------------------------------------

test('an expiry that throws is logged, and the tick and its other expiries go on', (t) => {
  mockClock(t)
  const logged = t.mock.method(console, 'error', () => {})
  const world = new World(4000)

  let throws = 0
  const ran: string[] = []
  Timers.schedule(0, () => { throws++; throw new Error('boom') })
  Timers.schedule(0, () => ran.push('after'))
  const mobsBefore = World.MOBS.length

  t.mock.timers.tick(1)
  assert.doesNotThrow(() => { world.update(DT) })

  assert.equal(throws, 1)
  assert.deepEqual(ran, ['after'], 'the next expiry in the batch did not run')
  // The mob and boss spawners are the last things in World.update: the tick
  // reached its end.
  assert.ok(World.MOBS.length > mobsBefore, 'the rest of the tick was skipped')
  assert.ok(logged.mock.calls.some((c) => c.arguments[0] === 'timer'), 'the throw was not logged')

  // Gone after one attempt: a throwing timer does not throw on every tick.
  t.mock.timers.tick(250)
  world.update(DT)
  assert.equal(throws, 1)
})

// --- owners ------------------------------------------------------------------

test('a mob\'s attack cooldown is cancelled when the mob dies', (t) => {
  mockClock(t)
  const player = playerAt(1000, 2000)
  const living = new Mob(1500, 2000, 0)
  const dying = new Mob(2000, 2000, 0)
  living.onCollideWithPlayer(player)
  dying.onCollideWithPlayer(player)
  assert.equal(living.canAttack, false)
  assert.equal(dying.canAttack, false)

  dying.destroy()
  advance(t, ARCHETYPES.grunt.contact.cooldownMs)

  assert.equal(living.canAttack, true, 'the cooldown never ended')
  assert.equal(dying.canAttack, false, 'a dead mob\'s cooldown still ran')
})

test('a player who exits takes their pending Defend with them', (t) => {
  mockClock(t)
  const player = playerAt(1000, 2000)
  assert.equal(new Defend(player).execute(), true)
  const reduced = player.damageReduction
  assert.ok(reduced > 0)

  player.exit()
  advance(t, 3000)

  assert.equal(player.damageReduction, reduced, 'an exited player\'s Defend still ran')
})

test('a destroyed or exited object\'s id is still freed a second later', (t) => {
  mockClock(t)
  GameObject.FreedIDs.length = 0
  const dead = playerAt(1000, 2000)
  const gone = playerAt(1200, 2000)
  dead.destroy()
  gone.exit()

  advance(t, 999)
  assert.deepEqual(GameObject.FreedIDs, [])
  advance(t, 1)
  assert.deepEqual(GameObject.FreedIDs.slice().sort(), [dead.id, gone.id].sort())
})

test('a breath is removed on time even if its caster dies first', (t) => {
  mockClock(t)
  const player = playerAt(1000, 2000)
  assert.equal(new IceBreath(player).execute(), true)
  const boss = new Mob(2000, 2000, 0)
  assert.equal(new FireBreath(boss).execute(), true)
  assert.equal(World.AREA_EFFECT.length, 2)

  player.destroy()
  boss.destroy()
  advance(t, 1000)

  assert.equal(World.AREA_EFFECT.length, 0, 'a dead caster\'s breath outlived its lifetime')
})

test('a stone wall outlives its caster and still comes down on time', (t) => {
  mockClock(t)
  const player = playerAt(1000, 2000)
  assert.equal(new StoneWall(player).execute(), true)
  const stones = World.OBSTACLES.length
  assert.ok(stones > 0)

  player.destroy()
  advance(t, StoneWall.LIFETIME - 1)
  assert.equal(World.OBSTACLES.length, stones, 'the wall fell with its caster')
  advance(t, 1)
  assert.equal(World.OBSTACLES.length, 0)
})

// --- lifetime is no longer tied to cooldown ----------------------------------

test('Defend re-cast inside its lifetime is not ended by the first cast\'s timer', (t) => {
  mockClock(t)
  const player = playerAt(1000, 2000)
  const defend = new Defend(player)
  defend.cooldown = 1000 // below the 3000 ms lifetime
  assert.equal(defend.execute(), true)
  advance(t, 2000)
  assert.equal(defend.execute(), true, 'the re-cast was refused')

  advance(t, 1000) // 3000 ms after the first cast
  assert.ok(player.damageReduction > 0, 'the first cast\'s timer ended the re-cast')
  advance(t, 2000) // 3000 ms after the re-cast
  assert.equal(player.damageReduction, 0)
})

const PROJECTILES = [
  { name: 'fireball', make: (owner: Unit) => new ThrowFireball(owner) },
  { name: 'icicle', make: (owner: Unit) => new Throwicicle(owner) }
]

for (const skill of PROJECTILES) {
  test(`two ${skill.name}s in flight with the cooldown below their flight each end on their own`, (t) => {
    // Hex-cells P3: a projectile ends at the end of its line, on its own 5th
    // tick, not on a 1200 ms timer; nothing of one may end the other.
    mockClock(t)
    const player = playerAt(1000, 2000)
    const cast = skill.make(player)
    cast.cooldown = 500 // under the 5 ticks of a flight
    let explosions = 0
    const explode = cast.explode.bind(cast)
    cast.explode = (target, struck) => { explosions++; explode(target, struck) }

    assert.equal(cast.execute(), true)
    const first = World.PROJECTILES[0]
    flyThrowables()
    flyThrowables()
    advance(t, 500)
    assert.equal(cast.execute(), true, 'the second cast was refused')
    const second = World.PROJECTILES.find((p) => p !== first)
    assert.ok(second !== undefined)

    for (let i = 0; i < 2; i++) flyThrowables()
    assert.equal(first.destroyed, false, 'the first ended early')
    flyThrowables()
    assert.equal(first.destroyed, true, 'the first outlived its 5th tick')
    assert.equal(second.destroyed, false, 'the first\'s end took the second with it')

    flyThrowables()
    assert.equal(second.destroyed, false, 'the second ended early')
    flyThrowables()
    assert.equal(second.destroyed, true, 'the second never ended')

    assert.equal(explosions, 2)
    assert.equal(World.PROJECTILES.length, 0)
    assert.equal(World.OBSTACLES.length, 0)
    assert.equal(Timers.size, 2, 'only the two freed-id timers should be left')
    advance(t, 5000)
    assert.equal(explosions, 2, 'a timer ended one again')
  })

  test(`a ${skill.name} that hits something does not explode again when its lifetime ends`, (t) => {
    mockClock(t)
    const player = playerAt(1000, 2000)
    const cast = skill.make(player)
    let explosions = 0
    const explode = cast.explode.bind(cast)
    cast.explode = (target, struck) => { explosions++; explode(target, struck) }
    const target = new Unit(ObjectType.Mob, 1200, 2000, 10, 0)
    target.hp = 1000
    World.MOBS.push(target)
    // A bystander that the splice of an already-removed projectile would take.
    const rock = { type: ObjectType.Obstacle } as unknown as GameObject

    assert.equal(cast.execute(), true)
    const projectile = World.PROJECTILES[0]
    World.OBSTACLES.push(rock)
    for (let i = 0; i < 4 && !projectile.destroyed; i++) flyThrowables()
    assert.equal(projectile.struck, target, 'it never hit')
    const hpAfterHit = target.hp

    advance(t, 5000)

    assert.equal(explosions, 1, 'it exploded again at the end of its lifetime')
    assert.equal(target.hp, hpAfterHit)
    assert.deepEqual(World.OBSTACLES, [rock])
  })
}

// server-cpu-trim: `run` returns without scanning while nothing is due. These
// pin that the shortcut never delays or loses a timer.

test('a run with nothing due runs nothing, and a later timer still runs on time', () => {
  Timers.clear()
  const now = Date.now()
  const ran: string[] = []
  Timers.schedule(1000, () => ran.push('late'))
  Timers.run(now)
  Timers.run(now + 500)
  assert.deepEqual(ran, [])
  Timers.run(now + 1000)
  assert.deepEqual(ran, ['late'])
  assert.equal(Timers.size, 0)
})

test('a timer scheduled after a skipped run, due before the earliest one, is not held back', () => {
  Timers.clear()
  const now = Date.now()
  const ran: string[] = []
  Timers.schedule(1000, () => ran.push('late'))
  Timers.run(now) // nothing due: returns without scanning
  Timers.schedule(10, () => ran.push('early'))
  Timers.run(now + 50)
  assert.deepEqual(ran, ['early'])
  Timers.run(now + 1000)
  assert.deepEqual(ran, ['early', 'late'])
})

test('a timer scheduled from inside a running timer is due at its own time', () => {
  Timers.clear()
  const now = Date.now()
  const ran: string[] = []
  Timers.schedule(0, () => {
    ran.push('first')
    Timers.schedule(20, () => ran.push('second'))
  })
  Timers.schedule(5000, () => ran.push('last'))
  Timers.run(now + 1)
  assert.deepEqual(ran, ['first'])
  Timers.run(now + 100)
  assert.deepEqual(ran, ['first', 'second'])
})

test('cancelling the earliest timer does not stop the next one', () => {
  Timers.clear()
  const now = Date.now()
  const ran: string[] = []
  const first = Timers.schedule(10, () => ran.push('first'))
  Timers.schedule(30, () => ran.push('second'))
  Timers.cancel(first)
  Timers.run(now + 20)
  assert.deepEqual(ran, [])
  Timers.run(now + 40)
  assert.deepEqual(ran, ['second'])
})
