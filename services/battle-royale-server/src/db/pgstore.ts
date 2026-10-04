import { Client, Pool, type PoolClient } from 'pg'
import { type Account, type AccountStore, type StoredLoadout, hashToken, newPublicId, newToken } from './accounts'
import { migrate } from './migrate'
import { MIGRATIONS, type Migration } from './migrations'
import {
  dueStarts, type LastPayout, type PaidSeason, type SeasonBoard, type SeasonCredit, seasonEndMs, seasonPayouts,
  seasonStart, type SeasonView, seasonView, type Tier, tierPlaces
} from '../progress/seasons'
import { SEASON } from '../progress/xp'
import { ThrottledLog } from '../network/multiplayer'

/**
 * The advisory lock a season payout takes, per transaction ("seasons" in
 * ASCII hex). Distinct from `MIGRATION_LOCK` (pgstore.spec.ts pins it).
 */
export const SEASON_LOCK = '0x736561736f6e73'

/**
 * Says when `payOne`'s last guard, the `seasons` primary key, fires: it should
 * never be reached while the lock and the paid check are in place. Not an
 * error (the season counts as paid), so it logs and is not reported.
 */
export const SEASON_PAID_LOG = new ThrottledLog('seasons', 60_000, undefined, console.log)

/**
 * The ranking order in SQL: `compareEntries` (progress/seasons.ts) exactly.
 * Postgres sorts NULL last ascending, as `compareEntries` puts a missing
 * `bankedAt` last; an eligible entry has banked loot and so a `banked_at`.
 */
const RANK_ORDER = 'banked DESC, banked_at, account_id'

/** An eligible entry in SQL: `eligible` (progress/seasons.ts), with $2..$4 the `SEASON` minimums. */
const ELIGIBLE = 'runs >= $2 AND extractions >= $3 AND banked >= $4'

