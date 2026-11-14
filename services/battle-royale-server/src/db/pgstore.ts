import { Client, Pool, type PoolClient } from 'pg'
import {
  type Account, type AccountStore, type AdRefilled, type AdRefillStore, type FirstRunStore, type PortalStore, type AdminAccount, type AdminGranted, type AdminStore, type Bring, byRowId, checkHolder, flatRolls, GEAR_SOURCE, type GearStore, hashToken,
  type Merged, mergeIdsOf, type MergeRule, newPublicId, newToken, RECONCILE_AFTER_MS, rollsOf, rowIdsOf, type Scrapped,
  type Settled, splitFound, type Spent, STALE_CARRY_MS, type StashEdits, type StashItem, storable, type StoredLoadout
} from './accounts'
import { type GearInstance, type GearTier, STASH_MAX } from '../utils/gear'
import { migrate } from './migrate'
import { MIGRATIONS, type Migration } from './migrations'
import {
  dueStarts, type LastPayout, type PaidSeason, type SeasonBoard, type SeasonCredit, seasonEndMs, seasonPayouts,
  seasonStart, type SeasonView, seasonView, type Tier, tierPlaces
} from '../progress/seasons'
import { ENERGY, SEASON } from '../progress/xp'
import { adRefillAt, type AdRefillRecord, energyAt, type EnergyRecord, refundAt, spendAt } from '../progress/energy'
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

/**
 * The class key of `settleGear`'s per-account advisory lock (two-int form;
 * "gear" in ASCII hex). The two-int key space never overlaps the one-bigint
 * space `SEASON_LOCK` and `MIGRATION_LOCK` use.
 */
export const STASH_LOCK_CLASS = 0x67656172

/** The columns a stash row is read with (`StashRowSql`). */
const STASH_COLUMNS = 'id::text AS id, tier, skill, rolls, state, source'

/** A stash row as pg returns `STASH_COLUMNS` (smallint arrays come back as numbers). */
interface StashRowSql {
  id: string
  tier: number
  skill: number
  rolls: number[] | null
  state: number
  source: number
}

function instanceOfRow (row: StashRowSql): GearInstance & { rowId: string } {
  return { tier: Number(row.tier) as GearTier, skill: Number(row.skill), rolls: rollsOf(row.rolls), rowId: row.id }
}

function stashItemOfRow (row: StashRowSql): StashItem {
  return { ...instanceOfRow(row), carried: Number(row.state) === 1, source: Number(row.source) }
}

/**
 * Migration 11's columns of `energy` (alias `en`), as `AdRefillRow` reads
 * them. The day as text: node-pg would turn a `date` into a local-midnight
 * `Date`, which is the wrong day east or west of UTC. Through `to_char`, never
 * `::text`, whose form follows the session's DateStyle: under a non-ISO one
 * the day never equals `utcDay(now)` and the daily cap fails open.
 */
const AD_REFILL_COLUMNS = `round(extract(epoch FROM en.ad_refill_at) * 1000)::bigint AS ad_refill_ms,
         to_char(en.ad_refills_day, 'YYYY-MM-DD') AS ad_refills_day, en.ad_refills_count`

interface AdRefillRow {
  ad_refill_ms: string | null
  ad_refills_day: string | null
  ad_refills_count: number | null
}

/** The stored refills, or null for none ever (no energy row, or no refill on it). */
function adRefillOfRow (row: AdRefillRow): AdRefillRecord | null {
  if (row.ad_refill_ms === null || row.ad_refill_ms === undefined) return null
  return { lastAtMs: Number(row.ad_refill_ms), day: row.ad_refills_day, count: Number(row.ad_refills_count ?? 0) }
}

/** What the energy transaction did: written or not, the record, and what a spend carried. */
interface EnergyWritten {
  written: boolean
  record: EnergyRecord
  carried?: GearInstance[]
}

