import { Client, Pool } from 'pg'
import { type Account, type AccountStore, hashToken, newPublicId, newToken } from './accounts'
import { migrate } from './migrate'
import { MIGRATIONS, type Migration } from './migrations'

/** Thrown by `resolve` and `create` until the migrations have run: the caller plays offline. */
export class NotReadyError extends Error {
  constructor () {
    super('accounts: database not migrated yet')
    this.name = 'NotReadyError'
  }
}

export interface PgAccountStoreOptions {
  connectionString: string
  /** How long after a failed migration attempt to try again. */
  retryMs?: number
  /** Every failure the store sees on its own: migrations, idle pool clients. */
  onError?: (e: unknown) => void
  /** Called once the migrations have run. */
  onReady?: (applied: number[]) => void
  migrations?: readonly Migration[]
}

/**
 * Accounts in Postgres (`DATABASE_URL`). Boot never waits for it: `start`
 * runs the migrations in the background and retries every `retryMs` (30 s)
 * until they succeed; until then `resolve` and `create` throw `NotReadyError`
 * and every connection plays offline (fail open, decision #48).
 *
 * Every query is bounded: `connectionTimeoutMillis` and `query_timeout` are
 * both 2 s, so a slow database costs a joining player at most a few seconds
 * in the lobby, then an offline run.
 */
export class PgAccountStore implements AccountStore {
  readonly pool: Pool
  ready = false
  private retry: NodeJS.Timeout | undefined
  private closed = false
  /** Grants in flight, which `close` waits for. */
  private readonly grants = new Set<Promise<unknown>>()
  private readonly retryMs: number
  private readonly onError: (e: unknown) => void
  private readonly onReady: (applied: number[]) => void
  private readonly migrations: readonly Migration[]
  private readonly connectionString: string

  constructor (options: PgAccountStoreOptions) {
    this.connectionString = options.connectionString
    this.retryMs = options.retryMs ?? 30_000
    this.onError = options.onError ?? (() => {})
    this.onReady = options.onReady ?? (() => {})
    this.migrations = options.migrations ?? MIGRATIONS
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: 5,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000
    })
    // An idle client that loses its connection emits `error` on the pool; with
    // no listener that is an uncaught exception and ends the process.
    this.pool.on('error', (e) => { this.onError(e) })
  }

  /** Run the migrations in the background, retrying until they succeed. Never throws. */
  start (): void {
    this.attempt().catch((e) => { this.onError(e) })
  }

  /**
   * One migration attempt on its own connection: the advisory lock may wait
   * for another server's runner, which the pool's 2 s `query_timeout` would
   * cut short, so this client has a 60 s `statement_timeout` instead.
   */
  async migrateOnce (): Promise<number[]> {
    const client = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5000, statement_timeout: 60_000 })
    client.on('error', (e) => { this.onError(e) })
    await client.connect()
    try {
      return await migrate(client, this.migrations)
    } finally {
      await client.end().catch(() => {})
    }
  }

  private async attempt (): Promise<void> {
    if (this.closed) return
    try {
      const applied = await this.migrateOnce()
      this.ready = true
      this.onReady(applied)
    } catch (e) {
      this.onError(e)
      if (!this.closed) {
        this.retry = setTimeout(() => { this.start() }, this.retryMs)
        this.retry.unref()
      }
    }
  }

  async resolve (token: string): Promise<Account | null> {
    if (!this.ready) throw new NotReadyError()
    // One round trip: the account and its XP (no progress row yet reads as 0).
    const result = await this.pool.query(
      `WITH a AS (UPDATE accounts SET last_seen_at = now() WHERE token_hash = $1 RETURNING id, public_id)
       SELECT a.public_id, COALESCE(p.xp, 0) AS xp FROM a LEFT JOIN account_progress p ON p.account_id = a.id`,
      [hashToken(token)]
    )
    const row = result.rows[0] as { public_id: string, xp: string | number } | undefined
    return row === undefined ? null : { publicId: row.public_id, persisted: true, xp: Number(row.xp) }
  }

  async create (): Promise<{ account: Account, token: string }> {
    if (!this.ready) throw new NotReadyError()
    // A unique violation is a public id (64 bits) or a token hash (256)
    // already taken: practically never, and a fresh pair fixes either.
    for (let attempt = 1; ; attempt++) {
      const token = newToken()
      const publicId = newPublicId()
      try {
        await this.pool.query('INSERT INTO accounts (public_id, token_hash) VALUES ($1, $2)', [publicId, hashToken(token)])
        return { account: { publicId, persisted: true, xp: 0 }, token }
      } catch (e) {
        if ((e as { code?: string }).code !== '23505' || attempt >= 3) throw e
      }
    }
  }

  /**
   * Add `xp` to the account's total: one atomic upsert, so two grants at once
   * (two tabs ending runs together) both count. Throws for an unknown public
   * id, as for any failure.
   */
  async grant (publicId: string, xp: number): Promise<number> {
    if (!this.ready) throw new NotReadyError()
    if (this.closed) throw new Error('accounts: store closed')
    const pending = this.pool.query(
      `INSERT INTO account_progress (account_id, xp)
       SELECT id, $2 FROM accounts WHERE public_id = $1
       ON CONFLICT (account_id) DO UPDATE SET xp = account_progress.xp + EXCLUDED.xp, updated_at = now()
       RETURNING xp`,
      [publicId, xp]
    )
    this.grants.add(pending)
    try {
      const row = (await pending).rows[0] as { xp: string | number } | undefined
      if (row === undefined) throw new Error('accounts: grant to an unknown account')
      return Number(row.xp)
    } finally {
      this.grants.delete(pending)
    }
  }

  /**
   * Waits for the grants in flight, then ends the pool. Runs cut short by a
   * drain's deadline are all granted at once from their disconnects, more
   * than the pool's 5 clients, and `pool.end()` would leave the queued ones
   * waiting forever: their XP would be lost.
   */
  async close (): Promise<void> {
    this.closed = true
    if (this.retry !== undefined) clearTimeout(this.retry)
    await Promise.allSettled([...this.grants])
    await this.pool.end()
  }
}
