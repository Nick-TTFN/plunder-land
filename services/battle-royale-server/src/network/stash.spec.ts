import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import type Player from '../objects/player'
import type GearPickup from '../objects/gearpickup'
import Analytics, { type Params } from '../analytics'
import { type Bring, type GearStore, MemoryAccountStore, type Settled, type Spent } from '../db/accounts'
import { GearLedger } from '../gear/ledger'
import { parseBring, type StashEvent } from '../gear/stash'
import { BRING_LEVEL, GEAR_STATS, type GearInstance, type GearTier } from '../utils/gear'
import { SKILL_INFO } from '../utils/skills'
import { xpToReach } from '../progress/xp'

/**
 * The stash in play (decision #49, task 49-4) through `Worlds` on the memory
 * store: `start_requested.bring` carried in with the spend, the `stash`
 * event, and the settle for every way a run or an item leaves the world
 * (extraction, death and someone else's extraction, a drain's cut-off, a
 * bot's extraction, a dropped item expiring, a world closing, an offline
 * extraction), the level gate, a paid run that never begins, and a second
 * READY while the last run's settle is still writing (race 3).
 */

let reported: unknown[] = []
let savedLog: ThrottledLog
const savedReport = Worlds.accountReport

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  reported = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = (e) => { reported.push(e) }
  Worlds.accountSuccess()
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  World.strict = false
  mock.restoreAll()
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

  start (bring?: unknown): void {
    this.handlers.start_requested({ name: this.id, ...(bring !== undefined ? { bring } : {}) })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }

  stash (): StashEvent[] {
    return this.events('stash') as StashEvent[]
  }
}

/** The memory store, with spends and settles that can be held, and counted. */
class Store extends MemoryAccountStore {
  spends = 0
  settles = 0
  spendGate: Promise<void> | undefined
  settleGate: Promise<void> | undefined

  async spend (publicId: string, nowMs: number, bring?: Bring): Promise<Spent> {
    this.spends++
    if (this.spendGate !== undefined) await this.spendGate
    return await super.spend(publicId, nowMs, bring)
  }

  async settleGear (publicId: string, holder: string, keep: readonly string[], found: readonly GearInstance[]): Promise<Settled> {
    this.settles++
    if (this.settleGate !== undefined) await this.settleGate
    return await super.settleGear(publicId, holder, keep, found)
  }

  /** Each row's owner and state, by row id. */
  rows (): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [id, row] of this.stashRows) out[id] = `${row.owner}:${row.carried ? 'carried' : 'stashed'}`
    return out
  }
}

function gate (): { promise: Promise<void>, open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve))
}

const FIREBALL = SKILL_INFO.fireball.id
const ICICLE = SKILL_INFO.icicle.id
const STONEWALL = SKILL_INFO.stoneWall.id

function item (tier: GearTier, skill: number): GearInstance {
  return Object.freeze({ tier, skill, rolls: Object.freeze([{ stat: GEAR_STATS.hp.id, q: 500 }]) })
}

/** A started ledger on `store`, its first heartbeat landed (`canCarry`). */
async function ledgerOn (store: GearStore): Promise<GearLedger> {
  const ledger = new GearLedger(store, { timeoutMs: 3000 })
  await ledger.beat()
  assert.equal(ledger.canCarry, true)
  return ledger
}

function makeWorlds (store: Store, ledger: GearLedger | undefined, options: { cap?: number, bots?: number } = {}): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: options.cap ?? 10, idleMs: 300_000, redis: redisStub(), accounts: store, ledger, bots: options.bots })
}

/** An account at `level` with `items` stashed; their row ids in order. */
async function accountWith (store: Store, ledger: GearLedger, level: number, items: GearInstance[]): Promise<{ token: string, publicId: string, ids: string[] }> {
  const { account, token } = await store.create()
  if (level > 1) await store.grant(account.publicId, xpToReach(level))
  const settled = await store.settleGear(account.publicId, ledger.holder, [], items)
  store.settles = 0
  return { token, publicId: account.publicId, ids: settled.stash.map((row) => row.rowId) }
}

/** A connected client on `token`, not yet in a run. */
async function connect (worlds: Worlds, token: string | undefined, name: string): Promise<Client> {
  const client = new Client(name, token !== undefined ? { token } : undefined)
  client.connection = worlds.onConnection(client.socket)
  await settle()
  return client
}

