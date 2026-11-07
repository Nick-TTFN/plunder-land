import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import HandoffGate from '../firstrun/gate'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import BotBrain, { BOT_SKILL, botLayer, kitOf, robotAllowedOn } from './brain'
import BotFill from './fill'

/**
 * Bots in a partial world (decision #60, task private-1): a pad out of the
 * world leads to a layer the world does not hold, and a bot is never handed
 * off, so it must never route to one, however keen to descend it is.
 */

const [TOP, MIDDLE, BOTTOM] = World.TAGS

function seeded (seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
}

test('a diver bot on layer -1 of a [0, -1] world never routes to a pad to -2 nor stands on one, over 2000 ticks', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  const mp = new Multiplayer(250, redis)
  const world = World.build(4000, { multiplayer: mp, layers: [TOP, MIDDLE] })
  World.run(world, () => {
    world.MOBS.length = 0
    world.CONSUMABLES.length = 0
    world.ITEMS.length = 0
    world.GEAR.length = 0
    const pads = world.OBSTACLES.filter((o): o is HandoffGate => o instanceof HandoffGate)
    assert.ok(pads.length > 0)
    const padCells = new Set(pads.map((p) => { const c = Hex.toCell(p.position); return Hex.key(c.x, c.y) }))

    // A Hopper: listed on 02 and 03 but not 01, so it stays on -1 (no up
    // portal), and only the held-layer gate keeps it off the pads to -2.
    const rows = BOT_SKILL.map((row) => (row.robots as readonly string[]).includes('hopper'))
    assert.deepEqual(rows, [false, true, true, true, true])
    assert.equal(robotAllowedOn('hopper', BOTTOM), false, 'a bot may go to a layer this world does not hold')
    assert.equal(robotAllowedOn('hopper', MIDDLE), true)
    assert.ok(botLayer(MIDDLE).descend > 0)

    const random = seeded(99)
    const bot = World.createPlayer('bot-diver', 'diver', undefined, 'hopper', kitOf('diver', random), MIDDLE)
    bot.bot = new BotBrain(bot, Date.now(), random, 'diver')
    bot.addAIRoutine(bot.bot)
    bot.maxHp = 60000
    bot.hp = 60000

    let routes = 0
    let moved = 0
    let last = Hex.key(bot.cell.x, bot.cell.y)
    // 100 ms a tick: 200 s, inside a diver's 240 s deadline, so it never heads out.
    for (let tick = 0; tick < 2000; tick++) {
      t.mock.timers.tick(100)
      bot.update(0.1)
      const here = Hex.key(bot.cell.x, bot.cell.y)
      if (here !== last) moved++
      last = here
      assert.equal(bot.tag, MIDDLE, `tick ${tick}: the bot left -1`)
      assert.ok(!padCells.has(here), `tick ${tick}: the bot stands on a pad`)
      const end = bot.path[bot.path.length - 1]
      if (end !== undefined) {
        routes++
        assert.ok(!padCells.has(Hex.key(end.x, end.y)), `tick ${tick}: the bot's route ends on a pad`)
      }
    }
    assert.ok(moved > 50 && routes > 0, `the bot hardly moved (${moved} cells, ${routes} ticks routed)`)
  })
  world.close()
})

test('a bot sent straight at a pad (a wander or a walk to loot that ends there) halts instead', () => {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  const mp = new Multiplayer(250, redis)
  const world = World.build(4000, { multiplayer: mp, layers: [TOP, MIDDLE] })
  World.run(world, () => {
    world.MOBS.length = 0
    const pad = world.OBSTACLES.find((o): o is HandoffGate => o instanceof HandoffGate)
    assert.ok(pad !== undefined)
    const cell = Hex.toCell(pad.position)
    const bot = World.createPlayer('bot-walker', 'walker', undefined, 'hopper', undefined, MIDDLE)
    bot.position = Hex.toPosition(Hex.neighbour(Hex.neighbour(cell, 3), 3))
    const brain = new BotBrain(bot, Date.now(), seeded(3), 'steady')
    bot.bot = brain
    const go = (brain as unknown as { go: (c: Vector) => boolean }).go.bind(brain)
    assert.equal(go(new Vector(cell.x, cell.y)), false, 'the bot took a route onto a pad')
    assert.equal(bot.path.length, 0)
  })
  world.close()
})

test('a bot with no layer joins the world\'s top held layer', () => {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  const mp = new Multiplayer(250, redis)
  const world = World.build(4000, { multiplayer: mp, layers: [BOTTOM] })
  World.run(world, () => {
    const fill = new BotFill(1, 0, seeded(5))
    const bot = fill.spawn(Date.now())
    assert.equal(bot.tag, BOTTOM)
  })
  world.close()
})
