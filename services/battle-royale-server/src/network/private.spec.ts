import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds, { PRIVATE_BOTS_DEFAULT, PRIVATE_MAP_SIZE, privateBotsFrom } from './worlds'
import World from '../objects/world'
import Mob from '../objects/mob'
import Portal from '../objects/portal'
import Timers from '../objects/timers'
import { ObjectType } from '../objects/gameobject'
import type Player from '../objects/player'
import { type Account, MemoryAccountStore } from '../db/accounts'
import { type SeasonCredit } from '../progress/seasons'
import { energyAt } from '../progress/energy'
import { runResultOf } from '../progress/run'
import { ARCHETYPES } from '../archetypes/archetypes'
import Analytics from '../analytics'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Decision #60 (task private-6): every run starts in a private world of its
 * own holding the private layers (`LayerSpec.owned`), with NPCs and bots and
 * no other human; a pad on its deepest layer hands the run off into a shared
 * world's top layer, where humans meet. What a start gets, the bots, the pad
 * (and what it carries, spends and closes), a run ending inside a private
 * world, the cap, a drain, and every reader of the worlds lists.
 *
 * **Worlds and players are compared by identity only** (`assert.ok(a === b)`):
 * a failing `assert.equal`/`deepEqual` on anything holding a World makes Node
 * build a multi-GB diff (it took the machine down twice, 2026-11-06).
 */

let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
const realPost = Analytics.post
const realNow = Date.now
let sent: Array<{ name: string, params: Record<string, unknown> }> = []

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = () => {}
  Worlds.accountSuccess()
  sent = []
  Analytics.post = async (_url, body) => {
    const parsed = JSON.parse(body) as { events: Array<{ name: string, params: Record<string, unknown> }> }
    sent.push(...parsed.events)
  }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  World.strict = false
  Analytics.post = realPost
  Date.now = realNow
  delete process.env.GA_MEASUREMENT_ID
  delete process.env.GA_API_SECRET
})

/** The private layers, top first, and the shared world's top layer: from the `LAYERS` rows, as `Worlds` reads them. */
const PRIVATE_TAGS = World.LAYERS.filter((layer) => layer.owned === true).map((layer) => layer.tag)
const SHARED_TOP = World.TAGS.find((tag) => !PRIVATE_TAGS.includes(tag)) as number

test('the LAYERS rows make some layers private and leave some shared', () => {
  assert.ok(PRIVATE_TAGS.length > 0, 'no private layer: every spec below would test the pre-#60 path')
  assert.ok(PRIVATE_TAGS[0] === World.TAGS[0], 'the top layer is not private')
  assert.ok(World.TAGS.some((tag) => !PRIVATE_TAGS.includes(tag)), 'no shared layer')
})

