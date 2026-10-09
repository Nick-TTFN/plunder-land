import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import type Redis from 'ioredis'
import World from './world'
import Timers from './timers'
import Player from './player'
import Mob from './mob'
import { Unit } from './unit'
import { ObjectType } from './gameobject'
import { RangedAttack } from '../skills/rangedattack'
import { MeleeAttack } from '../skills/meleeattack'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { FireBreath } from '../skills/firebreath'
import { detonate } from '../items/bomb'
import { fuseOf } from '../mobskills/broodling'
import { ARCHETYPES, ITEMS, LAYERS, isPackEntry, type Archetype } from '../archetypes/archetypes'
import { ARCHETYPE_INFO, type ArchetypeKey } from '../utils/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Ring footprint (decision #52 open item 6, Archie's option B,
 * `ideas/ring-footprint-npcs.md`): the Reactor and the Brood are 7-cell
 * bodies. A player's attack hits one on any of its cells; other mobs keep
 * off them; a body steps and spawns only where all 7 are free; players
 * walk through, as before.
 */

const DT = 0.25

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop, effectAt: noop
  } as unknown as Multiplayer
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.GEAR.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  World.STEPS.clear()
  Timers.clear()
})

const C = Hex.toCell(new Vector(2000, 2000))
const D = Hex.DIRECTIONS
/** The cell `a` steps along direction i and `b` along direction j from `from` (C by default). */
const off = (i: number, a: number, j = 0, b = 0, from: Vector = C): Vector =>
  new Vector(from.x + D[i % 6].x * a + D[j % 6].x * b, from.y + D[i % 6].y * a + D[j % 6].y * b)

/** A Reactor-sized body with no AI, on a cell centre, indexed the server's way. */
function bodyOn (cell: Vector, archetype: Archetype = ARCHETYPES.reactor, tag = 0): Unit {
  const at = Hex.toPosition(cell)
  const body = new Unit(ObjectType.Mob, at.x, at.y, 10, tag, archetype)
  World.addUnit(World.MOBS, body)
  return body
}

/** A one-cell mob with no archetype and no AI. */
function smallOn (cell: Vector, tag = 0): Unit {
  const at = Hex.toPosition(cell)
  const mob = new Unit(ObjectType.Mob, at.x, at.y, 10, tag)
  mob.hp = 1000
  mob.maxVelocity = 100
  World.addUnit(World.MOBS, mob)
  return mob
}

