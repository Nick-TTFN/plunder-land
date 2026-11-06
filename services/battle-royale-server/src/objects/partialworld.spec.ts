import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Portal from './portal'
import Exit from './exit'
import type Player from './player'
import HandoffGate from '../firstrun/gate'
import Analytics from '../analytics'
import { BOT_SKILL, botLayer } from '../bots/brain'
import { ObjectType } from './gameobject'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * A world that holds only some of the layers (decision #60, task private-1):
 * `WorldOptions.layers`. Every world keeps the global `World.TAGS`; an unheld
 * layer is built empty, and a held layer's portals into it are pads out of
 * the world (`HandoffGate` with the real `to`) that hop nobody and hand a
 * human off. A default world (no `layers`) is unchanged: compared byte for
 * byte against the base commit by a seeded script, see the task's handoff.
 */

const [TOP, MIDDLE, BOTTOM] = World.TAGS

function redisStub (): Redis {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  return redis
}

/** A partial world, not left current. */
function build (layers?: readonly number[], padsUp?: boolean): { world: World, mp: Multiplayer } {
  const mp = new Multiplayer(250, redisStub())
  const world = World.build(4000, { multiplayer: mp, layers, padsUp })
  return { world, mp }
}

const gatesOf = (world: World): Array<Portal | Exit> =>
  world.OBSTACLES.filter((o): o is Portal | Exit => o instanceof Portal || o instanceof Exit)

const pads = (world: World): HandoffGate[] => gatesOf(world).filter((g): g is HandoffGate => g instanceof HandoffGate)

test('layers [0, -1]: valleys, walls and gates on 0 and -1 only; -1\'s down count is pads to -2; nothing ever on -2 over 2000 ticks', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const { world } = build([TOP, MIDDLE])
  World.run(world, () => {
    assert.ok((world.VOIDS.get(TOP)?.size ?? 0) > 0, 'no valleys on 0')
    assert.ok((world.VOIDS.get(MIDDLE)?.size ?? 0) > 0, 'no valleys on -1')
    assert.ok((world.WALLS.get(TOP)?.size ?? 0) > 0, 'no walls on 0')
    assert.equal(world.VOIDS.get(BOTTOM), undefined)
    assert.equal(world.WALLS.get(BOTTOM), undefined)
    assert.equal(world.BLOCKED.get(BOTTOM)?.size ?? 0, 0)
    assert.equal(world.VOID_RUNS.get(BOTTOM), undefined)
    assert.equal(world.WALL_RUNS.get(BOTTOM), undefined)
    assert.deepEqual(World.TAGS.filter((tag) => world.holds(tag)), [TOP, MIDDLE])
    assert.equal(world.topLayer, TOP)

    const gates = gatesOf(world)
    assert.equal(gates.filter((g) => g.tag === BOTTOM).length, 0, 'a gate on -2')
    // Layer 0: down portals to -1 and exits, no pad.
    for (const g of gates.filter((g) => g.tag === TOP)) {
      assert.ok(g instanceof Exit || (!(g instanceof HandoffGate) && g.to === MIDDLE), 'layer 0 gate leads somewhere unexpected')
    }
    // Layer -1: its up portals still lead to 0 (held), its down count is pads.
    const middle = gates.filter((g) => g.tag === MIDDLE)
    const up = middle.filter((g) => g instanceof Portal && !(g instanceof HandoffGate))
    assert.ok(up.length > 0 && up.every((g) => g.to === TOP), 'up portals on -1')
    const out = pads(world)
    assert.ok(out.length > 0 && out.length <= World.LAYERS[1].portalsDown, `pads: ${out.length}`)
    for (const pad of out) {
      assert.equal(pad.tag, MIDDLE)
      assert.equal(pad.to, BOTTOM)
      assert.equal(pad.type, ObjectType.Portal, 'on the wire a pad is a portal')
      const cell = Hex.toCell(pad.position)
      assert.equal(World.portalOn(cell.x, cell.y, MIDDLE), undefined, 'portalOn finds a pad out of the world')
      assert.equal(World.padOn(cell.x, cell.y, MIDDLE), pad)
    }
    assert.equal(world.unheldRuns(TOP).length, 0)
    assert.deepEqual(world.unheldRuns(BOTTOM), [0, Hex.mapCells(4000).length])

    // A human on each held layer, so caches fill too; healed every tick.
    const humans = [
      World.createPlayer('a1', 'top'),
      World.createPlayer('a2', 'middle', undefined, undefined, undefined, MIDDLE),
      // A tag the world does not hold falls back to its top layer.
      World.createPlayer('a3', 'bottom', undefined, undefined, undefined, BOTTOM)
    ]
    assert.deepEqual(humans.map((h) => h.tag), [TOP, MIDDLE, TOP])
    const seen = new Set<number>()
    for (let tick = 0; tick < 2000; tick++) {
      t.mock.timers.tick(250)
      for (const h of humans) { h.maxHp = 60000; h.hp = 60000 }
      world.update(0.25)
      for (const list of [world.MOBS, world.CONSUMABLES, world.ITEMS, world.GEAR, world.PLAYERS, world.OBSTACLES] as Array<Array<{ tag: number }>>) {
        for (const o of list) {
          seen.add(o.tag)
          if (o.tag === BOTTOM) assert.fail(`tick ${tick}: ${o.constructor.name} on -2`)
        }
      }
    }
    assert.ok(world.MOBS.some((m) => m.tag === TOP) && world.MOBS.some((m) => m.tag === MIDDLE), 'no mobs spawned on the held layers')
    assert.ok(world.CONSUMABLES.some((c) => c.tag === MIDDLE), 'no loot on -1')
    assert.deepEqual([...seen].sort(), [MIDDLE, TOP].sort())
  })
  world.close()
})