/** Redis that counts the stats writes (`hincrby`). */
function redisStub (): Redis & { writes: string[] } {
  const writes: string[] = []
  return Object.assign(new EventEmitter(), {
    writes,
    hincrby: async (key: string, field: string) => { writes.push(`${key} ${field}`); return 1 },
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis & { writes: string[] }
}

/** The memory store, counting grants and refunds. */
class Store extends MemoryAccountStore {
  grants: Array<{ publicId: string, xp: number }> = []
  refunds = 0

  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> {
    this.grants.push({ publicId, xp })
    return await super.grant(publicId, xp, credit)
  }

  async refund (publicId: string, nowMs: number): ReturnType<MemoryAccountStore['refund']> {
    this.refunds++
    return await super.refund(publicId, nowMs)
  }

  /** The account's stock now (no record: a new account's 6). */
  async stock (token: string): Promise<number> {
    return energyAt((await this.resolve(token))?.energy ?? null, Date.now()).stock
  }
}

class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection
  closed = false

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: {
        write: () => {},
        close: () => {
          if (this.closed) return
          this.closed = true
          this.handlers.disconnect?.()
        }
      }
    } as unknown as Socket
  }

  start (extra: Record<string, unknown> = {}): void {
    this.handlers.start_requested({ id: 'abcdef', name: this.id, ...extra })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

interface Options { bots?: number, privateBots?: readonly number[], privateCap?: number, maxPlayers?: number, idleMs?: number, redis?: Redis }

function makeWorlds (store: MemoryAccountStore, options: Options = {}): Worlds {
  return new Worlds({
    tickLengthMs: 250,
    cap: 10,
    idleMs: options.idleMs ?? 300_000,
    redis: options.redis ?? redisStub(),
    accounts: store,
    bots: options.bots,
    privateBots: options.privateBots,
    privateCap: options.privateCap,
    maxPlayers: options.maxPlayers
  })
}

/** A connected client on a new persisted account, its account resolved. */
async function connect (worlds: Worlds, store: MemoryAccountStore, name = 'a'): Promise<{ client: Client, token: string, account: Account }> {
  const { account, token } = await store.create()
  const client = new Client(name, { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  assert.equal(client.connection.account?.publicId, account.publicId)
  return { client, token, account }
}

/** Connect and start; the client's world after the start. */
async function begin (worlds: Worlds, store: MemoryAccountStore, extra?: Record<string, unknown>, name = 'a'): Promise<{ client: Client, token: string, world: World, player: Player }> {
  const { client, token } = await connect(worlds, store, name)
  client.start(extra)
  await settle()
  const world = worlds.worldFor(client.connection)
  const player = client.connection.player
  assert.ok(world !== undefined && player !== undefined, 'the run did not start')
  return { client, token, world, player }
}

/** Onto a gate on the player's layer that `pick` accepts, standing, and one tick. */
function stepOn (worlds: Worlds, world: World, player: Player, pick: (gate: { to: number, handoff?: boolean }) => boolean): void {
  const gate = world.OBSTACLES.find((o) => o.type === ObjectType.Portal && o.tag === player.tag && pick(o as unknown as { to: number, handoff?: boolean }))
  assert.ok(gate !== undefined, `no such gate on layer ${player.tag}`)
  World.run(world, () => {
    player.stop()
    player.position = Hex.toPosition(Hex.toCell(gate.position))
  })
  worlds.tickAll(250)
}

/** Down real portals to the private world's deepest layer. */
function descend (worlds: Worlds, world: World, player: Player): void {
  const deepest = PRIVATE_TAGS[PRIVATE_TAGS.length - 1]
  while (player.tag !== deepest) {
    const from = player.tag
    stepOn(worlds, world, player, (gate) => gate.handoff !== true && gate.to < from)
    assert.ok(player.tag < from, 'the portal hopped nobody')
  }
}

/** Down to the deepest private layer and onto a pad there: the handoff runs after that tick. */
function takePad (worlds: Worlds, world: World, player: Player): void {
  descend(worlds, world, player)
  stepOn(worlds, world, player, (gate) => gate.handoff === true)
}

/** Bots in `world` still playing. */
function botsIn (world: World): Player[] {
  return world.PLAYERS.filter((p) => p.bot !== undefined && !p.destroyed && !p.exited)
}

function humansIn (world: World): number {
  return world.PLAYERS.filter((p) => p.bot === undefined && !p.destroyed && !p.exited).length
}

/** A Crawler killed by `player` and `loot` picked up: one kill, one kill credit. */
function killAndLoot (world: World, player: Player, loot: number): void {
  World.run(world, () => {
    const mob = new Mob(player.position.x + 200, player.position.y, player.tag, ARCHETYPES.crawler)
    World.addUnit(World.MOBS, mob)
    mob.hit(1e6)
    player.onKill(mob)
    player.addLoot(loot)
  })
}

/** Collect garbage until `ref` empties (at most 10 passes). */
async function collected (ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 10 && ref.deref() !== undefined; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    setFlagsFromString('--expose_gc')
    ;(runInNewContext('gc') as () => void)()
  }
  return ref.deref() === undefined
}

// The start ======

test('a start lands on the top layer of a private world of its own, with no other human; two starts, two worlds, whatever their party code', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const shared = worlds.worlds[0]
  const a = await begin(worlds, store, { party: 'abc123' }, 'a')
  const b = await begin(worlds, store, { party: 'abc123' }, 'b')
  assert.ok(a.world !== b.world, 'two starts share a private world')
  assert.equal(worlds.privates.length, 2)
  assert.ok(worlds.worlds.length === 1 && worlds.worlds[0] === shared, 'a start opened or joined a shared world')
  for (const { world, player } of [a, b]) {
    assert.ok(worlds.privates.includes(world) && !worlds.worlds.includes(world), 'the start is not in a private world')
    assert.equal(world.firstRun, false)
    assert.equal(world.mapSize, PRIVATE_MAP_SIZE)
    assert.deepEqual(World.TAGS.filter((tag) => world.holds(tag)), PRIVATE_TAGS)
    assert.equal(humansIn(world), 1, 'another human in a private world')
    World.run(world, () => { assert.equal(player.tag, World.TAGS[0], 'not on the top layer') })
  }
  // Each is a run: a `run_start` each, nothing of the pad's.
  await settle()
  assert.equal(sent.filter((e) => e.name === 'run_start').length, 2)
  assert.equal(sent.filter((e) => e.name === 'private_done').length, 0)
})

test('privateRuns false, or no owned row: every run in a shared world holding every layer, as before #60', async () => {
  const store = new Store()
  const worlds = new Worlds({ privateRuns: false, tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), accounts: store })
  assert.equal(worlds.privateRuns, false)
  const a = await begin(worlds, store)
  assert.ok(worlds.worlds.includes(a.world), 'not in a shared world')
  assert.equal(worlds.privates.length, 0)
  assert.deepEqual(World.TAGS.filter((tag) => a.world.holds(tag)), World.TAGS)
})

