import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import { type Connection, ThrottledLog } from '../network/multiplayer'
import Worlds from '../network/worlds'
import World from '../objects/world'
import { MemoryAccountStore, type Merged, type MergeRule, type Scrapped } from '../db/accounts'
import { GearLedger } from './ledger'
import type { StashEvent } from './stash'
import { seeded } from '../db/storecontract'
import { BRING_LEVEL, GEAR_STATS, type GearInstance, type GearTier } from '../utils/gear'
import { SKILL_INFO } from '../utils/skills'
import { xpToReach } from '../progress/xp'

/**
 * Merge and scrap through `Worlds` (decision #49, task 49-5) on the memory
 * store: the `merged`/`scrapped` answers and the `stash` after them, one
 * stash write in flight per connection, refused while a start is in flight,
 * allowed mid-run on stashed rows only, and the offline, failing and slow
 * store paths.
 */

let reported: unknown[] = []
let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
const savedRandom = Worlds.mergeRandom

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  reported = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = (e) => { reported.push(e) }
  Worlds.accountSuccess()
  Worlds.mergeRandom = seeded(49)
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.mergeRandom = savedRandom
  Worlds.accountSuccess()
  World.strict = false
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

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }

  /** Event names from index `from` on, `merged`/`scrapped`/`stash` only. */
  order (from: number): string[] {
    return this.emitted.slice(from).map(([event]) => event).filter((e) => e === 'merged' || e === 'scrapped' || e === 'stash')
  }

  lastStash (): StashEvent {
    const all = this.events('stash') as StashEvent[]
    return all[all.length - 1]
  }
}

/** The memory store, with merges that can be held or made to fail, and counted. */
class Store extends MemoryAccountStore {
  merges = 0
  scraps = 0
  gate: Promise<void> | undefined
  fail = false

  async mergeGear (publicId: string, ids: readonly string[], rule: MergeRule): Promise<Merged> {
    this.merges++
    if (this.gate !== undefined) await this.gate
    if (this.fail) throw new Error('store down')
    return await super.mergeGear(publicId, ids, rule)
  }

  async scrapGear (publicId: string, id: string): Promise<Scrapped> {
    this.scraps++
    if (this.gate !== undefined) await this.gate
    if (this.fail) throw new Error('store down')
    return await super.scrapGear(publicId, id)
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

function item (tier: GearTier, skill: number): GearInstance {
  return Object.freeze({ tier, skill, rolls: Object.freeze([{ stat: GEAR_STATS.hp.id, q: 500 }]) })
}

const PART1: GearInstance = Object.freeze({ tier: 1, skill: 0, rolls: Object.freeze([]) })
const FIREBALL = SKILL_INFO.fireball.id
const ICICLE = SKILL_INFO.icicle.id

async function setup (options: { timeoutMs?: number } = {}): Promise<{ store: Store, ledger: GearLedger, worlds: Worlds }> {
  const store = new Store()
  const ledger = new GearLedger(store, { timeoutMs: 3000 })
  await ledger.beat()
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), accounts: store, ledger, accountTimeoutMs: options.timeoutMs })
  return { store, ledger, worlds }
}