/** `createLinked`'s rollback when the user was linked meanwhile (not an error to anyone outside). */
class LinkTaken extends Error {}

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
export class PgAccountStore implements AccountStore, GearStore, StashEdits, AdminStore, FirstRunStore, PortalStore, AdRefillStore {
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
    return await this.readAccount('UPDATE accounts SET last_seen_at = now() WHERE token_hash = $1 RETURNING id, public_id', [hashToken(token)])
  }

  /**
   * One round trip: the account `found` names (a CTE giving `id, public_id`,
   * touching `last_seen_at`), its XP (no progress row yet reads as 0), its
   * saved loadouts (none reads as []), its energy (none reads as null), its
   * first run (no row reads as not done, migration 8), its first portal
   * link (none: no `portal`, migration 10) and its ad refills (none ever: no
   * `adRefill`, migration 11).
   */
  private async readAccount (found: string, params: unknown[]): Promise<Account | null> {
    const result = await this.pool.query(
      `WITH a AS (${found})
       SELECT a.public_id, COALESCE(p.xp, 0) AS xp, en.stock, round(extract(epoch FROM en.as_of) * 1000)::bigint AS as_of_ms,
         ${AD_REFILL_COLUMNS},
         EXISTS (SELECT 1 FROM first_runs f WHERE f.account_id = a.id) AS first_run_done,
         (SELECT k.portal FROM account_links k WHERE k.account_id = a.id ORDER BY k.linked_at, k.portal LIMIT 1) AS portal,
         COALESCE((SELECT json_agg(json_build_object('robot', l.robot, 'index', l.slot_index, 'skills', l.skills) ORDER BY l.robot, l.slot_index)
                   FROM loadouts l WHERE l.account_id = a.id), '[]'::json) AS loadouts
       FROM a LEFT JOIN account_progress p ON p.account_id = a.id LEFT JOIN energy en ON en.account_id = a.id`,
      params
    )
    const row = result.rows[0] as ({ public_id: string, xp: string | number, loadouts: StoredLoadout[], stock: number | null, as_of_ms: string | null, first_run_done: boolean, portal: string | null } & AdRefillRow) | undefined
    if (row === undefined) return null
    // Raw as stored: `kitFor` checks every row at the join.
    const loadouts = Array.isArray(row.loadouts) ? row.loadouts.map((l) => ({ robot: l.robot, index: Number(l.index), skills: l.skills })) : []
    const energy = row.stock === null || row.as_of_ms === null ? null : { stock: Number(row.stock), asOfMs: Number(row.as_of_ms) }
    const account: Account = { publicId: row.public_id, persisted: true, xp: Number(row.xp), loadouts, energy, firstRunDone: row.first_run_done === true }
    if (row.portal !== null) account.portal = row.portal
    const ads = adRefillOfRow(row)
    if (ads !== null) account.adRefill = ads
    return account
  }

  // --- rewarded-video refills (g2-6d, migration 11; contract on `AdRefillStore`) --

  /**
   * One transaction holding the energy row (`FOR UPDATE`, after the same
   * start-stock insert as a spend), so a refill and a spend, or two refills,
   * never interleave. Refused: rolled back, nothing written.
   */
  async adRefill (publicId: string, nowMs: number): Promise<AdRefilled> {
    this.checkOpen()
    return await this.tracked(this.adRefillWrite(publicId, nowMs))
  }

  private async adRefillWrite (publicId: string, nowMs: number): Promise<AdRefilled> {
    const client: PoolClient = await this.pool.connect()
    const onError = (e: unknown): void => { this.onError(e) }
    client.on('error', onError)
    let failed: Error | undefined
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO energy (account_id, stock, as_of)
         SELECT id, $2, to_timestamp($3::double precision / 1000.0) FROM accounts WHERE public_id = $1
         ON CONFLICT (account_id) DO NOTHING`,
        [publicId, ENERGY.start, nowMs]
      )
      const found = await client.query(
        `SELECT en.account_id, en.stock, round(extract(epoch FROM en.as_of) * 1000)::bigint AS as_of_ms, ${AD_REFILL_COLUMNS}
         FROM energy en JOIN accounts a ON a.id = en.account_id WHERE a.public_id = $1 FOR UPDATE OF en`,
        [publicId]
      )
      const row = found.rows[0] as ({ account_id: string, stock: number, as_of_ms: string } & AdRefillRow) | undefined
      if (row === undefined) throw new Error('accounts: refill for an unknown account')
      const stored = { stock: Number(row.stock), asOfMs: Number(row.as_of_ms) }
      const ads = adRefillOfRow(row)
      const result = adRefillAt(stored, ads, nowMs)
      if (!result.ok) {
        await client.query('ROLLBACK')
        return { ok: false, reason: result.reason, energy: result.energy, adRefill: ads }
      }
      await client.query(
        `UPDATE energy SET stock = $2, as_of = to_timestamp($3::double precision / 1000.0),
           ad_refill_at = to_timestamp($4::double precision / 1000.0), ad_refills_day = $5::date, ad_refills_count = $6, updated_at = now()
         WHERE account_id = $1`,
        [row.account_id, result.energy.stock, result.energy.asOfMs, result.ads.lastAtMs, result.ads.day, result.ads.count]
      )
      await client.query('COMMIT')
      return { ok: true, energy: result.energy, adRefill: result.ads }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      failed = e instanceof Error ? e : new Error(String(e))
      throw e
    } finally {
      client.removeListener('error', onError)
      client.release(failed)
    }
  }

  // --- portal accounts (g2-6b, migration 10; contract on `PortalStore`) --------

  async resolvePortal (portal: string, externalId: string): Promise<Account | null> {
    if (!this.ready) throw new NotReadyError()
    return await this.readAccount(
      `UPDATE accounts SET last_seen_at = now()
       WHERE id = (SELECT account_id FROM account_links WHERE portal = $1 AND external_id = $2) RETURNING id, public_id`,
      [portal, externalId]
    )
  }

  /**
   * One insert that either unique key can refuse (`ON CONFLICT DO NOTHING`
   * covers both): of two links racing for one user or one account, one row
   * lands and the other reads the row that won. Throws for an unknown account.
   */
  async linkPortal (portal: string, externalId: string, publicId: string): Promise<'linked' | 'taken'> {
    this.checkOpen()
    const result = await this.tracked(this.pool.query(
      `WITH a AS (SELECT id FROM accounts WHERE public_id = $3),
       i AS (INSERT INTO account_links (portal, external_id, account_id) SELECT $1, $2, id FROM a ON CONFLICT DO NOTHING RETURNING account_id)
       SELECT (SELECT count(*)::int FROM a) AS known, (SELECT count(*)::int FROM i) AS inserted`,
      [portal, externalId, publicId]
    ))
    const row = result.rows[0] as { known: number, inserted: number }
    if (row.known !== 1) throw new Error('accounts: link for an unknown account')
    if (row.inserted === 1) return 'linked'
    // Refused: already this link (idempotent), or another account's user or another user's account.
    const held = await this.pool.query(
      `SELECT 1 FROM account_links k JOIN accounts a ON a.id = k.account_id
       WHERE k.portal = $1 AND k.external_id = $2 AND a.public_id = $3`,
      [portal, externalId, publicId]
    )
    return held.rows.length === 1 ? 'linked' : 'taken'
  }

  async linkedPortal (publicId: string): Promise<string | null> {
    if (!this.ready) throw new NotReadyError()
    const result = await this.pool.query(
      `SELECT k.portal FROM account_links k JOIN accounts a ON a.id = k.account_id
       WHERE a.public_id = $1 ORDER BY k.linked_at, k.portal LIMIT 1`,
      [publicId]
    )
    return (result.rows[0] as { portal: string } | undefined)?.portal ?? null
  }

  /**
   * The account and its link in one transaction. A user linked meanwhile (the
   * link's primary key; a racing insert is waited on) rolls the new account
   * back, and the account that won is returned.
   */
  async createLinked (portal: string, externalId: string): Promise<Account> {
    this.checkOpen()
    for (let attempt = 1; ; attempt++) {
      let created: Account | null
      try {
        created = await this.tracked(this.transaction(async (client) => {
          const publicId = newPublicId()
          // A random token's hash, never returned: `token_hash` is NOT NULL UNIQUE.
          const made = await client.query('INSERT INTO accounts (public_id, token_hash) VALUES ($1, $2) RETURNING id', [publicId, hashToken(newToken())])
          const linked = await client.query(
            'INSERT INTO account_links (portal, external_id, account_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING account_id',
            [portal, externalId, (made.rows[0] as { id: string }).id]
          )
          if (linked.rows.length === 0) throw new LinkTaken()
          return { publicId, persisted: true, xp: 0, loadouts: [], energy: null, firstRunDone: false, portal }
        }))
      } catch (e) {
        if (e instanceof LinkTaken) created = null
        else if ((e as { code?: string }).code === '23505' && attempt < 3) continue
        else throw e
      }
      if (created !== null) return created
      const winner = await this.resolvePortal(portal, externalId)
      if (winner !== null) return winner
      if (attempt >= 3) throw new Error('accounts: portal link kept changing')
    }
  }

  /**
   * One statement: the `first_runs` row, unless there is one (the first
   * `done_at` stays). Counts the account, not the insert, so a second call
   * succeeds and an unknown public id throws. `close` waits for it.
   */
  async finishFirstRun (publicId: string, nowMs: number): Promise<void> {
    this.checkOpen()
    const result = await this.tracked(this.pool.query(
      `WITH a AS (SELECT id FROM accounts WHERE public_id = $1),
       i AS (INSERT INTO first_runs (account_id, done_at) SELECT id, to_timestamp($2::double precision / 1000) FROM a ON CONFLICT (account_id) DO NOTHING)
       SELECT count(*)::int AS n FROM a`,
      [publicId, nowMs]
    ))
    if ((result.rows[0] as { n: number }).n !== 1) throw new Error('accounts: first run for an unknown account')
  }

  async spend (publicId: string, nowMs: number, bring?: Bring): Promise<Spent> {
    if (bring !== undefined) checkHolder(bring.holder)
    const { written, record, carried } = await this.energyTx(publicId, nowMs, (stored) => {
      const spent = spendAt(stored, nowMs)
      return spent.ok ? spent.record : undefined
    }, bring)
    return bring === undefined ? { ok: written, energy: record } : { ok: written, energy: record, carried: carried ?? [] }
  }

  async refund (publicId: string, nowMs: number): Promise<EnergyRecord> {
    return (await this.energyTx(publicId, nowMs, (stored) => refundAt(stored, nowMs))).record
  }

  private async energyTx (publicId: string, nowMs: number, change: (record: EnergyRecord) => EnergyRecord | undefined, bring?: Bring): Promise<EnergyWritten> {
    this.checkOpen()
    return await this.tracked(this.energyWrite(publicId, nowMs, change, bring))
  }

  /** `pending` as a write `close` waits for (callers run `checkOpen` first). */
  private async tracked<T> (pending: Promise<T>): Promise<T> {
    this.grants.add(pending)
    try {
      return await pending
    } finally {
      this.grants.delete(pending)
    }
  }

  private checkOpen (): void {
    if (!this.ready) throw new NotReadyError()
    if (this.closed) throw new Error('accounts: store closed')
  }

  /**
   * `fn` in one transaction on its own client: committed if it returns,
   * rolled back if it throws (and the client dropped, not pooled).
   */
  private async transaction<T> (fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect()
    const onError = (e: unknown): void => { this.onError(e) }
    client.on('error', onError)
    let failed: Error | undefined
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      failed = e instanceof Error ? e : new Error(String(e))
      throw e
    } finally {
      client.removeListener('error', onError)
      client.release(failed)
    }
  }

  private async energyWrite (publicId: string, nowMs: number, change: (record: EnergyRecord) => EnergyRecord | undefined, bring?: Bring): Promise<EnergyWritten> {
    // Checked before anything is sent: a bad id would fail the cast inside the transaction.
    const ids = bring === undefined ? [] : rowIdsOf(bring.ids)
    const client: PoolClient = await this.pool.connect()
    const onError = (e: unknown): void => { this.onError(e) }
    client.on('error', onError)
    let failed: Error | undefined
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO energy (account_id, stock, as_of)
         SELECT id, $2, to_timestamp($3::double precision / 1000.0) FROM accounts WHERE public_id = $1
         ON CONFLICT (account_id) DO NOTHING`,
        [publicId, ENERGY.start, nowMs]
      )
      const found = await client.query(
        `SELECT e.account_id, e.stock, round(extract(epoch FROM e.as_of) * 1000)::bigint AS as_of_ms
         FROM energy e JOIN accounts a ON a.id = e.account_id WHERE a.public_id = $1 FOR UPDATE OF e`,
        [publicId]
      )
      const row = found.rows[0] as { account_id: string, stock: number, as_of_ms: string } | undefined
      if (row === undefined) throw new Error('accounts: energy for an unknown account')
      const stored = { stock: Number(row.stock), asOfMs: Number(row.as_of_ms) }
      const next = change(stored)
      if (next === undefined) {
        await client.query('ROLLBACK')
        return { written: false, record: energyAt(stored, nowMs) }
      }
      await client.query(
        'UPDATE energy SET stock = $2, as_of = to_timestamp($3::double precision / 1000.0), updated_at = now() WHERE account_id = $1',
        [row.account_id, next.stock, next.asOfMs]
      )
      // The carry (decision #49), in the spend's transaction: conditional on
      // stashed, so of two tabs bringing one item only one gets it (the
      // other's UPDATE waits on the row lock, re-checks `state = 0` and skips).
      let carried: GearInstance[] | undefined
      if (bring !== undefined && ids.length > 0) {
        const moved = await client.query(
          `UPDATE stash_items SET state = 1, holder = $3::uuid, carried_at = now()
           WHERE id = ANY($2::bigint[]) AND account_id = $1 AND state = 0 AND skill > 0
           RETURNING ${STASH_COLUMNS}`,
          [row.account_id, ids, bring.holder]
        )
        carried = (moved.rows as StashRowSql[]).map((r) => instanceOfRow(r)).sort(byRowId)
      }
      await client.query('COMMIT')
      return { written: true, record: next, carried }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      failed = e instanceof Error ? e : new Error(String(e))
      throw e
    } finally {
      client.removeListener('error', onError)
      client.release(failed)
    }
  }

  // --- the gear stash (decision #49, task 49-3; contract on `GearStore`) -------

  /** The account's internal id, inside a transaction; throws for an unknown public id. */
  private async accountId (client: PoolClient, publicId: string, what: string): Promise<string> {
    const found = await client.query('SELECT id::text AS id FROM accounts WHERE public_id = $1', [publicId])
    const row = found.rows[0] as { id: string } | undefined
    if (row === undefined) throw new Error(`accounts: ${what} for an unknown account`)
    return row.id
  }

  private async stashOf (client: PoolClient, accountId: string): Promise<StashItem[]> {
    const rows = await client.query(`SELECT ${STASH_COLUMNS} FROM stash_items WHERE account_id = $1 ORDER BY id`, [accountId])
    return (rows.rows as StashRowSql[]).map((r) => stashItemOfRow(r))
  }

  /**
   * The stale return, then the account's rows, in one transaction. Not folded
   * into `resolve`: a data-modifying CTE's effect isn't visible to the same
   * statement's SELECT, so the rows read would be from before the return.
   */
  async loadStash (publicId: string): Promise<StashItem[]> {
    this.checkOpen()
    return await this.tracked(this.transaction(async (client) => {
      const account = await this.accountId(client, publicId, 'stash')
      await client.query(
        `UPDATE stash_items SET state = 0, holder = NULL, carried_at = NULL
         WHERE account_id = $1 AND state = 1
           AND holder NOT IN (SELECT holder FROM gear_holders WHERE seen_at > now() - $2::double precision * interval '1 millisecond')`,
        [account, STALE_CARRY_MS]
      )
      return await this.stashOf(client, account)
    }))
  }

  async settleGear (publicId: string, holder: string, keep: readonly string[], found: readonly GearInstance[]): Promise<Settled> {
    this.checkOpen()
    checkHolder(holder)
    const { keepIds, insert } = splitFound(keep, found)
    return await this.tracked(this.transaction(async (client) => {
      const account = await this.accountId(client, publicId, 'settle')
      // One settle per account at a time, so the count below is never stale:
      // two settles at the cap can't both see room (race 11). Advisory, not a
      // row lock on `accounts`, which `resolve`'s last_seen_at UPDATE would
      // queue behind. The two-int key space is separate from the one-bigint
      // space of SEASON_LOCK and MIGRATION_LOCK; accounts whose ids collide
      // modulo 2^31 - 1 only wait for each other.
      await client.query('SELECT pg_advisory_xact_lock($1::int, ($2::bigint % 2147483647)::int)', [STASH_LOCK_CLASS, account])
      let kept: string[] = []
      if (keepIds.length > 0) {
        const moved = await client.query(
          `UPDATE stash_items SET account_id = $1, state = 0, holder = NULL, carried_at = NULL
           WHERE id = ANY($2::bigint[]) AND state = 1 AND holder = $3::uuid
           RETURNING id::text AS id`,
          [account, keepIds, holder]
        )
        kept = (moved.rows as Array<{ id: string }>).map((r) => r.id).sort((a, b) => byRowId({ rowId: a }, { rowId: b }))
      }
      let inserted = 0
      if (insert.length > 0) {
        const added = await client.query(
          `INSERT INTO stash_items (account_id, tier, skill, rolls, source)
           SELECT $1::bigint, f.tier, f.skill, f.rolls::smallint[], $5::smallint
           FROM unnest($2::smallint[], $3::smallint[], $4::text[]) WITH ORDINALITY AS f(tier, skill, rolls, n)
           ORDER BY f.n
           LIMIT GREATEST(0, $6::bigint - (SELECT count(*) FROM stash_items WHERE account_id = $1::bigint))`,
          [account, insert.map((i) => i.tier), insert.map((i) => i.skill), insert.map((i) => `{${flatRolls(i.rolls).join(',')}}`), GEAR_SOURCE.found, STASH_MAX]
        )
        inserted = added.rowCount ?? 0
      }
      return { kept, inserted, stash: await this.stashOf(client, account) }
    }))
  }

  /**
   * Merge (49-5) in one transaction: the 3 rows locked (`FOR UPDATE`, in id
   * order) only if this account's and stashed. A carry of one of them either
   * committed first (the row is `state = 1` once the lock is ours, so fewer
   * than 3 rows come back and the merge is refused) or waits on the lock,
   * re-checks `state = 0` after the delete and skips it (race 2).
   */
  async mergeGear (publicId: string, ids: readonly string[], rule: MergeRule): Promise<Merged> {
    this.checkOpen()
    const wanted = mergeIdsOf(ids)
    return await this.tracked(this.transaction(async (client) => {
      const account = await this.accountId(client, publicId, 'merge')
      if (wanted === undefined) return { item: null, stash: await this.stashOf(client, account) }
      const locked = await client.query(
        `SELECT ${STASH_COLUMNS} FROM stash_items
         WHERE id = ANY($2::bigint[]) AND account_id = $1 AND state = 0
         ORDER BY id FOR UPDATE`,
        [account, wanted]
      )
      const byId = new Map((locked.rows as StashRowSql[]).map((r) => [r.id, stashItemOfRow(r)]))
      const inputs = wanted.map((id) => byId.get(id))
      const outcome = inputs.every((i) => i !== undefined) ? rule(inputs as StashItem[]) : null
      if (outcome === null || !storable(outcome)) return { item: null, stash: await this.stashOf(client, account) }
      const deleted = await client.query(
        'DELETE FROM stash_items WHERE id = ANY($2::bigint[]) AND account_id = $1 AND state = 0',
        [account, wanted]
      )
      // Held under our locks since the SELECT, so all 3 go; anything else is a bug, and rolls back.
      if (deleted.rowCount !== 3) throw new Error('accounts: a merge deleted other than its 3 rows')
      const added = await client.query(
        `INSERT INTO stash_items (account_id, tier, skill, rolls, source)
         VALUES ($1, $2, $3, $4::smallint[], $5) RETURNING ${STASH_COLUMNS}`,
        [account, outcome.tier, outcome.skill, `{${flatRolls(outcome.rolls).join(',')}}`, GEAR_SOURCE.merged]
      )
      return { item: stashItemOfRow(added.rows[0] as StashRowSql), stash: await this.stashOf(client, account) }
    }))
  }

  /** Scrap (49-5): one conditional delete, stashed rows of this account only. */
  async scrapGear (publicId: string, id: string): Promise<Scrapped> {
    this.checkOpen()
    const ids = rowIdsOf([id])
    return await this.tracked(this.transaction(async (client) => {
      const account = await this.accountId(client, publicId, 'scrap')
      let ok = false
      if (ids.length === 1) {
        const deleted = await client.query('DELETE FROM stash_items WHERE id = $2::bigint AND account_id = $1 AND state = 0', [account, ids[0]])
        ok = deleted.rowCount === 1
      }
      return { ok, stash: await this.stashOf(client, account) }
    }))
  }

  async discardGear (holder: string, rowIds: readonly string[]): Promise<number> {
    return await this.whereCarried(holder, rowIds, 'DELETE FROM stash_items')
  }

  async uncarry (holder: string, rowIds: readonly string[]): Promise<number> {
    return await this.whereCarried(holder, rowIds, 'UPDATE stash_items SET state = 0, holder = NULL, carried_at = NULL')
  }

  /** `statement` on the rows among `rowIds` that `holder` carries; how many. */
  private async whereCarried (holder: string, rowIds: readonly string[], statement: string): Promise<number> {
    this.checkOpen()
    checkHolder(holder)
    const ids = rowIdsOf(rowIds)
    if (ids.length === 0) return 0
    const result = await this.tracked(this.pool.query(
      `${statement} WHERE id = ANY($1::bigint[]) AND state = 1 AND holder = $2::uuid`,
      [ids, holder]
    ))
    return result.rowCount ?? 0
  }

  async heartbeat (holder: string, held: readonly string[]): Promise<number> {
    this.checkOpen()
    checkHolder(holder)
    const spared = rowIdsOf(held)
    return await this.tracked(this.transaction(async (client) => {
      await client.query(
        'INSERT INTO gear_holders (holder, seen_at) VALUES ($1::uuid, now()) ON CONFLICT (holder) DO UPDATE SET seen_at = now()',
        [holder]
      )
      const returned = await client.query(
        `UPDATE stash_items SET state = 0, holder = NULL, carried_at = NULL
         WHERE holder = $1::uuid AND state = 1 AND carried_at < now() - $3::double precision * interval '1 millisecond'
           AND id <> ALL($2::bigint[])`,
        [holder, spared, RECONCILE_AFTER_MS]
      )
      // Holders a day silent: they already read as dead (STALE_CARRY_MS), so
      // forgetting them changes nothing but the table's size.
      await client.query("DELETE FROM gear_holders WHERE seen_at < now() - interval '1 day'")
      return returned.rowCount ?? 0
    }))
  }

  async releaseHolder (holder: string): Promise<number> {
    this.checkOpen()
    checkHolder(holder)
    return await this.tracked(this.transaction(async (client) => {
      const returned = await client.query(
        'UPDATE stash_items SET state = 0, holder = NULL, carried_at = NULL WHERE holder = $1::uuid AND state = 1',
        [holder]
      )
      await client.query('DELETE FROM gear_holders WHERE holder = $1::uuid', [holder])
      return returned.rowCount ?? 0
    }))
  }

  // --- /admin (decision #50; contract on `AdminStore`) --------------------------

  /** One read: XP, the stored energy row, and the counts. Not tracked: it writes nothing. */
  async adminRead (publicId: string): Promise<AdminAccount | null> {
    this.checkOpen()
    const result = await this.pool.query(
      `SELECT a.public_id, COALESCE(p.xp, 0) AS xp, en.stock, round(extract(epoch FROM en.as_of) * 1000)::bigint AS as_of_ms,
         (SELECT count(*) FROM loadouts l WHERE l.account_id = a.id) AS loadouts,
         (SELECT count(*) FROM stash_items s WHERE s.account_id = a.id AND s.state = 0) AS stashed,
         (SELECT count(*) FROM stash_items s WHERE s.account_id = a.id AND s.state = 1) AS away
       FROM accounts a LEFT JOIN account_progress p ON p.account_id = a.id LEFT JOIN energy en ON en.account_id = a.id
       WHERE a.public_id = $1`,
      [publicId]
    )
    const row = result.rows[0] as { public_id: string, xp: string, stock: number | null, as_of_ms: string | null, loadouts: string, stashed: string, away: string } | undefined
    if (row === undefined) return null
    return {
      publicId: row.public_id,
      xp: Number(row.xp),
      energy: row.stock === null || row.as_of_ms === null ? null : { stock: Number(row.stock), asOfMs: Number(row.as_of_ms) },
      loadouts: Number(row.loadouts),
      stashed: Number(row.stashed),
      away: Number(row.away)
    }
  }

  /** One upsert, as `grant`'s, but setting the total. */
  async adminSetXp (publicId: string, xp: number): Promise<number | null> {
    this.checkOpen()
    const result = await this.tracked(this.pool.query(
      `INSERT INTO account_progress (account_id, xp)
       SELECT id, $2 FROM accounts WHERE public_id = $1
       ON CONFLICT (account_id) DO UPDATE SET xp = EXCLUDED.xp, updated_at = now()
       RETURNING xp`,
      [publicId, xp]
    ))
    const row = result.rows[0] as { xp: string | number } | undefined
    return row === undefined ? null : Number(row.xp)
  }

  /** One upsert; a spend holding the row (`FOR UPDATE`) makes it wait, so neither is lost half-way. */
  async adminSetEnergy (publicId: string, stock: number, nowMs: number): Promise<EnergyRecord | null> {
    this.checkOpen()
    const result = await this.tracked(this.pool.query(
      `INSERT INTO energy (account_id, stock, as_of)
       SELECT id, $2, to_timestamp($3::double precision / 1000.0) FROM accounts WHERE public_id = $1
       ON CONFLICT (account_id) DO UPDATE SET stock = EXCLUDED.stock, as_of = EXCLUDED.as_of, updated_at = now()
       RETURNING stock, round(extract(epoch FROM as_of) * 1000)::bigint AS as_of_ms`,
      [publicId, stock, nowMs]
    ))
    const row = result.rows[0] as { stock: number, as_of_ms: string } | undefined
    return row === undefined ? null : { stock: Number(row.stock), asOfMs: Number(row.as_of_ms) }
  }

  /** One transaction under `settleGear`'s per-account lock: count, then insert all or none. */
  async adminGrantGear (publicId: string, items: readonly GearInstance[]): Promise<AdminGranted | null> {
    this.checkOpen()
    if (!items.every((item) => storable(item))) throw new Error('accounts: an admin item is not storable')
    return await this.tracked(this.transaction(async (client) => {
      const found = await client.query('SELECT id::text AS id FROM accounts WHERE public_id = $1', [publicId])
      const account = (found.rows[0] as { id: string } | undefined)?.id
      if (account === undefined) return null
      await client.query('SELECT pg_advisory_xact_lock($1::int, ($2::bigint % 2147483647)::int)', [STASH_LOCK_CLASS, account])
      const counted = await client.query('SELECT count(*) AS n FROM stash_items WHERE account_id = $1', [account])
      const room = Math.max(0, STASH_MAX - Number((counted.rows[0] as { n: string }).n))
      if (items.length > room) return { inserted: 0, room, stash: await this.stashOf(client, account) }
      let inserted = 0
      if (items.length > 0) {
        const added = await client.query(
          `INSERT INTO stash_items (account_id, tier, skill, rolls, source)
           SELECT $1::bigint, f.tier, f.skill, f.rolls::smallint[], $5::smallint
           FROM unnest($2::smallint[], $3::smallint[], $4::text[]) WITH ORDINALITY AS f(tier, skill, rolls, n)
           ORDER BY f.n`,
          [account, items.map((i) => i.tier), items.map((i) => i.skill), items.map((i) => `{${flatRolls(i.rolls).join(',')}}`), GEAR_SOURCE.admin]
        )
        inserted = added.rowCount ?? 0
      }
      return { inserted, room, stash: await this.stashOf(client, account) }
    }))
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
        return { account: { publicId, persisted: true, xp: 0, loadouts: [], energy: null, firstRunDone: false }, token }
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
      `SELECT DISTINCT to_char(e.season_start, 'YYYY-MM-DD') AS start FROM season_entries e
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