// Bots ======

test('bots top a private world up to privateBots for its human\'s layer (2 on the top layer) and a shared world to bots (1 human + 7)', async () => {
  let clock = realNow()
  Date.now = () => clock
  const store = new Store()
  const worlds = makeWorlds(store, { bots: 8, privateBots: [2, 3] })
  const a = await begin(worlds, store, {}, 'a')
  const b = await begin(worlds, store, {}, 'b')
  takePad(worlds, b.world, b.player)
  await settle()
  const shared = worlds.worldFor(b.client.connection) as World
  assert.ok(worlds.worlds.includes(shared))
  // The shared world's portals away (as bots.spec.ts's `noPortals`): since
  // private-8 layer 03 has 10 down portals, and a bot whose wander or walk to
  // loot ends on one lands on a layer with no human and heads out while the
  // fill replaces it, so 8 or 9 bots were in play at once in 5 of 15 runs.
  // A bot's hop is play, not what this test is about.
  World.run(shared, () => {
    for (const o of [...World.OBSTACLES]) if (o instanceof Portal) World.removeObstacle(o)
  })
  const most = { private: 0, shared: 0 }
  for (let i = 0; i < 30; i++) {
    clock += 2500
    for (const connection of [a.client.connection, b.client.connection]) {
      const player = connection.player as Player
      World.run(worlds.worldFor(connection) as World, () => { player.hp = player.maxHP(); player.hit = () => false })
    }
    worlds.tickAll(250)
    most.private = Math.max(most.private, botsIn(a.world).length)
    most.shared = Math.max(most.shared, botsIn(shared).length)
  }
  assert.ok(!a.world.closed && !shared.closed)
  assert.deepEqual(most, { private: 2, shared: 7 }, 'a world not topped up to its own target')
  assert.equal(humansIn(a.world), 1, 'a bot fill put a human somewhere')
})

