import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import { ObjectType } from '../objects/gameobject'
import type Player from '../objects/player'
import type GearPickup from '../objects/gearpickup'
import Analytics, { type Params } from '../analytics'
import { type GearStore, MemoryAccountStore, type Settled } from '../db/accounts'
import { GearLedger } from '../gear/ledger'
import { type StashEvent } from '../gear/stash'
import { BRING_LEVEL, GEAR_STATS, type GearInstance, type GearTier } from '../utils/gear'
import { SKILL_INFO } from '../utils/skills'
import { ITEMS } from '../archetypes/archetypes'
import { xpToReach } from '../progress/xp'
import { Hex } from '../utils/hex'

/**
 * Decision #60 Q6 (task private-7): a private world's pad carries the whole
 * run into the shared world: loot and kills (private.spec.ts), and here the
 * gear slots and bag (every instance unchanged, a stash row keeping its
 * `rowId`), the item stacks, HP and armor, and the run's clock. Nothing the
 * run carried is discarded when the private world closes; the run's end in
 * the shared world settles each item once (an extraction) or drops it (a
 * death).
 *
 * **Worlds and players are compared by identity only** (`assert.ok(a === b)`):
 * a failing `assert.equal`/`deepEqual` on anything holding a World makes Node
 * build a multi-GB diff (private.spec.ts).
 */

let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
const realNow = Date.now
let reported: unknown[] = []

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
  Date.now = realNow
  mock.restoreAll()
})

const PRIVATE_TAGS = World.LAYERS.filter((layer) => layer.owned === true).map((layer) => layer.tag)
const SHARED_TOP = World.TAGS.find((tag) => !PRIVATE_TAGS.includes(tag)) as number

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

/** The memory store, counting settles and discards. */
class Store extends MemoryAccountStore {
  settles = 0
  discards: string[][] = []

  async settleGear (publicId: string, holder: string, keep: readonly string[], found: readonly GearInstance[]): Promise<Settled> {
    this.settles++
    return await super.settleGear(publicId, holder, keep, found)
  }

  async discardGear (holder: string, rowIds: readonly string[]): Promise<number> {
    this.discards.push([...rowIds])
    return await super.discardGear(holder, rowIds)
  }

  /** Each row's owner and state, by row id. */
  rows (): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [id, row] of this.stashRows) out[id] = `${row.owner}:${row.carried ? 'carried' : 'stashed'}`
    return out
  }
}

class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
  }

  stash (): StashEvent[] {
    return this.emitted.filter(([event]) => event === 'stash').map(([, data]) => data as StashEvent)
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve))
}

function item (tier: GearTier, skill: number): GearInstance {
  return Object.freeze({ tier, skill, rolls: Object.freeze([{ stat: GEAR_STATS.hp.id, q: 500 }]) })
}

async function ledgerOn (store: GearStore): Promise<GearLedger> {
  const ledger = new GearLedger(store, { timeoutMs: 3000 })
  await ledger.beat()
  assert.equal(ledger.canCarry, true)
  return ledger
}

/** `run_end` params sent from now on. */
function runEnds (): Params[] {
  const sent: Params[] = []
  mock.method(Analytics, 'send', (_run: unknown, name: string, params: Params) => { if (name === 'run_end') sent.push(params) })
  return sent
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

const FIREBALL = SKILL_INFO.fireball.id
const ICICLE = SKILL_INFO.icicle.id

interface Carry {
  store: Store
  worlds: Worlds
  client: Client
  publicId: string
  /** The stash row brought in. */
  rowId: string
  /** The skill item found on layer 01 (key 4) and the part found there (the bag). */
  found: GearInstance
  part: GearInstance
  first: Player
  next: Player
  shared: World
  /** The old player's HP and armor as it stood on the pad. */
  hp: number
  armor: number
  /** When the run began, on the spec's clock. */
  startedAt: number
  advance: (ms: number) => void
}

/**
 * The completion criterion's run: a stash item brought in (key 3), a found
 * skill item (key 4), a found part (the bag) and a medkit picked up on layer
 * 01, half its HP lost, 100 s in the private world, then the pad.
 */
async function carryRun (): Promise<Carry> {
  let clock = realNow()
  Date.now = () => clock
  const advance = (ms: number): void => { clock += ms }
  const store = new Store()
  const ledger = await ledgerOn(store)
  // No bots: nothing in the private world but the human and the map.
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), accounts: store, ledger })
  assert.ok(worlds.privateRuns, 'no private runs: this spec would test nothing')
  const { account, token } = await store.create()
  await store.grant(account.publicId, xpToReach(BRING_LEVEL))
  const seeded = await store.settleGear(account.publicId, ledger.holder, [], [item(1, FIREBALL)])
  store.settles = 0
  const rowId = seeded.stash[0].rowId
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  client.handlers.start_requested({ name: 'a', bring: [rowId] })
  await settle()
  const first = client.connection.player
  const world = worlds.worldFor(client.connection)
  assert.ok(first !== undefined && world !== undefined, 'the run did not start')
  assert.ok(worlds.privates.includes(world), 'the run did not start in a private world')
  const startedAt = first.createdAt
  // Nothing spawns or lies around to change what the player carries or its HP.
  ;(world as unknown as { refillLayer: () => void }).refillLayer = () => {}
  const found = item(2, ICICLE)
  const part = item(1, 0)
  World.run(world, () => {
    World.MOBS.length = 0
    World.CONSUMABLES.length = 0
    World.ITEMS.length = 0
    World.GEAR.length = 0
    assert.ok(first.gear[0]?.rowId === rowId, 'the stash item was not equipped in key 3')
    assert.ok(first.addGear(found), 'no room for the found item')
    assert.ok(first.addGear(part), 'no room for the part')
    assert.ok(first.addItem(ITEMS.medkit))
  })
  assert.ok(first.gear[1] === found && first.bag[0] === part)
  advance(100_000)
  descend(worlds, world, first)
  World.run(world, () => {
    first.hp = Math.floor(first.maxHp / 2)
    first.armor = Math.floor(first.maxArmor / 2)
  })
  stepOn(worlds, world, first, (gate) => gate.handoff === true)
  await settle()
  const shared = worlds.worldFor(client.connection) as World
  const next = client.connection.player as Player
  assert.ok(worlds.worlds.includes(shared), 'not in a shared world')
  assert.ok(next !== undefined && next !== first, 'no new player')
  assert.ok(world.closed, 'the private world is still open')
  return { store, worlds, client, publicId: account.publicId, rowId, found, part, first, next, shared, hp: first.hp, armor: first.armor, startedAt, advance }
}

