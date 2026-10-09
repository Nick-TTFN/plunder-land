import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Portal from './portal'
import Exit from './exit'
import Obstacle from './obstacle'
import Mob from './mob'
import { GameObject } from './gameobject'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { ARCHETYPES, LAYERS } from '../archetypes/archetypes'

/**
 * `safe-spawn-placement`: a new player starts on a free cell centre of layer
 * 01, at least `World.SPAWN_CLEARANCE` cells from every exit, portal and boss
 * there, and from other mobs while that is possible.
 */

const DT = 0.25
const TOP = LAYERS[0].tag
const N = World.SPAWN_CLEARANCE

function reset (): void {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  new Multiplayer(250, redis) // eslint-disable-line no-new
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
  // Ids are uint16 on the wire; 500 worlds' worth would run past 65535.
  GameObject.id = 0
  GameObject.FreedIDs.length = 0
}

const savedSpawnCell = World.spawnCell
const savedTries = World.SPAWN_TRIES
beforeEach(reset)
afterEach(() => {
  World.spawnCell = savedSpawnCell
  World.SPAWN_TRIES = savedTries
})

/** Hex distance from `cell` to the nearest of `things` on layer 01. */
function nearest (cell: Vector, things: Array<{ position: Vector, tag: number }>): number {
  let best = Infinity
  for (const t of things) if (t.tag === TOP) best = Math.min(best, Hex.distance(cell, Hex.toCell(t.position)))
  return best
}

function gates (): Array<Portal | Exit> {
  return World.OBSTACLES.filter((o): o is Portal | Exit => o instanceof Portal || o instanceof Exit)
}

/** The rules every spawn must meet, whichever path chose it. */
function assertSafe (player: { position: Vector, tag: number }): void {
  assert.equal(player.tag, TOP)
  const cell = Hex.toCell(player.position)
  assert.ok(player.position.sub(Hex.toPosition(cell)).getSquareMagnitude() < 1e-9, 'on a cell centre')
  assert.ok(!World.isBlocked(cell.x, cell.y, TOP), `cell ${cell.x},${cell.y} is blocked or off the map`)
  assert.ok(nearest(cell, gates()) >= N, 'too close to a gate')
  // A boss is any spawn hazard since #51 L1: the retired boss, a Reactor or a Brood.
  const bosses = World.MOBS.filter((m) => World.isSpawnHazard(m.archetype))
  assert.ok(nearest(cell, bosses) >= N, 'too close to a boss')
}

test('10,000 spawns into fresh worlds: every one on a free layer-01 cell, clear of gates and bosses', () => {
  let fallbacks = 0
  let mobClear = 0
  let spawns = 0
  World.spawnCell = (tag) => {
    const result = savedSpawnCell(tag)
    if (result.fallback) fallbacks++
    return result
  }

  for (let w = 0; w < 500; w++) {
    reset()
    const world = new World(4000)
    // Rocks all at once on the first tick, then one mob of each short
    // entry a tick (#51 L1: a pack counts as one); 22 ticks fills layer 01.
    for (let t = 0; t < 22; t++) world.update(DT)
    World.PLAYERS.length = 0
    for (let i = 0; i < 20; i++) {
      const player = World.createPlayer(`p${w}-${i}`)
      assertSafe(player)
      const mobs = World.MOBS.filter((m) => !World.isSpawnHazard(m.archetype))
      if (nearest(Hex.toCell(player.position), mobs) >= N) mobClear++
      spawns++
    }
    World.PLAYERS.length = 0
  }

  assert.equal(spawns, 10_000)
  console.log(`spawns ${spawns}, fallbacks ${fallbacks}, clear of mobs ${mobClear}`)
  assert.equal(fallbacks, 0)
  assert.equal(mobClear, spawns)
})

// #51 L1: the Reactor (epic) and the Brood (legendary) are hazards like the boss.
for (const boss of [ARCHETYPES.boss, ARCHETYPES.reactor, ARCHETYPES.brood]) {
  test(`keeps its distance from a ${boss.key} on layer 01`, () => {
    new World(4000) // eslint-disable-line no-new
    // Crowd the middle of the map with them so random tries often land near one.
    for (let x = 400; x < 3600; x += 400) {
      for (let y = 400; y < 3600; y += 400) World.MOBS.push(new Mob(x, y, TOP, boss))
    }
    for (let i = 0; i < 500; i++) assertSafe(World.createPlayer(`p${i}`))
  })
}

test('the fallback scan still finds the one safe cell', () => {
  new World(4000) // eslint-disable-line no-new
  World.SPAWN_TRIES = 0
  // Block every cell of layer 01 but one, far from any gate or boss.
  const safe = farthestFromGates()
  for (let r = -1; r <= 110; r++) {
    for (let q = -60; q <= 100; q++) {
      if (!Hex.onMap(q, r, World.mapSize)) continue
      if (q === safe.x && r === safe.y) continue
      World.block(q, r, TOP)
    }
  }
  const { cell, fallback } = World.spawnCell(TOP)
  assert.equal(fallback, true)
  assert.deepEqual([cell.x, cell.y], [safe.x, safe.y])
})