test('a descent inside a private world: the old layer\'s bots exit at once, and the target follows the human: 2 bots on the top layer, 3 below', async () => {
  let clock = realNow()
  Date.now = () => clock
  const store = new Store()
  const worlds = makeWorlds(store, { privateBots: [2, 3] })
  const { world, player } = await begin(worlds, store)
  // Healed and unhittable: these specs count bots, and since 01 and 02 shrank
  // (2026-11-08) their NPCs could kill a human between two heals (4 in 200 runs).
  const heal = (): void => { World.run(world, () => { player.hp = player.maxHP(); player.hit = () => false }) }
  // The most at once, not the count at the end: an NPC may kill a bot (at
  // half HP on layer 01) and its replacement joins up to 2 s later (seen
  // once in a full suite run).
  let mostTop = 0
  for (let i = 0; i < 6; i++) {
    clock += 2500
    heal()
    worlds.tickAll(250)
    mostTop = Math.max(mostTop, botsIn(world).length)
  }
  assert.equal(mostTop, 2, 'not 2 bots with the human on the top layer')
  // The bots still up top: one may already have taken a down portal itself
  // (more often since 01 shrank to a 1000 square, 2026-11-08: 1 in 20 runs).
  const top = botsIn(world).filter((bot) => bot.tag === World.TAGS[0])
  assert.ok(top.length > 0, 'no bot on the top layer: the descent checks nothing')
  descend(worlds, world, player)
  assert.ok(player.tag === PRIVATE_TAGS[1], 'the descent did not reach the second private layer')
  let most = 0
  let full = 0
  for (let i = 0; i < 12; i++) {
    clock += 2500
    heal()
    worlds.tickAll(250)
    const bots = botsIn(world)
    most = Math.max(most, bots.length)
    if (bots.length === 3 && bots.every((bot) => bot.tag === player.tag)) full++
  }
  // Exited (or killed meanwhile), never still walking out. A top-layer bot
  // that took a down portal itself is beside the human, not left behind
  // (#60 Q8; seen 2 in 10 full suite runs and 1 in 40 alone: tag -1, in the world).
  assert.ok(top.every((bot) => bot.exited || bot.destroyed || bot.tag === player.tag), 'a bot left behind on the old layer is still in the world')
  assert.ok(most <= 3, `${most} bots after a descent, over the target`)
  // A bot the human's NPCs kill meanwhile is replaced within 2 s, so most of the ticks hold all 3.
  assert.ok(full >= 4, `3 bots beside the human on only ${full} of 12 ticks after the descent`)
})

test('PRIVATE_BOTS: a comma list of bots per private layer, top first; unset or malformed is the default 2,3', () => {
  assert.deepEqual([...PRIVATE_BOTS_DEFAULT], [2, 3])
  assert.deepEqual([...privateBotsFrom(undefined)], [2, 3])
  assert.deepEqual([...privateBotsFrom('')], [2, 3])
  assert.deepEqual([...privateBotsFrom('1, 4')], [1, 4])
  assert.deepEqual([...privateBotsFrom('0')], [0])
  assert.deepEqual([...privateBotsFrom('2,x')], [2, 3])
  assert.deepEqual([...privateBotsFrom('-1,3')], [2, 3])
})

// NPC density ======

/**
 * Dez's area-scaled NPC rows for the private layers (`ideas/private-layers-numbers.md`
 * section 1, accepted in #60's 2026-11-07 addendum), top first: Crawler packs,
 * then single NPCs by archetype key. Pinned here on purpose: a retune of these
 * rows is a decision and changes this table.
 */
const PRIVATE_NPCS: ReadonlyArray<{ packs: number, escorts: boolean, singles: Record<string, number> }> = [
  { packs: 1, escorts: false, singles: { compactor: 1 } },
  { packs: 2, escorts: true, singles: { compactor: 2, kiln: 1, reactor: 1 } }
]