function playerOn (cell: Vector): Player {
  const at = Hex.toPosition(cell)
  const player = new Player(at.x, at.y, 0, 'caster')
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

function clear (): void {
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.PROJECTILES.length = 0
  World.AREA_EFFECT.length = 0
  World.STEPS.clear()
}

const keyOf = (cell: Vector): number => Hex.key(cell.x, cell.y)

// --- the data -----------------------------------------------------------------

test('Reactor and Brood have a 1-ring body, every other row none; no pack or escort is bodied (spawnPack places packs one cell each)', () => {
  for (const key in ARCHETYPE_INFO) {
    const want = key === 'reactor' || key === 'brood' ? 1 : 0
    assert.equal(ARCHETYPE_INFO[key as ArchetypeKey].bodyRings, want, key)
    assert.equal((ARCHETYPES as Record<string, Archetype>)[key].bodyRings, want, `${key}: the built archetype`)
  }
  for (const layer of LAYERS) {
    for (const entry of layer.mobs) {
      if (!isPackEntry(entry)) continue
      assert.equal(entry.pack.bodyRings, 0, `layer ${layer.tag}: a bodied pack member`)
      assert.equal(entry.escort?.bodyRings ?? 0, 0, `layer ${layer.tag}: a bodied escort`)
    }
  }
})

// --- the index ----------------------------------------------------------------

test('a body is filed on its 6 ring cells, refiled when it moves cell or layer, and holds nothing once dead; the sweep unfiles it', () => {
  const body = bodyOn(C)
  const ring = World.ringCells(C, 1)
  for (const cell of ring) assert.equal(World.bodyAt(0, keyOf(cell)), body)
  assert.equal(World.bodyAt(0, keyOf(C)), undefined, 'the centre is UNITS\', not BODIES\'')
  for (const cell of World.ringCells(C, 2)) assert.equal(World.bodyAt(0, keyOf(cell)), undefined)
  assert.equal(World.BODIES.get(0)?.size, 6)

  // One cell east: the new ring, and nothing of the old one left behind.
  const east = off(0, 1)
  body.position = Hex.toPosition(east)
  assert.equal(World.BODIES.get(0)?.size, 6)
  for (const cell of World.ringCells(east, 1)) assert.equal(World.bodyAt(0, keyOf(cell)), body)
  assert.equal(World.bodyAt(0, keyOf(off(3, 1))), undefined, 'the old ring\'s west cell is still filed')
  // A move inside its cell refiles nothing.
  body.position = Hex.toPosition(east).add(new Vector(5, 3))
  assert.equal(World.BODY_AT.get(body)?.q, east.x)

  // Another layer.
  body.tag = -1
  assert.equal(World.BODIES.get(0)?.size, 0)
  assert.equal(World.BODIES.get(-1)?.size, 6)
  assert.equal(World.mobHolds(off(0, 2).x, off(0, 2).y, -1), true)
  body.tag = 0
  assert.equal(World.BODIES.get(-1)?.size, 0)

  // Dead: held and hit on nothing at once, before the sweep.
  body.hit(1e6)
  assert.equal(body.destroyed, true)
  for (const cell of World.ringCells(east, 1)) {
    assert.equal(World.bodyAt(0, keyOf(cell)), undefined)
    assert.equal(World.mobHolds(cell.x, cell.y, 0), false)
    assert.deepEqual(World.FIND_IN_CELLS(cell, 0, 0, ObjectType.Player | ObjectType.Mob), [])
  }
  // The sweep (`World.update`'s MOBS pass) takes it out of the index.
  World.removeUnitAt(World.MOBS, World.MOBS.indexOf(body))
  assert.equal(World.BODIES.get(0)?.size, 0)
  assert.equal(World.BODY_AT.has(body), false)
})

test('a body a spec empties out of MOBS holds nothing; one never added is never filed', () => {
  const body = bodyOn(C)
  World.MOBS.length = 0
  for (const cell of World.ringCells(C, 1)) assert.equal(World.mobHolds(cell.x, cell.y, 0), false)
  const loose = new Unit(ObjectType.Mob, 0, 0, 10, 0, ARCHETYPES.brood)
  loose.position = Hex.toPosition(off(1, 5))
  assert.equal(World.BODY_AT.has(loose), false)
  assert.equal(World.bodyAt(0, keyOf(off(1, 6))), undefined)
  assert.equal(body.destroyed, false)
})

// --- hits: every player attack, on each ring cell -----------------------------

const MASK = ObjectType.Player | ObjectType.Mob

test('FIND_IN_CELLS takes a body on any of its cells, once, when the mask includes mobs; a players-only query does not look', () => {
  const body = bodyOn(C)
  for (const cell of World.ringCells(C, 1)) {
    assert.deepEqual(World.FIND_IN_CELLS(cell, 0, 0, MASK), [body], `ring cell ${cell.x},${cell.y}`)
    assert.deepEqual(World.FIND_IN_CELLS(cell, 0, 0, ObjectType.Player), [])
  }
  for (const cell of World.ringCells(C, 2)) assert.deepEqual(World.FIND_IN_CELLS(cell, 0, 0, MASK), [])
  // A disc over its centre and several ring cells finds it once.
  assert.deepEqual(World.FIND_IN_CELLS(C, 2, 0, MASK), [body])
  assert.deepEqual(World.FIND_IN_CELLS(off(0, 1), 1, 0, ObjectType.Mob), [body])
})

for (let i = 0; i < 6; i++) {
  test(`ranged: a player's shot hits a body on its ring cell ${i} without crossing its centre, and passes it at ring 2`, () => {
    // Along direction i+2 through ring cell i: the line never crosses the
    // centre, and meets ring cell i first (then ring cell i+1).
    const side = (i + 2) % 6
    const ringCell = off(i, 1)
    const body = bodyOn(C)
    const shooter = playerOn(off(i, 1, side, -3))
    assert.equal(new RangedAttack(shooter).execute(ringCell), true)
    assert.ok(body.hp < ARCHETYPES.reactor.maxHp, 'the shot passed the ring cell')
    // The line one ring further out touches ring 2 only.
    clear()
    const missed = bodyOn(C)
    const far = playerOn(off(i, 2, side, -3))
    assert.equal(new RangedAttack(far).execute(off(i, 2)), true)
    assert.equal(missed.hp, ARCHETYPES.reactor.maxHp, 'hit from ring 2')
  })

  test(`melee: a player 2 rings from ring cell ${i} (3 from the centre) hits the body; 4 from the centre misses`, () => {
    const body = bodyOn(C)
    const player = playerOn(off(i, 3))
    assert.equal(new MeleeAttack(player).execute(), true)
    assert.ok(body.hp < ARCHETYPES.reactor.maxHp)
    clear()
    const missed = bodyOn(C)
    assert.equal(new MeleeAttack(playerOn(off(i, 4))).execute(), true)
    assert.equal(missed.hp, ARCHETYPES.reactor.maxHp)
  })

  test(`bomb: a blast 2 rings from ring cell ${i} hits the body; from ring 4 it misses`, () => {
    const thrower = playerOn(off(i, 8))
    const body = bodyOn(C)
    detonate(thrower, ITEMS.bomb, ITEMS.bomb.use as Parameters<typeof detonate>[2], off(i, 3), 0)
    assert.ok(body.hp < ARCHETYPES.reactor.maxHp)
    const before = body.hp
    detonate(thrower, ITEMS.bomb, ITEMS.bomb.use as Parameters<typeof detonate>[2], off(i, 4), 0)
    assert.equal(body.hp, before)
  })

  test(`breath: a cone whose far ring reaches only ring cell ${i} hurts the body; one ring further misses`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const body = bodyOn(C)
    // 5 out along i, breathing back toward the centre: its 4th ring is ring cell i.
    const caster = playerOn(off(i, 5))
    assert.equal(new FireBreath(caster).execute(C), true)
    const area = World.AREA_EFFECT[0]
    assert.equal(area.overlaps(body.position), false, 'the centre itself is out of the cone')
    assert.equal(area.overlaps(body.position, body), true)
    body.update(DT)
    assert.ok(body.hp < ARCHETYPES.reactor.maxHp)
    clear()
    const missed = bodyOn(C)
    assert.equal(new FireBreath(playerOn(off(i, 6))).execute(C), true)
    missed.update(DT)
    assert.equal(missed.hp, ARCHETYPES.reactor.maxHp)
  })

  test(`breath: a cone over only ring cell ${i} provokes a Reactor's guard (GuardPosition reads the body too)`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const at = Hex.toPosition(C)
    const reactor = new Mob(at.x, at.y, 0, ARCHETYPES.reactor)
    World.addUnit(World.MOBS, reactor)
    const guard = reactor.routines[0] as unknown as { update: (dt: number) => void, targetAquiredAt: number }
    // Its own scan held off, so only the cone can give it a target.
    guard.targetAquiredAt = Date.now()
    const caster = playerOn(off(i, 5))
    assert.equal(new FireBreath(caster).execute(C), true)
    guard.update(DT)
    assert.equal(reactor.target, caster)
  })

  test(`Broodling blast: one going off on ring 2 next to ring cell ${i} hits the body`, () => {
    const body = bodyOn(C, ARCHETYPES.brood)
    const at = Hex.toPosition(off(i, 2))
    const ling = new Mob(at.x, at.y, 0, ARCHETYPES.broodling)
    World.addUnit(World.MOBS, ling)
    assert.equal(fuseOf(ling)?.detonate(), true)
    assert.ok(body.hp < ARCHETYPES.brood.maxHp)
    // From ring 3 it reaches ring 2 only.
    const before = body.hp
    const farAt = Hex.toPosition(off(i, 3))
    const far = new Mob(farAt.x, farAt.y, 0, ARCHETYPES.broodling)
    World.addUnit(World.MOBS, far)
    assert.equal(fuseOf(far)?.detonate(), true)
    assert.equal(body.hp, before)
  })
}

