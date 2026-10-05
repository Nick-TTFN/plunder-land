import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { hashToken, type MergeRule } from './accounts'
import { PgAccountStore, NotReadyError, SEASON_LOCK, STASH_LOCK_CLASS } from './pgstore'
import { migrate, MIGRATION_LOCK } from './migrate'
import { PAYOUT_DELAY_MS, seasonEndMs, seasonStart } from '../progress/seasons'
import { MIGRATIONS, type Migration } from './migrations'
import { adminContract, gearContract, type GearHooks, PART, seeded, storeContract, T1, T2 } from './storecontract'
import { mergeOutcome } from '../gear/merge'

/**
 * The Postgres store and the migration runner against a real database, only
 * when `TEST_DATABASE_URL` is set; otherwise every test here reports a skip
 * (a spec that passes without running is a guard that can't fire). For
 * example:
 *
 *   docker run -d --name plunder-pg-spec -p 5439:5432 -e POSTGRES_PASSWORD=spec postgres:18-alpine
 *   TEST_DATABASE_URL=postgres://postgres:spec@127.0.0.1:5439/postgres \
 *     node --test --require ts-node/register src/db/pgstore.spec.ts
 *
 * **Each test drops and recreates the `public` schema** of that database.
 * Never point it at anything but a throwaway container. So it refuses (a
 * failure, not a skip) any URL whose host isn't this machine
 * (`isLocalDatabase`): a Railway URL pasted here would wipe every account.
 */
const URL = process.env.TEST_DATABASE_URL

/** The only hosts this spec will drop a schema on. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Whether `url` names a database on this machine; false for anything unparseable. */
function isLocalDatabase (url: string): boolean {
  let host: string
  try {
    host = new globalThis.URL(url).hostname
  } catch {
    return false
  }
  // WHATWG keeps the brackets on an IPv6 host.
  return LOCAL_HOSTS.has(host.replace(/^\[(.*)\]$/, '$1').toLowerCase())
}

async function freshSchema (): Promise<void> {
  const client = new Client({ connectionString: URL })
  await client.connect()
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  } finally {
    await client.end()
  }
}

async function withClient<T> (fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

function pgTest (name: string, fn: (t: TestContext) => Promise<void>): void {
  test(name, async (t) => {
    if (URL === undefined || URL === '') {
      t.skip('TEST_DATABASE_URL not set')
      return
    }
    // Before anything touches it: this spec drops the public schema.
    assert.ok(isLocalDatabase(URL), 'TEST_DATABASE_URL is not on 127.0.0.1, localhost or ::1: refusing to drop its schema')
    await freshSchema()
    await fn(t)
  })
}

test('the spec refuses any database not on this machine (no database needed)', () => {
  for (const url of ['postgres://postgres:spec@127.0.0.1:5439/postgres', 'postgres://p:s@localhost/x', 'postgresql://p:s@[::1]:5439/x', 'postgres://p:s@LOCALHOST:1/x']) {
    assert.equal(isLocalDatabase(url), true, url)
  }
  for (const url of [
    'postgres://postgres:secret@postgres.railway.internal:5432/railway',
    'postgres://postgres:secret@monorail.proxy.rlwy.net:41234/railway',
    'postgres://p:s@127.0.0.1.evil.example/x',
    'postgres://p:s@10.0.0.5/x',
    'postgres://p:s@postgres:5432/plunderland',
    'not a url',
    ''
  ]) {
    assert.equal(isLocalDatabase(url), false, url)
  }
})

pgTest('migrations twice in a row apply once', async () => {
  const first = await withClient(async (client) => await migrate(client))
  assert.deepEqual(first, MIGRATIONS.map((m) => m.version))
  const second = await withClient(async (client) => await migrate(client))
  assert.deepEqual(second, [])
  const rows = await withClient(async (client) => (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows)
  assert.deepEqual(rows.map((r) => r.version), MIGRATIONS.map((m) => m.version))
})

pgTest('two runners started together apply each version once (the advisory lock)', async () => {
  // A slow migration, so the second runner really arrives while the first
  // holds the lock; without the lock both would find it missing and the
  // second CREATE TABLE (or the schema_migrations insert) would fail.
  const slow: Migration[] = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'slow', sql: 'SELECT pg_sleep(0.5); CREATE TABLE slow_probe (id int)' }]
  const results = await Promise.all([1, 2, 3].map(async () => await withClient(async (client) => await migrate(client, slow))))
  const applied = results.flat().sort((a, b) => a - b)
  assert.deepEqual(applied, slow.map((m) => m.version), `each version once across runners, got ${JSON.stringify(results)}`)
  const rows = await withClient(async (client) => (await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows)
  assert.equal(rows[0].n, slow.length)
})

pgTest('a failed migration rolls back and is retried next time', async () => {
  const broken: Migration[] = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'broken', sql: 'CREATE TABLE half (id int); SELECT no_such_function()' }]
  await assert.rejects(withClient(async (client) => await migrate(client, broken)))
  const tables = await withClient(async (client) => (await client.query("SELECT to_regclass('public.half') AS t")).rows)
  assert.equal(tables[0].t, null, 'the failed migration was not rolled back')
  const fixed: Migration[] = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'fixed', sql: 'CREATE TABLE half (id int)' }]
  assert.deepEqual(await withClient(async (client) => await migrate(client, fixed)), [MIGRATIONS.length + 1])
})