test('a private world holds Dez\'s area-scaled NPC counts on each private layer over two simulated minutes', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { world, player } = await begin(worlds, store)
  assert.equal(PRIVATE_TAGS.length, PRIVATE_NPCS.length, 'a private layer without a pinned row')
  const TICKS = 480
  const full = PRIVATE_TAGS.map(() => 0)
  for (let tick = 0; tick < TICKS; tick++) {
    // The human stands still and is kept alive; nothing kills an NPC, so
    // each layer fills to its rows and stays there.
    World.run(world, () => { player.hp = player.maxHP(); player.hit = () => false })
    worlds.tickAll(250)
    assert.ok(!world.closed, 'the private world closed')
    World.run(world, () => {
      PRIVATE_TAGS.forEach((tag, i) => {
        const want = PRIVATE_NPCS[i]
        const live = (World.MOBS as Mob[]).filter((m) => m.tag === tag && !m.destroyed)
        const packs = new Set(live.map((m) => m.pack).filter((p) => p !== undefined))
        assert.ok(packs.size <= want.packs, `tick ${tick}, layer ${tag}: ${packs.size} packs, over ${want.packs}`)
        for (const pack of packs) {
          const crawlers = pack.members.filter((m) => m.archetype === ARCHETYPES.crawler).length
          const coils = pack.members.filter((m) => m.archetype === ARCHETYPES.coil).length
          assert.ok(crawlers >= 2 && crawlers <= 4, `a pack of ${crawlers} Crawlers`)
          assert.ok(coils <= (want.escorts ? 1 : 0), `${coils} Coils in a pack on layer ${tag}`)
        }
        const singles: Record<string, number> = {}
        for (const m of live) if (m.pack === undefined) singles[m.archetype.key] = (singles[m.archetype.key] ?? 0) + 1
        for (const [key, n] of Object.entries(singles)) {
          assert.ok(n <= (want.singles[key] ?? 0), `tick ${tick}, layer ${tag}: ${n} lone ${key}, over ${want.singles[key] ?? 0}`)
        }
        // Mobs alive within the pack-size range: 2-4 Crawlers (plus a Coil where escorted) a pack, plus the singles.
        const singlesWanted = Object.values(want.singles).reduce((a, b) => a + b, 0)
        const most = want.packs * (want.escorts ? 5 : 4) + singlesWanted
        assert.ok(live.length <= most, `tick ${tick}, layer ${tag}: ${live.length} mobs alive, over ${most}`)
        const exact = packs.size === want.packs && Object.entries(want.singles).every(([key, n]) => singles[key] === n)
        if (exact) {
          assert.ok(live.length >= want.packs * 2 + singlesWanted, `tick ${tick}, layer ${tag}: ${live.length} mobs alive, under the least`)
          full[i]++
        }
      })
    })
  }
  // After the first fill (a few ticks), full on nearly every tick.
  full.forEach((n, i) => { assert.ok(n >= TICKS - 60, `layer ${PRIVATE_TAGS[i]} at its rows on only ${n} of ${TICKS} ticks`) })
})

// The pad ======

test('the pad: a shared world\'s top layer, loot, kills and kill credit carried, the run never ended at the pad, one play spent and refunded at the extraction, the private world closed and collected', async () => {
  const redis = redisStub()
  const store = new Store()
  const worlds = makeWorlds(store, { redis })
  const started = await begin(worlds, store)
  const { client, token, player: first } = started
  let priv: World | undefined = started.world
  ;(started as { world?: World }).world = undefined
  assert.equal(await store.stock(token), 5)
  killAndLoot(priv, first, 75)
  worlds.tickAll(250)
  await settle()
  redis.writes.length = 0
  const ref = new WeakRef(priv)

  // The shared world's join asks no clearance of its own (`SPAWN_CLEARANCE`):
  // the 6 was for a newcomer's first NPC.
  descend(worlds, priv, first)
  const asked: Array<number | undefined> = []
  const spawnCell = World.spawnCell
  World.spawnCell = (tag, clearance) => {
    asked.push(clearance)
    return spawnCell.call(World, tag, clearance)
  }
  try {
    stepOn(worlds, priv, first, (gate) => gate.handoff === true)
  } finally {
    World.spawnCell = spawnCell
  }
  assert.deepEqual(asked, [undefined])
  await settle()
  assert.equal(ref.deref()?.closed, true, 'the private world is still open')
  priv = undefined
  assert.equal(worlds.privates.length, 0)
  const shared = worlds.worldFor(client.connection) as World
  const next = client.connection.player as Player
  assert.ok(shared !== undefined && worlds.worlds.includes(shared), 'not in a shared world')
  assert.ok(next !== undefined && next !== first)
  assert.deepEqual(client.emitted.map(([e]) => e).filter((e) => e === 'handoff' || e === 'hello'), ['hello', 'handoff', 'hello'])
  World.run(shared, () => {
    assert.equal(next.tag, SHARED_TOP, 'not on the shared world\'s top layer')
    // As it stood on the pad: the walk there may pick up loot on the way.
    assert.ok(first.loot >= 75)
    assert.equal(next.loot, first.loot, 'the loot was not carried')
    assert.equal(next.kills, 1, 'the kills were not carried')
    assert.deepEqual(runResultOf(next, 0, 1).mobKills, { crawler: 1 }, 'the kill credit was not carried')
  })
  // Not a run's end: no grant, stats, run_end or refund; the play stays spent.
  assert.deepEqual(store.grants, [])
  assert.deepEqual(redis.writes, [])
  assert.equal(sent.filter((e) => e.name === 'run_end').length, 0)
  assert.equal(store.refunds, 0)
  assert.equal(await store.stock(token), 5)
  // One run: one `run_start` (the private one), one `private_done`, no first-run event.
  assert.equal(sent.filter((e) => e.name === 'run_start').length, 1)
  const done = sent.filter((e) => e.name === 'private_done')
  assert.equal(done.length, 1)
  assert.equal(typeof done[0].params.seconds, 'number')
  assert.equal(sent.filter((e) => e.name.startsWith('first_run_')).length, 0)

  // The extraction there ends the run once and gives the play back.
  World.run(shared, () => { next.exit() })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.grants.length, 1)
  const end = sent.filter((e) => e.name === 'run_end')
  assert.equal(end.length, 1)
  assert.equal(end[0].params.outcome, 'extracted')
  assert.equal(end[0].params.kills, 1)
  assert.equal(end[0].params.loot, Math.floor(first.loot))
  assert.equal(store.grants[0].xp, end[0].params.xp_gained)
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(token), 6, 'the extraction did not give the play back')

  assert.ok(await collected(ref), 'the closed private world was never collected')
})