/** A run on `client`, its world emptied of anything that could end it. */
async function play (worlds: Worlds, client: Client, bring?: unknown): Promise<{ player: Player, world: World }> {
  client.start(bring)
  await settle()
  const player = client.connection.player
  assert.ok(player !== undefined, 'the run did not start')
  const world = worlds.worldFor(client.connection) as World
  World.run(world, () => {
    World.MOBS.length = 0
    World.OBSTACLES.length = 0
  })
  return { player, world }
}

/** Stash pickups (by row id) and the given instances lying in `world`. */
function onGround (world: World, rowIds: readonly string[], instances: readonly GearInstance[] = []): GearPickup[] {
  return World.run(world, () => World.GEAR.filter((g) => !g.destroyed &&
    ((g.instance.rowId !== undefined && rowIds.includes(g.instance.rowId)) || instances.includes(g.instance))))
}

/** Give every listed stash pickup in `world` to `player`, as a pickup would. */
function takeAll (world: World, player: Player, rowIds: readonly string[]): void {
  World.run(world, () => {
    for (const pickup of onGround(world, rowIds)) {
      assert.ok(player.addGear(pickup.instance), 'no room')
      World.gearTaken(pickup, player)
    }
  })
}

/** `run_end` params sent from now on. */
function runEnds (): Params[] {
  const sent: Params[] = []
  mock.method(Analytics, 'send', (_run: unknown, name: string, params: Params) => { if (name === 'run_end') sent.push(params) })
  return sent
}

// --- parsing ------------------------------------------------------------------

test('bring: up to two decimal row ids by position; junk, repeats and extras are empty slots, never a refusal', () => {
  assert.deepEqual(parseBring(['12', '7']), ['12', '7'])
  assert.deepEqual(parseBring([null, '7']), [null, '7'])
  assert.deepEqual(parseBring(['7', '7']), ['7', null], 'a repeat')
  assert.deepEqual(parseBring(['1', '2', '3']), ['1', '2'], 'past two')
  assert.deepEqual(parseBring([7, '-1', '', '1e3']), undefined)
  assert.deepEqual(parseBring(['x', '9']), [null, '9'])
  assert.equal(parseBring(['1'.repeat(20)]), undefined, 'over 19 digits')
  for (const bad of [undefined, null, '7', 7, {}, []]) assert.equal(parseBring(bad), undefined, JSON.stringify(bad))
  assert.deepEqual(Multiplayer.parseStart({ name: 'a', bring: ['4', '5', '6'] })?.bring, ['4', '5'])
  assert.equal('bring' in (Multiplayer.parseStart({ name: 'a', bring: 'nope' }) ?? {}), false)
})

// --- bring, keep --------------------------------------------------------------

test('bring 2 and extract: both equipped in keys 3 and 4, back stashed after, a found item inserted; stash events and run_end say so', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(2, ICICLE)])
  const client = await connect(worlds, a.token, 'a')
  assert.deepEqual(client.stash().map((e) => [e.items.map((i) => i.id), e.away]), [[a.ids, 0]], 'the stash after account')
  assert.deepEqual(client.stash()[0].items[0], { id: a.ids[0], tier: 1, skill: FIREBALL, rolls: [[GEAR_STATS.hp.id, 500]] })
  assert.ok(client.emitted.findIndex(([e]) => e === 'stash') > client.emitted.findIndex(([e]) => e === 'account'))

  // Key 4 first in the request: positions are kept.
  const { player, world } = await play(worlds, client, [a.ids[1], a.ids[0]])
  assert.equal(player.gear[0]?.rowId, a.ids[1])
  assert.equal(player.gear[1]?.rowId, a.ids[0])
  assert.deepEqual(Object.values(store.rows()), [`${a.publicId}:carried`, `${a.publicId}:carried`])
  assert.deepEqual(ledger.heldIds().sort(), [...a.ids].sort())
  const afterStart = client.stash().at(-1) as StashEvent
  assert.deepEqual([afterStart.items, afterStart.away], [[], 2], 'the stash after the carry')

  const found = item(1, STONEWALL)
  World.run(world, () => { assert.ok(player.addGear(found)) })
  const ends = runEnds()
  World.run(world, () => { player.exit() })
  assert.deepEqual([...player.gear, ...player.bag], [null, null], 'the gear stayed on the extracted player')
  await settle()
  assert.equal(store.settles, 1)
  const rows = store.rows()
  assert.equal(Object.keys(rows).length, 3)
  assert.ok(Object.values(rows).every((r) => r === `${a.publicId}:stashed`), JSON.stringify(rows))
  assert.deepEqual(ledger.heldIds(), [], 'the ledger still holds the kept rows')
  const last = client.stash().at(-1) as StashEvent
  assert.equal(last.items.length, 3)
  assert.equal(last.away, 0)
  assert.deepEqual(last.run, { kept: 3, full: 0 })
  assert.deepEqual(ends.map((p) => [p.gear_brought, p.gear_found, p.gear_kept]), [[2, 1, 3]])
  assert.deepEqual(reported, [])
})

