import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds, { PRIVATE_BOTS_DEFAULT } from './worlds'
import World from '../objects/world'
import Mob from '../objects/mob'
import { ARCHETYPES } from '../archetypes/archetypes'
import type Player from '../objects/player'
import { type Unit } from '../objects/unit'
import { MemoryAccountStore } from '../db/accounts'
import GuardPosition from '../ai/guardposition'
import Analytics from '../analytics'
import { Hex } from '../utils/hex'

/**
 * Private-13 (decision #60, Nick's Q-C and Q-D): in a private world an idle
 * mob beyond every viewpoint's reach sleeps (its `update` is skipped) and a
 * far bot thinks `FAR_THINK_FACTOR` times less often. What a player could see
 * or be noticed by is always awake; a hit wakes a mob and its pack; a
 * spectated bot is a viewpoint; shared worlds never sleep anything.
 *
 * Which mobs slept is read off a spy on `Mob.prototype.update`, not off the
 * code under test. Worlds and players are compared by identity only
 * (`assert.ok(a === b)`, CLAUDE.md).
 */

let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
const realPost = Analytics.post
const realUpdate = Mob.prototype.update
const realNow = Date.now
/** The world's clock: bots join and think on it (as private.spec.ts). */
let clock = 0
/** The mobs whose `update` ran since the last `clear`. */
const updated = new Set<Unit>()

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = () => {}
  Worlds.accountSuccess()
  Analytics.post = async () => {}
  updated.clear()
  clock = realNow()
  Date.now = () => clock
  Mob.prototype.update = function (this: Mob, dt: number) {
    updated.add(this)
    realUpdate.call(this, dt)
  }
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  World.strict = false
  Analytics.post = realPost
  Mob.prototype.update = realUpdate
  Date.now = realNow
})

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly socket: Socket
  connection!: Connection

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: () => true,
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function makeWorlds (store: MemoryAccountStore): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), accounts: store, privateBots: PRIVATE_BOTS_DEFAULT })
}

/**
 * A private run, its bots joined (the clock jumps 2.5 s a tick for a few
 * ticks, as private.spec.ts does): its worlds, client, world and player. The
 * player is healed and unhittable, so no NPC or bot ends the run mid-spec.
 */
async function privateRun (): Promise<{ worlds: Worlds, client: Client, world: World, player: Player }> {
  const store = new MemoryAccountStore()
  const worlds = makeWorlds(store)
  const { token } = await store.create()
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  client.handlers.start_requested({ id: 'abcdef', name: 'a' })
  await settle()
  const world = worlds.worldFor(client.connection)
  const player = client.connection.player
  assert.ok(world !== undefined && player !== undefined, 'the run did not start')
  assert.ok(worlds.privates.includes(world), 'the run is not in a private world')
  World.run(world, () => { player.hit = () => false })
  for (let i = 0; i < 4; i++) {
    clock += 2500
    worlds.tickAll(250)
  }
  assert.ok(world.PLAYERS.some((p) => p.bot !== undefined), 'no bot joined')
  return { worlds, client, world, player }
}

/** Keeps `player` alive and puts it on a random free cell of its layer. */
function moveTo (world: World, player: Player, random: () => number): void {
  World.run(world, () => {
    player.hp = player.maxHP()
    player.stop()
    const at = world.getUnobstructedPosition(player.tag, random)
    assert.ok(at !== undefined, 'no free cell')
    player.position = at
  })
}

