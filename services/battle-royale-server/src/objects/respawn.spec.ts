import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Mob from './mob'
import type Player from './player'
import { ARCHETYPES, LAYERS } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'

/**
 * Mob respawn (Nick 2026-11-10: "instant mob respawn, sometimes you get him
 * straight away on the same spot you just killed him"): a layer fills at
 * once, then a killed mob's slot waits `LayerSpec.mobRespawnMs`, and no mob
 * spawns within `World.SPAWN_CLEAR_OF_HUMANS` rings of a human.
 */

const DT = 0.25
const DEEP = LAYERS[2].tag

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null, keys: async () => [], hgetall: async () => ({})
  }) as unknown as Redis
}

function freshWorld (): World {
  World.strict = false
  void new Multiplayer(250, redisStub())
  const world = new World(4000)
  // No gates to carry anyone anywhere (CLAUDE.md, "Specs that tick a real new World()").
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  Timers.clear()
  return world
}

const compactors = (tag: number): Mob[] =>
  (World.MOBS as Mob[]).filter((m) => m.archetype === ARCHETYPES.compactor && m.tag === tag && !m.destroyed)

test('respawn delays: 01 45 s, 02 30 s, 03-05 20 s', () => {
  assert.deepEqual(LAYERS.map((l) => l.mobRespawnMs), [45000, 30000, 20000, 20000, 20000])
})

test('a layer fills at once; a killed mob\'s slot waits its layer\'s delay, then refills', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const world = freshWorld()
  const want = LAYERS[2].mobs.find((e) => !('pack' in e) && e.archetype === ARCHETYPES.compactor)?.count ?? 0
  assert.ok(want > 1)
  // The first fill: one a tick per entry, no delay.
  for (let i = 0; i < want + 2; i++) { t.mock.timers.tick(250); world.update(DT) }
  assert.equal(compactors(DEEP).length, want, 'the first fill waited')

  compactors(DEEP)[0].hit(100_000)
  const delay = LAYERS[2].mobRespawnMs ?? 0
  const killedAt = Date.now()
  while (Date.now() - killedAt < delay - 250) {
    t.mock.timers.tick(250)
    world.update(DT)
    assert.equal(compactors(DEEP).length, want - 1, `back ${Date.now() - killedAt} ms after the kill`)
  }
  // Due now; it may take a few ticks to find a spot.
  for (let i = 0; i < 8 && compactors(DEEP).length < want; i++) { t.mock.timers.tick(250); world.update(DT) }
  assert.equal(compactors(DEEP).length, want, 'never came back')
  world.close()
})

test('two killed together come back one delay apart', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const world = freshWorld()
  const want = compactors(DEEP).length
  for (let i = 0; i < 12; i++) { t.mock.timers.tick(250); world.update(DT) }
  const full = compactors(DEEP).length
  assert.ok(full >= 2 && full >= want)
  compactors(DEEP)[0].hit(100_000)
  compactors(DEEP)[1].hit(100_000)
  const delay = LAYERS[2].mobRespawnMs ?? 0
  const at = Date.now()
  const back: number[] = []
  let last = full - 2
  while (Date.now() - at < delay * 2 + 5000) {
    t.mock.timers.tick(250)
    world.update(DT)
    const n = compactors(DEEP).length
    if (n > last) back.push(Date.now() - at)
    last = n
  }
  assert.equal(back.length, 2, `came back at ${back.join()}`)
  assert.ok(back[0] >= delay && back[0] < delay + 2000, `the first at ${back[0]}`)
  assert.ok(back[1] - back[0] >= delay, `the second ${back[1] - back[0]} ms after the first`)
  world.close()
})

test('no mob spawns within SPAWN_CLEAR_OF_HUMANS rings of a human; a bot does not hold spawns off', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  // Refill at once, so many spawns happen in the run.
  const before = World.LAYERS
  World.LAYERS = LAYERS.map((layer) => ({ ...layer, mobRespawnMs: 0 }))
  t.after(() => { World.LAYERS = before })
  const world = freshWorld()
  const human: Player = World.createPlayer('a0000c', 'h', undefined, 'peep', undefined, DEEP)
  const keepOut = World.SPAWN_CLEAR_OF_HUMANS
  assert.equal(keepOut, 8)
  const known = new Set<Mob>()
  let spawns = 0
  for (let tick = 0; tick < 400; tick++) {
    t.mock.timers.tick(250)
    // Kill everything on the layer now and then, so it refills again and again.
    if (tick % 10 === 0) for (const m of World.MOBS as Mob[]) if (m.tag === DEEP && !m.destroyed) m.hit(100_000)
    human.hp = human.maxHp
    world.update(DT)
    for (const m of World.MOBS as Mob[]) {
      if (known.has(m) || m.tag !== DEEP || m.destroyed) continue
      known.add(m)
      spawns++
      // A pack member may stand one ring off its centre, which was checked.
      const d = Hex.distance(m.cell, human.cell)
      assert.ok(d > keepOut - (m.pack !== undefined ? 1 : 0), `a ${m.archetype.key} spawned ${d} rings from the human`)
    }
  }
  assert.ok(spawns > 100, `only ${spawns} spawns`)

  // A bot standing on a spot does not stop a spawn there.
  const bot = World.createPlayer('bot-x', 'b', undefined, 'peep', undefined, DEEP)
  Object.assign(bot, { bot: {} })
  assert.equal(World.farFromHumans(bot.cell, DEEP), Hex.distance(bot.cell, human.cell) > keepOut)
  world.close()
})