test('the pad carries gear slots and bag (same instances, the stash row with its rowId), items, HP and armor, and the run\'s clock; the private world discards nothing', async () => {
  const run = await carryRun()
  const { store, next, first } = run
  assert.equal(next.tag, SHARED_TOP)
  // Gear: the same objects in the same places; none left on the old player.
  assert.ok(next.gear[0]?.rowId === run.rowId, 'the stash item is not in key 3')
  assert.ok(next.gear[1] === run.found, 'the found item is not the same instance in key 4')
  assert.ok(next.bag.length === 1 && next.bag[0] === run.part, 'the bag was not carried')
  assert.ok(first.gear.every((g) => g === null) && first.bag.length === 0, 'the old player still holds gear')
  // Its stats still count: both skill items roll max HP %.
  assert.equal(next.maxHp, first.maxHp)
  assert.ok(next.maxHp > next.archetype.maxHp, 'the gear\'s max HP did not apply')
  // HP and armor as on the pad, below full.
  assert.ok(run.hp < next.maxHp, 'the spec lost no HP')
  assert.equal(next.hp, run.hp)
  assert.equal(next.armor, run.armor)
  assert.equal(next.countOf(ITEMS.medkit), 1, 'the medkit was not carried')
  // The run's clock.
  assert.equal(next.createdAt, run.startedAt)
  // Nothing discarded at the close; the row is still carried by this account.
  await settle()
  assert.deepEqual(store.discards, [])
  assert.deepEqual(store.rows(), { [run.rowId]: `${run.publicId}:carried` })
  assert.deepEqual(reported, [])
})

test('after the pad an extraction settles each item once (the stash row kept, the found item and part inserted once), and run_end.seconds counts the private part', async () => {
  const run = await carryRun()
  const { store, next, shared } = run
  const ends = runEnds()
  run.advance(20_000)
  World.run(shared, () => { next.exit() })
  await settle()
  assert.equal(store.settles, 1)
  assert.deepEqual(store.discards, [])
  const rows = store.rows()
  assert.equal(Object.keys(rows).length, 3, `rows: ${JSON.stringify(rows)}`)
  assert.ok(Object.values(rows).every((r) => r === `${run.publicId}:stashed`), JSON.stringify(rows))
  assert.ok(rows[run.rowId] !== undefined, 'the brought row was replaced, not kept')
  const last = run.client.stash().at(-1) as StashEvent
  assert.deepEqual([last.items.length, last.away, last.run], [3, 0, { kept: 3, full: 0 }])
  assert.equal(ends.length, 1)
  assert.deepEqual([ends[0].outcome, ends[0].gear_brought, ends[0].gear_found, ends[0].gear_kept], ['extracted', 1, 2, 3])
  // 100 s private + 20 s shared (plus the few ticks' walk, which advance no clock).
  assert.equal(ends[0].seconds, 120)
  assert.deepEqual(reported, [])
})

test('after the pad a death drops every carried item in the shared world (the stash row with its rowId) and writes nothing', async () => {
  const run = await carryRun()
  const { store, next, shared, worlds } = run
  World.run(shared, () => { assert.equal(next.hit(1e6), true) })
  worlds.tickAll(250)
  await settle()
  assert.equal(store.settles, 0, 'a death settled something')
  assert.deepEqual(store.discards, [], 'a death discarded something')
  assert.deepEqual(store.rows(), { [run.rowId]: `${run.publicId}:carried` })
  const dropped = World.run(shared, () => World.GEAR.filter((g: GearPickup) => !g.destroyed).map((g) => g.instance))
  assert.ok(dropped.some((g) => g.rowId === run.rowId), 'the stash item was not dropped')
  assert.ok(dropped.includes(run.found) && dropped.includes(run.part), 'a found item was not dropped')
  assert.deepEqual(reported, [])
})

// Keep the import: multiplayer enters the module graph first.
assert.ok(Multiplayer !== undefined)