for (const [name, Make] of [['fireball', ThrowFireball], ['icicle', Throwicicle]] as const) {
  for (let i = 0; i < 6; i++) {
    test(`${name}: a throw passing 2 rings from the centre (direction ${i}) strikes the body through its ring; 3 rings out it flies past`, () => {
      // Along direction i+1, through the cells 2 out along i: the swath (1
      // ring round the line) covers ring cells, never the centre.
      const side = (i + 1) % 6
      for (const [rings, hits] of [[2, true], [3, false]] as const) {
        clear()
        const body = bodyOn(C)
        const caster = playerOn(off(i, rings, side, -4))
        assert.equal(new Make(caster).execute(off(i, rings, side, -3)), true)
        const projectile = World.PROJECTILES[0]
        for (let n = 0; n < 20 && !projectile.destroyed; n++) World.updateProjectiles(DT)
        assert.equal(projectile.destroyed, true)
        assert.equal(body.hp < ARCHETYPES.reactor.maxHp, hits, `${rings} rings out`)
      }
    })
  }
}

test('mob attacks on players are unchanged: a players-only query ignores bodies, and a body is never a player\'s shot\'s only blocker by mistake for a mob shooter', () => {
  const body = bodyOn(C)
  const line = Hex.line(off(0, 1, 2, -3), off(0, 1), 6)
  // A mob's shot (players only) passes the body's ring.
  assert.equal(World.FIRST_ON_LINE(line, Hex.toPosition(line[0]), 0, ObjectType.Player), undefined)
  assert.equal(World.FIRST_ON_LINE(line, Hex.toPosition(line[0]), 0, MASK), body)
})

