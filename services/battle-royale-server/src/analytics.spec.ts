import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from './network/multiplayer'
import Worlds from './network/worlds'
import World from './objects/world'
import Mob from './objects/mob'
import { ARCHETYPES } from './archetypes/archetypes'
import Analytics, { payload } from './analytics'
import { MemoryAccountStore } from './db/accounts'
import { xpToReach } from './progress/xp'
import { portalOf } from './network/visits'

/**
 * The game events sent to GA4 (decision #46): what each run sends, and that
 * nothing is sent without the two Railway variables.
 */

interface Sent { url: string, body: { client_id: string, events: Array<{ name: string, params: Record<string, unknown> }> } }
let sent: Sent[] = []
const realPost = Analytics.post

beforeEach(() => {
  sent = []
  Analytics.post = async (url, body) => { sent.push({ url, body: JSON.parse(body) }) }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
})

afterEach(() => {
  Analytics.post = realPost
  delete process.env.GA_MEASUREMENT_ID
  delete process.env.GA_API_SECRET
  World.strict = false
})

/** Redis with just what stats and analytics use, in memory. */
function redisStub (): Redis {
  const hashes = new Map<string, Map<string, string>>()
  const hash = (key: string): Map<string, string> => {
    if (!hashes.has(key)) hashes.set(key, new Map())
    return hashes.get(key) as Map<string, string>
  }
  return Object.assign(new EventEmitter(), {
    hincrby: async (key: string, field: string, by: number) => {
      const v = Number(hash(key).get(field) ?? 0) + by
      hash(key).set(field, String(v))
      return v
    },
    hsetnx: async (key: string, field: string, value: unknown) => {
      if (hash(key).has(field)) return 0
      hash(key).set(field, String(value))
      return 1
    },
    hget: async (key: string, field: string) => hash(key).get(field) ?? null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

function client (worlds: Worlds, id: string, token?: string, portal?: string): { connection: Connection, start: () => void, disconnect: () => void } {
  const handlers: Record<string, (data?: unknown) => void> = {}
  const auth = token === undefined && portal === undefined ? undefined : { ...(token !== undefined ? { token } : {}), ...(portal !== undefined ? { portal } : {}) }
  const socket = {
    id,
    handshake: { query: { frames: '1' }, auth },
    on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
    emit: () => true,
    conn: { write: () => {}, close: () => { handlers.disconnect?.() } }
  } as unknown as Socket
  const connection = worlds.onConnection(socket)
  return { connection, start: () => { handlers.start_requested({ id: 'abc123', name: id, robot: 'magnet' }) }, disconnect: () => { handlers.disconnect() } }
}

/** Let the analytics' Redis reads and the stub's sends settle. */
async function settle (): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** The runs' events: the visit events (`network/visits.ts`) have their own tests below. */
function events (): Array<{ name: string, params: Record<string, unknown> }> {
  return all().filter((e) => !VISIT_EVENTS.includes(e.name))
}

const VISIT_EVENTS = ['visit_start', 'visit_end', 'energy_out']

function all (): Array<{ name: string, params: Record<string, unknown>, clientId: string }> {
  return sent.flatMap((s) => s.body.events.map((e) => ({ ...e, clientId: s.body.client_id })))
}

test('a run sends run_start, first_loot and run_end, to the EU endpoint, as one GA session', async () => {
  // An account at level 3, where Magnet opens (#48 step 5): a new one would play Peep.
  const accounts = new MemoryAccountStore()
  const { account, token } = await accounts.create()
  await accounts.grant(account.publicId, xpToReach(3))
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => 0, accounts })
  const a = client(worlds, 'a', token)
  a.start()
  await settle()
  const player = a.connection.player
  const world = worlds.worldFor(a.connection)
  assert.ok(player !== undefined && world !== undefined)

  World.run(world, () => {
    player.addLoot(10)
    player.addLoot(5) // only the first sends
    player.exit()
  })
  await settle()

  assert.deepEqual(events().map((e) => e.name), ['run_start', 'first_loot', 'run_end'])
  const [start, , end] = events()
  assert.deepEqual(
    { robot: start.params.robot, run_number: start.params.run_number, days_since_first: start.params.days_since_first, world_players: start.params.world_players },
    { robot: 'magnet', run_number: 1, days_since_first: 0, world_players: 1 }
  )
  assert.equal(end.params.outcome, 'extracted')
  assert.equal(end.params.loot, 15)
  assert.equal(end.params.deepest_layer, 1)
  assert.equal(end.params.robot, 'magnet')
  assert.equal(end.params.killed_by, undefined, 'only on a death')
  for (const s of sent.filter((s) => !VISIT_EVENTS.includes(s.body.events[0].name))) {
    assert.ok(s.url.startsWith('https://region1.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=secret'))
    // The account's id (decision #48), never the start's 'abc123'.
    assert.equal(s.body.client_id, a.connection.account?.publicId)
    assert.notEqual(s.body.client_id, 'abc123')
  }
  const sessions = new Set(events().map((e) => e.params.session_id))
  assert.equal(sessions.size, 1, 'one session per run')

  // A second run: the history counts the first. A tick first: the connection
  // is free for its next run once the tick has seen the exit.
  worlds.tickAll(250)
  a.start()
  await settle()
  const second = events().filter((e) => e.name === 'run_start')[1]
  assert.equal(second.params.run_number, 2)
})

test('a death says what killed it', async () => {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => 0 })
  const a = client(worlds, 'a')
  a.start()
  await settle()
  const player = a.connection.player
  const world = worlds.worldFor(a.connection)
  assert.ok(player !== undefined && world !== undefined)
  World.run(world, () => {
    const mob = new Mob(player.position.x, player.position.y, player.tag, ARCHETYPES.grunt)
    if (player.hit(99999)) mob.onKill(player)
  })
  worlds.tickAll(250)
  await settle()
  const end = events().find((e) => e.name === 'run_end')
  assert.equal(end?.params.outcome, 'died')
  assert.equal(end?.params.killed_by, 'mob')
})

