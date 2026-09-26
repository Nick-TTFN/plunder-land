import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { GameObject } from '../objects/gameobject'
import GuardPosition from '../ai/guardposition'
import UseSkillOnTarget from '../ai/useskillontarget'
import { RangedAttack } from '../skills/rangedattack'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { ARCHETYPES } from './archetypes'

/**
 * unit-archetypes step 2: the gunner (design section 1 and section 7 row 2,
 * decision #23). It holds off at `standoff` 5 cells, fires RangedAttack for 10
 * every 1500 ms or more only while its target is within 6 cells, deals no
 * contact damage, and is provoked like a grunt.
 *
 * Grunt and boss are pinned by baseline.spec.ts, which this step must leave
 * passing unchanged: `standoff` 0 and an unset `withinCells` are today's
 * behaviour.
 *
 * `Math.random` is pinned for every test. An idle guard picks a wander goal
 * with it (a cell of home's 1-ring patch), and one step toward a random goal
 * decided whether a gunner crossed into the next cell before or after it came
 * in range: the provoked test failed about half its runs that way. At 0.5 the
 * goal is home itself (the middle of the patch), so an idle gunner stays put.
 */

const DT = 0.25

/** `Multiplayer.effect` calls: [type, originator]. */
let effects: Array<[number, GameObject]> = []

beforeEach(() => {
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  effects = []
  Multiplayer.Instance = {
    create: noop,
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
})

afterEach(() => {
  mock.restoreAll()
})

/** A cell centre, so hex distances along the q axis are exact multiples of Hex.SIZE. */
const HOME = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))