test('after the pad a death in the shared world keeps the play spent', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, token, world, player } = await begin(worlds, store)
  takePad(worlds, world, player)
  await settle()
  const shared = worlds.worldFor(client.connection) as World
  const next = client.connection.player as Player
  assert.ok(worlds.worlds.includes(shared))
  World.run(shared, () => { assert.equal(next.hit(1e6), true) })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.refunds, 0)
  assert.equal(await store.stock(token), 5)
  assert.equal(sent.filter((e) => e.name === 'run_end').length, 1)
})

test('standing on the pad across several ticks hands off once', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, world, player } = await begin(worlds, store)
  descend(worlds, world, player)
  const pad = world.OBSTACLES.find((o) => o.tag === player.tag && (o as { handoff?: boolean }).handoff === true)
  assert.ok(pad !== undefined)
  World.run(world, () => {
    player.stop()
    player.position = Hex.toPosition(Hex.toCell(pad.position))
  })
  world.handoff?.(player)
  world.handoff?.(player)
  worlds.tickAll(250)
  worlds.tickAll(250)
  await settle()
  assert.equal(client.events('handoff').length, 1)
  assert.equal(sent.filter((e) => e.name === 'private_done').length, 1)
  assert.equal(client.events('hello').length, 2)
})

// A run ending inside a private world ======

test('a death inside a private world ends the run normally (stats, run_end, XP, no refund), ends the spectate and closes the world', async () => {
  let clock = realNow()
  Date.now = () => clock
  const redis = redisStub()
  const store = new Store()
  const worlds = makeWorlds(store, { redis, privateBots: [2, 3] })
  const { client, token, world, player } = await begin(worlds, store)
  for (let i = 0; i < 4; i++) {
    clock += 2500
    World.run(world, () => { player.hp = player.maxHP(); player.hit = () => false })
    worlds.tickAll(250)
  }
  // The real `hit` back (the prototype's) for the kill below.
  delete (player as { hit?: unknown }).hit
  assert.ok(botsIn(world).length > 0, 'no bot to watch: the spectate check checks nothing')
  killAndLoot(world, player, 30)
  // Killed inside the tick, as a mob or a bot kills (a `Timers` callback runs
  // in `World.update`), so the flush that follows picks someone to watch.
  let died = false
  World.run(world, () => { Timers.schedule(0, () => { died = player.hit(1e6) }) })
  worlds.tickAll(250)
  assert.equal(died, true)
  await settle()
  const end = sent.filter((e) => e.name === 'run_end')
  assert.equal(end.length, 1)
  assert.equal(end[0].params.outcome, 'died')
  assert.equal(end[0].params.kills, 1)
  assert.equal(store.grants.length, 1, 'no XP grant for a private run')
  assert.equal(store.grants[0].xp, end[0].params.xp_gained)
  assert.ok(redis.writes.length > 0, 'no Redis stats for a private run')
  assert.equal(store.refunds, 0)
  assert.equal(await store.stock(token), 5)
  // Watched a bot at the death (#47), then nobody once the world closed (#60 Q9).
  const spectates = client.events('spectate') as Array<{ id: number | null }>
  assert.ok(spectates.some((s) => s.id !== null), 'the death watched nobody')
  assert.equal(spectates[spectates.length - 1].id, null, 'the spectate outlived the private world')
  assert.equal(world.closed, true)
  assert.equal(worlds.privates.length, 0)
  assert.equal(worlds.worldFor(client.connection), undefined)
  // The next start opens a new private world.
  client.start()
  await settle()
  const again = worlds.worldFor(client.connection)
  assert.ok(again !== undefined && again !== world && worlds.privates.includes(again), 'the next start is not in a new private world')
})

