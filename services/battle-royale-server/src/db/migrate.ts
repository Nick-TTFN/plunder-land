import { MIGRATIONS, type Migration } from './migrations'

/**
 * The advisory lock every migration runner takes (an arbitrary fixed key,
 * "plunderland" in ASCII hex, truncated to fit a bigint). Railway overlaps
 * deploys, so two servers can boot against one database at once; the lock
 * makes the second wait for the first and then find nothing left to apply.
 */
export const MIGRATION_LOCK = '0x706c756e6465726c'

/** What `migrate` needs of a connection: one session, so the lock and the transactions share it. */
export interface MigrationClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * Apply every migration in `migrations` that `schema_migrations` doesn't
 * list, in version order, each in its own transaction with its row, under
 * `pg_advisory_lock`. Returns the versions applied by this call (empty when
 * the schema was already current). Throws on any failure; the failed
 * migration's transaction is rolled back and the lock released, and the
 * caller retries later (PgAccountStore).
 */
export async function migrate (client: MigrationClient, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [BigInt(MIGRATION_LOCK).toString()])
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    int PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((row) => Number(row.version)))
    const applied: number[] = []
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(migration.version)) continue
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      }
      applied.push(migration.version)
    }
    return applied
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [BigInt(MIGRATION_LOCK).toString()]).catch(() => {})
  }
}