function mockDate (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

/** Move the mocked clock and run what fell due, as `World.update` does first. */
function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function addGunner (at: Vector = HOME): Mob {
  const gunner = new Mob(at.x, at.y, 0, ARCHETYPES.gunner)
  World.MOBS.push(gunner)
  return gunner
}

function addPlayer (at: Vector, name = 'p1'): Player {
  const player = new Player(at.x, at.y, 0, name)
  // unit-archetypes step 3: an emptied pool, so hp measures the gunner's shots
  // as it did before the pool existed. The pool is armor.spec.ts's.
  player.armor = 0
  World.PLAYERS.push(player)
  return player
}

/** `cells` cells east of HOME along the q axis: exactly `cells * Hex.SIZE` units. */
const east = (cells: number): Vector => Hex.toPosition(Hex.toCell(HOME).add(new Vector(cells, 0)))

const shots = (gunner: Mob): number => effects.filter(([type, obj]) => type === 3 && obj === gunner).length

// --- the entry ------------------------------------------------------------------

test('gunner: stats, skill overrides and routines from its table row', () => {
  const gunner = addGunner()
  assert.equal(ARCHETYPES.gunner.id, 8)
  assert.equal(gunner.maxHp, 40)
  assert.equal(gunner.hp, 40)
  assert.equal(gunner.radius, 24)
  assert.equal(gunner.loot, 75)
  assert.equal(gunner.level, undefined)
  assert.deepEqual(ARCHETYPES.gunner.contact, { damage: 0, cooldownMs: 0 })
  assert.deepEqual(ARCHETYPES.gunner.killStats, ['mobKills'])

  assert.deepEqual(gunner.routines.map((r) => r.constructor), [GuardPosition, UseSkillOnTarget])
  const guard = gunner.routines[0] as GuardPosition
  assert.deepEqual(
    [guard.spec.acquire, guard.spec.lose, guard.spec.idleSpeed, guard.spec.chaseSpeed, guard.spec.standoff],
    // hex-cells P1, deliberate (decision #32): acquire, lose and standoff are
    // rings. Was [270, 315, 30, 80, 225] in units.
    [6, 7, 30, 80, 5])
  const use = gunner.routines[1] as UseSkillOnTarget
  assert.equal(use.withinCells, 6)
  assert.ok(use.skill instanceof RangedAttack)
  assert.deepEqual([use.skill.damage, use.skill.cooldown, use.skill.range], [10, 1500, 6])
  assert.equal(use.skill.owner, gunner)
})

test('grunt and boss keep standoff 0 and no withinCells (today\'s behaviour)', () => {
  for (const archetype of [ARCHETYPES.grunt, ARCHETYPES.boss]) {
    for (const spec of archetype.routines) {
      if (spec.kind === 'guard') assert.equal(spec.standoff, 0, archetype.key)
      else assert.equal(spec.withinCells, undefined, archetype.key)
    }
  }
})

// --- standoff -------------------------------------------------------------------

// hex-cells P1, deliberate (decision #32): the standoff is 5 rings. This held
// "just inside 225 units, in [205, 225)".
test('gunner: closes on a target, then holds at 5 cells and never touches', (t) => {
  mockDate(t)
  const gunner = addGunner()
  const player = addPlayer(east(6))
  const rings = (): number => Hex.distance(Hex.toCell(gunner.position), Hex.toCell(player.position))

  let nearest = Infinity
  for (let i = 0; i < 40; i++) {
    gunner.update(DT)
    advance(t, 250)
    nearest = Math.min(nearest, rings())
  }

  assert.equal(gunner.target, player)
  // It stops on the first tick that ends 5 cells from the target.
  assert.equal(rings(), 5, 'holding at the wrong distance')
  assert.equal(nearest, 5, `came as close as ${nearest} cells`)
  // hex-cells P2: it steps by cells now and no longer steers by `direction`,
  // so "still moving" is a step in progress.
  assert.equal(gunner.stepTo, undefined, 'still moving while inside the standoff')
})

test('gunner: a target that walks away is followed again', (t) => {
  mockDate(t)
  const gunner = addGunner()
  const player = addPlayer(HOME.add(new Vector(200, 0)))
  gunner.update(DT)
  assert.equal(gunner.target, player)
  assert.deepEqual(gunner.position, HOME, 'closed in from inside the standoff')

  player.position = gunner.position.add(new Vector(260, 0))
  gunner.update(DT)
  assert.ok(gunner.position.x > HOME.x && gunner.stepTo !== undefined, 'did not follow a target outside the standoff')
  assert.ok(gunner.facing.x > 0.99, 'did not step toward it')
})

// --- withinCells ------------------------------------------------------------------

test('gunner: fires at a target 6 cells away, not at 7', (t) => {
  mockDate(t)
  for (const [cells, fires] of [[6, true], [7, false]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    effects = []
    const gunner = addGunner()
    const player = addPlayer(east(cells))
    // Provoked, so the target is set whatever the acquire distance says.
    GuardPosition.provoke(gunner, player)
    assert.equal(gunner.target, player)
    assert.equal(Hex.distance(Hex.toCell(gunner.position), Hex.toCell(player.position)), cells)

    gunner.update(DT)
    assert.equal(shots(gunner), fires ? 1 : 0, `shots at ${cells} cells`)
    assert.equal(player.hp, fires ? 90 : 100, `player hp at ${cells} cells`)
  }
})

test('gunner: hits a target at the far edge of a cell exactly 6 away (decision #24)', (t) => {
  mockDate(t)
  const gunner = addGunner()
  // A cell is a pointy-top hexagon with an inradius of Hex.SIZE / 2 (22.5) and
  // corners 26 out at 30 degrees. Its farthest point from HOME is the corner
  // at (+22.5, +13): 292.8 away. This is just inside it, still in the cell.
  const edge = east(6).add(new Vector(22, 12.5))
  const player = addPlayer(edge)
  assert.equal(Hex.distance(Hex.toCell(gunner.position), Hex.toCell(player.position)), 6)
  const reach = player.position.sub(gunner.position).getMagnitude()
  assert.ok(reach > 290, `test point only ${reach} away`)

  GuardPosition.provoke(gunner, player)
  gunner.update(DT)
  assert.equal(shots(gunner), 1)
  assert.equal(player.hp, 90, `a shot at a target ${reach.toFixed(1)} away fell short`)
})

test('gunner: holding fire out of range does not spend the cooldown', (t) => {
  mockDate(t)
  const gunner = addGunner()
  const player = addPlayer(east(7))
  GuardPosition.provoke(gunner, player)
  gunner.update(DT)
  assert.equal(shots(gunner), 0)

  // Straight back in range with no time passed: fires at once.
  gunner.position = HOME
  player.position = east(5)
  gunner.update(DT)
  assert.equal(shots(gunner), 1)
})

test('gunner: 10 a shot, and never again inside 1500 ms', (t) => {
  mockDate(t)
  const gunner = addGunner()
  const player = addPlayer(east(4))
  gunner.update(DT)
  assert.equal(gunner.target, player)
  assert.equal(player.hp, 90)

  advance(t, 1499)
  gunner.update(DT)
  assert.equal(player.hp, 90, 'fired again inside 1500 ms')
  advance(t, 1)
  gunner.update(DT)
  assert.equal(player.hp, 80, 'did not fire again at 1500 ms')
  assert.equal(shots(gunner), 2)
})

// --- zero contact damage ------------------------------------------------------------

test('gunner: touching a player deals nothing, arms no cooldown and calls no hit', (t) => {
  mockDate(t)
  const gunner = addGunner()
  // The contact path alone: without routines it never targets or shoots.
  gunner.routines.length = 0
  const player = addPlayer(HOME.add(new Vector(20, 0)))
  const hits = t.mock.method(player, 'hit')

  gunner.update(DT)
  assert.equal(player.hp, 100)
  assert.equal(hits.mock.callCount(), 0, 'hit() was called on touch')
  assert.equal(gunner.canAttack, true, 'a contact cooldown was armed')
  assert.equal(Timers.size, 0, 'a timer was scheduled')
  // hex-cells P2: nothing is pushed apart any more; it was held at 24 + 14.
  assert.deepEqual(player.position, HOME.add(new Vector(20, 0)), 'the player was moved')
})

test('gunner: a player at 0 hp that it touches is not killed or credited by the touch', (t) => {
  mockDate(t)
  const gunner = addGunner()
  gunner.routines.length = 0
  const player = addPlayer(HOME.add(new Vector(20, 0)))
  player.hp = 0 // hit(0) on this would destroy it and report a kill
  const kills = t.mock.method(gunner, 'onKill')

  gunner.update(DT)
  assert.equal(player.destroyed, false)
  assert.equal(kills.mock.callCount(), 0)
})

// --- provoked like a grunt ------------------------------------------------------------

test('gunner: a player shooting it from beyond acquire range is chased and shot back', (t) => {
  mockDate(t)
  const gunner = addGunner()
  // 7 cells (315): beyond acquire (270), inside the player's 8-cell range.
  const player = addPlayer(east(7))
  gunner.update(DT)
  assert.equal(gunner.target, undefined, 'noticed a player beyond acquire')

  assert.equal(player.skills[2].execute(Hex.toCell(gunner.position)), true)
  assert.equal(gunner.hp, 40 - World.config.ranged)
  assert.equal(gunner.target, player, 'not provoked')
  assert.equal(gunner.maxVelocity, 80, 'not at chase speed')

  // Chases (a target beyond the standoff) and, once within 6 cells, fires.
  const before = gunner.position.x
  gunner.update(DT)
  assert.ok(gunner.position.x > before, 'did not close in')
  for (let i = 0; i < 8 && shots(gunner) === 0; i++) {
    advance(t, 250)
    gunner.update(DT)
  }
  assert.equal(shots(gunner), 1, 'never fired back')
  assert.equal(player.hp, 90)
})
