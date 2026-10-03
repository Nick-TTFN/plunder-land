import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import Mob from './mob'
import Exit from './exit'
import Portal from './portal'
import Obstacle from './obstacle'
import Consumable from './consumable'
import { GameObject, ObjectType } from './gameobject'
import { type Unit } from './unit'
import { CellIndex } from '../utils/cellindex'
import { throwBomb } from '../items/bomb'
import { StoneWall } from '../skills/stonewall'
import { ARCHETYPES, ITEMS, LAYERS } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * hex-cells P1: the cell indexes (`CellIndex`, and World's `UNITS`,
 * `INTEREST`, `PICKUPS`, `GATES`). An index that misses a move, a layer
 * change or a removal answers every later query wrong without an error, so
 * each way a unit can move or leave is checked here against the lookup.
 */

const DT = 0.25
const [TOP, MIDDLE] = LAYERS.map((layer) => layer.tag)

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

beforeEach(() => {
  Multiplayer.Instance = new Multiplayer(250, okRedis())
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  World.FINISHED.length = 0
  Timers.clear()
})

const MID = Hex.toCell(new Vector(2000, 2000))
const centre = (dq: number, dr: number = 0): Vector => Hex.toPosition(new Vector(MID.x + dq, MID.y + dr))
const on = (unit: Unit, dq: number, dr: number = 0, tag: number = TOP): boolean =>
  World.UNITS_ON(MID.x + dq, MID.y + dr, tag).includes(unit)