test('bring 2 and die, someone else picks both up and extracts: they are theirs, and gone from the dead player\'s stash', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(1, ICICLE)])
  const b = await accountWith(store, ledger, 1, [])
  const ca = await connect(worlds, a.token, 'a')
  const cb = await connect(worlds, b.token, 'b')
  const ends = runEnds()
  const runA = await play(worlds, ca, a.ids)
  const runB = await play(worlds, cb)
  assert.equal(runA.world, runB.world)
  const guard = World.wrongWorld

  World.run(runA.world, () => { assert.equal(runA.player.hit(1e6), true) })
  await settle()
  assert.equal(store.settles, 0, 'a death wrote something')
  assert.deepEqual(Object.values(store.rows()), [`${a.publicId}:carried`, `${a.publicId}:carried`], 'a death changed the rows')
  worlds.tickAll(250)
  assert.equal(onGround(runA.world, a.ids).length, 2, 'the death sweep did not drop both, rowId kept')

  takeAll(runA.world, runB.player, a.ids)
  World.run(runB.world, () => { runB.player.exit() })
  await settle()
  assert.deepEqual(store.rows(), { [a.ids[0]]: `${b.publicId}:stashed`, [a.ids[1]]: `${b.publicId}:stashed` })
  assert.deepEqual((cb.stash().at(-1) as StashEvent).items.map((i) => i.id), a.ids)
  assert.deepEqual((cb.stash().at(-1) as StashEvent).run, { kept: 2, full: 0 })
  assert.deepEqual((await store.loadStash(a.publicId)).map((r) => r.rowId), [], 'the dead player still has them')
  // A's run: brought 2, kept 0; B's: found 2 (another player's rows), kept 2.
  assert.deepEqual(ends.map((p) => [p.outcome, p.gear_brought, p.gear_found, p.gear_kept]), [['died', 2, 0, 0], ['extracted', 0, 2, 2]])
  assert.equal(World.wrongWorld, guard)
})

test('a drain\'s cut-off keeps both brought items and a found one, and the sweep after the disconnect drops nothing of the player\'s', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(1, ICICLE)])
  const client = await connect(worlds, a.token, 'a')
  const { player, world } = await play(worlds, client, a.ids)
  const found = item(2, STONEWALL)
  World.run(world, () => { assert.ok(player.addGear(found)) })
  const ends = runEnds()

  worlds.drain()
  worlds.closeAll()
  assert.equal(client.closed, true)
  assert.equal(player.destroyed, true)
  assert.deepEqual([...player.gear, ...player.bag], [null, null], 'the gear stayed on the cut-off player')
  worlds.tickAll(250)
  assert.equal(World.run(world, () => World.PLAYERS.includes(player)), false, 'not swept')
  assert.deepEqual(onGround(world, a.ids, [found]), [], 'the sweep dropped the cut-off player\'s gear')
  await settle()
  const rows = store.rows()
  assert.equal(Object.keys(rows).length, 3)
  assert.ok(Object.values(rows).every((r) => r === `${a.publicId}:stashed`), JSON.stringify(rows))
  assert.deepEqual(ends.map((p) => [p.outcome, p.gear_kept]), [['left', 3]])
  // The connection closed, so no `stash` reached it after the settle.
  assert.equal(client.stash().at(-1)?.run, undefined)
})

test('a death drops brought gear and writes nothing; the player\'s own disconnect too', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL)])
  const client = await connect(worlds, a.token, 'a')
  const { player, world } = await play(worlds, client, [a.ids[0]])
  client.socket.conn.close()
  await settle()
  assert.equal(player.destroyed, true)
  assert.equal(store.settles, 0)
  worlds.tickAll(250)
  assert.equal(onGround(world, a.ids).length, 1, 'a disconnect is a death: the item drops')
  assert.deepEqual(store.rows(), { [a.ids[0]]: `${a.publicId}:carried` })
  assert.equal(ledger.holds(a.ids[0]), true, 'the ledger let go of a row still in the world')
})

// --- discards -----------------------------------------------------------------