test('a pad out of the world: a human on it is handed off once a tick and stays on -1; a bot on it is not; a route ends on it', () => {
  const { world } = build([TOP, MIDDLE])
  World.run(world, () => {
    world.MOBS.length = 0
    const pad = pads(world)[0]
    assert.ok(pad !== undefined)
    const cell = Hex.toCell(pad.position)
    const handed: Player[] = []
    world.handoff = (p) => { handed.push(p) }

    const human = World.createPlayer('h1', 'human', undefined, undefined, undefined, MIDDLE)
    human.position = Hex.toPosition(cell)
    human.update(0.25)
    assert.equal(human.tag, MIDDLE, 'the pad hopped the human')
    assert.deepEqual(handed, [human])
    human.update(0.25)
    assert.equal(handed.length, 2, 'every tick on the pad calls it; Worlds keeps it single')
    assert.equal(human.tag, MIDDLE)

    // A bot standing on it is never handed off.
    const bot = World.createPlayer('bot-1', 'bot', undefined, 'magnet', undefined, MIDDLE)
    bot.bot = {} as unknown as NonNullable<Player['bot']>
    bot.position = Hex.toPosition(cell)
    bot.update(0.25)
    assert.equal(handed.length, 2, 'a bot was handed off')
    assert.equal(bot.tag, MIDDLE)

    // The client's `_stopsOn` ends a route on any portal to another tag, so
    // the server ends it there too (`Player.stopsOn`).
    const walker = World.createPlayer('h2', 'walker', undefined, undefined, undefined, MIDDLE)
    assert.equal(walker.stopsOn(cell.x, cell.y), true)
    walker.path = [Hex.neighbour(cell, 3), cell, Hex.neighbour(cell, 0)].map((c) => new Vector(c.x, c.y))
    walker.endAtPortal()
    assert.equal(walker.path.length, 2, 'a route ran on past a pad')
  })
  world.close()
})

test('layers [-2]: a human joins on -2; hello keeps every tag, sends -2\'s valleys and one all-void run for 0 and -1; no gate leads up', async (t: TestContext) => {
  const sent: Array<{ name: string, params: Record<string, unknown> }> = []
  const realPost = Analytics.post
  Analytics.post = async (_url, body) => { sent.push(...JSON.parse(body).events) }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
  t.after(() => {
    Analytics.post = realPost
    delete process.env.GA_MEASUREMENT_ID
    delete process.env.GA_API_SECRET
  })

  const { world, mp } = build([BOTTOM])
  World.run(world, () => {
    assert.equal(world.topLayer, BOTTOM)
    assert.equal(world.VOIDS.get(TOP), undefined)
    assert.equal(world.VOIDS.get(MIDDLE), undefined)
    const gates = gatesOf(world)
    assert.ok(gates.every((g) => g.tag === BOTTOM), 'a gate off -2')
    // padsUp left out: -2's up count places nothing, so only exits.
    assert.ok(gates.length > 0 && gates.every((g) => g instanceof Exit), 'a gate leads up out of a shared world')

    const handlers: Record<string, (data?: unknown) => void> = {}
    const hellos: Array<Record<string, unknown>> = []
    const socket = {
      id: 's1',
      handshake: { query: { frames: '1' } },
      on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
      emit: (event: string, data: Record<string, unknown>) => { if (event === 'hello') hellos.push(data); return true },
      conn: { write: () => {} }
    } as unknown as Socket
    mp.onConnect(socket)
    handlers.start_requested({ id: 'abc123', name: 'deep' })
    const player = world.PLAYERS[world.PLAYERS.length - 1]
    assert.equal(player.tag, BOTTOM, 'the human did not join on -2')

    assert.equal(hellos.length, 1)
    const hello = hellos[0]
    assert.deepEqual(hello.layers, World.TAGS)
    const all = Hex.mapCells(4000).length
    assert.deepEqual(hello.voids, [[0, all], [0, all], world.VOID_RUNS.get(BOTTOM)])
    assert.deepEqual(hello.walls, [[], [], world.WALL_RUNS.get(BOTTOM)])

    // Layer numbers stay global: -2 is layer 03 for the bots and in run_end.
    assert.equal(botLayer(BOTTOM), BOT_SKILL[2])
    Multiplayer.sendRunEnd(player)
  })
  // `sendRunEnd` queues its GA send on a microtask.
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runEnd = sent.find((e) => e.name === 'run_end')
  assert.equal(runEnd?.params.deepest_layer, 3)
  world.close()
})

test('padsUp: a held layer\'s up count into an unheld layer places pads, with the real `to`', () => {
  const { world } = build([BOTTOM], true)
  World.run(world, () => {
    const out = pads(world)
    assert.ok(out.length > 0 && out.every((p) => p.tag === BOTTOM && p.to === MIDDLE))
  })
  world.close()
})

test('a world must hold some known layers', () => {
  assert.throws(() => build([]))
  assert.throws(() => build([TOP, 7]))
})

test('a default world holds every layer: no pads, no all-void runs, portalOn as before', () => {
  const { world } = build()
  World.run(world, () => {
    assert.equal(world.held, undefined)
    assert.ok(World.TAGS.every((tag) => world.holds(tag)))
    assert.equal(world.topLayer, TOP)
    for (const tag of World.TAGS) assert.deepEqual(world.unheldRuns(tag), [])
    assert.equal(pads(world).length, 0)
    for (const g of gatesOf(world)) {
      if (!(g instanceof Portal)) continue
      const cell = Hex.toCell(g.position)
      assert.equal(World.portalOn(cell.x, cell.y, g.tag), g)
      assert.equal(World.padOn(cell.x, cell.y, g.tag), undefined)
    }
  })
  world.close()
})
