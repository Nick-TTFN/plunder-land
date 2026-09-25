import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import Exit from '../objects/exit'
import Obstacle from '../objects/obstacle'
import { ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import GuardPosition from './guardposition'
import { type Archetype, ARCHETYPES } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * hex-cells P1, decision #32: the guard's ranges in rings, each boundary
 * included. Grunt and boss 4 / 5 / 0 and the gunner's acquire and standoff
 * are pinned by baseline.spec.ts and gunner.spec.ts; this covers the rest:
 * the gunner's lose ring, who is noticed when several are in range, the
 * provoked chase-off and the wander goal.
 */

const DT = 0.25

beforeEach(() => {
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  Multiplayer.Instance = { create: noop, update: noop, destroy: noop, effect: noop } as unknown as Multiplayer
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

afterEach(() => { mock.restoreAll() })

const HOME = Hex.toCell(new Vector(2000, 2000))
const at = (dq: number, dr: number = 0): Vector => Hex.toPosition(new Vector(HOME.x + dq, HOME.y + dr))

function mobAt (archetype: Archetype, dq = 0, dr = 0): Mob {
  const p = at(dq, dr)
  const mob = new Mob(p.x, p.y, 0, archetype)
  World.MOBS.push(mob)
  return mob
}

function playerAt (dq: number, dr = 0, id = 'p1'): Player {
  const p = at(dq, dr)
  const player = new Player(p.x, p.y, 0, id)
  World.PLAYERS.push(player)
  return player
}

const guardOf = (unit: Unit): GuardPosition => unit.routines.find((r) => r instanceof GuardPosition) as GuardPosition

function mockDate (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

test('the gunner keeps a target at 7 rings and drops it at 8', (t) => {
  mockDate(t)
  for (const [rings, kept] of [[7, true], [8, false]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const gunner = mobAt(ARCHETYPES.gunner)
    gunner.routines.length = 1 // the guard alone: no shooting
    const player = playerAt(6)
    gunner.update(DT)
    assert.equal(gunner.target, player, 'test setup: not acquired at 6')
    gunner.position = at(0)
    player.position = at(rings)
    gunner.update(DT)
    assert.equal(gunner.target === player, kept, `target kept at ${rings} rings`)
  }
})

test('the nearest player by rings is noticed, not the last one found', (t) => {
  mockDate(t)
  const grunt = mobAt(ARCHETYPES.grunt)
  const far = playerAt(-4, 0, 'far')
  const near = playerAt(2, 0, 'near')
  const farther = playerAt(0, 3, 'farther')
  grunt.update(DT)
  assert.equal(grunt.target, near)
  assert.notEqual(grunt.target, far)
  assert.notEqual(grunt.target, farther)
})

test('a tie in rings goes to the lowest id, whatever order they were added in', (t) => {
  mockDate(t)
  const grunt = mobAt(ARCHETYPES.grunt)
  const a = playerAt(3, 0, 'aa')
  const b = playerAt(-3, 0, 'bb')
  // Filed in the reverse order of their ids.
  World.PLAYERS.reverse()
  const lower = a.id < b.id ? a : b
  grunt.update(DT)
  assert.equal(grunt.target, lower)
})

test('a dead or extracted player is not noticed, and a live one behind it is', (t) => {
  mockDate(t)
  const grunt = mobAt(ARCHETYPES.grunt)
  const dead = playerAt(1, 0, 'dead')
  const gone = playerAt(0, 1, 'gone')
  const live = playerAt(3, 0, 'live')
  dead.hit(9999)
  gone.exit()
  grunt.update(DT)
  assert.equal(grunt.target, live)
})

test('provoked from 8 rings, a grunt chases until the attacker is more than 9 away', () => {
  const grunt = mobAt(ARCHETYPES.grunt)
  grunt.routines.length = 1
  const player = playerAt(8)
  GuardPosition.provoke(grunt, player)
  assert.equal(guardOf(grunt).loseRings, 9)

  // Hold the grunt still: the rule is about rings, not about how it walks.
  player.position = at(9)
  grunt.position = at(0)
  grunt.update(DT)
  assert.equal(grunt.target, player, 'dropped at 9 rings')
  grunt.position = at(0)
  player.position = at(10)
  grunt.update(DT)
  assert.equal(grunt.target, undefined, 'kept at 10 rings')
})

test('provoked from close in, the chase-off is still the usual lose range', () => {
  const grunt = mobAt(ARCHETYPES.grunt)
  const player = playerAt(2)
  GuardPosition.provoke(grunt, player)
  assert.equal(guardOf(grunt).loseRings, 5)
})

test('a wander goal is the centre of a free cell within 1 ring of home, never a rock or a gate', () => {
  const grunt = mobAt(ARCHETYPES.grunt)
  const guard = guardOf(grunt)
  // Block four of the seven, leave (0, 0), (0, 1) and (1, -1).
  for (const [dq, dr] of [[-1, 0], [-1, 1], [1, 0]]) new Obstacle(at(dq, dr).x, at(dq, dr).y, 0) // eslint-disable-line no-new
  World.addObstacle(new Exit(at(0, -1).x, at(0, -1).y, 0))

  const goals = new Set<string>()
  for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
    mock.method(Math, 'random', () => r)
    const goal = guard.wanderGoal()
    const cell = Hex.toCell(goal)
    const centre = Hex.toPosition(cell)
    assert.deepEqual([goal.x, goal.y], [centre.x, centre.y], 'not a cell centre')
    goals.add(`${cell.x - HOME.x},${cell.y - HOME.y}`)
  }
  assert.deepEqual([...goals].sort(), ['0,0', '0,1', '1,-1'])
})

test('a guard with nowhere free around home wanders to home', () => {
  const grunt = mobAt(ARCHETYPES.grunt)
  for (let dq = -1; dq <= 1; dq++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (Hex.distance(new Vector(0, 0), new Vector(dq, dr)) <= 1) new Obstacle(at(dq, dr).x, at(dq, dr).y, 0) // eslint-disable-line no-new
    }
  }
  const goal = guardOf(grunt).wanderGoal()
  assert.deepEqual([goal.x, goal.y], [at(0).x, at(0).y])
})

test('NEAREST_IN_CELLS includes its boundary ring and nothing past it', () => {
  const four = playerAt(4, 0, 'four')
  assert.equal(World.NEAREST_IN_CELLS(HOME, 4, 0, ObjectType.Player), four)
  assert.equal(World.NEAREST_IN_CELLS(HOME, 3, 0, ObjectType.Player), undefined)
})