test('with no clear cell left, the fallback takes the free cell furthest from every gate, never a gate', () => {
  World.SPAWN_TRIES = 0
  // Two exits side by side, and only three free cells: on one exit, next to
  // it, and two cells out. None is 3 cells clear.
  const a = new Vector(40, 40)
  World.OBSTACLES.push(new Exit(Hex.toPosition(a).x, Hex.toPosition(a).y, TOP))
  const free = [a, new Vector(41, 40), new Vector(42, 40)]
  for (let r = -1; r <= 110; r++) {
    for (let q = -60; q <= 100; q++) {
      if (!Hex.onMap(q, r, World.mapSize)) continue
      if (free.some((c) => c.x === q && c.y === r)) continue
      World.block(q, r, TOP)
    }
  }
  const { cell, fallback } = World.spawnCell(TOP)
  assert.equal(fallback, true)
  assert.deepEqual([cell.x, cell.y], [42, 40])
})

test('if the only free cell is a gate\'s own, the fallback takes a blocked cell instead', () => {
  World.SPAWN_TRIES = 0
  const a = new Vector(40, 40)
  World.OBSTACLES.push(new Exit(Hex.toPosition(a).x, Hex.toPosition(a).y, TOP))
  for (let r = -1; r <= 110; r++) {
    for (let q = -60; q <= 100; q++) {
      if (!Hex.onMap(q, r, World.mapSize)) continue
      if (q === a.x && r === a.y) continue
      World.block(q, r, TOP)
    }
  }
  const { cell, fallback } = World.spawnCell(TOP)
  assert.equal(fallback, true)
  assert.ok(Hex.distance(cell, a) >= N, `picked ${cell.x},${cell.y}, next to the exit`)
})

test('a boss is a hard rule like a gate; a grunt is the one the fallback gives up first', () => {
  World.SPAWN_TRIES = 0
  // Two free cells: one next to a boss, one next to a grunt. Neither is clear
  // of both, so the fallback must pick the grunt's, every time.
  const nearBoss = new Vector(20, 40)
  const nearGrunt = new Vector(60, 40)
  const at = (c: Vector): Vector => Hex.toPosition(c)
  World.MOBS.push(new Mob(at(new Vector(21, 40)).x, at(new Vector(21, 40)).y, TOP, ARCHETYPES.boss))
  World.MOBS.push(new Mob(at(new Vector(61, 40)).x, at(new Vector(61, 40)).y, TOP, ARCHETYPES.grunt))
  for (let r = -1; r <= 110; r++) {
    for (let q = -60; q <= 100; q++) {
      if (!Hex.onMap(q, r, World.mapSize)) continue
      if ((q === nearBoss.x || q === nearGrunt.x) && r === 40) continue
      World.block(q, r, TOP)
    }
  }
  for (let i = 0; i < 50; i++) {
    const { cell, fallback } = World.spawnCell(TOP)
    assert.equal(fallback, true)
    assert.deepEqual([cell.x, cell.y], [nearGrunt.x, nearGrunt.y])
  }
})

test('the random tries skip blocked cells and gates, and keep clear of mobs', () => {
  // Only rocks and grunts, no scan: whatever the tries return met every rule.
  new World(4000) // eslint-disable-line no-new
  for (let i = 0; i < 136; i++) {
    const pos = Hex.toPosition(Hex.toCell(new Vector(200 + (i % 12) * 300, 200 + Math.floor(i / 12) * 300)))
    World.OBSTACLES.push(new Obstacle(pos.x, pos.y, TOP))
  }
  for (let x = 350; x < 3800; x += 700) {
    for (let y = 350; y < 3800; y += 700) World.MOBS.push(new Mob(x, y, TOP, ARCHETYPES.grunt))
  }
  let tried = 0
  for (let i = 0; i < 2000; i++) {
    const { cell, fallback } = World.spawnCell(TOP)
    if (fallback) continue
    tried++
    assert.ok(!World.isBlocked(cell.x, cell.y, TOP))
    assert.ok(nearest(cell, gates()) >= N)
    assert.ok(nearest(cell, World.MOBS) >= N)
  }
  assert.ok(tried > 1900, `only ${tried} of 2000 came from the random tries`)
})

test('SPAWN_CLEARANCE is 3 cells (provisional)', () => {
  assert.equal(World.SPAWN_CLEARANCE, 3)
})

/** The layer-01 cell furthest from every gate the world placed. */
function farthestFromGates (): Vector {
  let best = new Vector(0, 0)
  let bestD = -1
  for (let r = 0; r <= 105; r++) {
    for (let q = -55; q <= 95; q++) {
      if (!Hex.onMap(q, r, World.mapSize)) continue
      const d = nearest(new Vector(q, r), gates())
      if (d > bestD) { best = new Vector(q, r); bestD = d }
    }
  }
  return best
}
