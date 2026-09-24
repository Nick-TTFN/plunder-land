import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Obstacle from '../objects/obstacle'
import Portal from '../objects/portal'
import Mob from '../objects/mob'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { StoneWall } from './stonewall'

/**
 * StoneWall (`fix-stonewall-gap`, decision #22).
 */

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

function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function playerAt (x: number, y: number): Player {
  const player = new Player(x, y, 0, 'caster')
  World.PLAYERS.push(player)
  return player
}

/** A caster standing on a cell centre, facing along `Hex.DIRECTIONS[d]`. */
function casterOn (cell: Vector, d: number): Player {
  const centre = Hex.toPosition(cell)
  const caster = playerAt(centre.x, centre.y)
  const step = Hex.toPosition(Hex.DIRECTIONS[d])
  caster.facing = step.normalised()
  return caster
}

const ORIGIN = Hex.toCell(new Vector(2000, 2000))

function offset (cell: Vector, dq: number, dr: number): Vector {
  return new Vector(cell.x + dq, cell.y + dr)
}

function key (cell: Vector): number {
  return Hex.key(cell.x, cell.y)
}

function stones (): GameObject[] {
  return World.OBSTACLES.filter((o) => o.type === ObjectType.Obstacle)
}

function stoneKeys (): number[] {
  return stones().map((s) => key(Hex.toCell(s.position))).sort((a, b) => a - b)
}

/** The three cells behind a caster facing d, written out rather than derived. */
function behind (cell: Vector, d: number): number[] {
  const back = (d + 3) % 6
  return [back + 5, back, back + 1]
    .map((i) => key(Hex.neighbour(cell, i % 6)))
    .sort((a, b) => a - b)
}

test('a stone that is already out of OBSTACLES does not take another obstacle with it', (t) => {
  mockClock(t)
  const caster = playerAt(2000, 2000)
  assert.equal(new StoneWall(caster).execute(), true)
  assert.ok(World.OBSTACLES.length > 0, 'no stones placed')

  // The stones leave the list by some other route (a sweep, a reset); a rock
  // that stays is what `splice(indexOf(stone) = -1, 1)` would take instead.
  World.OBSTACLES.length = 0
  const rock = { type: ObjectType.Obstacle } as unknown as GameObject
  World.OBSTACLES.push(rock)

  advance(t, StoneWall.LIFETIME)
  assert.deepEqual(World.OBSTACLES, [rock])
})

for (let d = 0; d < 6; d++) {
  test(`facing direction ${d}: the three stones sit on the cell centres directly behind, and block them`, (t) => {
    mockClock(t)
    const caster = casterOn(ORIGIN, d)
    assert.equal(World.FACING_INDEX(caster.facing), d)
    assert.equal(new StoneWall(caster).execute(), true)

    const expected = behind(ORIGIN, d)
    assert.deepEqual(stoneKeys(), expected)
    // Every cell behind is a neighbour of the caster's cell, and on the far
    // side of it from the facing.
    for (const stone of stones()) {
      const cell = Hex.toCell(stone.position)
      assert.equal(Hex.distance(cell, ORIGIN), 1)
      assert.deepEqual(stone.position, Hex.toPosition(cell), 'not on the cell centre')
      assert.equal(World.isBlocked(cell.x, cell.y, 0), true, 'a stone that does not block its cell')
      const toStone = stone.position.sub(caster.position)
      assert.ok(toStone.x * caster.facing.x + toStone.y * caster.facing.y < 0, 'a stone in front of the caster')
    }

    advance(t, StoneWall.LIFETIME)
    assert.equal(stones().length, 0)
    for (const k of expected) {
      assert.equal(World.BLOCKED.get(0)?.has(k) ?? false, false, 'a stone\'s cell stayed blocked')
    }
  })
}

test('a pursuer routed straight through the wall\'s line detours round it, without being told to', (t) => {
  mockClock(t)
  // Caster runs East; the pursuer is 5 cells West on the same row, heading for
  // 5 cells East. The only shortest route is the row itself, which crosses the
  // cell directly behind the caster.
  const caster = casterOn(ORIGIN, 0)
  const start = Hex.toPosition(offset(ORIGIN, -5, 0))
  const pursuer = new Player(start.x, start.y, 0, 'pursuer')
  World.PLAYERS.push(pursuer)
  const goal = offset(ORIGIN, 5, 0)
  pursuer.setDestination(goal.x, goal.y)

  const west = Hex.neighbour(ORIGIN, 3)
  assert.equal(pursuer.pathCrosses(west.x, west.y), true, 'the set-up route does not cross the wall')
  const before = pursuer.path.length

  assert.equal(new StoneWall(caster).execute(), true)
  assert.equal(stones().length, 3)

  assert.ok(pursuer.path.length > 0, 'the pursuer gave up instead of detouring')
  for (const stone of stones()) {
    const cell = Hex.toCell(stone.position)
    assert.equal(pursuer.pathCrosses(cell.x, cell.y), false, 'the route still runs through a stone')
  }
  assert.ok(pursuer.path.length > before, `no detour: ${pursuer.path.length} cells against ${before}`)
  const last = pursuer.path[pursuer.path.length - 1]
  assert.deepEqual(last, goal, 'the detour ends somewhere else')

  advance(t, StoneWall.LIFETIME)
})