test('nothing is sent without both variables', async () => {
  delete process.env.GA_API_SECRET
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => 0 })
  const a = client(worlds, 'a')
  a.start()
  await settle()
  const player = a.connection.player
  const world = worlds.worldFor(a.connection)
  assert.ok(player !== undefined && world !== undefined)
  World.run(world, () => { player.addLoot(3); player.exit() })
  await settle()
  assert.equal(sent.length, 0)
})

test('the payload carries the session and some engagement time', () => {
  const body = payload({ playerId: 'abc123', startedAt: 10_000 }, 'run_end', { outcome: 'left' }, 12_500) as Sent['body'] & { timestamp_micros: number }
  assert.equal(body.timestamp_micros, 12_500_000)
  assert.deepEqual(body.events[0].params, { outcome: 'left', session_id: '10', engagement_time_msec: 2500 })
})

test('an offline run\'s events carry offline: 1, and only an offline run\'s', () => {
  const offline = payload({ playerId: 'abc123', startedAt: 10_000, offline: true }, 'run_end', { outcome: 'left' }, 12_500) as Sent['body']
  assert.deepEqual(offline.events[0].params, { outcome: 'left', offline: 1, session_id: '10', engagement_time_msec: 2500 })
  const online = payload({ playerId: 'abc123', startedAt: 10_000, offline: false }, 'run_end', { outcome: 'left' }, 12_500) as Sent['body']
  assert.equal(online.events[0].params.offline, undefined)
})

test('portalOf: the allowlist, other for anything else, web for none (a client from before it)', () => {
  assert.equal(portalOf(undefined), 'web')
  assert.equal(portalOf({ token: 'x' }), 'web')
  assert.equal(portalOf({ portal: 'itch' }), 'itch')
  assert.equal(portalOf({ portal: 'crazygames' }), 'crazygames')
  assert.equal(portalOf({ portal: 'evil.example' }), 'other')
  assert.equal(portalOf({ portal: 5 }), 'other')
})

test('a visit: visit_start, its runs carry the portal, visit_end says how it went', async () => {
  const accounts = new MemoryAccountStore()
  const { account, token } = await accounts.create()
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => 0, accounts })
  const a = client(worlds, 'a', token, 'itch')
  await settle()
  a.start()
  await settle()
  const player = a.connection.player
  const world = worlds.worldFor(a.connection)
  assert.ok(player !== undefined && world !== undefined)
  World.run(world, () => { player.addLoot(3); player.exit() })
  worlds.tickAll(250)
  await settle()
  a.disconnect()
  await settle()

  assert.deepEqual(all().map((e) => e.name), ['visit_start', 'run_start', 'first_loot', 'run_end', 'visit_end'])
  for (const e of all()) {
    assert.equal(e.params.portal, 'itch', e.name)
    assert.equal(e.clientId, account.publicId, e.name)
  }
  const [start] = all()
  assert.equal(start.params.new_player, 0)
  assert.equal(start.params.days_since_first, undefined, 'no run before this visit')
  const end = all()[4]
  assert.deepEqual(
    { runs: end.params.runs, ended_in: end.params.ended_in, last_outcome: end.params.last_outcome, energy_refusals: end.params.energy_refusals, new_player: end.params.new_player },
    { runs: 1, ended_in: 'lobby', last_outcome: 'extracted', energy_refusals: 0, new_player: 0 }
  )
})

test('a new player\'s visit starts under a one-off id and ends under the account its first READY made', async () => {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => 0, accounts: new MemoryAccountStore() })
  const a = client(worlds, 'a')
  await settle()
  a.start()
  await settle()
  a.disconnect()
  await settle()
  const start = all().find((e) => e.name === 'visit_start')
  const end = all().find((e) => e.name === 'visit_end')
  assert.ok(start !== undefined && end !== undefined)
  assert.match(start.clientId, /^anon-[0-9a-f]{12}$/)
  assert.equal(start.params.new_player, 1)
  assert.equal(start.params.portal, 'web', 'no portal: a client from before it')
  assert.equal(end.clientId, a.connection.account?.publicId)
  assert.equal(end.params.ended_in, 'run', 'disconnected mid-run')
  assert.equal(end.params.new_player, 1)
})

test('READY with no plays left sends energy_out, and visit_end counts it', async () => {
  const accounts = new MemoryAccountStore()
  const { account, token } = await accounts.create()
  for (let i = 0; i < 6; i++) assert.equal((await accounts.spend(account.publicId, 0)).ok, true)
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => 0, accounts })
  const a = client(worlds, 'a', token)
  await settle()
  a.start()
  await settle()
  assert.equal(a.connection.player, undefined, 'refused')
  a.disconnect()
  await settle()
  const out = all().find((e) => e.name === 'energy_out')
  assert.equal(out?.params.runs, 0)
  const end = all().find((e) => e.name === 'visit_end')
  assert.deepEqual({ refusals: end?.params.energy_refusals, runs: end?.params.runs, ended_in: end?.params.ended_in }, { refusals: 1, runs: 0, ended_in: 'lobby' })
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
