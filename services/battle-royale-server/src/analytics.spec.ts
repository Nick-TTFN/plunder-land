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

function client (worlds: Worlds, id: string): { connection: Connection, start: () => void } {
  const handlers: Record<string, (data?: unknown) => void> = {}
  const socket = {
    id,
    handshake: { query: { frames: '1' } },
    on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
    emit: () => true,
    conn: { write: () => {}, close: () => { handlers.disconnect?.() } }
  } as unknown as Socket
  const connection = worlds.onConnection(socket)
  return { connection, start: () => { handlers.start_requested({ id: 'abc123', name: id, robot: 'magnet' }) } }
}

/** Let the analytics' Redis reads and the stub's sends settle. */
async function settle (): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

function events (): Array<{ name: string, params: Record<string, unknown> }> {
  return sent.flatMap((s) => s.body.events)
}

test('a run sends run_start, first_loot and run_end, to the EU endpoint, as one GA session', async () => {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), now: () => 0 })
  const a = client(worlds, 'a')
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
  for (const s of sent) {
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

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
