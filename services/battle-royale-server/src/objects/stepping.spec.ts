import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import Mob from './mob'
import Portal from './portal'
import Obstacle from './obstacle'
import { type Unit } from './unit'
import { StoneWall } from '../skills/stonewall'
import { ARCHETYPES, LAYERS } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Mobs move by cell steps (hex-cells P2, decision #31 Q1 and Q2): at a cell
 * centre a mob steps to the free neighbour nearest its goal, or stays if none
 * is nearer; one mob per cell, and a mob holds both the cell it left and the
 * cell it is moving into until it arrives. Players may share cells.
 */

const DT = 0.25
const [TOP, MIDDLE] = LAYERS.map((layer) => layer.tag)
/** Every mob `LAYERS` keeps alive, 81 today. */
const POPULATION = LAYERS.reduce((sum, layer) => sum + layer.mobs.reduce((n, { count }) => n + count, 0), 0)

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
  World.STEPS.clear()
  Timers.clear()
})

const MID = Hex.toCell(new Vector(2000, 2000))
const cell = (dq: number, dr: number = 0): Vector => new Vector(MID.x + dq, MID.y + dr)
const centre = (dq: number, dr: number = 0): Vector => Hex.toPosition(cell(dq, dr))

function addMob (at: Vector, archetype = ARCHETYPES.grunt, tag = TOP): Mob {
  const mob = new Mob(at.x, at.y, tag, archetype)
  World.addUnit(World.MOBS, mob)
  return mob
}

