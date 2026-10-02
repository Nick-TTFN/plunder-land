import test, { afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from '../network/multiplayer'
import Worlds from '../network/worlds'
import World from '../objects/world'
import type Player from '../objects/player'
import Analytics from '../analytics'
import { Hex } from '../utils/hex'
import { LEAVE_GRACE_MS } from './fill'

/**
 * Bots (decision #47): a world with a human is topped up to the target, a
 * human over it displaces a bot that leaves by extracting, an empty world's
 * bots head out, and bots count nowhere a world counts its humans. Then a
 * simulated ten minutes of a real world, to see that they play.
 */

afterEach(() => { World.strict = false })

function redisStub (writes: string[] = []): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async (key: string, field: string) => { writes.push(`${key} ${field}`); return 1 },
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

function human (worlds: Worlds, id: string): { connection: Connection, start: () => void } {
  const handlers: Record<string, (data?: unknown) => void> = {}
  const socket = {
    id,
    handshake: { query: { frames: '1' } },
    on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
    emit: () => true,
    conn: { write: () => {}, close: () => { handlers.disconnect?.() } }
  } as unknown as Socket
  const connection = worlds.onConnection(socket)
  return {
    connection,
    start: () => {
      handlers.start_requested({ id: 'abc123', name: id })
      // Can't be killed in a spec's lifetime (a mob or a bot would otherwise
      // end the run and change the human count): within hp's uint16 on the wire.
      const player = connection.player
      if (player !== undefined) { player.maxHp = 60000; player.hp = 60000 }
    }
  }
}

function bots (world: World): number {
  return world.PLAYERS.filter((p) => p.bot !== undefined && !p.destroyed && !p.exited && !p.bot.leaving).length
}

function clock (t: TestContext): (ms: number) => void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  return (ms) => { t.mock.timers.tick(ms) }
}

test('a world with a human fills to the target, one bot every 2 s; none without a human', (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 4, now: () => Date.now() })
  const world = worlds.worlds[0]
  for (let i = 0; i < 20; i++) { worlds.tickAll(250); tick(250) }
  assert.equal(bots(world), 0, 'no human, no bots')

  const a = human(worlds, 'a')
  a.start()
  worlds.tickAll(250)
  assert.equal(bots(world), 1, 'the first at once')
  for (let i = 0; i < 4; i++) { tick(250); worlds.tickAll(250) }
  assert.equal(bots(world), 1, 'the next waits 2 s')
  for (let i = 0; i < 40; i++) { tick(250); worlds.tickAll(250) }
  assert.equal(bots(world), 3, 'humans + bots = 4')
  assert.equal(Worlds.activePlayers(world), 1, 'bots are not humans')
  assert.equal(worlds.drained, false)
})

test('a human over the target displaces a bot, which heads out and is gone within the grace', (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 3, now: () => Date.now() })
  const world = worlds.worlds[0]
  human(worlds, 'a').start()
  for (let i = 0; i < 40; i++) { worlds.tickAll(250); tick(250) }
  assert.equal(bots(world), 2)

  human(worlds, 'b').start()
  worlds.tickAll(250)
  assert.equal(bots(world), 1, 'one bot is leaving')
  const leaving = world.PLAYERS.find((p) => p.bot?.leaving === true)
  assert.ok(leaving !== undefined)
  for (let elapsed = 0; elapsed <= LEAVE_GRACE_MS + 1000; elapsed += 250) { tick(250); worlds.tickAll(250) }
  assert.ok(leaving.exited || leaving.destroyed, 'out, by extracting or at the grace')
  assert.equal(bots(world), 1, 'and not replaced while the humans fill the rest')
})

test('bots never count as humans: world choice, idle and drain ignore them', (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 1, idleMs: 300_000, redis: redisStub(), bots: 6, now: () => Date.now() })
  const a = human(worlds, 'a')
  a.start()
  for (let i = 0; i < 40; i++) { worlds.tickAll(250); tick(250) }
  assert.ok(bots(worlds.worlds[0]) >= 5)
  // cap 1 counts humans only: the second human opens a second world, bots or not.
  human(worlds, 'b').start()
  assert.equal(worlds.worlds.length, 2)
  worlds.drain()
  const player = a.connection.player
  const other = worlds.worlds.flatMap((w) => w.PLAYERS).filter((p) => p.bot === undefined && p !== player)
  assert.ok(player !== undefined)
  World.run(worlds.worldFor(a.connection) as World, () => { player.exit() })
  for (const p of other) World.run(worlds.worlds[1], () => { p.exit() })
  assert.equal(worlds.drained, true, 'bots alive, drained all the same')
})