// --- mobs among bodies ---------------------------------------------------------

test('another mob cannot step into a body\'s ring: it stalls on ring 2', () => {
  bodyOn(C)
  for (let i = 0; i < 6; i++) {
    const mob = smallOn(off(i, 4))
    mob.stepGoal = { cell: C, within: 0 }
    for (let n = 0; n < 40; n++) {
      mob.update(DT)
      assert.ok(Hex.distance(mob.cell, C) >= 2, `direction ${i}: stood in the ring`)
      if (mob.stepTo !== undefined) assert.ok(Hex.distance(mob.stepTo, C) >= 2, `direction ${i}: stepped into the ring`)
    }
    assert.equal(Hex.distance(mob.cell, C), 2)
    assert.equal(mob.stepBlocked, true)
    World.removeUnitAt(World.MOBS, World.MOBS.indexOf(mob))
  }
  for (const cell of World.ringCells(C, 1)) {
    assert.equal(World.mobHolds(cell.x, cell.y, 0), true)
    assert.equal(World.mobCellFree(cell.x, cell.y, 0), false)
  }
})

test('a body steps only where its whole body fits: it stalls rather than cover another mob, and holds both bodies (10 cells) while stepping', () => {
  const body = bodyOn(C)
  body.maxVelocity = 60
  const blocker = smallOn(off(0, 3))
  body.stepGoal = { cell: off(0, 6), within: 0 }

  let sawStep = false
  for (let n = 0; n < 40; n++) {
    body.update(DT)
    assert.ok(Hex.distance(body.cell, blocker.cell) >= 2, 'the body covered the other mob')
    if (body.stepTo !== undefined) {
      assert.ok(Hex.distance(body.stepTo, blocker.cell) >= 2, 'stepped to cover the other mob')
      // Mid-step: both bodies held, and nothing else.
      const held = [...(World.STEPS.get(0)?.entries() ?? [])].filter(([, u]) => u === body).map(([k]) => k)
      const want = new Set<number>()
      World.forKeysWithin(body.stepFrom as Vector, 1, (k) => want.add(k))
      World.forKeysWithin(body.stepTo, 1, (k) => want.add(k))
      assert.deepEqual(held.sort((a, b) => a - b), [...want].sort((a, b) => a - b))
      assert.equal(want.size, 10)
      // The cells it is moving its body onto are closed to other mobs now.
      const ahead = off(0, 1, 0, 0, body.stepTo)
      assert.equal(World.mobHolds(ahead.x, ahead.y, 0, blocker), true, 'its new ring cell is open mid-step')
      sawStep = true
    }
  }
  assert.ok(sawStep, 'it never stepped')
  // One step east, then the next would put its ring on the blocker.
  assert.deepEqual([body.cell.x, body.cell.y], [off(0, 1).x, off(0, 1).y])
  assert.equal(body.stepBlocked, true)
  assert.equal([...(World.STEPS.get(0)?.values() ?? [])].filter((u) => u === body).length, 0, 'the step claims were not released')
  for (const cell of World.ringCells(off(0, 1), 1)) assert.equal(World.bodyAt(0, keyOf(cell)), body)

  // The blocker gone, it walks on.
  World.removeUnitAt(World.MOBS, World.MOBS.indexOf(blocker))
  for (let n = 0; n < 60; n++) body.update(DT)
  assert.deepEqual([body.cell.x, body.cell.y], [off(0, 6).x, off(0, 6).y])
})

test('a body does not step its ring onto a blocked cell', () => {
  const body = bodyOn(C)
  body.maxVelocity = 60
  World.block(off(0, 2).x, off(0, 2).y, 0)
  body.stepGoal = { cell: off(0, 5), within: 0 }
  for (let n = 0; n < 20; n++) body.update(DT)
  assert.deepEqual([body.cell.x, body.cell.y], [C.x, C.y], 'it stepped its ring onto the rock')
  assert.equal(body.stepBlocked, true)
})

test('players still walk through a body (no change to player movement)', () => {
  bodyOn(C)
  const player = playerOn(off(3, 3))
  player.setDestination(off(0, 3).x, off(0, 3).y)
  assert.ok(player.path.some((c) => c.x === C.x && c.y === C.y), 'the route went round the body')
  for (let n = 0; n < 40 && player.path.length > 0; n++) player.update(DT)
  assert.deepEqual([player.cell.x, player.cell.y], [off(0, 3).x, off(0, 3).y])
})