function addPlayer (at: Vector, tag = TOP, id = 'p1'): Player {
  const player = new Player(at.x, at.y, tag, id)
  player.armor = 0
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

function rock (at: Vector, tag = TOP): void {
  const p = Hex.toPosition(at)
  World.addObstacle(new Obstacle(p.x, p.y, tag))
}

/** Every cell a live mob holds on each layer: the one it stands on, and a step's two. */
function holds (): Map<string, Unit[]> {
  const held = new Map<string, Unit[]>()
  const add = (tag: number, c: Vector | undefined, mob: Unit): void => {
    if (c === undefined) return
    const key = `${tag}:${c.x},${c.y}`
    const list = held.get(key) ?? []
    if (!list.includes(mob)) list.push(mob)
    held.set(key, list)
  }
  for (const mob of World.MOBS) {
    if (mob.destroyed) continue
    add(mob.tag, mob.cell, mob)
    add(mob.tag, mob.stepFrom, mob)
    add(mob.tag, mob.stepTo, mob)
  }
  return held
}

function assertOnePerCell (when: string): void {
  for (const [key, mobs] of holds()) {
    assert.equal(mobs.length, 1, `${when}: ${mobs.length} mobs hold ${key} (ids ${mobs.map((m) => m.id).join(', ')})`)
  }
}

// --- the long run -------------------------------------------------------------------

test('no two mobs ever stand on or hold one cell, and none stands on a gate, an arrival cell or a rock, over a long random run', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const world = new World(4000)
  world.update(DT) // first fill: rocks, and the first mob of each kind

  // Players scattered over every layer, walking to random cells nearby, so
  // mobs notice them, chase, crowd round and lose them again.
  const bots: Player[] = []
  const join = (n: number): Player => {
    const tag = World.TAGS[n % World.TAGS.length]
    const at = Hex.toPosition(World.spawnCell(tag).cell)
    const bot = addPlayer(at, tag, (0x100000 + n).toString(16))
    bot.armor = 50
    bots.push(bot)
    return bot
  }
  for (let n = 0; n < 30; n++) join(n)

  let steps = 0
  let crowded = 0
  let blocked = 0
  let joined = 30
  let full = 0
  const TICKS = 2400 // ten minutes of play
  for (let tick = 0; tick < TICKS; tick++) {
    t.mock.timers.tick(250)
    for (const bot of bots) {
      if (bot.destroyed || bot.exited) continue
      if (bot.path.length === 0 && Math.random() < 0.3) {
        const here = bot.cell
        bot.setDestination(here.x + Math.floor(Math.random() * 13) - 6, here.y + Math.floor(Math.random() * 13) - 6)
      }
      if (bot.hp < 40) bot.hp = 100 // keep the crowd alive
    }
    world.update(DT)
    for (let i = bots.length - 1; i >= 0; i--) {
      if (!World.PLAYERS.includes(bots[i])) { bots.splice(i, 1); join(joined++) }
    }

    assertOnePerCell(`tick ${tick}`)

    // The refill never keeps more of a kind alive on a layer than `LAYERS`
    // says. Count live mobs only: MOBS can hold one more entry than that
    // between ticks, a mob killed during this tick's MOBS pass after its own
    // sweep check (a gunner's shot, a boss's breath inside the victim's own
    // update). The refill at the end of the same tick already replaced it,
    // and the next tick's sweep removes the corpse (CLAUDE.md: a dead unit
    // stays findable until the next sweep). Counting `MOBS.length` is what
    // failed "the population never filled" with 82, about 1 run in 100.
    let live = 0
    for (const layer of LAYERS) {
      for (const { archetype, count } of layer.mobs) {
        const alive = World.MOBS.filter((m) => !m.destroyed && m.tag === layer.tag && m.archetype === archetype).length
        assert.ok(alive <= count, `tick ${tick}: ${alive} live ${archetype.key}s on layer ${layer.tag}, over its ${count}`)
        live += alive
      }
    }
    if (live === POPULATION) full++

    for (const mob of World.MOBS) {
      if (mob.destroyed) continue
      const here = mob.cell
      if (mob.stepTo !== undefined) steps++
      if (mob.stepBlocked) blocked++
      // Where it stands, and where it is going, are cells a mob may be on.
      for (const c of [here, mob.stepTo]) {
        if (c === undefined) continue
        assert.equal(World.isBlocked(c.x, c.y, mob.tag), false, `tick ${tick}: a mob on a blocked cell`)
        assert.equal(World.GATES_ON(c.x, c.y, mob.tag).length, 0, `tick ${tick}: a mob on a gate`)
        assert.equal(World.isArrival(c.x, c.y, mob.tag), false, `tick ${tick}: a mob on an arrival cell`)
      }
      if (World.FIND_IN_CELLS(here, 1, mob.tag, 1 << 5).filter((m) => m !== mob && !m.destroyed).length > 0) crowded++
    }
  }

  // That the run did what it is for: mobs moved, met, and got in each other's way.
  // Full on every tick once the first fill is done (about 20 ticks, one mob of
  // each kind a tick) in 40 instrumented runs; the margin allows for a tick
  // that loses two of one kind on one layer, which the refill replaces one a
  // tick.
  assert.ok(full >= TICKS - 100, `the population was full on only ${full} of ${TICKS} ticks`)
  assert.ok(steps > 10_000, `only ${steps} mob-ticks spent stepping`)
  assert.ok(crowded > 1_000, `mobs were next to each other only ${crowded} times`)
  assert.ok(blocked > 0, 'no mob was ever blocked')
})

// --- chase ---------------------------------------------------------------------------

test('a grunt closes on a standing player, stops on the next cell and hits from there', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const player = addPlayer(centre(0))
  const grunt = addMob(centre(-4))
  for (let n = 0; n < 12; n++) {
    t.mock.timers.tick(250)
    Timers.run(Date.now())
    grunt.update(DT)
    const rings = Hex.distance(grunt.cell, player.cell)
    assert.ok(rings >= 1, `tick ${n}: walked onto the player's cell`)
  }
  assert.equal(Hex.distance(grunt.cell, player.cell), 1)
  assert.equal(grunt.stepTo, undefined, 'still stepping')
  assert.ok(player.hp < 100, 'never hit')
  // Ends on a cell centre, not somewhere along a step.
  assert.deepEqual(grunt.position, Hex.toPosition(grunt.cell))
})