test('a bot writes no stats and sends no analytics, and a kill on a bot counts for the human', (t) => {
  clock(t)
  const writes: string[] = []
  const sent: string[] = []
  const realPost = Analytics.post
  Analytics.post = async (_url, body) => { sent.push(JSON.parse(body).events[0].name) }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
  try {
    const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(writes), bots: 2, now: () => Date.now() })
    const a = human(worlds, 'a')
    a.start()
    worlds.tickAll(250)
    const world = worlds.worlds[0]
    const bot = world.PLAYERS.find((p) => p.bot !== undefined)
    const me = a.connection.player
    assert.ok(bot !== undefined && me !== undefined)
    writes.length = 0
    sent.length = 0
    World.run(world, () => {
      bot.addLoot(5)
      bot.onKill(me) // a bot's kill: no stats
      if (bot.hit(99999)) me.onKill(bot) // the human's kill on a bot: counted
    })
    assert.deepEqual(sent, [], 'no first_loot for a bot')
    assert.ok(writes.every((w) => w.startsWith('stats-abc123')), `only the human's stats, got ${JSON.stringify(writes)}`)
    assert.ok(writes.some((w) => w === 'stats-abc123 kills'))
    assert.equal(me.kills, 1)
  } finally {
    Analytics.post = realPost
    delete process.env.GA_MEASUREMENT_ID
    delete process.env.GA_API_SECRET
  }
})

test('bots leave a human alone for the first 10 s of the run', (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 2, now: () => Date.now() })
  const world = worlds.worlds[0]
  const a = human(worlds, 'a')
  a.start()
  worlds.tickAll(250)
  const me = a.connection.player
  const bot = world.PLAYERS.find((p) => p.bot !== undefined)
  assert.ok(me !== undefined && bot !== undefined)
  World.run(world, () => {
    // Nothing else around, and the bot right beside the human.
    world.MOBS.length = 0
    for (const p of world.PLAYERS) if (p !== me && p !== bot) p.exit()
    bot.position = Hex.toPosition(Hex.neighbour(me.cell, 0))
  })
  const full = me.hp + me.armor
  for (let i = 0; i < 36; i++) { tick(250); worlds.tickAll(250); World.run(world, () => { world.MOBS.length = 0 }) }
  assert.equal(me.hp + me.armor, full, 'untouched at 9 s')
  // It wandered off to loot meanwhile: beside the human again as the grace ends.
  World.run(world, () => { bot.stop(); bot.position = Hex.toPosition(Hex.neighbour(me.cell, 0)) })
  for (let i = 0; i < 24; i++) { tick(250); worlds.tickAll(250); World.run(world, () => { world.MOBS.length = 0 }) }
  assert.ok(me.hp + me.armor < full, 'attacked after the grace')
})

test('ten simulated minutes: bots loot, fight, extract, without one error', (t) => {
  const tick = clock(t)
  const errors: unknown[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 7, now: () => Date.now() })
    const world = worlds.worlds[0]
    const a = human(worlds, 'a')
    a.start()
    // A human who stands still and can't be killed, so the world keeps its bots.
    // Every bot that ever played, by object: FINISHED forgets after 10 s.
    const all = new Set<Player>()
    const ended = new Map<Player, number>()
    for (let i = 0; i < 2400; i++) {
      tick(250)
      worlds.tickAll(250)
      for (const p of world.PLAYERS) if (p.bot !== undefined) all.add(p)
      for (const p of all) if ((p.destroyed || p.exited) && !ended.has(p)) ended.set(p, Date.now() - p.createdAt)
    }
    if (process.env.BOT_DEBUG === '1') {
      for (const p of all) {
        if (!p.exited || !p.extracted) continue
        const b = p.bot as NonNullable<Player['bot']>
        console.log(`DBG out after ${Math.round((ended.get(p) ?? 0) / 1000)}s loot ${p.loot}/${b.lootGoal} hp ${p.hp}/${p.maxHp} medkits ${p.inventory[0]} leaving ${b.leaving}`)
      }
    }
    const lengths = [...ended.values()].sort((x, y) => x - y)
    console.log(`run seconds: median ${Math.round((lengths[lengths.length >> 1] ?? 0) / 1000)}, min ${Math.round((lengths[0] ?? 0) / 1000)}, max ${Math.round((lengths[lengths.length - 1] ?? 0) / 1000)}`)
    console.error = realError
    const list = [...all]
    const extracted = list.filter((p) => p.exited && p.extracted)
    const died = list.filter((p) => p.destroyed && !p.exited)
    const kills = list.reduce((n, p) => n + p.kills, 0)
    const looted = list.filter((p) => p.loot > 0).length
    const deeper = list.filter((p) => p.deepestTag < World.TAGS[0]).length
    console.log(`bots ${list.length}: ${extracted.length} extracted (loot ${extracted.map((p) => p.loot).join(' ')}), ${died.length} died; ${looted} looted, ${kills} kills, ${deeper} went deeper`)
    assert.deepEqual(errors, [], 'no tick error')
    assert.ok(extracted.length > 0, 'some bot found an exit and extracted')
    assert.ok(looted > list.length / 2, 'most bots pick up loot')
  } finally {
    console.error = realError
  }
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