test('a cell holding a rock is skipped, and the stones\' expiry leaves the rock\'s cell blocked', (t) => {
  mockClock(t)
  const west = Hex.neighbour(ORIGIN, 3)
  const centre = Hex.toPosition(west)
  const rock = new Obstacle(centre.x, centre.y, 0)
  World.OBSTACLES.push(rock)

  const caster = casterOn(ORIGIN, 0)
  assert.equal(new StoneWall(caster).execute(), true)
  const expected = behind(ORIGIN, 0).filter((k) => k !== key(west))
  assert.deepEqual(stoneKeys().filter((k) => k !== key(west)), expected)
  assert.equal(stones().length, 3, 'the rock plus two stones')

  advance(t, StoneWall.LIFETIME)
  assert.deepEqual(World.OBSTACLES, [rock])
  assert.equal(World.isBlocked(west.x, west.y, 0), true, 'a stone expiring released the rock\'s cell')
  for (const k of expected) assert.equal(World.BLOCKED.get(0)?.has(k) ?? false, false)
})

test('a cell already holding a stone is skipped, so the first wall\'s expiry is not undone by the second', (t) => {
  mockClock(t)
  const caster = casterOn(ORIGIN, 0)
  const wall = new StoneWall(caster)
  wall.cooldown = 0
  assert.equal(wall.execute(), true)
  const first = stones().slice()
  assert.equal(first.length, 3)

  advance(t, 1000)
  assert.equal(wall.execute(), true)
  assert.equal(stones().length, 3, 'a second stone was stacked on a cell')

  advance(t, StoneWall.LIFETIME - 1000)
  assert.equal(stones().length, 0)
  assert.equal(World.BLOCKED.get(0)?.size ?? 0, 0)
})

test('a cell a unit stands on is skipped, and the unit is not moved', (t) => {
  mockClock(t)
  const west = Hex.neighbour(ORIGIN, 3)
  const centre = Hex.toPosition(west)
  const mob = new Mob(centre.x, centre.y, 0)
  World.MOBS.push(mob)

  const caster = casterOn(ORIGIN, 0)
  assert.equal(new StoneWall(caster).execute(), true)
  assert.equal(stones().length, 2)
  assert.equal(stoneKeys().includes(key(west)), false, 'a stone went on the mob')
  assert.equal(World.isBlocked(west.x, west.y, 0), false)
  assert.deepEqual(mob.position, centre)

  advance(t, StoneWall.LIFETIME)
})

test('a unit on another plane does not stop the stone', (t) => {
  mockClock(t)
  const west = Hex.neighbour(ORIGIN, 3)
  const centre = Hex.toPosition(west)
  World.MOBS.push(new Mob(centre.x, centre.y, -1))

  assert.equal(new StoneWall(casterOn(ORIGIN, 0)).execute(), true)
  assert.equal(stones().length, 3)
  advance(t, StoneWall.LIFETIME)
})

test('a portal\'s cell is skipped', (t) => {
  mockClock(t)
  const west = Hex.neighbour(ORIGIN, 3)
  const centre = Hex.toPosition(west)
  World.OBSTACLES.push(new Portal(centre.x, centre.y, -1, 0))

  assert.equal(new StoneWall(casterOn(ORIGIN, 0)).execute(), true)
  assert.equal(stones().length, 2)
  assert.equal(stoneKeys().includes(key(west)), false, 'a stone went on the portal')
  advance(t, StoneWall.LIFETIME)
})

test('cells off the map are skipped', (t) => {
  mockClock(t)
  // Cell (0, 0) is the map's corner. Behind an East-facer are SW (-1, 1),
  // W (-1, 0) and NW (0, -1): all three off the map.
  const corner = new Vector(0, 0)
  for (const k of behind(corner, 0)) {
    const q = Math.floor(k / 4096) - 1024
    const r = (k % 4096) - 1024
    assert.equal(Hex.onMap(q, r, World.mapSize), false)
  }
  assert.equal(new StoneWall(casterOn(corner, 0)).execute(), true)
  assert.equal(stones().length, 0)
})