pgTest('the store: not ready until migrated, then the contract, and token_hash is the SHA-256, not the token', async () => {
  const errors: unknown[] = []
  const store = new PgAccountStore({ connectionString: URL as string, onError: (e) => { errors.push(e) } })
  try {
    await assert.rejects(store.resolve('x'.repeat(43)), NotReadyError)
    await assert.rejects(store.create(), NotReadyError)
    await store.migrateOnce()
    store.ready = true
    await storeContract(store)

    const { account, token } = await store.create()
    const row = (await store.pool.query('SELECT token_hash, public_id, created_at, last_seen_at FROM accounts WHERE public_id = $1', [account.publicId])).rows[0]
    assert.ok(Buffer.isBuffer(row.token_hash))
    assert.ok(!row.token_hash.equals(Buffer.from(token)), 'the token itself is stored')
    // Computed here, not only through hashToken, so a broken hashToken shows.
    assert.ok(row.token_hash.equals(createHash('sha256').update(token).digest()), 'token_hash is not the token\'s SHA-256')
    assert.ok(row.token_hash.equals(hashToken(token)))
    assert.equal(row.token_hash.length, 32)

    // resolve touches last_seen_at.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.resolve(token)
    const seen = (await store.pool.query('SELECT last_seen_at FROM accounts WHERE public_id = $1', [account.publicId])).rows[0]
    assert.ok(seen.last_seen_at > row.last_seen_at, 'last_seen_at did not move')

    // The CHECK backs the shape.
    await assert.rejects(store.pool.query("INSERT INTO accounts (public_id, token_hash) VALUES ('NOT-HEX', '\\x00')"))
    assert.deepEqual(errors, [])
  } finally {
    await store.close()
  }
})