function addPlayer (at: Vector, tag: number = TOP, id = 'p1'): Player {
  const player = new Player(at.x, at.y, tag, id)
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

function addMob (at: Vector, tag: number = TOP): Mob {
  const mob = new Mob(at.x, at.y, tag, ARCHETYPES.grunt)
  mob.routines = []
  World.addUnit(World.MOBS, mob)
  return mob
}

/** A World whose constructor has run, then emptied of its random gates, rocks and mobs. */
function emptyWorld (): World {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  return world
}

// --- CellIndex on its own -------------------------------------------------------

interface Dot { layer: number, key: number }

function dots (): { lists: Dot[][], index: CellIndex<Dot> } {
  const lists: Dot[][] = [[], []]
  const index = new CellIndex<Dot>(() => lists, (d) => d.layer, (d) => d.key)
  return { lists, index }
}

test('CellIndex files what is pushed through it, and unfiles what is removed', () => {
  const { lists, index } = dots()
  const a = { layer: 0, key: 5 }
  const b = { layer: 0, key: 5 }
  index.push(lists[0], a)
  index.push(lists[1], b)
  assert.deepEqual(index.at(0, 5), [a, b], 'insertion order')
  assert.deepEqual(index.at(1, 5), [], 'another layer')

  index.removeAt(lists[0], 0)
  assert.deepEqual(index.at(0, 5), [b])
  assert.equal(index.remove(lists[1], b), true)
  assert.equal(index.remove(lists[1], b), false, 'removed twice')
  assert.deepEqual(index.at(0, 5), [])
  assert.equal(index.buckets(0).size, 0, 'an empty bucket was kept')
  assert.equal(index.rebuilds, 0)
})

test('CellIndex refiles a moved member, and ignores a move by anything it does not hold', () => {
  const { lists, index } = dots()
  const a = { layer: 0, key: 5 }
  index.push(lists[0], a)
  a.key = 6
  index.moved(a)
  assert.deepEqual(index.at(0, 5), [])
  assert.deepEqual(index.at(0, 6), [a])
  a.layer = -1
  index.moved(a)
  assert.deepEqual(index.at(0, 6), [])
  assert.deepEqual(index.at(-1, 6), [a])

  const stranger = { layer: 0, key: 9 }
  index.moved(stranger)
  assert.deepEqual(index.at(0, 9), [], 'filed something that is in no list')
  assert.equal(index.rebuilds, 0)
})

test('CellIndex rebuilds when a list is edited behind its back, and only then', () => {
  const { lists, index } = dots()
  const a = { layer: 0, key: 1 }
  index.push(lists[0], a)

  // The spec reset: emptied in place.
  lists[0].length = 0
  assert.deepEqual(index.at(0, 1), [], 'still held a unit after its list was emptied')
  assert.equal(index.rebuilds, 1)

  // A direct push, as the specs do.
  const b = { layer: 0, key: 2 }
  lists[1].push(b)
  assert.deepEqual(index.at(0, 2), [b], 'missed a unit pushed straight onto its list')
  assert.equal(index.rebuilds, 2)

  // Emptied and refilled to the same length: the last element differs.
  const c = { layer: 0, key: 3 }
  lists[1].length = 0
  lists[1].push(c)
  assert.deepEqual(index.at(0, 2), [])
  assert.deepEqual(index.at(0, 3), [c])
  assert.equal(index.rebuilds, 3)

  // Lookups with nothing changed cost no rebuild.
  for (let i = 0; i < 5; i++) index.at(0, 3)
  assert.equal(index.rebuilds, 3)
})

test('CellIndex catches up on an outside edit before its own mutation, so the edit is not lost', () => {
  const { lists, index } = dots()
  const outside = { layer: 0, key: 1 }
  lists[0].push(outside)
  const own = { layer: 0, key: 1 }
  index.push(lists[0], own)
  assert.deepEqual(index.at(0, 1), [outside, own])
})

// --- World.UNITS: every way a unit moves or leaves ------------------------------

test('a unit that moves is found on its new cell and not its old one', () => {
  const player = addPlayer(centre(0))
  assert.ok(on(player, 0))
  player.position = centre(3)
  assert.ok(!on(player, 0), 'still on the cell it left')
  assert.ok(on(player, 3), 'not on the cell it moved to')
})

test('a unit walking a route is refiled by its own update', () => {
  const player = addPlayer(centre(0))
  player.setDestination(MID.x + 4, MID.y)
  for (let i = 0; i < 12; i++) player.update(DT)
  assert.deepEqual([player.cell.x, player.cell.y], [MID.x + 4, MID.y], 'test setup: the walk did not arrive')
  assert.ok(on(player, 4))
  assert.equal(World.FIND_IN_CELLS(MID, 3, TOP, ObjectType.Player).length, 0, 'left behind on a cell it walked through')
})

test('a layer change refiles the unit on the new layer', () => {
  const player = addPlayer(centre(0))
  player.changeLayer(MIDDLE)
  assert.ok(!on(player, 0, 0, TOP), 'still on the old layer')
  assert.ok(on(player, 0, 0, MIDDLE), 'not on the new layer')
})

test('a dead unit stays findable until the sweep, then is gone', () => {
  const world = emptyWorld()
  const mob = addMob(centre(0))
  mob.hit(9999)
  assert.ok(mob.destroyed)
  assert.ok(on(mob, 0), 'a corpse must stay findable until the sweep (callers check destroyed)')
  assert.equal(World.NEAREST_IN_CELLS(MID, 2, TOP, ObjectType.Mob), undefined, 'NEAREST_IN_CELLS returned a corpse')

  world.update(DT)
  assert.ok(!World.MOBS.includes(mob))
  assert.ok(!on(mob, 0), 'a swept corpse is still indexed')
})

test('an extracted player leaves the index at the sweep, a disconnected one too', () => {
  const world = emptyWorld()
  const exits = addPlayer(centre(0), TOP, 'aaaaaa')
  const quits = addPlayer(centre(1), TOP, 'bbbbbb')
  exits.exit()
  quits.destroy() // what Multiplayer.onDisconnect does
  world.update(DT)
  assert.ok(!on(exits, 0))
  assert.ok(!on(quits, 1))
  assert.ok(!World.INTEREST.has(exits) && !World.INTEREST.has(quits), 'left in the interest buckets')
})

test('a recycled id is a new unit to the index', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const world = emptyWorld()
  // The update below tops layer 01 up with a grunt on a random cell, and the
  // query covers 37 cells: 14 runs in 2000 found that grunt inside it (rings
  // 1-3, live, in MOBS) and failed. The index is the subject here, not refill.
  Object.assign(world, { refillLayer: () => {} })
  const first = addMob(centre(0))
  const id = first.id
  first.hit(9999)
  world.update(DT) // swept
  t.mock.timers.tick(1001)
  Timers.run(Date.now()) // the id is freed a second later
  const second = addMob(centre(2))
  assert.equal(second.id, id, 'test setup: the id was not reused')
  assert.ok(!on(first, 0))
  assert.ok(on(second, 2))
  assert.deepEqual(World.FIND_IN_CELLS(MID, 3, TOP, ObjectType.Mob), [second])
})