test('eight grunts round one player: six stand on the six neighbours, each on its own, and two wait behind', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const player = addPlayer(centre(0))
  player.hp = 1e9 // survive it
  const grunts = [
    centre(-3), centre(3), centre(0, -3), centre(0, 3), centre(-3, 3), centre(3, -3), centre(-2, -1), centre(2, 1)
  ].map((at) => addMob(at))
  for (let n = 0; n < 40; n++) {
    t.mock.timers.tick(250)
    Timers.run(Date.now())
    for (const grunt of grunts) grunt.update(DT)
    assertOnePerCell(`tick ${n}`)
  }
  const adjacent = grunts.filter((g) => Hex.distance(g.cell, player.cell) === 1)
  assert.equal(adjacent.length, 6, `${adjacent.length} grunts next to the player`)
  assert.ok(grunts.every((g) => Hex.distance(g.cell, player.cell) >= 1), 'a grunt on the player\'s cell')
})

test('a mob with a wall between it and its target stays put, without rocking between two cells', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  // A wall three cells wide across the line from the mob to the player: every
  // neighbour nearer the player is a rock once the mob reaches it.
  for (const c of [cell(0, -1), cell(0, 0), cell(-1, 1)]) rock(c)
  // Four rings apart, so the grunt notices; the wall's middle cell is on the
  // straight line between them.
  const player = addPlayer(centre(1))
  const grunt = addMob(centre(-3))
  const cells: string[] = []
  for (let n = 0; n < 40; n++) {
    t.mock.timers.tick(250)
    Timers.run(Date.now())
    grunt.update(DT)
    cells.push(`${grunt.cell.x},${grunt.cell.y}`)
  }
  assert.equal(grunt.target, player, 'lost its target')
  assert.notEqual(cells[0], `${MID.x - 3},${MID.y}`, 'never moved, so this proved nothing')
  // The last 30 ticks on one cell, on its centre, with no step started.
  const settled = cells.slice(10)
  assert.deepEqual([...new Set(settled)], [`${MID.x - 1},${MID.y}`], `moved among ${[...new Set(settled)].join(' ')}`)
  assert.deepEqual(grunt.position, centre(-1))
  assert.equal(grunt.stepTo, undefined)
  assert.equal(grunt.stepBlocked, true)
})

test('a single rock straight between a grunt and its target stops it: the rule is greedy, ties stay (#31 Q1)', (t: TestContext) => {
  // Along a hex axis only the one neighbour straight ahead is nearer, so one
  // rock there leaves no neighbour nearer than where the grunt stands, and it
  // waits rather than side-stepping onto a cell no nearer. That is the rule
  // as decided; a breadth-first search is the upgrade if it plays badly
  // (see `Unit.chooseStep`). This pins it, so a change to it is on purpose.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  rock(cell(0))
  const player = addPlayer(centre(2))
  const grunt = addMob(centre(-2))
  for (let n = 0; n < 20; n++) {
    t.mock.timers.tick(250)
    Timers.run(Date.now())
    grunt.update(DT)
  }
  assert.equal(grunt.target, player)
  assert.deepEqual(grunt.position, centre(-1))
  assert.equal(grunt.stepBlocked, true)
})

test('a mob always finishes the step it started, holding both cells until it arrives', () => {
  const grunt = addMob(centre(0))
  grunt.routines.length = 0
  grunt.maxVelocity = 100
  grunt.stepGoal = { cell: cell(5), within: 0 }
  grunt.update(0.1) // 10 units into a 45-unit step east
  assert.deepEqual([grunt.stepFrom?.x, grunt.stepTo?.x], [MID.x, MID.x + 1])
  assert.equal(World.mobHolds(MID.x, MID.y, TOP), true, 'let go of the cell it left')
  assert.equal(World.mobHolds(MID.x + 1, MID.y, TOP), true, 'did not claim the cell it is entering')
  assert.equal(World.mobHolds(MID.x, MID.y, TOP, grunt), false, 'its own hold blocks itself')

  grunt.stepGoal = undefined // told to stay mid-step: it finishes the step anyway
  grunt.update(0.4)
  assert.deepEqual(grunt.position, centre(1))
  assert.equal(grunt.stepTo, undefined)
  assert.equal(World.mobHolds(MID.x, MID.y, TOP), false, 'still holds the cell it left')
  assert.equal(World.STEPS.get(TOP)?.size ?? 0, 0, 'a claim outlived the step')
})