test('a bot extracting with a stash item deletes its row; its rowless cargo is simply gone', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger, { bots: 2 })
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL)])
  const client = await connect(worlds, a.token, 'a')
  const { player, world } = await play(worlds, client, [a.ids[0]])
  let bot: Player | undefined
  for (let i = 0; i < 40 && bot === undefined; i++) {
    worlds.tickAll(250)
    bot = World.run(world, () => World.PLAYERS.find((p) => p.bot !== undefined && !p.destroyed))
  }
  assert.ok(bot !== undefined, 'no bot joined')
  World.run(world, () => { player.hit(1e6) })
  worlds.tickAll(250)
  takeAll(world, bot, a.ids)
  assert.ok(bot.bag.some((g) => g.rowId === a.ids[0]))
  World.run(world, () => { (bot as Player).exit() })
  assert.deepEqual([...bot.gear, ...bot.bag], [null, null])
  await settle()
  assert.deepEqual(store.rows(), {}, 'the row survived the bot\'s extraction')
  assert.equal(store.settles, 0)
  assert.deepEqual(ledger.heldIds(), [])
})

test('a dropped stash item expiring deletes its row', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(1, ICICLE)])
  const client = await connect(worlds, a.token, 'a')
  const { player, world } = await play(worlds, client, a.ids)
  World.run(world, () => { player.hit(1e6) })
  worlds.tickAll(250)
  const dropped = onGround(world, a.ids)
  assert.equal(dropped.length, 2)
  const gone = dropped.find((g) => g.instance.rowId === a.ids[0]) as GearPickup
  gone.expiresAt = 1
  worlds.tickAll(250)
  await settle()
  assert.deepEqual(store.rows(), { [a.ids[1]]: `${a.publicId}:carried` }, 'the expired one\'s row is still there, or the other went')
  assert.equal(ledger.holds(a.ids[0]), false)
  assert.equal(ledger.holds(a.ids[1]), true)
})

test('several worlds: closing one deletes the stash rows left in it, on the ground or on a corpse, and leaves the others alone', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger, { cap: 1 })
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(1, ICICLE)])
  const b = await accountWith(store, ledger, BRING_LEVEL, [item(1, STONEWALL)])
  const c = await accountWith(store, ledger, BRING_LEVEL, [item(2, FIREBALL)])
  const ca = await connect(worlds, a.token, 'a')
  const cb = await connect(worlds, b.token, 'b')
  const cc = await connect(worlds, c.token, 'c')
  const runA = await play(worlds, ca, a.ids)
  const runB = await play(worlds, cb, b.ids)
  const runC = await play(worlds, cc, c.ids)
  assert.equal(new Set([runA.world, runB.world, runC.world]).size, 3, 'not three worlds')
  const guard = World.wrongWorld

  // A's on the ground (a death drop, swept); B's still on its corpse (not swept).
  World.run(runA.world, () => { runA.player.hit(1e6) })
  World.run(runB.world, () => { runB.player.hit(1e6) })
  World.run(runA.world, () => { runA.world.update(0.25) })
  assert.equal(onGround(runA.world, a.ids).length, 2)
  assert.equal(World.run(runB.world, () => World.PLAYERS.includes(runB.player)), true, 'B was swept')
  ca.socket.conn.close()
  cb.socket.conn.close()
  await settle()
  worlds.close(runA.world)
  await settle()
  assert.deepEqual(store.rows(), { [b.ids[0]]: `${b.publicId}:carried`, [c.ids[0]]: `${c.publicId}:carried` })
  worlds.close(runB.world)
  await settle()
  assert.deepEqual(store.rows(), { [c.ids[0]]: `${c.publicId}:carried` })
  assert.deepEqual(ledger.heldIds(), [c.ids[0]])
  assert.equal(World.wrongWorld, guard)
})

test('an offline extraction inserts nothing, and an offline start ignores bring', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const other = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL)])
  store.create = async () => { throw new Error('down (stub)') }
  const worlds = makeWorlds(store, ledger)
  const client = await connect(worlds, undefined, 'a')
  const { player, world } = await play(worlds, client, other.ids)
  assert.equal(client.connection.account?.persisted, false)
  assert.deepEqual(player.gear, [null, null])
  assert.equal(store.spends, 0)
  World.run(world, () => { assert.ok(player.addGear(item(1, ICICLE))) })
  World.run(world, () => { player.exit() })
  await settle()
  assert.equal(store.settles, 0)
  assert.deepEqual(store.rows(), { [other.ids[0]]: `${other.publicId}:stashed` })
  assert.deepEqual(client.stash(), [], 'an offline account was sent a stash')
})

