import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Mob from '../objects/mob'
import Consumable from '../objects/consumable'
import { ObjectType } from '../objects/gameobject'
import { ARCHETYPES, LAYERS } from '../archetypes/archetypes'
import { ARCHETYPE_INFO, archetypeById } from '../utils/archetypes'
import { lookFor } from '../../../../plunder-land-client/src/objects/archetypesprites'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { PROGRESSION, runXp, xpToReach } from '../progress/xp'
import { buildFirstRun, FIRST_RUN, firstRunStrip } from './scenario'

/**
 * The first run's content (decision #58, task retest-5): Dez's strip
 * (`ideas/retest-onboarding.md` section 4), the rock (archetype 16), and that
 * the whole first run can't level an account by itself.
 */

afterEach(() => {
  World.strict = false
})

function redisStub (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

/** A first-run world with the scenario in it, current for `fn`. */
function withFirstRun<T> (fn: (world: World) => T): T {
  const world = World.build(FIRST_RUN.mapSize, { multiplayer: new Multiplayer(250, redisStub()), firstRun: true })
  return World.run(world, () => {
    buildFirstRun(world)
    return fn(world)
  })
}

const at = (mob: { position: Vector }): Vector => Hex.toCell(mob.position)

test('the strip: 24 centreline cells bent once, 5 wide, valleys everywhere else on the first layer, sent in hello.voids', () => {
  const { line, cells } = firstRunStrip()
  assert.equal(line.length, FIRST_RUN.padAt + 1)
  assert.equal(line.length, 24)
  for (let i = 1; i < line.length; i++) assert.equal(Hex.distance(line[i - 1], line[i]), 1, `a gap at ${i}`)
  // Bent: the far end is not on the first leg's line.
  assert.notEqual(line[line.length - 1].y, line[0].y)
  withFirstRun((world) => {
    const tag = World.TAGS[0]
    const voids = World.VOIDS.get(tag) as Set<number>
    let ground = 0
    for (const cell of Hex.mapCells(FIRST_RUN.mapSize)) {
      const key = Hex.key(cell.x, cell.y)
      const inStrip = cells.has(key)
      assert.equal(voids.has(key), !inStrip, `cell ${cell.x},${cell.y}`)
      assert.equal(World.isBlocked(cell.x, cell.y, tag), !inStrip)
      if (inStrip) ground++
    }
    assert.equal(ground, cells.size)
    // 5 wide: every centreline cell has its 2 rings of ground.
    for (const c of line) {
      for (const cell of Hex.mapCells(FIRST_RUN.mapSize)) {
        if (Hex.distance(cell, c) <= FIRST_RUN.halfWidth) assert.ok(cells.has(Hex.key(cell.x, cell.y)))
      }
    }
    // The encoding the client decodes covers the whole map.
    const runs = World.VOID_RUNS.get(tag) as number[]
    assert.equal(runs.reduce((a, b) => a + b, 0), Hex.mapCells(FIRST_RUN.mapSize).length)
    // The other layers: nothing (nobody reaches them).
    for (const other of World.TAGS.slice(1)) assert.equal(World.VOIDS.get(other), undefined)
    assert.deepEqual(world.spawn, line[0])
  })
})

test('the beats: 3 rocks, one Crawler, one Compactor, the pad at the end, and nothing else', () => {
  const { line, cells } = firstRunStrip()
  withFirstRun(() => {
    const rocks = World.MOBS.filter((m) => m.archetype === ARCHETYPES.rock)
    const crawlers = World.MOBS.filter((m) => m.archetype === ARCHETYPES.crawler)
    const compactors = World.MOBS.filter((m) => m.archetype === ARCHETYPES.compactor)
    assert.equal(rocks.length, 3)
    assert.equal(crawlers.length, 1)
    assert.equal(compactors.length, 1)
    assert.equal(World.MOBS.length, 5, 'something else among the mobs')
    for (const rock of rocks) {
      assert.equal(rock.hp, 24)
      assert.equal(rock.loot, 25)
      assert.ok(cells.has(Hex.key(at(rock).x, at(rock).y)), 'a rock off the strip')
    }
    assert.deepEqual(at(crawlers[0]), line[FIRST_RUN.crawlerAt])
    assert.deepEqual(at(compactors[0]), line[FIRST_RUN.compactorAt])
    // Beat 1: nothing within a robot's vision or shot (6) of the start.
    for (const mob of World.MOBS) assert.ok(Hex.distance(at(mob), line[0]) > 6, `${mob.archetype?.key ?? '?'} within reach of the start`)
    // The pad, and no other gate, pickup or item.
    assert.equal(World.OBSTACLES.length, 1)
    const pad = World.OBSTACLES[0]
    assert.equal(pad.type, ObjectType.Portal)
    assert.equal((pad as { handoff?: boolean }).handoff, true)
    assert.equal(pad.to, pad.tag, 'the pad leads somewhere: it would hop the player')
    assert.deepEqual(Hex.toCell(pad.position), line[FIRST_RUN.padAt])
    assert.equal(World.portalOn(line[FIRST_RUN.padAt].x, line[FIRST_RUN.padAt].y, pad.tag), undefined)
    assert.deepEqual([World.CONSUMABLES.length, World.ITEMS.length, World.GEAR.length, World.PLAYERS.length], [0, 0, 0, 0])
    // Every mob guards its own beat: placed by the scenario, never by a layer.
    for (const mob of World.MOBS) assert.ok(cells.has(Hex.key(at(mob).x, at(mob).y)))
  })
})

test('a rock: two shots of 12, a 25-loot pickup through the normal death path, no gear, inert', () => {
  withFirstRun((world) => {
    const rock = World.MOBS.find((m) => m.archetype === ARCHETYPES.rock) as Mob
    const cell = at(rock)
    for (let i = 0; i < 12; i++) world.update(0.25)
    assert.deepEqual(at(rock), cell, 'a rock moved')
    assert.equal(rock.hit(12), false)
    assert.equal(rock.hit(12), true)
    world.update(0.25)
    assert.equal(World.MOBS.includes(rock), false)
    const drops = World.CONSUMABLES as Consumable[]
    assert.equal(drops.length, 1)
    assert.equal(drops[0].loot, 25)
    assert.ok(Hex.distance(Hex.toCell(drops[0].position), cell) <= World.DROP_RINGS)
    assert.equal(World.isBlocked(Hex.toCell(drops[0].position).x, Hex.toCell(drops[0].position).y, rock.tag), false, 'the loot fell in a valley')
    assert.equal(World.GEAR.length, 0)
  })
  // Anywhere: its row rolls no gear and credits no stats key.
  assert.equal(ARCHETYPES.rock.gearRolls, null)
  assert.deepEqual(ARCHETYPES.rock.killStats, [])
  assert.deepEqual([ARCHETYPES.rock.skills, ARCHETYPES.rock.routines, ARCHETYPES.rock.contact.damage], [[], [], 0])
  const shared = World.build(1000, { multiplayer: new Multiplayer(250, redisStub()) })
  World.run(shared, () => {
    const rock = new Mob(500, 500, 0, ARCHETYPES.rock)
    for (let i = 0; i < 50; i++) assert.deepEqual(shared.createGearFrom(rock, () => 0), [])
  })
})

test('archetype 16 is the rock, drawn with the StoneWall crate', () => {
  assert.equal(ARCHETYPE_INFO.rock.id, 16)
  assert.equal(archetypeById(16)?.key, 'rock')
  assert.equal(ARCHETYPE_INFO.rock.kind, 'mob')
  assert.equal(ARCHETYPE_INFO.rock.rarity, null)
  assert.equal(lookFor('mob', ARCHETYPE_INFO.rock).still, 'crate')
  assert.equal(lookFor('mob', ARCHETYPE_INFO.crawler).still, undefined)
})

test('everything a first run can carry out stays below level 2 (40 XP): it can\'t unlock Melee by itself', () => {
  withFirstRun(() => {
    const mobKills: Record<string, number> = {}
    let loot = 0
    for (const mob of World.MOBS) {
      const key = mob.archetype?.key as string
      mobKills[key] = (mobKills[key] ?? 0) + 1
      loot += mob.loot
    }
    assert.equal(loot, 3 * 25 + Math.round(ARCHETYPES.crawler.loot * LAYERS[0].lootMultiplier) + Math.round(ARCHETYPES.compactor.loot * LAYERS[0].lootMultiplier))
    // All of it, banked by an extraction the moment the shared run begins.
    const xp = runXp({ extracted: true, loot, playerKills: 0, mobKills, deepestLayer: 1, seconds: 0 })
    assert.ok(xp < xpToReach(2), `the first run alone pays ${xp} XP`)
    assert.equal(xpToReach(2), PROGRESSION.curve.first)
  })
})