// --- spawning --------------------------------------------------------------------

test('a body spawns only on a cell with all 7 cells free; a one-cell NPC takes a candidate whose ring is taken', () => {
  const world = World.current as unknown as { getUnobstructedPosition: (tag: number) => Vector | undefined, spawnMob: (a: Archetype, l: unknown) => void }
  const layer = LAYERS[0]
  const tag = layer.tag
  const taken = off(0, 0, 0, 0, new Vector(C.x - 20, C.y))
  smallOn(off(1, 1, 0, 0, taken), tag)
  const rocky = new Vector(C.x + 20, C.y)
  World.block(off(4, 1, 0, 0, rocky).x, off(4, 1, 0, 0, rocky).y, tag)
  const free = new Vector(C.x, C.y + 20)
  const own = world.getUnobstructedPosition
  try {
    let candidates = [taken, rocky, free]
    world.getUnobstructedPosition = () => { const c = candidates.shift(); return c === undefined ? undefined : Hex.toPosition(c) }
    world.spawnMob(ARCHETYPES.reactor, layer)
    const reactor = (World.MOBS as Mob[]).find((m) => m.archetype === ARCHETYPES.reactor)
    assert.ok(reactor !== undefined, 'no Reactor spawned')
    assert.deepEqual([reactor.cell.x, reactor.cell.y], [free.x, free.y])

    candidates = [taken]
    world.spawnMob(ARCHETYPES.compactor, layer)
    const compactor = (World.MOBS as Mob[]).find((m) => m.archetype === ARCHETYPES.compactor)
    assert.ok(compactor !== undefined)
    assert.deepEqual([compactor.cell.x, compactor.cell.y], [taken.x, taken.y])
  } finally {
    world.getUnobstructedPosition = own
  }
})

// --- a real world -----------------------------------------------------------------

test('two simulated minutes on a real world: no mob ever stands, or steps, on a body\'s cells, and no body covers a blocked, gate or arrival cell', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const redis = { on: function () { return this }, hincrby: async () => 0 } as unknown as Redis
  // eslint-disable-next-line no-new
  new Multiplayer(250, redis)
  const world = new World(4000)
  const deep = LAYERS.filter((l) => l.tag !== LAYERS[0].tag).map((l) => l.tag)
  // Players on the deep layers, so the bodies chase and step, not only idle.
  const players: Player[] = []
  for (let i = 0; i < 12; i++) {
    const player = World.createPlayer(`p${i}`)
    const tag = deep[i % deep.length]
    player.tag = tag
    player.position = Hex.toPosition(World.spawnCell(tag).cell)
    players.push(player)
  }
  const rebuilds = World.UNITS.rebuilds
  let bodySteps = 0
  let bodiesSeen = 0
  for (let tick = 0; tick < 480; tick++) {
    t.mock.timers.tick(250)
    for (const p of players) { p.hp = p.maxHp; p.armor = p.maxArmor }
    world.update(DT)
    for (const body of World.MOBS) {
      if (body.destroyed || body.bodyRings === 0) continue
      bodiesSeen++
      if (body.stepTo !== undefined) bodySteps++
      const cells: Vector[] = [body.cell, ...World.ringCells(body.cell, 1)]
      for (const cell of cells) {
        assert.equal(World.isBlocked(cell.x, cell.y, body.tag), false, `tick ${tick}: a ${(body as Mob).archetype.key} on a blocked cell`)
        assert.equal(World.GATES_ON(cell.x, cell.y, body.tag).length, 0, `tick ${tick}: a body on a gate`)
        assert.equal(World.isArrival(cell.x, cell.y, body.tag), false, `tick ${tick}: a body on an arrival cell`)
      }
      for (const other of World.MOBS) {
        if (other === body || other.destroyed || other.tag !== body.tag) continue
        const reach = 1 + other.bodyRings
        assert.ok(Hex.distance(other.cell, body.cell) > reach, `tick ${tick}: a ${(other as Mob).archetype.key} on a ${(body as Mob).archetype.key}'s body`)
        if (other.stepTo !== undefined) assert.ok(Hex.distance(other.stepTo, body.cell) > reach, `tick ${tick}: a step onto a body`)
      }
    }
  }
  assert.ok(bodiesSeen > 480 * 4, `bodies on only ${bodiesSeen} body-ticks`)
  assert.ok(bodySteps > 50, `bodies stepped on only ${bodySteps} body-ticks: the test says little`)
  assert.equal(World.UNITS.rebuilds, rebuilds, 'the cell index rebuilt: something edited a list behind it')
})