test('an extraction inside a private world ends the run normally, gives the play back and closes the world', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, token, world, player } = await begin(worlds, store)
  World.run(world, () => { player.addLoot(40) })
  World.run(world, () => { player.exit() })
  worlds.tickAll(250)
  await settle()
  const end = sent.filter((e) => e.name === 'run_end')
  assert.equal(end.length, 1)
  assert.equal(end[0].params.outcome, 'extracted')
  assert.equal(end[0].params.loot, 40)
  assert.equal(store.grants.length, 1)
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(token), 6)
  assert.equal(sent.filter((e) => e.name === 'private_done').length, 0, 'private_done for a run that never took the pad')
  assert.equal(world.closed, true)
  assert.equal(worlds.privates.length, 0)
  assert.equal(worlds.worldFor(client.connection), undefined)
})

test('a disconnect inside a private world ends the run as left (play kept spent) and closes the world at once', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, token, world } = await begin(worlds, store)
  client.socket.conn.close()
  assert.equal(world.closed, true, 'the private world waited for a tick')
  assert.equal(worlds.privates.length, 0)
  await settle()
  const end = sent.filter((e) => e.name === 'run_end')
  assert.equal(end.length, 1)
  assert.equal(end[0].params.outcome, 'left')
  assert.equal(store.refunds, 0)
  assert.equal(await store.stock(token), 5)
})

// The cap ======

test('at PRIVATE_CAP open private worlds a start is sent full with nothing spent; a first run\'s pad still opens one over it', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { privateCap: 1 })
  // A first run starts while there is room; it opens no private world yet.
  const firstRun = await begin(worlds, store, { firstRun: true }, 'first')
  assert.equal(firstRun.world.firstRun, true)
  const a = await begin(worlds, store, {}, 'a')
  assert.ok(worlds.privates.length === 1 && worlds.privates[0] === a.world)
  assert.equal(worlds.privateFull, true)

  const { client, token } = await connect(worlds, store, 'b')
  client.start()
  await settle()
  assert.equal(client.events('full').length, 1, 'no full at the cap')
  assert.equal(client.closed, true)
  assert.equal(client.events('hello').length, 0)
  assert.equal(client.events('energy').length, 0)
  assert.equal(await store.stock(token), 6, 'a refused start spent a play')
  assert.equal(worlds.privates.length, 1)
  assert.equal(worlds.worlds.length, 1)

  // The first run's pad is a handoff, never refused: it opens a second one.
  const gate = firstRun.world.OBSTACLES.find((o) => (o as { handoff?: boolean }).handoff === true)
  assert.ok(gate !== undefined)
  World.run(firstRun.world, () => { firstRun.player.position = Hex.toPosition(Hex.toCell(gate.position)) })
  worlds.tickAll(250)
  await settle()
  const landed = worlds.worldFor(firstRun.client.connection)
  assert.ok(landed !== undefined && worlds.privates.includes(landed) && landed !== a.world, 'the first run\'s pad was refused at the cap')
  assert.equal(worlds.privates.length, 2)
  assert.equal(firstRun.client.closed, false)
})

test('no cap with privateCap 0', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { privateCap: 0 })
  await begin(worlds, store, {}, 'a')
  await begin(worlds, store, {}, 'b')
  assert.equal(worlds.privateFull, false)
  assert.equal(worlds.privates.length, 2)
})

// A drain ======