test('queries find units pushed straight onto the lists, as the specs do', () => {
  const mob = new Mob(centre(1).x, centre(1).y, TOP, ARCHETYPES.grunt)
  World.MOBS.push(mob)
  assert.deepEqual(World.FIND_IN_CELLS(MID, 1, TOP, ObjectType.Mob), [mob])
  World.MOBS.length = 0
  assert.deepEqual(World.FIND_IN_CELLS(MID, 1, TOP, ObjectType.Mob), [])
})

// --- the world's own paths never need a rebuild ---------------------------------

interface Recorded { event: string, data: unknown }

function join (id: string): Player {
  const handlers: Record<string, (data: unknown) => void> = {}
  const sent: Recorded[] = []
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string, data: unknown) => { sent.push({ event, data }); return true }
  } as unknown as Socket
  Multiplayer.Instance.onConnect(socket)
  handlers.start_requested({ id, name: id })
  return World.PLAYERS[World.PLAYERS.length - 1]
}

test('a world run through its own paths never rebuilds an index after the first sync', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const world = new World(4000)
  world.update(DT) // the first sync after the reset's out-of-band clears
  const indexes = { UNITS: World.UNITS, INTEREST: World.INTEREST, PICKUPS: World.PICKUPS, GATES: World.GATES }
  const before = Object.fromEntries(Object.entries(indexes).map(([name, index]) => [name, index.rebuilds]))

  const players = ['a1a1a1', 'b2b2b2', 'c3c3c3', 'd4d4d4', 'e5e5e5'].map(join)
  // That each path below really ran, so a pass means something.
  const ran = { pickup: false, stones: false, drops: false, swept: false }
  let crystal: Consumable | undefined
  let caster: Player | undefined
  for (let tick = 0; tick < 200; tick++) {
    t.mock.timers.tick(250)
    world.update(DT)
    Multiplayer.Instance.flushAll(tick, 250)

    const live = players.filter((p) => !p.destroyed && !p.exited)
    if (tick === 5) {
      // Walk everyone somewhere; routes cross pickups and cells.
      for (const p of live) p.setDestination(p.cell.x + 6, p.cell.y + 2)
    }
    if (tick === 10 && live[0] !== undefined) {
      // A pickup on the player's own cell, standing: taken through PICKUPS.
      live[0].stop()
      const at = Hex.toPosition(live[0].cell)
      crystal = new Consumable(at.x, at.y, live[0].tag, 20 as never, 7)
      World.PICKUPS.push(World.CONSUMABLES, crystal)
    }
    // Taken by a player and out of its list, within a few ticks. Not
    // necessarily by live[0]: the five walk the same route offset, and another
    // one within a ring may update first and take it (3 runs in 600 failed so
    // on `live[0].loot`). Nor necessarily on tick 11: a player takes one loot a
    // tick, and a natural crystal refilled within its ring can come first (4
    // runs in 3000 when this looked at tick 11 alone).
    if (tick >= 11 && tick <= 15 && !ran.pickup && crystal !== undefined) {
      const by = crystal.collector
      ran.pickup = crystal.destroyed && !World.CONSUMABLES.includes(crystal) && players.some((p) => p.id === by)
    }
    if (tick === 13) ran.stones = World.OBSTACLES.some((o) => o instanceof Obstacle && o.lifetime > 0)
    if (tick === 12) {
      // StoneWall fills the cells behind its caster that are free. A player
      // backed against the map edge or a valley has none (3 runs in 600 placed
      // nothing that way), so the first one with room casts.
      // It throws the bomb too, as one player did both before.
      caster = live.find((p) => StoneWall.cells(p).some((cell) => StoneWall.canPlace(cell, p.tag))) ?? live[1]
      if (caster !== undefined) {
        caster.skills[4].execute() // StoneWall: stones in and, 4 s later, out
        caster.skills[5].execute() // a fireball
      }
    }
    if (tick === 14 && caster !== undefined && !caster.destroyed && !caster.exited) {
      caster.addItem(ITEMS.bomb)
      throwBomb(caster, ITEMS.bomb, ITEMS.bomb.use as never)
    }
    if (tick === 20) {
      for (const mob of World.MOBS.slice(0, 5)) mob.hit(9999) // swept, loot dropped, refilled
    }
    if (tick === 21) ran.swept = World.MOBS.every((mob) => !mob.destroyed)
    if (tick === 25 && live[2] !== undefined) {
      live[2].loot = 400
      live[2].hit(9999) // dies: loot and items drop
    }
    if (tick === 26) ran.drops = World.CONSUMABLES.some((c) => c.expiresAt > 0)
    if (tick === 30 && live[3] !== undefined) live[3].exit()
    if (tick === 35 && live[4] !== undefined) live[4].changeLayer(MIDDLE)
  }

  assert.deepEqual(ran, { pickup: true, stones: true, drops: true, swept: true }, 'a path this test means to cover never ran')
  for (const [name, index] of Object.entries(indexes)) {
    assert.equal(index.rebuilds - before[name], 0, `${name} rebuilt while the world ran through its own paths`)
  }
  // And each is still exactly its lists.
  for (const unit of [...World.PLAYERS, ...World.MOBS] as Unit[]) assert.ok(World.UNITS.has(unit))
  assert.equal(World.UNITS.size, World.PLAYERS.length + World.MOBS.length)
  assert.equal(World.PICKUPS.size, World.CONSUMABLES.length + World.ITEMS.length)
  assert.equal(World.GATES.size, World.OBSTACLES.filter((o) => o instanceof Exit || o instanceof Portal).length)
})

