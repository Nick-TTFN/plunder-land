import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { hashToken } from './accounts'
import { PgAccountStore, NotReadyError } from './pgstore'
import { migrate } from './migrate'
import { MIGRATIONS, type Migration } from './migrations'
import { storeContract } from './storecontract'

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
    assert.deepEqual(await again.resolve(token), { publicId, persisted: true, xp: 175, loadouts: [] })
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
  assert.deepEqual(await withClient(async (client) => await migrate(client)), [3])
  const after = await withClient(async (client) => (await client.query('SELECT a.public_id, a.token_hash, p.xp FROM accounts a JOIN account_progress p ON p.account_id = a.id ORDER BY a.id')).rows)
  assert.deepEqual(after, before, 'migration 3 changed an existing row')

  const store = new PgAccountStore({ connectionString: URL as string })
  try {
    store.ready = true
    // The previous release's resolve and grant, on the new schema.
    const old = await store.pool.query(V2_RESOLVE, [hashToken(made[0].token)])
    assert.deepEqual(old.rows.map((r) => [r.public_id, Number(r.xp)]), [[made[0].publicId, 10]])
    const granted = await store.pool.query(V2_GRANT, [made[1].publicId, 5])
    assert.equal(Number(granted.rows[0].xp), 25)
    // This release's, on an account from before it: no loadouts yet.
    assert.deepEqual(await store.resolve(made[2].token), { publicId: made[2].publicId, persisted: true, xp: 30, loadouts: [] })
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
