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
import BotBrain, { BOT_KIT_BASE, botKit } from './brain'

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

function human (worlds: Worlds, id: string): { connection: Connection, start: () => Promise<void> } {
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
    start: async () => {
      handlers.start_requested({ id: 'abc123', name: id })
      // The account (decision #48): looked up and created before the run starts.
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
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

/**
 * Bots that can't be killed in a spec's lifetime, like the humans, for the
 * tests that count them: in 300 runs of the cap test, 7 had a bot die within
 * its 10 s (to another bot's scuffle, a mob, a breath after a portal down),
 * and the count came up one short; 1 in 300 of the displacement test lost its
 * staying bot the same way. Nor do they head out of their own accord: in
 * 1200 more runs of that test, a staying bot reached its loot goal on layer
 * 03 and extracted in the last 2 s, before the fill could replace it. Their
 * deaths and exits are play, not what these tests are about. Call after every
 * tick: the fill adds bots in it.
 */
function sturdy (world: World): void {
  for (const p of world.PLAYERS) {
    if (p.bot !== undefined && p.maxHp < 60000) {
      p.maxHp = 60000
      p.hp = 60000
      Object.assign(p.bot, { lootGoal: Infinity, deadline: Infinity })
    }
  }
}

function clock (t: TestContext): (ms: number) => void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  return (ms) => { t.mock.timers.tick(ms) }
}

test('a world with a human fills to the target, one bot every 2 s; none without a human', async (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 4, now: () => Date.now() })
  const world = worlds.worlds[0]
  for (let i = 0; i < 20; i++) { worlds.tickAll(250); tick(250) }
  assert.equal(bots(world), 0, 'no human, no bots')

  const a = human(worlds, 'a')
  await a.start()
  worlds.tickAll(250)
  sturdy(world)
  assert.equal(bots(world), 1, 'the first at once')
  for (let i = 0; i < 4; i++) { tick(250); worlds.tickAll(250); sturdy(world) }
  assert.equal(bots(world), 1, 'the next waits 2 s')
  for (let i = 0; i < 40; i++) { tick(250); worlds.tickAll(250); sturdy(world) }
  assert.equal(bots(world), 3, 'humans + bots = 4')
  assert.equal(Worlds.activePlayers(world), 1, 'bots are not humans')
  assert.equal(worlds.drained, false)
})

test('a human over the target displaces a bot, which heads out and is gone within the grace', async (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 3, now: () => Date.now() })
  const world = worlds.worlds[0]
  await human(worlds, 'a').start()
  for (let i = 0; i < 40; i++) { worlds.tickAll(250); sturdy(world); tick(250) }
  assert.equal(bots(world), 2)

  await human(worlds, 'b').start()
  worlds.tickAll(250)
  sturdy(world)
  assert.equal(bots(world), 1, 'one bot is leaving')
  const leaving = world.PLAYERS.find((p) => p.bot?.leaving === true)
  assert.ok(leaving !== undefined)
  for (let elapsed = 0; elapsed <= LEAVE_GRACE_MS + 1000; elapsed += 250) { tick(250); worlds.tickAll(250); sturdy(world) }
  assert.ok(leaving.exited || leaving.destroyed, 'out, by extracting or at the grace')
  assert.equal(bots(world), 1, 'and not replaced while the humans fill the rest')
})

test('bots never count as humans: world choice, idle and drain ignore them', async (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 1, idleMs: 300_000, redis: redisStub(), bots: 6, now: () => Date.now() })
  const a = human(worlds, 'a')
  await a.start()
  for (let i = 0; i < 40; i++) { worlds.tickAll(250); sturdy(worlds.worlds[0]); tick(250) }
  assert.ok(bots(worlds.worlds[0]) >= 5)
  // cap 1 counts humans only: the second human opens a second world, bots or not.
  await human(worlds, 'b').start()
  assert.equal(worlds.worlds.length, 2)
  worlds.drain()
  const player = a.connection.player
  const other = worlds.worlds.flatMap((w) => w.PLAYERS).filter((p) => p.bot === undefined && p !== player)
  assert.ok(player !== undefined)
  World.run(worlds.worldFor(a.connection) as World, () => { player.exit() })
  for (const p of other) World.run(worlds.worlds[1], () => { p.exit() })
  assert.equal(worlds.drained, true, 'bots alive, drained all the same')
})

test('a bot writes no stats and sends no analytics, and a kill on a bot counts for the human', async (t) => {
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
    await a.start()
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
    // The human's account id (decision #48), not the start's 'abc123'.
    const id = a.connection.account?.publicId as string
    assert.match(id, /^[0-9a-f]{16}$/)
    assert.ok(writes.every((w) => w.startsWith(`stats-${id} `)), `only the human's stats, got ${JSON.stringify(writes)}`)
    assert.ok(writes.some((w) => w === `stats-${id} kills`))
    assert.equal(me.kills, 1)
  } finally {
    Analytics.post = realPost
    delete process.env.GA_MEASUREMENT_ID
    delete process.env.GA_API_SECRET
  }
})