/** A seeded generator, so a failing run can be replayed. */
function seeded (seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

/** A guard's acquire rings, or 0 for a mob with no guard. */
function acquireOf (mob: Unit): number {
  let rings = 0
  for (const routine of mob.routines) if (routine instanceof GuardPosition) rings = Math.max(rings, routine.spec.acquire)
  return rings
}

/**
 * Ticks once with the spy cleared; the mobs that slept: in the world before
 * the tick, alive after it, not updated (the refill adds mobs after the mob
 * loop, which no tick has updated yet).
 */
function tick (worlds: Worlds, world: World, run: () => void = () => { worlds.tickAll(250) }): Unit[] {
  const before = new Set(world.MOBS)
  updated.clear()
  clock += 250
  run()
  return world.MOBS.filter((mob) => before.has(mob) && !mob.destroyed && !updated.has(mob))
}

/**
 * Every tick: no mob within the viewer's enter radius, or whose acquire rings
 * reach the viewer, slept; every sleeping mob is held by no connection (so no
 * update, create or destroy about it can go out: those go only to holders,
 * and a create only within the enter radius). And the branch fires: mobs did
 * sleep, and the world's own count agrees with the spy.
 */
function checkTick (worlds: Worlds, world: World, viewer: Player, still: () => boolean = () => true): number {
  const asleep = tick(worlds, world)
  // A viewpoint that changed after the mob loop (a watched bot died and the
  // spectator was moved to another, or the viewer is gone) was judged from
  // where the old one stood: a mob near the new one may sleep for that one
  // tick (docs/npcs.md). Nothing to check against then.
  if (!still() || viewer.destroyed || viewer.exited) return asleep.length
  const viewerCell = Hex.toCell(viewer.position)
  for (const mob of asleep) {
    assert.equal(mob.knownBy.size, 0, `a sleeping ${mob.archetype?.key ?? 'mob'} is held by a connection`)
    if (mob.tag !== viewer.tag) continue
    const view = Multiplayer.viewOf(viewer, mob.position.x, mob.position.y, Hex.toCell(mob.position))
    assert.notEqual(view, Multiplayer.VIEW_IN, `a ${mob.archetype?.key ?? 'mob'} slept within the viewer's enter radius ` +
      `(${Hex.distance(mob.cell, viewerCell)} rings by its cell, ${Hex.distance(Hex.toCell(mob.position), viewerCell)} by its position, ` +
      `viewer ${viewer.bot !== undefined ? 'bot' : 'human'} reach ${Multiplayer.leaveRings(viewer)}, step ${String(mob.stepTo)})`)
    assert.ok(Hex.distance(mob.cell, viewerCell) > acquireOf(mob),
      `a ${mob.archetype?.key ?? 'mob'} slept within its acquire rings of the viewer`)
  }
  assert.equal(world.sleepingMobs, asleep.length, 'the world counts sleeping mobs differently from the spy')
  return asleep.length
}

/**
 * A sleeping guard on the viewer's own layer (a provoke needs the attacker on
 * it), one with a pack if `pack` and there is one. Layer 01 holds only ~4
 * mobs, so on some maps none of them sleeps wherever the player stands: then
 * a Crawler is put on the ground cell furthest from the player and ticked
 * until it settles and sleeps.
 */
function sleeper (worlds: Worlds, world: World, player: Player, random: () => number, pack = false): Unit {
  const guarded = (mob: Unit): boolean => mob.tag === player.tag && mob.routines.some((r) => r instanceof GuardPosition)
  for (let tries = 0; tries < 10; tries++) {
    moveTo(world, player, random)
    const asleep = tick(worlds, world).filter(guarded)
    const found = (pack ? asleep.find((mob) => ((mob as Mob).pack?.members.length ?? 0) > 1) : undefined) ?? asleep[0]
    if (found !== undefined) return found
  }
  const from = Hex.toCell(player.position)
  let far: { at: ReturnType<World['getUnobstructedPosition']>, rings: number } = { at: undefined, rings: -1 }
  World.run(world, () => {
    for (let i = 0; i < 300; i++) {
      const at = world.getUnobstructedPosition(player.tag, random)
      if (at === undefined) continue
      const rings = Hex.distance(from, Hex.toCell(at))
      if (rings > far.rings) far = { at, rings }
    }
  })
  const at = far.at
  assert.ok(at !== undefined, 'no ground cell on the viewer\'s layer')
  const mob = World.run(world, () => {
    const crawler = new Mob(at.x, at.y, player.tag, ARCHETYPES.crawler)
    World.addUnit(World.MOBS, crawler)
    return crawler
  })
  for (let i = 0; i < 40; i++) {
    World.run(world, () => { player.stop() })
    if (tick(worlds, world).includes(mob)) return mob
  }
  assert.fail(`a Crawler ${far.rings} rings from the viewer never slept`)
}

test('a private world: what the viewer could see or be noticed by is always awake, and the rest sleeps', async () => {
  const { worlds, world, player } = await privateRun()
  const random = seeded(13)
  let slept = 0
  let ticks = 0
  for (let hop = 0; hop < 12; hop++) {
    moveTo(world, player, random)
    for (let i = 0; i < 8; i++) {
      slept += checkTick(worlds, world, player)
      ticks++
    }
  }
  const mobs = world.MOBS.filter((mob) => !mob.destroyed).length
  assert.ok(slept > 0, 'no mob ever slept: the sleep branch never fired')
  assert.ok(slept < mobs * ticks, 'every mob slept every tick')
})

test('a hit wakes a sleeping mob and it turns on the attacker; its pack wakes with it', async () => {
  const { worlds, world, player } = await privateRun()
  // A sleeping mob on the viewer's own layer (provoke needs the attacker on
  // it): one with a pack if there is one. The top layer is small, so look
  // from a few spots.
  const target = sleeper(worlds, world, player, seeded(5), true)
  World.run(world, () => { GuardPosition.provoke(target, player) })
  tick(worlds, world)
  assert.ok(updated.has(target), 'the provoked mob slept on')
  // After the player, or after a bot that hit it later in the tick (a
  // provoke turns a mob on its latest attacker).
  assert.ok(target.target != null, 'the provoked mob is after nobody')
  const pack = (target as Mob).pack
  if (pack !== undefined) {
    for (const member of pack.members) {
      if (member.destroyed) continue
      assert.ok(updated.has(member), 'a pack member slept on after the pack was provoked')
    }
  }
})

test('a mob whose notice range reaches the viewer stays awake, however far that is', async () => {
  // At today's numbers a viewer's reach plus the margin is wider than every
  // guard's acquire, so the notice term never decides; this gives one
  // sleeping mob a range that does, and it must wake and notice the player.
  const { worlds, world, player } = await privateRun()
  const mob = sleeper(worlds, world, player, seeded(7))
  const guard = mob.routines.find((r) => r instanceof GuardPosition) as GuardPosition
  const rings = Hex.distance(mob.cell, Hex.toCell(player.position))
  // A copy: the archetype's spec is shared by every mob of its kind.
  guard.spec = { ...guard.spec, acquire: rings + 1, lose: rings + 2 }
  guard.targetAquiredAt = 0
  tick(worlds, world)
  assert.ok(updated.has(mob), 'a mob that could notice the viewer slept')
  // The player, or a bot nearer to it: either way it is awake and looking.
  assert.ok(mob.target != null, 'the mob noticed nobody')
})

test('a spectated bot is a viewpoint: what is around it wakes', async () => {
  const { worlds, client, world, player } = await privateRun()
  const bot = world.PLAYERS.find((p) => p.bot !== undefined && !p.destroyed && p.tag === player.tag)
  assert.ok(bot !== undefined, 'no bot on the player\'s layer')
  // Put the player's own robot far from the bot, then watch the bot.
  World.run(world, () => { player.stop() })
  client.connection.spectating = bot
  for (let i = 0; i < 6; i++) checkTick(worlds, world, bot, () => client.connection.spectating === bot)
  client.connection.spectating = undefined
})

test('far bots think less often in a private world, and a bot beside the viewer never counts as far', async () => {
  const { worlds, world, player } = await privateRun()
  let far = 0
  for (let i = 0; i < 40; i++) {
    moveTo(world, player, seeded(100 + i))
    tick(worlds, world)
    far += world.farBots
    for (const bot of world.PLAYERS) {
      if (bot.bot === undefined || bot.destroyed || bot.tag !== player.tag) continue
      if (Hex.distance(bot.cell, Hex.toCell(player.position)) > 2) continue
      assert.equal(World.run(world, () => world.isFar(bot.cell, bot.tag, 0)), false, 'a bot beside the viewer counts as far')
    }
  }
  assert.ok(far > 0, 'no bot ever thought far: the far branch never fired')
})

test('a shared world sleeps nothing and slows no bot', () => {
  const worlds = makeWorlds(new MemoryAccountStore())
  const world = worlds.worlds[0]
  assert.equal(world.sleepFar, false)
  let mobs = 0
  for (let i = 0; i < 20; i++) {
    // Directly: `tickAll` skips a shared world with nobody in it.
    const asleep = tick(worlds, world, () => { World.run(world, () => { world.update(250) }) })
    assert.equal(asleep.length, 0, 'a mob in a shared world skipped its update')
    assert.equal(world.sleepingMobs, 0)
    assert.equal(world.farBots, 0)
    mobs = world.MOBS.length
  }
  assert.ok(mobs > 0, 'no mob in the shared world: the check checks nothing')
  const far = World.run(world, () => world.isFar(Hex.toCell(world.MOBS[0].position), world.MOBS[0].tag, 0))
  assert.equal(far, false)
})