pgTest('the store migrates itself in the background, and a dead database never throws out of start', async () => {
  let ready: number[] | undefined
  const store = new PgAccountStore({ connectionString: URL as string, onReady: (applied) => { ready = applied } })
  try {
    store.start()
    for (let i = 0; i < 100 && !store.ready; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(store.ready, true)
    assert.deepEqual(ready, MIGRATIONS.map((m) => m.version))
  } finally {
    await store.close()
  }

  const errors: unknown[] = []
  const dead = new PgAccountStore({ connectionString: 'postgres://postgres:x@127.0.0.1:1/none', retryMs: 50, onError: (e) => { errors.push(e) } })
  try {
    dead.start()
    for (let i = 0; i < 100 && errors.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(errors.length >= 2, 'it did not retry')
    assert.equal(dead.ready, false)
    await assert.rejects(dead.create(), NotReadyError)
  } finally {
    await dead.close()
  }
})

pgTest('XP: account_progress (migration 2), grants add up atomically, resolve reads them, and a new store sees them', async () => {
  const store = new PgAccountStore({ connectionString: URL as string })
  let token: string
  let publicId: string
  try {
    await assert.rejects(store.grant('0123456789abcdef', 1), NotReadyError)
    await store.migrateOnce()
    store.ready = true
    const created = await store.create()
    token = created.token
    publicId = created.account.publicId
    assert.equal(created.account.xp, 0)
    // No progress row yet: resolve reads 0 and makes none.
    assert.equal((await store.resolve(token))?.xp, 0)
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM account_progress')).rows[0].n, 0)
    // More concurrent grants than the pool has clients: every one counts.
    const totals = await Promise.all(Array.from({ length: 25 }, async () => await store.grant(publicId, 7)))
    assert.equal(Math.max(...totals), 175)
    assert.equal(new Set(totals).size, 25)
    const row = (await store.pool.query('SELECT p.xp, p.updated_at FROM account_progress p JOIN accounts a ON a.id = p.account_id WHERE a.public_id = $1', [publicId])).rows[0]
    assert.equal(Number(row.xp), 175)
    // The CHECK backs the total.
    await assert.rejects(store.pool.query('UPDATE account_progress SET xp = -1'))
    // The query the previous release runs still works on this schema (additive only).
    const old = await store.pool.query('UPDATE accounts SET last_seen_at = now() WHERE token_hash = $1 RETURNING public_id', [hashToken(token)])
    assert.equal(old.rows[0].public_id, publicId)
  } finally {
    await store.close()
  }
  const again = new PgAccountStore({ connectionString: URL as string })
  try {
    await again.migrateOnce()
    again.ready = true
    assert.deepEqual(await again.resolve(token), { publicId, persisted: true, xp: 175, loadouts: [], energy: null })
  } finally {
    await again.close()
  }
})

/** The previous release's queries (migration 2's), verbatim: they must still run on the new schema. */
const V2_RESOLVE = `WITH a AS (UPDATE accounts SET last_seen_at = now() WHERE token_hash = $1 RETURNING id, public_id)
       SELECT a.public_id, COALESCE(p.xp, 0) AS xp FROM a LEFT JOIN account_progress p ON p.account_id = a.id`
const V2_GRANT = `INSERT INTO account_progress (account_id, xp)
       SELECT id, $2 FROM accounts WHERE public_id = $1
       ON CONFLICT (account_id) DO UPDATE SET xp = account_progress.xp + EXCLUDED.xp, updated_at = now()
       RETURNING xp`

pgTest('loadouts (migration 3): added to a v2 database it keeps every row, the v2 queries still run, and its CHECKs hold', async () => {
  // A database at version 2, holding accounts and progress.
  assert.deepEqual(await withClient(async (client) => await migrate(client, MIGRATIONS.filter((m) => m.version <= 2))), [1, 2])
  const v2 = new PgAccountStore({ connectionString: URL as string, migrations: MIGRATIONS.filter((m) => m.version <= 2) })
  const made: Array<{ token: string, publicId: string }> = []
  try {
    v2.ready = true
    for (let i = 0; i < 3; i++) {
      const { account, token } = await v2.create()
      await v2.grant(account.publicId, 10 * (i + 1))
      made.push({ token, publicId: account.publicId })
    }
  } finally {
    await v2.close()
  }
  const before = await withClient(async (client) => (await client.query('SELECT a.public_id, a.token_hash, p.xp FROM accounts a JOIN account_progress p ON p.account_id = a.id ORDER BY a.id')).rows)
  assert.deepEqual(await withClient(async (client) => await migrate(client, MIGRATIONS.filter((m) => m.version <= 3))), [3])
  const after = await withClient(async (client) => (await client.query('SELECT a.public_id, a.token_hash, p.xp FROM accounts a JOIN account_progress p ON p.account_id = a.id ORDER BY a.id')).rows)
  assert.deepEqual(after, before, 'migration 3 changed an existing row')
  // The rest, so this release's queries find their tables.
  assert.deepEqual(await withClient(async (client) => await migrate(client)), [4, 5, 6])

  const store = new PgAccountStore({ connectionString: URL as string })
  try {
    store.ready = true
    // The previous release's resolve and grant, on the new schema.
    const old = await store.pool.query(V2_RESOLVE, [hashToken(made[0].token)])
    assert.deepEqual(old.rows.map((r) => [r.public_id, Number(r.xp)]), [[made[0].publicId, 10]])
    const granted = await store.pool.query(V2_GRANT, [made[1].publicId, 5])
    assert.equal(Number(granted.rows[0].xp), 25)
    // This release's, on an account from before it: no loadouts yet.
    assert.deepEqual(await store.resolve(made[2].token), { publicId: made[2].publicId, persisted: true, xp: 30, loadouts: [], energy: null })
    await store.saveLoadout(made[2].publicId, 'periscope', 2, [8, 7, 6, 5])
    assert.deepEqual((await store.resolve(made[2].token))?.loadouts, [{ robot: 'periscope', index: 2, skills: [8, 7, 6, 5] }])

    // The CHECKs back what the server checks first.
    const id = (await store.pool.query('SELECT id FROM accounts WHERE public_id = $1', [made[0].publicId])).rows[0].id
    const insert = async (robot: string, slot: number, skills: string): Promise<unknown> =>
      await store.pool.query(`INSERT INTO loadouts (account_id, robot, slot_index, skills) VALUES ($1, $2, $3, '${skills}'::smallint[])`, [id, robot, slot])
    await assert.rejects(insert('peep', 0, '{1,2,3}'), /check/i, 'cardinality 3')
    await assert.rejects(insert('peep', 0, '{{1,2},{3,0}}'), /check/i, 'a 2-D array')
    await assert.rejects(insert('peep', -1, '{1,2,3,0}'), /check/i, 'slot_index -1')
    await assert.rejects(insert('peep', 16, '{1,2,3,0}'), /check/i, 'slot_index 16')
    await assert.rejects(insert('Peep!', 0, '{1,2,3,0}'), /check/i, "robot 'Peep!'")
    await insert('peep', 0, '{1,2,3,0}')
    await assert.rejects(store.saveLoadout(made[0].publicId, 'peep', 0, [1, 2, 3]), /check/i, 'a 3-skill save through the store')
    assert.deepEqual((await store.resolve(made[0].token))?.loadouts, [{ robot: 'peep', index: 0, skills: [1, 2, 3, 0] }])
  } finally {
    await store.close()
  }
})

pgTest('close waits for every loadout save in flight before ending the pool', async () => {
  const store = new PgAccountStore({ connectionString: URL as string })
  await store.migrateOnce()
  store.ready = true
  const { account, token } = await store.create()
  const saves = Array.from({ length: 20 }, async (_, i) => { await store.saveLoadout(account.publicId, 'peep', i % 4, [1 + (i % 8), 0, 0, 0]) })
  await store.close()
  const settled = await Promise.allSettled(saves)
  assert.deepEqual(settled.filter((r) => r.status === 'rejected'), [], 'a save was lost at close')
  await assert.rejects(store.saveLoadout(account.publicId, 'peep', 0, [1, 0, 0, 0]), 'a save after close')
  const again = new PgAccountStore({ connectionString: URL as string })
  try {
    again.ready = true
    assert.equal((await again.resolve(token))?.loadouts.length, 4)
  } finally {
    await again.close()
  }
})

pgTest('close waits for every grant in flight, queued ones included, before ending the pool', async () => {
  const store = new PgAccountStore({ connectionString: URL as string })
  await store.migrateOnce()
  store.ready = true
  const { account } = await store.create()
  // A drain's cut-off grants every live run at once: far more than 5 clients.
  const grants = Array.from({ length: 40 }, async () => await store.grant(account.publicId, 3))
  await store.close()
  const settled = await Promise.allSettled(grants)
  assert.deepEqual(settled.filter((r) => r.status === 'rejected'), [], 'a grant was lost at close')
  await assert.rejects(store.grant(account.publicId, 1), 'a grant after close')
  const total = await withClient(async (client) => (await client.query('SELECT xp FROM account_progress')).rows[0].xp)
  assert.equal(Number(total), 120)
})

// --- seasons (decision #48 step 6) --------------------------------------------

test('the payout\'s advisory lock is not the migration runner\'s (no database needed)', () => {
  assert.notEqual(BigInt(SEASON_LOCK), BigInt(MIGRATION_LOCK))
})

pgTest('seasons (migration 4): added to a v3 database it keeps every row, and the step-3 grant and step-4 resolve still run', async () => {
  const v3 = MIGRATIONS.filter((m) => m.version <= 3)
  assert.deepEqual(await withClient(async (client) => await migrate(client, v3)), [1, 2, 3])
  const old = new PgAccountStore({ connectionString: URL as string, migrations: v3 })
  const made: Array<{ token: string, publicId: string }> = []
  try {
    old.ready = true
    for (let i = 0; i < 3; i++) {
      const { account, token } = await old.create()
      await old.grant(account.publicId, 10 * (i + 1))
      await old.saveLoadout(account.publicId, 'peep', 0, [1, 2, 3, i])
      made.push({ token, publicId: account.publicId })
    }
  } finally {
    await old.close()
  }
  const snapshot = async (): Promise<unknown[]> => await withClient(async (client) => (await client.query(
    'SELECT a.public_id, a.token_hash, p.xp, l.robot, l.slot_index, l.skills FROM accounts a JOIN account_progress p ON p.account_id = a.id JOIN loadouts l ON l.account_id = a.id ORDER BY a.id')).rows)
  const before = await snapshot()
  assert.deepEqual(await withClient(async (client) => await migrate(client, MIGRATIONS.filter((m) => m.version <= 4))), [4])
  assert.deepEqual(await snapshot(), before, 'migration 4 changed an existing row')
  assert.deepEqual(await withClient(async (client) => await migrate(client)), [5, 6])

  const store = new PgAccountStore({ connectionString: URL as string })
  try {
    store.ready = true
    // The step-3 grant (no credit), as the old server runs it during overlap: no entry.
    const granted = await store.pool.query(V2_GRANT, [made[1].publicId, 5])
    assert.equal(Number(granted.rows[0].xp), 25)
    assert.equal(await store.grant(made[1].publicId, 1), 26, 'this release\'s grant without a credit')
    assert.deepEqual(await store.resolve(made[2].token), { publicId: made[2].publicId, persisted: true, xp: 30, loadouts: [{ robot: 'peep', index: 0, skills: [1, 2, 3, 2] }], energy: null })
    assert.equal(Number((await store.pool.query('SELECT count(*) AS n FROM season_entries')).rows[0].n), 0)
    // And a credit on an account from before it.
    const at = Date.parse('2026-10-07T12:00:00.000Z')
    assert.equal(await store.grant(made[0].publicId, 50, { season: seasonStart(at), atMs: at, banked: 700, extracted: true, xp: 50, name: 'ROOK-42' }), 60)
    const row = (await store.pool.query('SELECT season_start::text AS s, banked, runs, extractions, xp, banked_at, name FROM season_entries')).rows[0]
    assert.deepEqual([row.s, Number(row.banked), row.runs, row.extractions, Number(row.xp), (row.banked_at as Date).getTime(), row.name], ['2026-10-05', 700, 1, 1, 50, at, 'ROOK-42'])
  } finally {
    await store.close()
  }
})

/** A migrated, ready store on the spec's database. */
async function readyStore (): Promise<PgAccountStore> {
  const store = new PgAccountStore({ connectionString: URL as string })
  await store.migrateOnce()
  store.ready = true
  return store
}

/** `n` new accounts, each ranked in the season holding `at` (3 runs, 1 extraction, distinct banked). */
async function fillSeason (store: PgAccountStore, at: number, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const { account } = await store.create()
    for (let run = 0; run < 3; run++) {
      const banked = run === 2 ? 1000 * (n - i) : 0
      await store.grant(account.publicId, 400, { season: seasonStart(at), atMs: at + run, banked, extracted: banked > 0, xp: 400, name: `P${i}` })
    }
    ids.push(account.publicId)
  }
  return ids
}

async function count (sql: string, values: unknown[] = []): Promise<number> {
  return await withClient(async (client) => Number((await client.query(sql, values)).rows[0].n))
}

/** Step 6's resolve, as the previous release runs it during overlap and drain. */
const V6_RESOLVE = `WITH a AS (UPDATE accounts SET last_seen_at = now() WHERE token_hash = $1 RETURNING id, public_id)
       SELECT a.public_id, COALESCE(p.xp, 0) AS xp,
         COALESCE((SELECT json_agg(json_build_object('robot', l.robot, 'index', l.slot_index, 'skills', l.skills) ORDER BY l.robot, l.slot_index)
                   FROM loadouts l WHERE l.account_id = a.id), '[]'::json) AS loadouts
       FROM a LEFT JOIN account_progress p ON p.account_id = a.id`

pgTest('energy (migration 5): added to a v4 database it keeps every row, step 6\'s queries still run, an old account starts at 6, and its CHECK holds', async () => {
  const v4 = MIGRATIONS.filter((m) => m.version <= 4)
  assert.deepEqual(await withClient(async (client) => await migrate(client, v4)), [1, 2, 3, 4])
  const old = new PgAccountStore({ connectionString: URL as string, migrations: v4 })
  const at = Date.parse('2026-10-07T12:00:00.000Z')
  const made: Array<{ token: string, publicId: string }> = []
  // Step 6's resolve is this one's without energy: it is run as SQL below.
  try {
    old.ready = true
    for (let i = 0; i < 2; i++) {
      const { account, token } = await old.create()
      await old.grant(account.publicId, 10, { season: seasonStart(at), atMs: at, banked: 100, extracted: true, xp: 10, name: 'OLD' })
      await old.saveLoadout(account.publicId, 'peep', 0, [1, 2, 3, i])
      made.push({ token, publicId: account.publicId })
    }
  } finally {
    await old.close()
  }
  const snapshot = async (): Promise<unknown[]> => await withClient(async (client) => (await client.query(
    'SELECT a.public_id, a.token_hash, p.xp, l.skills, e.banked FROM accounts a JOIN account_progress p ON p.account_id = a.id JOIN loadouts l ON l.account_id = a.id JOIN season_entries e ON e.account_id = a.id ORDER BY a.id')).rows)
  const before = await snapshot()
  assert.deepEqual(await withClient(async (client) => await migrate(client, MIGRATIONS.filter((m) => m.version <= 5))), [5])
  assert.deepEqual(await snapshot(), before, 'migration 5 changed an existing row')
  assert.deepEqual(await withClient(async (client) => await migrate(client)), [6])

  const store = new PgAccountStore({ connectionString: URL as string })
  try {
    store.ready = true
    // Step 6's resolve and grant, as the old server runs them during overlap.
    const resolved = await store.pool.query(V6_RESOLVE, [hashToken(made[0].token)])
    assert.deepEqual(resolved.rows.map((r) => [r.public_id, Number(r.xp)]), [[made[0].publicId, 10]])
    assert.equal(await store.grant(made[0].publicId, 5, { season: seasonStart(at), atMs: at + 1, banked: 0, extracted: false, xp: 5, name: 'OLD' }), 15)
    // An account from before energy: no row, 6 plays.
    assert.equal((await store.resolve(made[1].token))?.energy, null)
    assert.deepEqual(await store.spend(made[1].publicId, at), { ok: true, energy: { stock: 5, asOfMs: at } })
    assert.deepEqual((await store.resolve(made[1].token))?.energy, { stock: 5, asOfMs: at }, 'the stock read back, to the millisecond')
    // The CHECK backs the arithmetic.
    await assert.rejects(store.pool.query('UPDATE energy SET stock = -1'), /check/i, 'a negative stock')
  } finally {
    await store.close()
  }
})

pgTest('two servers racing: every due season paid exactly once, over 20 rounds', async () => {
  const one = await readyStore()
  const two = new PgAccountStore({ connectionString: URL as string })
  two.ready = true
  try {
    const first = Date.parse('2025-01-08T12:00:00.000Z')
    for (let round = 0; round < 20; round++) {
      const at = first + round * 7 * 86_400_000
      const start = seasonStart(at)
      const ids = await fillSeason(one, at, 10)
      const now = seasonEndMs(start) + PAYOUT_DELAY_MS
      const [a, b] = await Promise.all([one.payDue(now), two.payDue(now)])
      const paid = [...a, ...b]
      assert.deepEqual(paid, [{ start, ranked: 10, paid: 2 }], `round ${round}: paid ${JSON.stringify(paid)}`)
      assert.equal(await count('SELECT count(*) AS n FROM seasons WHERE start = $1::date', [start]), 1)
      assert.equal(await count('SELECT count(*) AS n FROM season_payouts WHERE season_start = $1::date', [start]), 2)
      // Rank 1 (ids[0]) 1,000 capped at its 1,200 season XP: 1,000; rank 2 250.
      const xp = await withClient(async (client) => (await client.query('SELECT a.public_id, p.xp FROM accounts a JOIN account_progress p ON p.account_id = a.id WHERE a.public_id = ANY($1)', [ids])).rows)
      const byId = new Map(xp.map((r) => [r.public_id as string, Number(r.xp)]))
      assert.deepEqual(ids.map((id) => byId.get(id)), [2200, 1450, ...Array(8).fill(1200)], `round ${round}`)
    }
    assert.equal(await count('SELECT count(*) AS n FROM seasons'), 20)
    assert.equal(await count('SELECT count(*) AS n FROM (SELECT season_start, account_id FROM season_payouts GROUP BY 1, 2 HAVING count(*) > 1) d'), 0)
  } finally {
    await one.close()
    await two.close()
  }
})

pgTest('drain mid-payout: close waits for a payout in flight, which pays every due season once', async () => {
  const store = await readyStore()
  const at = Date.parse('2025-02-05T12:00:00.000Z')
  await fillSeason(store, at, 4)
  await fillSeason(store, at + 7 * 86_400_000, 4)
  let entered: () => void = () => {}
  const inside = new Promise<void>((resolve) => { entered = resolve })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  store.payoutHook = async () => {
    if (held++ === 0) {
      entered()
      await gate
    }
  }
  const paying = store.payDue(seasonEndMs(seasonStart(at + 7 * 86_400_000)) + PAYOUT_DELAY_MS)
  await inside
  let closed = false
  const closing = store.close().then(() => { closed = true })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(closed, false, 'close did not wait for the payout')
  await assert.rejects(store.payDue(Date.now()), 'a payout started after close')
  release()
  await closing
  assert.deepEqual((await paying).map((p) => p.start), [seasonStart(at), seasonStart(at + 7 * 86_400_000)])
  assert.equal(await count('SELECT count(*) AS n FROM seasons'), 2)
  assert.equal(await count('SELECT count(*) AS n FROM season_payouts'), 2)
})

pgTest('a payout whose backend is killed mid-transaction pays nothing, and the next pays once', async () => {
  const errors: unknown[] = []
  const store = new PgAccountStore({ connectionString: URL as string, onError: (e) => { errors.push(e) } })
  await store.migrateOnce()
  store.ready = true
  const at = Date.parse('2025-03-12T12:00:00.000Z')
  const ids = await fillSeason(store, at, 10)
  const xpOf = async (): Promise<number[]> => await withClient(async (client) => {
    const rows = (await client.query('SELECT a.public_id, p.xp FROM accounts a JOIN account_progress p ON p.account_id = a.id')).rows
    const byId = new Map(rows.map((r) => [r.public_id as string, Number(r.xp)]))
    return ids.map((id) => byId.get(id) ?? -1)
  })
  const before = await xpOf()
  store.payoutHook = async (_start, pid) => {
    await withClient(async (client) => { await client.query('SELECT pg_terminate_backend($1)', [pid]) })
  }
  const now = seasonEndMs(seasonStart(at)) + PAYOUT_DELAY_MS
  try {
    await assert.rejects(store.payDue(now), 'a payout on a killed backend succeeded')
  } finally {
    await store.close()
  }
  assert.equal(await count('SELECT count(*) AS n FROM seasons'), 0)
  assert.equal(await count('SELECT count(*) AS n FROM season_payouts'), 0)
  assert.deepEqual(await xpOf(), before, 'XP moved on a killed payout')
  const next = await readyStore()
  try {
    assert.deepEqual(await next.payDue(now), [{ start: seasonStart(at), ranked: 10, paid: 2 }])
    assert.deepEqual(await next.payDue(now), [])
  } finally {
    await next.close()
  }
  const after = await xpOf()
  assert.deepEqual(after.map((xp, i) => xp - before[i]), [1000, 250, ...Array(8).fill(0)])
})

// --- the gear stash (decision #49, task 49-3) ----------------------------------

test('the stash lock class fits the two-int advisory key (no database needed)', () => {
  assert.ok(Number.isInteger(STASH_LOCK_CLASS) && STASH_LOCK_CLASS > 0 && STASH_LOCK_CLASS <= 2147483647)
})

/** The pg side of the gear contract's hooks: time passes by moving the timestamps back. */
function pgGearHooks (store: PgAccountStore): GearHooks {
  return {
    age: async (ms) => {
      await store.pool.query("UPDATE stash_items SET carried_at = carried_at - $1::double precision * interval '1 millisecond' WHERE carried_at IS NOT NULL", [ms])
      await store.pool.query("UPDATE gear_holders SET seen_at = seen_at - $1::double precision * interval '1 millisecond'", [ms])
    },
    allRowIds: async () => (await store.pool.query('SELECT id::text AS id FROM stash_items ORDER BY id')).rows.map((r) => r.id as string)
  }
}

pgTest('stash (migration 6): added to a v5 database it keeps every row, the step-7 queries still run, and its CHECKs hold', async () => {
  const v5 = MIGRATIONS.filter((m) => m.version <= 5)
  assert.deepEqual(await withClient(async (client) => await migrate(client, v5)), [1, 2, 3, 4, 5])
  const old = new PgAccountStore({ connectionString: URL as string, migrations: v5 })
  const at = Date.parse('2026-10-07T12:00:00.000Z')
  const made: Array<{ token: string, publicId: string }> = []
  try {
    old.ready = true
    for (let i = 0; i < 2; i++) {
      const { account, token } = await old.create()
      await old.grant(account.publicId, 10, { season: seasonStart(at), atMs: at, banked: 100, extracted: true, xp: 10, name: 'OLD' })
      await old.saveLoadout(account.publicId, 'peep', 0, [1, 2, 3, i])
      assert.equal((await old.spend(account.publicId, at)).ok, true)
      made.push({ token, publicId: account.publicId })
    }
  } finally {
    await old.close()
  }
  const snapshot = async (): Promise<unknown[]> => await withClient(async (client) => (await client.query(
    'SELECT a.public_id, a.token_hash, p.xp, l.skills, e.banked, en.stock, en.as_of FROM accounts a JOIN account_progress p ON p.account_id = a.id JOIN loadouts l ON l.account_id = a.id JOIN season_entries e ON e.account_id = a.id JOIN energy en ON en.account_id = a.id ORDER BY a.id')).rows)
  const before = await snapshot()
  assert.equal(before.length, 2)
  assert.deepEqual(await withClient(async (client) => await migrate(client)), [6])
  assert.deepEqual(await snapshot(), before, 'migration 6 changed an existing row')

  // Step 7's queries are this release's resolve, grant, saveLoadout, spend
  // and refund unchanged (a spend without `bring` sends exactly step 7's SQL).
  const store = new PgAccountStore({ connectionString: URL as string })
  try {
    store.ready = true
    const resolved = await store.resolve(made[0].token)
    assert.deepEqual(resolved, { publicId: made[0].publicId, persisted: true, xp: 10, loadouts: [{ robot: 'peep', index: 0, skills: [1, 2, 3, 0] }], energy: { stock: 5, asOfMs: at } })
    assert.equal(await store.grant(made[0].publicId, 5, { season: seasonStart(at), atMs: at + 1, banked: 0, extracted: false, xp: 5, name: 'OLD' }), 15)
    await store.saveLoadout(made[1].publicId, 'peep', 1, [1, 2, 3, 0])
    assert.deepEqual(await store.spend(made[1].publicId, at), { ok: true, energy: { stock: 4, asOfMs: at } })
    assert.deepEqual(await store.refund(made[1].publicId, at), { stock: 5, asOfMs: at })
    // An account from before the stash has none.
    assert.deepEqual(await store.loadStash(made[1].publicId), [])

    // The CHECKs back what the stores check first.
    const id = (await store.pool.query('SELECT id FROM accounts WHERE public_id = $1', [made[0].publicId])).rows[0].id
    const insert = async (columns: string, values: string): Promise<unknown> =>
      await store.pool.query(`INSERT INTO stash_items (account_id, ${columns}) VALUES ($1, ${values})`, [id])
    await assert.rejects(insert('tier, skill, source', '0, 1, 1'), /check/i, 'tier 0')
    await assert.rejects(insert('tier, skill, source', '4, 1, 1'), /check/i, 'tier 4')
    await assert.rejects(insert('tier, skill, source', '1, 256, 1'), /check/i, 'skill 256')
    await assert.rejects(insert('tier, skill, source', '1, -1, 1'), /check/i, 'skill -1')
    await assert.rejects(insert('tier, skill, source', '1, 1, 0'), /check/i, 'source 0')
    await assert.rejects(insert('tier, skill, source, state', '1, 1, 1, 2'), /check/i, 'state 2')
    await assert.rejects(insert('tier, skill, source, state', '1, 1, 1, 1'), /check/i, 'carried with no holder')
    await assert.rejects(insert('tier, skill, source, state, holder', `1, 1, 1, 1, '${randomUUID()}'`), /check/i, 'carried with no carried_at')
    await assert.rejects(insert('tier, skill, source, holder, carried_at', `1, 1, 1, '${randomUUID()}', now()`), /check/i, 'stashed with a holder')
    await assert.rejects(insert('tier, skill, source, rolls', "1, 1, 1, '{{1,2},{3,4}}'"), /check/i, 'a 2-D rolls')
    await assert.rejects(insert('tier, skill, source, rolls', `1, 1, 1, '{${Array(17).fill(1).join(',')}}'`), /check/i, '17 rolls values')
    await insert('tier, skill, source, rolls', `1, 1, 1, '{${Array(16).fill(1).join(',')}}'`)
    await insert('tier, skill, source, state, holder, carried_at', `1, 1, 1, 1, '${randomUUID()}', now()`)
    // A row without rolls takes the default.
    await insert('tier, skill, source', '1, 0, 1')
    assert.equal((await store.loadStash(made[0].publicId)).length, 3)
  } finally {
    await store.close()
  }
})

pgTest('the gear stash contract, dupe races 1-11, merge and scrap, against Postgres', async () => {
  const store = await readyStore()
  try {
    await gearContract(store, pgGearHooks(store))
  } finally {
    await store.close()
  }
})

pgTest('the admin contract against Postgres (decision #50), and close waits for an admin grant in flight', async () => {
  const store = await readyStore()
  try {
    await adminContract(store, pgGearHooks(store))
  } finally {
    await store.close()
  }
  const again = await readyStore()
  const { account } = await again.create()
  const pending = again.adminGrantGear(account.publicId, [T1, T2])
  await again.close()
  assert.equal((await pending)?.inserted, 2, 'close cut an admin grant short')
  assert.equal(await withClient(async (client) => Number((await client.query('SELECT count(*) AS n FROM stash_items WHERE source = 3')).rows[0].n)) >= 2, true)
})

pgTest('admin grants under load: five at once on one account never take it past STASH_MAX (the stash lock)', async () => {
  const store = await readyStore()
  try {
    const parts = Array.from({ length: 30 }, () => PART)
    for (let round = 0; round < 10; round++) {
      const { account } = await store.create()
      // Five clients open first, so the transactions really overlap.
      await Promise.all(Array.from({ length: 5 }, async () => await store.pool.query('SELECT 1')))
      const granted = await Promise.all(Array.from({ length: 5 }, async () => await store.adminGrantGear(account.publicId, parts)))
      assert.deepEqual(granted.map((g) => g?.inserted).sort(), [0, 0, 30, 30, 30], `round ${round}`)
      assert.equal((await store.adminRead(account.publicId))?.stashed, 90, `round ${round}`)
    }
  } finally {
    await store.close()
  }
})

pgTest('race 1 under load: many concurrent spends bringing the same items, each item carried once', async () => {
  const store = await readyStore()
  try {
    for (let round = 0; round < 15; round++) {
      const { account } = await store.create()
      const ids = (await store.settleGear(account.publicId, randomUUID(), [], [T1, T2, T1])).stash.map((r) => r.rowId)
      const holders = Array.from({ length: 5 }, () => randomUUID())
      for (const h of holders) await store.heartbeat(h, [])
      // Five at once, as many as the pool has clients: the transactions overlap.
      const spent = await Promise.all(holders.map(async (holder, i) => await store.spend(account.publicId, Date.now(), { ids: i % 2 === 0 ? ids : [...ids].reverse(), holder })))
      assert.equal(spent.filter((s) => s.ok).length, 5)
      const got = spent.flatMap((s) => (s.carried ?? []).map((c) => c.rowId as string)).sort()
      assert.deepEqual(got, [...ids].sort(), `round ${round}: an item carried twice or by nobody`)
      const rows = (await store.pool.query('SELECT id::text AS id, holder::text AS holder FROM stash_items WHERE id = ANY($1::bigint[]) ORDER BY id', [ids])).rows
      // Each row's holder is the spend that says it carried it.
      for (const row of rows) {
        const winner = spent.findIndex((s) => (s.carried ?? []).some((c) => c.rowId === row.id))
        assert.equal(row.holder, holders[winner], `round ${round}: row ${row.id as string} held by another than its carrier`)
      }
    }
  } finally {
    await store.close()
  }
})

pgTest('race 2 under load (49-5): a merge racing a bring-in of its rows, or another merge, or a scrap: exactly one happens', async () => {
  const store = await readyStore()
  const rule = (seed: number): MergeRule => {
    const random = seeded(seed)
    return (inputs) => mergeOutcome(inputs, undefined, random)
  }
  try {
    for (let round = 0; round < 24; round++) {
      // A carry and two merges of the same three rows at once.
      const { account } = await store.create()
      const ids = (await store.settleGear(account.publicId, randomUUID(), [], [T1, T1, T1])).stash.map((r) => r.rowId)
      const holder = randomUUID()
      await store.heartbeat(holder, [])
      // The carry brings one row, or all three in the other order (lock order differs from the merge's).
      const bring = round % 2 === 0 ? [ids[round % 3]] : [...ids].reverse()
      const [spent, merged, again] = await Promise.allSettled([
        store.spend(account.publicId, Date.now(), { ids: bring, holder }),
        store.mergeGear(account.publicId, ids, rule(round)),
        store.mergeGear(account.publicId, [...ids].reverse(), rule(round + 100))
      ])
      for (const r of [spent, merged, again]) assert.equal(r.status, 'fulfilled', `round ${round}: ${r.status === 'rejected' ? String(r.reason) : ''}`)
      const carried = spent.status === 'fulfilled' ? (spent.value.carried ?? []).length : 0
      const merges = [merged, again].filter((m) => m.status === 'fulfilled' && m.value.item !== null).length
      assert.equal(merges + (carried > 0 ? 1 : 0), 1, `round ${round}: ${merges} merges and ${carried} carried`)
      const stash = await store.loadStash(account.publicId)
      if (merges === 1) {
        assert.deepEqual(stash.map((r) => [r.source, r.carried]), [[2, false]])
      } else {
        assert.equal(stash.length, 3, `round ${round}: rows lost or made`)
        assert.equal(stash.filter((r) => r.carried).length, carried)
      }

      // A carry and a scrap of one row at once.
      const other = await store.create()
      const [row] = (await store.settleGear(other.account.publicId, randomUUID(), [], [T1])).stash.map((r) => r.rowId)
      const [took, scrapped] = await Promise.all([
        store.spend(other.account.publicId, Date.now(), { ids: [row], holder }),
        store.scrapGear(other.account.publicId, row)
      ])
      assert.equal((took.carried ?? []).length + (scrapped.ok ? 1 : 0), 1, `round ${round}: the row both carried and scrapped, or neither`)
      assert.equal((await store.loadStash(other.account.publicId)).length, scrapped.ok ? 0 : 1)
    }
  } finally {
    await store.close()
  }
})

pgTest('race 11 under load: concurrent settles at the cap never pass STASH_MAX', async () => {
  const store = await readyStore()
  try {
    for (let round = 0; round < 6; round++) {
      const { account } = await store.create()
      const room = round % 3 + 1
      await store.settleGear(account.publicId, randomUUID(), [], Array.from({ length: 100 - room }, () => PART))
      const settles = await Promise.all(Array.from({ length: 6 }, async () => await store.settleGear(account.publicId, randomUUID(), [], [T1, T2, T1])))
      assert.equal(settles.reduce((n, s) => n + s.inserted, 0), room, `round ${round}: inserted past the cap`)
      const n = Number((await store.pool.query('SELECT count(*) AS n FROM stash_items s JOIN accounts a ON a.id = s.account_id WHERE a.public_id = $1', [account.publicId])).rows[0].n)
      assert.equal(n, 100, `round ${round}`)
    }
  } finally {
    await store.close()
  }
})

pgTest('close waits for every gear write in flight; none starts after it', async () => {
  const store = await readyStore()
  const { account } = await store.create()
  const holder = randomUUID()
  await store.heartbeat(holder, [])
  const ids = (await store.settleGear(account.publicId, holder, [], Array.from({ length: 12 }, () => T1))).stash.map((r) => r.rowId)
  assert.equal((await store.spend(account.publicId, Date.now(), { ids, holder })).carried?.length, 12)
  // A drain's run ends all at once: more writes than the pool's clients.
  const writes: Array<Promise<unknown>> = [
    ...ids.slice(0, 4).map(async (id) => await store.settleGear(account.publicId, holder, [id], [PART])),
    ...ids.slice(4, 8).map(async (id) => await store.discardGear(holder, [id])),
    ...ids.slice(8).map(async (id) => await store.uncarry(holder, [id])),
    store.heartbeat(holder, [])
  ]
  await store.close()
  const settled = await Promise.allSettled(writes)
  assert.deepEqual(settled.filter((r) => r.status === 'rejected'), [], 'a gear write was lost at close')
  await assert.rejects(store.settleGear(account.publicId, holder, [], [T1]), 'a settle after close')
  await assert.rejects(store.releaseHolder(holder), 'a release after close')
  const n = await count('SELECT count(*) AS n FROM stash_items')
  assert.equal(n, 12 - 4 + 4, 'four discarded, four parts found')
  assert.equal(await count('SELECT count(*) AS n FROM stash_items WHERE state = 1'), 0)
})