test('a drain: a private run keeps the process from drained, its pad still hands off here (Q10), and drained once it ends', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, world, player } = await begin(worlds, store)
  worlds.drain()
  assert.equal(client.closed, false, 'a drain redirected a live private run')
  assert.equal(Worlds.activeRuns(worlds), 1)
  assert.equal(worlds.drained, false, 'a drain would cut a private run')
  takePad(worlds, world, player)
  await settle()
  assert.equal(client.closed, false, 'the pad redirected during a drain')
  const shared = worlds.worldFor(client.connection) as World
  assert.ok(shared !== undefined && worlds.worlds.includes(shared), 'the pad did not hand off during a drain')
  assert.equal(world.closed, true)
  assert.equal(worlds.drained, false)
  const next = client.connection.player as Player
  World.run(shared, () => { next.exit() })
  worlds.tickAll(250)
  assert.equal(worlds.drained, true)
})

test('a drain\'s cut-off inside a private world refunds once and closes it', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { token, world } = await begin(worlds, store)
  worlds.drain()
  worlds.closeAll()
  await settle()
  assert.equal(store.refunds, 1)
  assert.equal(await store.stock(token), 6)
  assert.equal(world.closed, true)
  assert.equal(worlds.privates.length, 0)
})

// Every reader of the worlds lists ======

test('choose never returns a private world, even for the party code of a human inside one; closeIdle never closes one', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { idleMs: 0 })
  const { world, player } = await begin(worlds, store, { party: 'abc123' })
  for (let i = 0; i < 20; i++) {
    assert.ok(!worlds.privates.includes(worlds.choose()), 'choose returned a private world')
    assert.ok(!worlds.privates.includes(worlds.choose('abc123')), 'choose followed a party code into a private world')
  }
  // idleMs 0: every idle shared world but one closes at once; the private
  // world, with its human, is no shared world and stays.
  worlds.open()
  for (let i = 0; i < 10; i++) {
    World.run(world, () => { player.hp = player.maxHP(); player.hit = () => false })
    worlds.tickAll(250)
  }
  assert.equal(world.closed, false)
  assert.ok(worlds.privates.length === 1 && worlds.privates[0] === world, 'closeIdle touched a private world')
  assert.equal(worlds.worlds.length, 1, 'closeIdle did not close the idle shared world')
})

test('activeRuns and full count a private run', async () => {
  const store = new Store()
  const worlds = makeWorlds(store, { maxPlayers: 1 })
  await begin(worlds, store)
  assert.equal(Worlds.activeRuns(worlds), 1)
  assert.equal(worlds.full, true)
  const { client, token } = await connect(worlds, store, 'b')
  client.start()
  await settle()
  assert.equal(client.events('full').length, 1, 'a burst cap undercounted a private run')
  assert.equal(await store.stock(token), 6)
})

test('tickAll ticks a private world: its human walks', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { world, player } = await begin(worlds, store)
  const from = Hex.toCell(player.position)
  World.run(world, () => {
    // Any free cell 2-4 rings out: the four cells 3 out along the axes were
    // all blocked in 1 of 3 full suite runs on private-8's map (the spawn
    // cell is random; the private map changed with Dez's gate counts).
    const near: Vector[] = []
    for (let dq = -4; dq <= 4; dq++) {
      for (let dr = -4; dr <= 4; dr++) {
        const c = from.add(new Vector(dq, dr))
        const d = Hex.distance(from, c)
        if (d >= 2 && d <= 4 && Hex.onMap(c.x, c.y, World.mapSize) && !World.isBlocked(c.x, c.y, player.tag)) near.push(c)
      }
    }
    const to = near[0]
    assert.ok(to !== undefined, 'no free cell 2-4 rings from the spawn')
    player.setWaypoints([to])
  })
  for (let i = 0; i < 8; i++) worlds.tickAll(250)
  const now = Hex.toCell(player.position)
  assert.ok(now.x !== from.x || now.y !== from.y, 'the private world was not ticked')
})

test('Multiplayer reaches a private world\'s connection only through its own world', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const { client, world } = await begin(worlds, store)
  assert.ok(world.multiplayer instanceof Multiplayer)
  assert.ok(world.multiplayer !== worlds.worlds[0].multiplayer, 'a private world shares a shared world\'s Multiplayer')
  World.run(world, () => { assert.ok(world.multiplayer?.connectionCount === 1) })
  assert.ok(worlds.worldFor(client.connection) === world)
})