// --- GATES, PICKUPS and BLOCKED ------------------------------------------------

test('the exit check is a lookup of the player\'s cell on its own layer', () => {
  World.addObstacle(new Exit(centre(0).x, centre(0).y, TOP))
  const player = addPlayer(centre(0).add(new Vector(10, 5)))
  assert.equal(player.onExit(), true)
  player.position = centre(1)
  assert.equal(player.onExit(), false, 'on the next cell')
  player.position = centre(0)
  player.changeLayer(MIDDLE)
  assert.equal(player.onExit(), false, 'an exit on another layer')
})

test('BLOCKED names the obstacle on each cell, and forgets it when it goes', () => {
  const rock = new Obstacle(centre(2).x, centre(2).y, TOP)
  assert.equal(World.BLOCKED.get(TOP)?.get(Hex.key(MID.x + 2, MID.y)), rock)
  rock.destroy()
  assert.equal(World.BLOCKED.get(TOP)?.has(Hex.key(MID.x + 2, MID.y)), false)
})

test('a death\'s loot lands on free cell centres near the body, never on a rock or a portal', () => {
  const world = emptyWorld()
  // A rock and a portal on two of the 19 cells around the body.
  World.addObstacle(new Obstacle(centre(1).x, centre(1).y, TOP))
  World.addObstacle(new Portal(centre(-1).x, centre(-1).y, MIDDLE, TOP))
  const player = addPlayer(centre(0))
  player.loot = 5000
  world.createLootFrom(player)

  assert.ok(World.CONSUMABLES.length > 1)
  let total = 0
  for (const drop of World.CONSUMABLES) {
    total += drop.loot
    const cell = Hex.toCell(drop.position)
    const exact = Hex.toPosition(cell)
    assert.deepEqual([drop.position.x, drop.position.y], [exact.x, exact.y], 'not on a cell centre')
    assert.ok(Hex.distance(MID, cell) <= World.DROP_RINGS, 'further than DROP_RINGS')
    assert.ok(!(cell.x === MID.x + 1 && cell.y === MID.y), 'on the rock')
    assert.ok(!(cell.x === MID.x - 1 && cell.y === MID.y), 'on the portal')
    assert.ok(World.PICKUPS.has(drop))
  }
  assert.equal(total, 5000)
})

test('the cells a drop may land on are the 19 around the body less rocks and portals, exits kept', () => {
  World.addObstacle(new Obstacle(centre(1).x, centre(1).y, TOP))
  World.addObstacle(new Portal(centre(-1).x, centre(-1).y, MIDDLE, TOP))
  World.addObstacle(new Exit(centre(0, 1).x, centre(0, 1).y, TOP))
  const keys = World.dropCells(MID, TOP).map((c) => `${c.x - MID.x},${c.y - MID.y}`)
  assert.equal(keys.length, 17)
  assert.ok(!keys.includes('1,0'), 'a rock\'s cell')
  assert.ok(!keys.includes('-1,0'), 'a portal\'s cell')
  assert.ok(keys.includes('0,1'), 'an exit\'s cell is walkable and was dropped')
  // A portal on another layer is not in the way.
  assert.equal(World.dropCells(MID, MIDDLE).length, 19)
})