test('bots leave a human alone for the first 10 s of the run', async (t) => {
  const tick = clock(t)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 2, now: () => Date.now() })
  const world = worlds.worlds[0]
  const a = human(worlds, 'a')
  await a.start()
  worlds.tickAll(250)
  const me = a.connection.player
  const bot = world.PLAYERS.find((p) => p.bot !== undefined)
  assert.ok(me !== undefined && bot !== undefined)
  // No mobs at all: refilled every tick, one next to the human drew a bot's
  // melee, which hits everyone within 2 rings (2 runs in 20 failed that way).
  Object.assign(world, { refillLayer: () => {} })
  World.run(world, () => {
    // Nothing else around, and the bot right beside the human.
    world.MOBS.length = 0
    for (const p of world.PLAYERS) if (p !== me && p !== bot) p.exit()
    bot.position = Hex.toPosition(Hex.neighbour(me.cell, 0))
  })
  const full = me.hp + me.armor
  for (let i = 0; i < 36; i++) { tick(250); worlds.tickAll(250) }
  assert.equal(me.hp + me.armor, full, 'untouched at 9 s')
  // On to 10.25 s, past the grace, before putting it back: put back at 9 s,
  // its next think still saw a human in its grace, so it wandered, and on
  // layer 01 a quarter of its wanders head for a portal down. In 400 runs 3
  // bots were on layer 02 within 0.75 s and spent the window there.
  for (let i = 0; i < 5; i++) { tick(250); worlds.tickAll(250) }
  // It wandered off meanwhile, maybe through a portal: beside the human
  // again, on its layer, now the grace is over.
  World.run(world, () => {
    bot.stop()
    if (bot.tag !== me.tag) bot.changeLayer(me.tag)
    bot.position = Hex.toPosition(Hex.neighbour(me.cell, 0))
  })
  for (let i = 0; i < 24; i++) { tick(250); worlds.tickAll(250) }
  assert.ok(me.hp + me.armor < full, 'attacked after the grace')
})

test('ten simulated minutes: bots loot, fight, extract, without one error', async (t) => {
  const tick = clock(t)
  const errors: unknown[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 7, now: () => Date.now() })
    const world = worlds.worlds[0]
    const a = human(worlds, 'a')
    await a.start()
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
    // Every bot's kit (#48 step 4), and both throws turn up.
    const kits = new Set(list.map((p) => p.skillIds.join()))
    for (const kit of kits) assert.ok(kit === '2,3,4,6' || kit === '2,3,4,7', `a bot played kit ${kit}`)
    assert.equal(kits.size, 2, `${list.length} bots and only one kit`)
  } finally {
    console.error = realError
  }
})

// --- the kit and the brain's presses (decision #48 step 4) -----------------------

test('a bot\'s kit: melee, ranged, defend, plus fireball or icicle', () => {
  assert.deepEqual([...BOT_KIT_BASE], [2, 3, 4])
  assert.deepEqual(botKit(() => 0), [2, 3, 4, 6])
  assert.deepEqual(botKit(() => 0.49), [2, 3, 4, 6])
  assert.deepEqual(botKit(() => 0.5), [2, 3, 4, 7])
})

test('the brain presses by skill: melee, ranged and defend at their slots, the throw only on 02-03, never an empty or missing slot', () => {
  World.strict = false
  void new Multiplayer(250, redisStub())
  const world = new World(4000)
  World.MOBS.length = 0
  World.OBSTACLES.length = 0
  // Slot orders the brain can't know, so a press by fixed slot would miss.
  const cases: Array<{ kit: number[], throws: number | undefined }> = [
    { kit: [2, 3, 4, 6], throws: 6 },
    { kit: [2, 3, 4, 7], throws: 7 },
    { kit: [7, 4, 3, 2], throws: 7 },
    { kit: [1, 2, 3, 0], throws: undefined } // the start kit: no defend, no throw
  ]
  for (const { kit, throws } of cases) {
    const me = World.createPlayer(`bot-${kit.join('')}`, 'b', undefined, 'peep', kit)
    // random 0: the 30% throw always happens; with aimMiss 0 the aim never misses.
    const brain = new BotBrain(me, Date.now(), () => 0)
    const pressed: number[] = []
    const slots: number[] = []
    me.skills.forEach((skill, slot) => {
      if (skill !== null) skill.execute = () => { pressed.push(me.skillIds[slot]); return true }
    })
    const press = me.tryExecuteSkill.bind(me)
    me.tryExecuteSkill = (slot, aim) => { slots.push(slot); press(slot, aim) }
    const fight = (brain as unknown as { fight: (enemy: unknown, distance: number, skill: unknown, health: number, fleeing: boolean) => void }).fight.bind(brain)
    const enemy = { cell: Hex.neighbour(me.cell, 0), type: me.type }

    // On 01, close and hurt: defend, melee, ranged; no throw.
    fight(enemy, 1, { aimMiss: 0 }, 0.4, true)
    assert.deepEqual(pressed, [4, 2, 3].filter((id) => kit.includes(id)), `01, kit ${kit.join()}`)
    // On 02, at range: ranged and the throw it carries.
    pressed.length = 0
    me.tag = World.TAGS[1]
    fight(enemy, 3, { aimMiss: 0 }, 1, true)
    assert.deepEqual(pressed, throws === undefined ? [3] : [3, throws], `02, kit ${kit.join()}`)
    for (const slot of slots) {
      assert.ok(slot >= 0 && slot < 4, `pressed slot ${slot}`)
      assert.notEqual(me.skillIds[slot], 0, 'pressed an empty slot')
    }
  }
  world.close()
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