/** An account at `level` with `items` stashed, connected (its `account` and first `stash` landed). */
async function connected (setupResult: { store: Store, ledger: GearLedger, worlds: Worlds }, items: GearInstance[], level = 1): Promise<{ client: Client, publicId: string, ids: string[] }> {
  const { store, ledger, worlds } = setupResult
  const { account, token } = await store.create()
  if (level > 1) await store.grant(account.publicId, xpToReach(level))
  const settled = await store.settleGear(account.publicId, ledger.holder, [], items)
  const client = new Client('c', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  assert.equal(client.events('stash').length, 1, 'no stash after account')
  return { client, publicId: account.publicId, ids: settled.stash.map((r) => r.rowId) }
}

test('merge in the lobby: merged { ok, item } with the kept skill, then the stash without the inputs', async () => {
  const s = await setup()
  const { client, ids } = await connected(s, [item(1, FIREBALL), PART1, item(1, ICICLE), item(2, FIREBALL)])
  const from = client.emitted.length
  client.handlers.merge({ ids: [ids[0], ids[1], ids[2]], keep: ids[2] })
  await settle()
  assert.deepEqual(client.order(from), ['merged', 'stash'], 'merged first, then stash')
  const merged = client.events('merged')[0] as { ok: boolean, item: { id: string, tier: number, skill: number, rolls: Array<[number, number]> } }
  assert.equal(merged.ok, true)
  assert.deepEqual([merged.item.tier, merged.item.skill, merged.item.rolls.length], [2, ICICLE, 2])
  assert.equal('reason' in merged, false)
  const stash = client.lastStash()
  assert.deepEqual(stash.items.map((i) => i.id), [ids[3], merged.item.id])
  assert.deepEqual(stash.items[1], merged.item, 'the stash shows another item than merged said')
  assert.equal(stash.away, 0)
  assert.equal('run' in stash, false)
})

test('one stash write in flight: a second merge or a scrap meanwhile answers busy and writes nothing', async () => {
  const s = await setup()
  const { client, ids } = await connected(s, [PART1, PART1, PART1, PART1])
  const held = gate()
  s.store.gate = held.promise
  client.handlers.merge({ ids: ids.slice(0, 3) })
  client.handlers.merge({ ids: ids.slice(1, 4) })
  client.handlers.scrap({ id: ids[3] })
  await settle()
  assert.equal(s.store.merges, 1)
  assert.equal(s.store.scraps, 0)
  assert.deepEqual(client.events('merged'), [{ ok: false, reason: 'busy' }])
  assert.deepEqual(client.events('scrapped'), [{ id: ids[3], ok: false, reason: 'busy' }])
  assert.equal(client.events('stash').length, 1, 'a busy answer sent a stash')
  held.open()
  s.store.gate = undefined
  await settle()
  assert.equal((client.events('merged')[1] as { ok: boolean }).ok, true)
  // Free again.
  client.handlers.scrap({ id: ids[3] })
  await settle()
  assert.deepEqual(client.events('scrapped')[1], { id: ids[3], ok: true })
  assert.deepEqual(client.lastStash().items.map((i) => i.tier), [2])
})

test('refused while the connection\'s start is in flight (its carry), busy', async () => {
  const s = await setup()
  const { client, ids } = await connected(s, [PART1, PART1, PART1])
  client.connection.starting = true
  client.handlers.merge({ ids })
  client.handlers.scrap({ id: ids[0] })
  await settle()
  client.connection.starting = false
  assert.deepEqual(client.events('merged'), [{ ok: false, reason: 'busy' }])
  assert.deepEqual(client.events('scrapped'), [{ id: ids[0], ok: false, reason: 'busy' }])
  assert.equal(s.store.merges + s.store.scraps, 0)
})

test('mid-run: a carried row can\'t be merged or scrapped; three stashed ones merge, and the run keeps its gear', async () => {
  const s = await setup()
  const { client, ids, publicId } = await connected(s, [item(1, FIREBALL), item(1, ICICLE), PART1, PART1, item(1, FIREBALL)], BRING_LEVEL)
  client.handlers.start_requested({ name: 'c', bring: [ids[0], null] })
  await settle()
  const player = client.connection.player
  assert.ok(player !== undefined, 'the run did not start')
  assert.equal(player.gear[0]?.rowId, ids[0])

  client.handlers.merge({ ids: [ids[0], ids[2], ids[3]] })
  await settle()
  assert.deepEqual(client.events('merged'), [{ ok: false, reason: 'invalid' }])
  client.handlers.scrap({ id: ids[0] })
  await settle()
  assert.deepEqual(client.events('scrapped'), [{ id: ids[0], ok: false, reason: 'invalid' }])
  assert.equal(s.store.stashRows.get(ids[0])?.carried, true, 'the carried row changed')

  client.handlers.merge({ ids: [ids[1], ids[2], ids[3]] })
  await settle()
  const merged = client.events('merged')[1] as { ok: boolean, item: { skill: number } }
  assert.deepEqual([merged.ok, merged.item.skill], [true, ICICLE])
  const stash = client.lastStash()
  assert.equal(stash.away, 1, 'the carried row is not away')
  assert.equal(stash.items.length, 2)
  assert.equal(player.gear[0]?.rowId, ids[0], 'the run lost its gear')
  assert.equal((await s.store.loadStash(publicId)).length, 3)
})

test('malformed or no account: invalid, the store not asked, no stash; offline: store', async () => {
  const s = await setup()
  const { client, ids } = await connected(s, [PART1, PART1, PART1])
  for (const bad of [null, { ids: ids.slice(0, 2) }, { ids: [ids[0], ids[0], ids[1]] }, { ids, keep: 7 }]) client.handlers.merge(bad)
  client.handlers.scrap({ id: 12 })
  client.handlers.scrap({ id: 'x'.repeat(40) })
  await settle()
  assert.deepEqual(client.events('merged'), Array(4).fill({ ok: false, reason: 'invalid' }))
  assert.deepEqual(client.events('scrapped'), [{ id: null, ok: false, reason: 'invalid' }, { id: 'x'.repeat(20), ok: false, reason: 'invalid' }])
  assert.equal(s.store.merges + s.store.scraps, 0)
  assert.equal(client.events('stash').length, 1)

  // No token: no account until a first play.
  const anon = new Client('anon')
  anon.connection = s.worlds.onConnection(anon.socket)
  await settle()
  anon.handlers.merge({ ids })
  await settle()
  assert.deepEqual(anon.events('merged'), [{ ok: false, reason: 'invalid' }])

  // Offline (the store failed at connect).
  client.connection.account = { ...client.connection.account!, persisted: false }
  client.handlers.merge({ ids })
  await settle()
  assert.deepEqual(client.events('merged')[4], { ok: false, reason: 'store' })
  assert.equal(s.store.merges, 0)
})

test('a failing store: merged/scrapped answer store, the failure is reported, a fresh stash is asked for', async () => {
  const s = await setup()
  const { client, ids } = await connected(s, [PART1, PART1, PART1])
  s.store.fail = true
  client.handlers.merge({ ids })
  await settle()
  client.handlers.scrap({ id: ids[0] })
  await settle()
  assert.deepEqual(client.events('merged'), [{ ok: false, reason: 'store' }])
  assert.deepEqual(client.events('scrapped'), [{ id: ids[0], ok: false, reason: 'store' }])
  // Two stretches: the fresh stash's read succeeded between the two failures (`accountSuccess`).
  assert.equal(reported.length, 2, 'a failure was not reported')
  assert.equal(client.events('stash').length, 3, 'no fresh stash after a failure')
  assert.equal(s.store.stashRows.size, 3)
})

test('a slow store: store at the timeout and the mark cleared; the late merge lands once, and a retry of its ids is invalid', async () => {
  const s = await setup({ timeoutMs: 20 })
  const { client, ids } = await connected(s, [PART1, PART1, PART1])
  const held = gate()
  s.store.gate = held.promise
  client.handlers.merge({ ids })
  await new Promise((resolve) => setTimeout(resolve, 60))
  await settle()
  assert.deepEqual(client.events('merged'), [{ ok: false, reason: 'store' }])
  held.open()
  s.store.gate = undefined
  await settle()
  assert.equal(s.store.stashRows.size, 1, 'the late merge did not land')
  client.handlers.merge({ ids })
  await settle()
  assert.deepEqual(client.events('merged')[1], { ok: false, reason: 'invalid' }, 'a retry was busy or merged again')
  assert.equal(s.store.stashRows.size, 1)
})