/** A `season` query's row (pg returns bigint and count as strings). */
interface SeasonRow {
  banked: string | null
  runs: number | null
  extractions: number | null
  xp: string | null
  ranked: string
  rank: string | null
  last: { start: string, rank: number, ranked: number, tier: number, xp: number } | null
}

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
  /** Grants and loadout saves in flight, which `close` waits for. */
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
    // One round trip: the account, its XP (no progress row yet reads as 0)
    // and its saved loadouts (none reads as []).
    const result = await this.pool.query(
      `WITH a AS (UPDATE accounts SET last_seen_at = now() WHERE token_hash = $1 RETURNING id, public_id)
       SELECT a.public_id, COALESCE(p.xp, 0) AS xp,
         COALESCE((SELECT json_agg(json_build_object('robot', l.robot, 'index', l.slot_index, 'skills', l.skills) ORDER BY l.robot, l.slot_index)
                   FROM loadouts l WHERE l.account_id = a.id), '[]'::json) AS loadouts
       FROM a LEFT JOIN account_progress p ON p.account_id = a.id`,
      [hashToken(token)]
    )
    const row = result.rows[0] as { public_id: string, xp: string | number, loadouts: StoredLoadout[] } | undefined
    if (row === undefined) return null
    // Raw as stored: `kitFor` checks every row at the join.
    const loadouts = Array.isArray(row.loadouts) ? row.loadouts.map((l) => ({ robot: l.robot, index: Number(l.index), skills: l.skills })) : []
    return { publicId: row.public_id, persisted: true, xp: Number(row.xp), loadouts }
  }

  /**
   * One upsert: the account's loadout `index` for `robot` becomes `skills`.
   * Throws for an unknown public id (no row written), as for any failure.
   * `close` waits for it, as for a grant.
   */
  async saveLoadout (publicId: string, robot: string, index: number, skills: number[]): Promise<void> {
    if (!this.ready) throw new NotReadyError()
    if (this.closed) throw new Error('accounts: store closed')
    const pending = this.pool.query(
      `INSERT INTO loadouts (account_id, robot, slot_index, skills)
       SELECT id, $2, $3, $4::smallint[] FROM accounts WHERE public_id = $1
       ON CONFLICT (account_id, robot, slot_index) DO UPDATE SET skills = EXCLUDED.skills, updated_at = now()`,
      [publicId, robot, index, skills]
    )
    this.grants.add(pending)
    try {
      if ((await pending).rowCount !== 1) throw new Error('accounts: loadout for an unknown account')
    } finally {
      this.grants.delete(pending)
    }
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
        return { account: { publicId, persisted: true, xp: 0, loadouts: [] }, token }
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
  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> {
    if (!this.ready) throw new NotReadyError()
    if (this.closed) throw new Error('accounts: store closed')
    const pending = credit === undefined
      ? this.pool.query(
        `INSERT INTO account_progress (account_id, xp)
         SELECT id, $2 FROM accounts WHERE public_id = $1
         ON CONFLICT (account_id) DO UPDATE SET xp = account_progress.xp + EXCLUDED.xp, updated_at = now()
         RETURNING xp`,
        [publicId, xp]
      )
      // The season credit in the same statement (decision #48 step 6): the XP
      // and the entry land together or not at all. Data-modifying CTEs run
      // even unreferenced. A paid season takes no entry (`NOT EXISTS`); the
      // XP still lands. `banked_at` moves only on a run that banked.
      : this.pool.query(
        `WITH a AS (SELECT id FROM accounts WHERE public_id = $1),
         p AS (INSERT INTO account_progress (account_id, xp) SELECT id, $2 FROM a
               ON CONFLICT (account_id) DO UPDATE SET xp = account_progress.xp + EXCLUDED.xp, updated_at = now()
               RETURNING xp),
         s AS (INSERT INTO season_entries (season_start, account_id, banked, runs, extractions, xp, banked_at, name)
               SELECT $3::date, id, $4::bigint, 1, $5::int, $2::bigint, CASE WHEN $4::bigint > 0 THEN to_timestamp($6::double precision / 1000.0) END,
                 NULLIF(left($7::text, 64), '') FROM a
               WHERE NOT EXISTS (SELECT 1 FROM seasons WHERE start = $3::date)
               ON CONFLICT (season_start, account_id) DO UPDATE SET
                 banked = season_entries.banked + EXCLUDED.banked, runs = season_entries.runs + 1,
                 extractions = season_entries.extractions + EXCLUDED.extractions, xp = season_entries.xp + EXCLUDED.xp,
                 banked_at = COALESCE(EXCLUDED.banked_at, season_entries.banked_at),
                 name = COALESCE(EXCLUDED.name, season_entries.name), updated_at = now())
         SELECT xp FROM p`,
        [publicId, xp, credit.season, credit.banked, credit.extracted ? 1 : 0, credit.atMs, credit.name]
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
   * The account's view of the current season, in one round trip: its entry
   * (none reads as zeros), the eligible count, its rank among them (by
   * `RANK_ORDER`, null when it isn't eligible) and its latest payout.
   */
  async season (publicId: string, atMs: number): Promise<SeasonView> {
    if (!this.ready) throw new NotReadyError()
    const start = seasonStart(atMs)
    const result = await this.pool.query(
      `WITH a AS (SELECT id FROM accounts WHERE public_id = $5),
       el AS (SELECT account_id, row_number() OVER (ORDER BY ${RANK_ORDER}) AS rank
              FROM season_entries WHERE season_start = $1::date AND ${ELIGIBLE})
       SELECT e.banked, e.runs, e.extractions, e.xp,
         (SELECT count(*) FROM el) AS ranked,
         (SELECT el.rank FROM el WHERE el.account_id = a.id) AS rank,
         (SELECT json_build_object('start', p.season_start, 'rank', p.rank, 'ranked', s.ranked, 'tier', p.tier, 'xp', p.xp)
          FROM season_payouts p JOIN seasons s ON s.start = p.season_start
          WHERE p.account_id = a.id ORDER BY p.season_start DESC LIMIT 1) AS last
       FROM a LEFT JOIN season_entries e ON e.account_id = a.id AND e.season_start = $1::date`,
      [start, SEASON.minRuns, SEASON.minExtractions, SEASON.minBanked, publicId]
    )
    const row = result.rows[0] as SeasonRow | undefined
    if (row === undefined) throw new Error('accounts: season for an unknown account')
    const entry = row.runs === null ? undefined : { banked: Number(row.banked), runs: Number(row.runs), extractions: Number(row.extractions), xp: Number(row.xp) }
    const last: LastPayout | undefined = row.last === null
      ? undefined
      : { start: String(row.last.start), rank: Number(row.last.rank), ranked: Number(row.last.ranked), tier: Number(row.last.tier) as Tier, xp: Number(row.last.xp) }
    return seasonView(start, atMs, entry, Number(row.ranked), row.rank === null ? null : Number(row.rank), last)
  }

  /** The current season's eligible count and its top `limit`, by public id. */
  async seasonBoard (atMs: number, limit: number): Promise<SeasonBoard> {
    if (!this.ready) throw new NotReadyError()
    const start = seasonStart(atMs)
    const result = await this.pool.query(
      `WITH el AS (SELECT account_id, banked, banked_at, name FROM season_entries WHERE season_start = $1::date AND ${ELIGIBLE})
       SELECT (SELECT count(*) FROM el) AS ranked,
         COALESCE((SELECT json_agg(t ORDER BY t.n) FROM (
           SELECT ac.public_id AS id, el.name, el.banked, row_number() OVER (ORDER BY ${RANK_ORDER}) AS n
           FROM el JOIN accounts ac ON ac.id = el.account_id ORDER BY n LIMIT $5) t), '[]'::json) AS top`,
      [start, SEASON.minRuns, SEASON.minExtractions, SEASON.minBanked, limit]
    )
    const row = result.rows[0] as { ranked: string | number, top: Array<{ id: string, name: string | null, banked: number | string, n: number | string }> }
    const ranked = Number(row.ranked)
    return {
      start,
      endsInMs: Math.max(0, seasonEndMs(start) - atMs),
      ranked,
      places: tierPlaces(ranked),
      top: row.top.map((t) => ({ rank: Number(t.n), name: t.name ?? '', id: t.id, banked: Number(t.banked) }))
    }
  }

  /**
   * Test hook: awaited inside a payout's transaction, after the ranking and
   * before the writes, with the transaction's backend pid (the drain specs
   * hold or kill it there). Never set by the server.
   */
  payoutHook: ((start: string, pid: number) => Promise<void>) | undefined

  /**
   * Pay every due, unpaid season with entries, oldest first, each in its own
   * transaction (`payOne`). `close` waits for it, as for a grant, and a closed
   * store starts none. Throws at the first season that fails; the next check
   * (on this server or another) pays it.
   */
  async payDue (nowMs: number): Promise<PaidSeason[]> {
    if (!this.ready) throw new NotReadyError()
    if (this.closed) throw new Error('accounts: store closed')
    const pending = this.payAll(nowMs)
    this.grants.add(pending)
    try {
      return await pending
    } finally {
      this.grants.delete(pending)
    }
  }

  private async payAll (nowMs: number): Promise<PaidSeason[]> {
    const starts = dueStarts(nowMs)
    if (starts.length === 0) return []
    const due = await this.pool.query(
      `SELECT DISTINCT e.season_start::text AS start FROM season_entries e
       WHERE e.season_start = ANY($1::date[]) AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.start = e.season_start)
       ORDER BY 1`,
      [starts]
    )
    const done: PaidSeason[] = []
    for (const row of due.rows as Array<{ start: string }>) {
      const paid = await this.payOne(row.start)
      if (paid !== undefined) done.push(paid)
    }
    return done
  }

  /**
   * One season's payout, in one transaction on its own client. Three guards,
   * each enough for a different race: `pg_try_advisory_xact_lock` keeps two
   * servers from ranking at once (the loser pays nothing and never waits);
   * the `seasons` check inside the lock makes a later call a no-op; and the
   * `seasons` primary key aborts a second payout even without both. A crash
   * or a killed backend rolls the whole thing back, lock included.
   */
  private async payOne (start: string): Promise<PaidSeason | undefined> {
    const client: PoolClient = await this.pool.connect()
    // A checked-out client whose backend dies emits `error`; unheard, that ends the process.
    const onError = (e: unknown): void => { this.onError(e) }
    client.on('error', onError)
    let failed: Error | undefined
    try {
      await client.query('BEGIN')
      const lock = await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', [BigInt(SEASON_LOCK).toString()])
      if ((lock.rows[0] as { ok: boolean }).ok !== true) {
        await client.query('ROLLBACK')
        return undefined
      }
      if (((await client.query('SELECT 1 FROM seasons WHERE start = $1::date', [start])).rowCount ?? 0) > 0) {
        await client.query('ROLLBACK')
        return undefined
      }
      const mins = [SEASON.minRuns, SEASON.minExtractions, SEASON.minBanked]
      const n = Number((await client.query(`SELECT count(*) AS n FROM season_entries WHERE season_start = $1::date AND ${ELIGIBLE}`, [start, ...mins])).rows[0].n)
      const top = await client.query(
        `SELECT account_id::text AS key, xp FROM season_entries WHERE season_start = $1::date AND ${ELIGIBLE} ORDER BY ${RANK_ORDER} LIMIT $5`,
        [start, ...mins, tierPlaces(n)[2]]
      )
      const payouts = seasonPayouts((top.rows as Array<{ key: string, xp: string | number }>).map((r) => ({ key: r.key, xp: Number(r.xp) })), n)
      if (this.payoutHook !== undefined) {
        const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await this.payoutHook(start, pid)
      }
      await client.query('INSERT INTO seasons (start, ranked, paid) VALUES ($1::date, $2, $3)', [start, n, payouts.length])
      if (payouts.length > 0) {
        await client.query(
          `INSERT INTO season_payouts (season_start, account_id, rank, tier, xp)
           SELECT $1::date, * FROM unnest($2::bigint[], $3::int[], $4::smallint[], $5::int[])`,
          [start, payouts.map((p) => p.key), payouts.map((p) => p.rank), payouts.map((p) => p.tier), payouts.map((p) => p.xp)]
        )
        // The same upsert as `grant`, inside this transaction.
        await client.query(
          `INSERT INTO account_progress (account_id, xp) SELECT account_id, xp FROM season_payouts WHERE season_start = $1::date
           ON CONFLICT (account_id) DO UPDATE SET xp = account_progress.xp + EXCLUDED.xp, updated_at = now()`,
          [start]
        )
      }
      await client.query('COMMIT')
      return { start, ranked: n, paid: payouts.length }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      // The primary key caught a payout another server committed first (the
      // last guard, reached only if the other two were gone): paid, so this
      // call pays nothing, as when the lock or the check says so.
      const pg = e as { code?: string, constraint?: string }
      if (pg.code === '23505' && pg.constraint === 'seasons_pkey') {
        SEASON_PAID_LOG.report(`${start} already paid by another server (primary key); counted as paid, nothing paid here`)
        return undefined
      }
      failed = e instanceof Error ? e : new Error(String(e))
      throw e
    } finally {
      client.removeListener('error', onError)
      // A client that failed is dropped, not returned to the pool.
      client.release(failed)
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
