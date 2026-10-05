import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Client as PgClient } from 'pg'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { ThrottledLog } from '../network/multiplayer'
import Worlds from '../network/worlds'
import World from '../objects/world'
import { PgAccountStore } from '../db/pgstore'
import { GearLedger } from './ledger'
import type { StashEvent } from './stash'
import { BRING_LEVEL, GEAR_STATS, type GearInstance } from '../utils/gear'
import { SKILL_INFO } from '../utils/skills'
import { xpToReach } from '../progress/xp'

/**
 * Task 49-4's end-to-end run against the pg store: bring two stash items into
 * a run through `Worlds`, extract, and the `stash` event shows them stashed
 * again. Runs only with `TEST_DATABASE_URL` (as db/pgstore.spec.ts), and only
 * on a local host. It works in its **own database** (`plunder_stash_spec`,
 * created on the same server), never the URL's: node runs spec files in
 * parallel, and pgstore.spec.ts drops the URL database's public schema.
 */

const URL = process.env.TEST_DATABASE_URL
const DB = 'plunder_stash_spec'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

afterEach(() => { World.strict = false })

function isLocalDatabase (url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new globalThis.URL(url).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase())
  } catch {
    return false
  }
}

/** `URL` pointed at `DB`, which is created if missing and given an empty public schema. */
async function ownDatabase (): Promise<string> {
  const admin = new PgClient({ connectionString: URL })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${DB}`)
  } catch (e) {
    // 42P04: it already exists (an earlier run).
    if ((e as { code?: string }).code !== '42P04') throw e
  } finally {
    await admin.end()
  }
  const url = new globalThis.URL(URL as string)
  url.pathname = `/${DB}`
  const own = new PgClient({ connectionString: url.toString() })
  await own.connect()
  try {
    await own.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  } finally {
    await own.end()
  }
  return url.toString()
}

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

async function until (what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(ok(), `timed out waiting for ${what}`)
}

function item (skill: number): GearInstance {
  return { tier: 1, skill, rolls: [{ stat: GEAR_STATS.hp.id, q: 400 }] }
}

test('pg: bring two stash items, extract, and the stash event shows them stashed again', async (t) => {
  if (URL === undefined || URL === '') {
    t.skip('TEST_DATABASE_URL not set')
    return
  }
  assert.ok(isLocalDatabase(URL), 'TEST_DATABASE_URL is not on 127.0.0.1, localhost or ::1: refusing to touch it')
  const store = new PgAccountStore({ connectionString: await ownDatabase() })
  await store.migrateOnce()
  store.ready = true
  const ledger = new GearLedger(store, { timeoutMs: 3000 })
  const savedLog = Worlds.ACCOUNTS_LOG
  const savedReport = Worlds.accountReport
  const reported: unknown[] = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = (e) => { reported.push(e) }
  try {
    await ledger.beat()
    assert.equal(ledger.canCarry, true)
    const { account, token } = await store.create()
    await store.grant(account.publicId, xpToReach(BRING_LEVEL))
    const seeded = await store.settleGear(account.publicId, ledger.holder, [], [item(SKILL_INFO.fireball.id), item(SKILL_INFO.icicle.id)])
    const ids = seeded.stash.map((row) => row.rowId)
    assert.equal(ids.length, 2)

    const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), accounts: store, ledger })
    const handlers: Record<string, (data?: unknown) => void> = {}
    const stash: StashEvent[] = []
    const socket = {
      id: 'pg',
      handshake: { query: { frames: '1' }, auth: { token } },
      on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
      emit: (event: string, data?: unknown) => { if (event === 'stash') stash.push(data as StashEvent); return true },
      conn: { write: () => {}, close: () => { handlers.disconnect?.() } }
    } as unknown as Socket
    const connection = worlds.onConnection(socket)
    await until('the stash on connect', () => stash.length === 1)
    assert.deepEqual(stash[0].items.map((i) => i.id), ids)

    handlers.start_requested({ name: 'pg', bring: ids })
    await until('the run', () => connection.player !== undefined)
    const player = connection.player
    assert.ok(player !== undefined)
    assert.deepEqual(player.gear.map((g) => g?.rowId), ids)
    await until('the stash after the carry', () => stash.length === 2)
    assert.deepEqual([stash[1].items, stash[1].away], [[], 2])

    const world = worlds.worldFor(connection) as World
    World.run(world, () => { player.exit() })
    await until('the stash after the settle', () => stash.length === 3)
    assert.deepEqual(stash[2].items.map((i) => i.id), ids)
    assert.equal(stash[2].away, 0)
    assert.deepEqual(stash[2].run, { kept: 2, full: 0 })
    const rows = (await store.pool.query('SELECT state FROM stash_items ORDER BY id')).rows
    assert.deepEqual(rows.map((r) => r.state), [0, 0], 'not stashed in the table')
    assert.deepEqual(reported, [])
  } finally {
    Worlds.ACCOUNTS_LOG = savedLog
    Worlds.accountReport = savedReport
    await ledger.close()
    await store.close()
  }
  // Keep the import: multiplayer enters the module graph first.
  assert.ok(Multiplayer !== undefined)
})