// --- the start ----------------------------------------------------------------

test('bring below level 3 is ignored: the run plays, nothing is carried', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL - 1, [item(1, FIREBALL)])
  const client = await connect(worlds, a.token, 'a')
  const { player } = await play(worlds, client, a.ids)
  assert.deepEqual(player.gear, [null, null])
  assert.equal(store.spends, 1)
  assert.deepEqual(store.rows(), { [a.ids[0]]: `${a.publicId}:stashed` })
  assert.deepEqual(ledger.heldIds(), [])
})

test('no carry before the ledger\'s first heartbeat, nor without a ledger: the run plays without gear', async () => {
  for (const which of ['unbeaten', 'none'] as const) {
    const store = new Store()
    const seed = await ledgerOn(store)
    const a = await accountWith(store, seed, BRING_LEVEL, [item(1, FIREBALL)])
    const worlds = makeWorlds(store, which === 'none' ? undefined : new GearLedger(store))
    const client = await connect(worlds, a.token, 'a')
    const { player } = await play(worlds, client, a.ids)
    assert.deepEqual(player.gear, [null, null], which)
    assert.deepEqual(store.rows(), { [a.ids[0]]: `${a.publicId}:stashed` }, which)
  }
})

test('a row another tab already carries leaves its slot empty; the other slot still fills', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(1, ICICLE)])
  await store.spend(a.publicId, Date.now(), { ids: [a.ids[0]], holder: ledger.holder })
  const client = await connect(worlds, a.token, 'a')
  const { player } = await play(worlds, client, a.ids)
  assert.equal(player.gear[0], null)
  assert.equal(player.gear[1]?.rowId, a.ids[1])
})

test('a carried row the run can\'t equip (a skill this build doesn\'t know) goes back to the stash; the other is played', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, 250), item(1, ICICLE)])
  const client = await connect(worlds, a.token, 'a')
  const { player } = await play(worlds, client, a.ids)
  await settle()
  assert.equal(player.gear[0], null)
  assert.equal(player.gear[1]?.rowId, a.ids[1])
  assert.deepEqual(store.rows(), { [a.ids[0]]: `${a.publicId}:stashed`, [a.ids[1]]: `${a.publicId}:carried` })
  assert.deepEqual(ledger.heldIds(), [a.ids[1]])
})

for (const how of ['disconnect', 'drain'] as const) {
  test(`a paid run that doesn't begin (a ${how} during the spend) puts the carried rows back`, async () => {
    const store = new Store()
    const ledger = await ledgerOn(store)
    const worlds = makeWorlds(store, ledger)
    const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(1, ICICLE)])
    const client = await connect(worlds, a.token, 'a')
    const held = gate()
    store.spendGate = held.promise
    client.start(a.ids)
    await settle()
    if (how === 'disconnect') client.socket.conn.close()
    else worlds.drain()
    held.open()
    await settle()
    assert.equal(client.connection.player, undefined, 'a run began')
    assert.deepEqual(Object.values(store.rows()), [`${a.publicId}:stashed`, `${a.publicId}:stashed`])
    assert.deepEqual(ledger.heldIds(), [])
  })
}

test('a second READY while the last run\'s settle is writing waits for it, then brings the same items again', async () => {
  const store = new Store()
  const ledger = await ledgerOn(store)
  const worlds = makeWorlds(store, ledger)
  const a = await accountWith(store, ledger, BRING_LEVEL, [item(1, FIREBALL), item(1, ICICLE)])
  const client = await connect(worlds, a.token, 'a')
  const first = await play(worlds, client, a.ids)
  const held = gate()
  store.settleGate = held.promise
  World.run(first.world, () => { first.player.exit() })
  worlds.tickAll(250)
  await settle()
  assert.equal(client.connection.started, false, 'the connection cannot ask again')
  const hellos = client.events('hello').length

  client.start(a.ids)
  await settle()
  assert.equal(store.spends, 1, 'the start spent before the settle landed')
  assert.equal(client.events('hello').length, hellos, 'a run began before the settle landed')

  held.open()
  await settle()
  assert.equal(store.spends, 2)
  const second = client.connection.player
  assert.ok(second !== undefined && second !== first.player, 'the second run did not begin')
  assert.deepEqual(second.gear.map((g) => g?.rowId), a.ids, 'the returned items were not brought again')
  assert.deepEqual(Object.values(store.rows()), [`${a.publicId}:carried`, `${a.publicId}:carried`])
})