test('a mob keeps its speed across cell centres: the budget left at a centre carries into the next step', () => {
  const grunt = addMob(centre(0))
  grunt.routines.length = 0
  grunt.maxVelocity = 100
  grunt.stepGoal = { cell: cell(10), within: 0 }
  for (let n = 0; n < 8; n++) grunt.update(DT) // 2 s at 100 u/s
  assert.ok(Math.abs(grunt.position.x - (centre(0).x + 200)) < 1e-6, `at ${grunt.position.x - centre(0).x}`)
})

test('a mob never steps onto a portal\'s arrival cell', () => {
  // A portal on layer 02 down to 01 puts players down on cell(1) of layer 01.
  const at = centre(0)
  World.addObstacle(new Portal(at.x, at.y, TOP, MIDDLE))
  assert.equal(World.isArrival(MID.x + 1, MID.y, TOP), true)
  const grunt = addMob(centre(0))
  grunt.routines.length = 0
  grunt.maxVelocity = 100
  grunt.stepGoal = { cell: cell(4), within: 0 }
  for (let n = 0; n < 20; n++) {
    grunt.update(DT)
    assert.ok(grunt.cell.x !== MID.x + 1 || grunt.cell.y !== MID.y, `on the arrival cell at tick ${n}`)
  }
  assert.equal(World.mobCanEnter(MID.x + 1, MID.y, grunt), false)
})

test('a dead mob, or one a spec removed, holds nothing', () => {
  const grunt = addMob(centre(0))
  grunt.routines.length = 0
  grunt.maxVelocity = 100
  grunt.stepGoal = { cell: cell(5), within: 0 }
  grunt.update(0.1)
  assert.equal(World.mobHolds(MID.x + 1, MID.y, TOP), true)
  grunt.hit(9999)
  assert.equal(World.mobHolds(MID.x + 1, MID.y, TOP), false, 'a corpse holds its step')
  assert.equal(World.mobHolds(MID.x, MID.y, TOP), false, 'a corpse holds its cell')
})

// --- StoneWall and spawns keep clear of what mobs and arrivals need --------------

test('StoneWall skips a portal\'s arrival cell and a cell a mob is stepping into', () => {
  const at = centre(0)
  World.addObstacle(new Portal(at.x, at.y, TOP, MIDDLE))
  assert.equal(StoneWall.canPlace(cell(1), TOP), false, 'a stone on an arrival cell')
  assert.equal(StoneWall.canPlace(cell(1), MIDDLE), true, 'the arrival rule leaked onto the portal\'s own layer')

  const grunt = addMob(centre(4))
  grunt.routines.length = 0
  grunt.maxVelocity = 100
  grunt.stepGoal = { cell: cell(8), within: 0 }
  grunt.update(0.1)
  assert.equal(StoneWall.canPlace(cell(5), TOP), false, 'a stone on the cell a mob is stepping into')
  assert.equal(StoneWall.canPlace(cell(6), TOP), true)
})

test('the refill never spawns a mob on a gate, an arrival cell or another mob', () => {
  for (let w = 0; w < 5; w++) {
    World.OBSTACLES.length = 0
    World.BLOCKED.clear()
    World.MOBS.length = 0
    const world = new World(4000)
    // Enough ticks for every layer to fill its mobs (one of each kind a tick).
    for (let n = 0; n < 30; n++) world.update(DT)
    assert.equal(World.MOBS.length, 81)
    assertOnePerCell(`world ${w}`)
    for (const mob of World.MOBS) {
      const c = mob.cell
      assert.equal(World.GATES_ON(c.x, c.y, mob.tag).length, 0)
      assert.equal(World.isArrival(c.x, c.y, mob.tag), false)
    }
  }
})
