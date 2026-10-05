import { createHash, randomBytes } from 'node:crypto'
import { type EnergyRecord, refundAt, spendAt } from '../progress/energy'
import { type GearInstance, type GearRoll, type GearTier, Q_MAX, STASH_MAX } from '../utils/gear'
import {
  compareEntries, dueStarts, eligible, type LastPayout, type PaidSeason, type SeasonBoard, type SeasonCredit,
  type SeasonEntry, seasonEndMs, seasonPayouts, seasonStart, type SeasonView, seasonView, tierPlaces
} from '../progress/seasons'

/**
 * Guest accounts (decision #48, step 1). The server issues each new player a
 * random secret token on first play; the client keeps it in localStorage and
 * sends it in the socket.io handshake. The player id is the account's
 * `publicId`, never anything the client says.
 *
 * Fail open, no grants: a database that is down, slow or not yet migrated
 * never stops anyone playing. Such a connection gets an offline account
 * (`offlineAccount`), which writes no Redis stats and is sent no token
 * (`Worlds`).
 */
export interface Account {
  /** 16 lowercase hex digits: the player id (Redis keys, /stats, GA `client_id`). */
  publicId: string
  /** False for an offline account: made up for one connection while the store failed. */
  persisted: boolean
  /**
   * Total XP (decision #48 step 3) when the account was looked up, created or
   * last granted; 0 for an offline account, which earns nothing. The level is
   * derived from it (`progress/xp.ts`), never stored.
   */
  xp: number
  /**
   * Saved skill loadouts (decision #48 step 4), raw as stored: nothing here
   * is trusted. Every join checks the row again (`progress/loadouts.ts`
   * `kitFor`), because a level is derived from XP and a curve change can lock
   * what was valid when saved. `[]` for a new or offline account.
   */
  loadouts: StoredLoadout[]
  /**
   * The play stock (decision #48 step 7) as last read or written, `null` for
   * an account with no row yet (it reads as `ENERGY.start`) and for an
   * offline account, which spends nothing. Regenerated lazily
   * (`progress/energy.ts`); the store's is the truth, this is for showing.
   */
  energy: EnergyRecord | null
}

/** One saved loadout: a robot's key, its loadout index, and 4 skill ids. */
export interface StoredLoadout {
  robot: string
  index: number
  skills: number[]
}

export interface AccountStore {
  /** The account whose token this is, `null` for none. Throws when the store fails. */
  resolve: (token: string) => Promise<Account | null>
  /** A new account and its token, which is never stored. Throws when the store fails. */
  create: () => Promise<{ account: Account, token: string }>
  /**
   * Add `xp` to the account's total in one atomic step and return the new
   * total. Throws when the store fails or knows no such account. Never
   * retried by the caller: a failed grant is logged, not carried into the
   * next run.
   *
   * With `credit` (decision #48 step 6), the same atomic step adds the run to
   * the account's entry in `credit.season`: banked, one run, the extraction
   * and the XP, and `bankedAt = credit.atMs` when it banked. A season already
   * paid gets no entry, but the XP still lands. The cap is the caller's
   * (`creditOf`); the store stores.
   */
  grant: (publicId: string, xp: number, credit?: SeasonCredit) => Promise<number>
  /** The account's view of the season holding `atMs` (zeros and no rank without an entry). Throws when the store fails. */
  season: (publicId: string, atMs: number) => Promise<SeasonView>
  /** The season holding `atMs`: its ranked count, places and top `limit` by `compareEntries`. */
  seasonBoard: (atMs: number, limit: number) => Promise<SeasonBoard>
  /**
   * Pay every season `dueStarts(nowMs)` lists that has entries and isn't paid
   * yet, oldest first, each at most once however many servers call this at
   * once; return what this call paid.
   */
  payDue: (nowMs: number) => Promise<PaidSeason[]>
  /**
   * Store `skills` as the account's loadout `index` for `robot`, replacing
   * any there (one upsert). Validation is the caller's (`Worlds`, through
   * `checkLoadout`); the store stores. Throws when the store fails or knows
   * no such account.
   */
  saveLoadout: (publicId: string, robot: string, index: number, skills: number[]) => Promise<void>
  /**
   * Spend one play at `nowMs` (decision #48 step 7, `spendAt`), as one atomic
   * check-and-spend: two starts at once with one play left get one run.
   * `ok: false` (nothing written) with none left; either way the record as
   * it now stands. Throws when the store fails or knows no such account.
   *
   * With `bring` (decision #49, 49-3), a spend that succeeds also carries, in
   * the same atomic step, those of `bring.ids` that are the account's,
   * stashed and not parts: they become carried by `bring.holder` and come
   * back in `carried` (with their `rowId`s, in id order). Fewer than asked is
   * normal (another tab took one, or it was merged); a refused spend carries
   * nothing (`carried: []`). Without `bring` the result has no `carried`.
   */
  spend: (publicId: string, nowMs: number, bring?: Bring) => Promise<Spent>
  /** Give one play back at `nowMs` (`refundAt`), atomically; the record after. Throws as `spend`. */
  refund: (publicId: string, nowMs: number) => Promise<EnergyRecord>
  /** Waits for grants and saves in flight, then lets go of the store. */
  close: () => Promise<void>
}

/** What `AccountStore.spend` answers. `carried` only when the spend was asked to bring gear. */
export interface Spent {
  ok: boolean
  energy: EnergyRecord
  carried?: GearInstance[]
}

/** Gear to carry into a run with a spend (decision #49): stash row ids and the carrying process's boot id. */
export interface Bring {
  ids: readonly string[]
  holder: string
}

/**
 * The gear stash (decision #49, task 49-3). **Not part of `AccountStore` on
 * purpose:** several specs outside `db/` implement `AccountStore` as
 * wrappers, and ts-node type-checks a spec when it loads it, so required
 * methods added there would stop those specs loading. Both stores implement
 * both; 49-4 joins them where `Worlds` needs them.
 *
 * **The invariant every method serves:** a row is stashed or carried, and a
 * carried row names the process (`holder`, a `GearLedger`'s boot id) whose
 * memory may hold its in-world copy. A lineage instance (one with a `rowId`)
 * only ever moves or deletes its own row, conditionally on carried by this
 * holder; it is never inserted. Only rowless (found) instances are inserted,
 * once, at the run's end. Under that rule no failure, timeout or race makes
 * two rows of one item: the worst case is an item lost, or returned to its
 * last owner.
 *
 * Every write is waited for by `close` and bounded by the caller, as every
 * store call is. Times are the store's own clock (pg's `now()`).
 */
export interface GearStore {
  /**
   * The account's stash, every row (stashed and carried) in id order, after
   * first returning to the stash, in the same transaction, every carried row
   * of the account whose holder hasn't heartbeat within `STALE_CARRY_MS` (a
   * crashed or vanished process). Throws for an unknown account.
   */
  loadStash: (publicId: string) => Promise<StashItem[]>
  /**
   * A run's end, in one transaction: every `keep` row carried by `holder`
   * becomes the account's and stashed (its own brought-in items back, and
   * someone else's it picked up transferred), then the rowless `found`
   * instances are inserted (source 1) only while the account holds fewer
   * than `STASH_MAX` rows of either state, counted in the same transaction
   * under a per-account lock. A `found` instance that has a `rowId` is a
   * lineage item and is treated as a keep, never inserted. Throws for an
   * unknown account (nothing written).
   */
  settleGear: (publicId: string, holder: string, keep: readonly string[], found: readonly GearInstance[]) => Promise<Settled>
  /** Delete the rows carried by `holder` among `rowIds` (a death's loss, an expired drop); how many went. */
  discardGear: (holder: string, rowIds: readonly string[]) => Promise<number>
  /** Back to stashed, the rows carried by `holder` among `rowIds` (a run paid for that never began); how many. */
  uncarry: (holder: string, rowIds: readonly string[]) => Promise<number>
  /**
   * `holder` is alive (upsert of its heartbeat), then reconcile: its carried
   * rows not in `held` and carried more than `RECONCILE_AFTER_MS` ago go back
   * to stashed (a settle that timed out, a carry given up). How many did.
   */
  heartbeat: (holder: string, held: readonly string[]) => Promise<number>
  /** A clean exit: every row `holder` carries back to stashed, and its heartbeat forgotten. How many rows. */
  releaseHolder: (holder: string) => Promise<number>
}

/** One stash row as `loadStash` and `settleGear` give it: the instance, its row id, its state and source. */
export interface StashItem extends GearInstance {
  readonly rowId: string
  readonly carried: boolean
  readonly source: number
}

/** What a run's end did: the keep rows moved (id order), how many found items went in, and the stash after. */
export interface Settled {
  kept: string[]
  inserted: number
  stash: StashItem[]
}

/** `stash_items.source`. **Append-only**, like field indices. */
export const GEAR_SOURCE = Object.freeze({ found: 1, merged: 2 })

/**
 * How long after its holder's last heartbeat a carried row is returned to
 * the stash (at its owner's next `loadStash`). The spec's 15 minutes,
 * measured from the **holder's last heartbeat**, never from the carry: from
 * the carry, a run longer than 15 minutes would have its brought-in item
 * returned while still in the world, then brought into a second run
 * (Archie's reading, told to Nick, #49 build plan).
 */
export const STALE_CARRY_MS = 15 * 60_000

/**
 * A heartbeat's reconcile spares rows carried less than this long ago: a
 * carry issued after the heartbeat's snapshot of `held` (49-3 rule 2).
 */
export const RECONCILE_AFTER_MS = 2 * 60_000

/** A stash row id as a store gives it: a positive bigint in decimal. Anything else names no row. */
export const ROW_ID_SHAPE = /^[1-9][0-9]{0,17}$/

/** A holder (boot id): a lowercase UUID, as `randomUUID` makes it (pg's `uuid` column). */
export const HOLDER_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The distinct well-formed row ids in `ids`, first appearance first; the rest name no row. */
export function rowIdsOf (ids: readonly unknown[]): string[] {
  const out = new Set<string>()
  for (const id of ids) if (typeof id === 'string' && ROW_ID_SHAPE.test(id)) out.add(id)
  return [...out]
}

/** Throws unless `holder` has the boot id's shape (both stores alike; pg would reject it as a uuid). */
export function checkHolder (holder: string): void {
  if (typeof holder !== 'string' || !HOLDER_SHAPE.test(holder)) throw new Error('gear: malformed holder')
}

/**
 * Whether `item` fits a stash row: tier 1-3, skill 0-255, at most 8 rolls of
 * whole stats 0-255 and qualities 0..1000. A found item that doesn't is
 * dropped by `settleGear` (both stores alike) rather than failing the
 * transaction, which would also undo the run's keeps.
 */
export function storable (item: GearInstance): boolean {
  if (item === null || typeof item !== 'object') return false
  if (!Number.isInteger(item.tier) || item.tier < 1 || item.tier > 3) return false
  if (!Number.isInteger(item.skill) || item.skill < 0 || item.skill > 255) return false
  if (!Array.isArray(item.rolls) || item.rolls.length > 8) return false
  return item.rolls.every((r) => r !== null && typeof r === 'object' &&
    Number.isInteger(r.stat) && r.stat >= 0 && r.stat <= 255 && Number.isInteger(r.q) && r.q >= 0 && r.q <= Q_MAX)
}

/** Rolls as the `rolls` column holds them: flat `[stat, q, stat, q]`. */
export function flatRolls (rolls: readonly GearRoll[]): number[] {
  const flat: number[] = []
  for (const r of rolls) flat.push(r.stat, r.q)
  return flat
}

/** The `rolls` column read back; a trailing odd number is ignored. */
export function rollsOf (flat: readonly unknown[] | null | undefined): GearRoll[] {
  const rolls: GearRoll[] = []
  if (!Array.isArray(flat)) return rolls
  for (let i = 0; i + 1 < flat.length; i += 2) rolls.push({ stat: Number(flat[i]), q: Number(flat[i + 1]) })
  return rolls
}

/** Ascending by numeric row id (a string compare would put 10 before 9). */
export function byRowId (a: { rowId?: string }, b: { rowId?: string }): number {
  const x = BigInt(a.rowId ?? '0')
  const y = BigInt(b.rowId ?? '0')
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * A run end's `keep` and `found` as both stores read them: `keepIds` is the
 * well-formed row ids, plus the `rowId` of any found instance that has one
 * (a lineage item is moved, never inserted); `insert` is the rowless found
 * items a row can hold, in order.
 */
export function splitFound (keep: readonly string[], found: readonly GearInstance[]): { keepIds: string[], insert: GearInstance[] } {
  const lineage: string[] = []
  const insert: GearInstance[] = []
  for (const item of found) {
    if (item === null || typeof item !== 'object') continue
    if (item.rowId !== undefined) {
      lineage.push(item.rowId)
      continue
    }
    if (storable(item)) insert.push(item)
  }
  return { keepIds: rowIdsOf([...keep, ...lineage]), insert }
}

/** A token as `newToken` makes it: 32 bytes, base64url, no padding. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** A public id as `newPublicId` makes it; also the database's CHECK. */
export const PUBLIC_ID_SHAPE = /^[0-9a-f]{16}$/

/** 256 random bits. A slow hash buys nothing for a secret this size. */
export function newToken (): string {
  return randomBytes(32).toString('base64url')
}

/** What is stored for a token: its SHA-256. */
export function hashToken (token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** 64 random bits as 16 lowercase hex digits. */
export function newPublicId (): string {
  return randomBytes(8).toString('hex')
}

/** An account for one connection while the store is failing (fail open). */
export function offlineAccount (): Account {
  return { publicId: newPublicId(), persisted: false, xp: 0, loadouts: [], energy: null }
}

/**
 * The token in a handshake's `auth` (`{ token }`), if it has the shape
 * `newToken` gives; anything else is treated as no token at all.
 */
export function tokenOf (auth: unknown): string | undefined {
  if (auth === null || typeof auth !== 'object') return undefined
  const token = (auth as { token?: unknown }).token
  return typeof token === 'string' && TOKEN_SHAPE.test(token) ? token : undefined
}

/**
 * Accounts in a Map, for specs, the load harness and a bare local run (no
 * `DATABASE_URL`). **It never evicts**: about 200 bytes an account, kept until
 * the process ends, which is deliberate for a dev store and wrong for
 * production (every deploy forgets every account; `openAccountStore` reports
 * that on Railway).
 */
export class MemoryAccountStore implements AccountStore, GearStore {
  /** The stash's clock (pg's `now()`); specs pass a fake one to age carries and heartbeats. */
  private readonly clock: () => number

  constructor (options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? (() => Date.now())
  }

  /**
   * Stash rows by row id, in id order (insertion order). Public for specs
   * only, as `storedHashes` is: nothing in the server reads it.
   */
  readonly stashRows = new Map<string, MemoryStashRow>()
  private nextRowId = 1
  /** Each holder's last heartbeat (pg `gear_holders`). */
  private readonly holders = new Map<string, number>()
  /** Public id by token hash (hex). */
  private readonly byHash = new Map<string, string>()
  private readonly ids = new Set<string>()
  /** Total XP by public id; an account with none yet has 0. */
  private readonly xp = new Map<string, number>()
  /** Play stocks by public id; none is a new account's (`ENERGY.start`). */
  private readonly energy = new Map<string, EnergyRecord>()
  /** Saved loadouts by public id, then by `robot/index`. */
  private readonly loadouts = new Map<string, Map<string, StoredLoadout>>()
  /** Each account's key in creation order: stands in for pg's `account_id` in the ranking. */
  private readonly keys = new Map<string, number>()
  /** Season entries by season start, then public id. */
  private readonly entries = new Map<string, Map<string, SeasonEntry & { name?: string }>>()
  /** Paid seasons (pg `seasons`) by start. */
  private readonly paid = new Map<string, PaidSeason>()
  /** Every payout received, by public id, oldest first (pg `season_payouts`). */
  private readonly payouts = new Map<string, LastPayout[]>()

  async resolve (token: string): Promise<Account | null> {
    const publicId = this.byHash.get(hashToken(token).toString('hex'))
    if (publicId === undefined) return null
    // Copies, so an account in memory never shares an array with the store.
    const loadouts = [...(this.loadouts.get(publicId)?.values() ?? [])]
      .map((l) => ({ robot: l.robot, index: l.index, skills: copyOf(l.skills) }))
      .sort((a, b) => a.robot < b.robot ? -1 : a.robot > b.robot ? 1 : a.index - b.index)
    const energy = this.energy.get(publicId)
    return { publicId, persisted: true, xp: this.xp.get(publicId) ?? 0, loadouts, energy: energy === undefined ? null : { ...energy } }
  }

  /**
   * Synchronous from start to end (no `await`), so two at once can't both
   * spend the last play, nor both carry one item.
   */
  async spend (publicId: string, nowMs: number, bring?: Bring): Promise<Spent> {
    if (!this.ids.has(publicId)) throw new Error('accounts: spend for an unknown account')
    if (bring !== undefined) checkHolder(bring.holder)
    const { ok, record } = spendAt(this.energy.get(publicId) ?? null, nowMs)
    if (ok) this.energy.set(publicId, record)
    if (bring === undefined) return { ok, energy: { ...record } }
    const carried: GearInstance[] = []
    if (ok) {
      const at = this.clock()
      for (const id of rowIdsOf(bring.ids)) {
        const row = this.stashRows.get(id)
        // As pg: the account's, stashed, not a part.
        if (row === undefined || row.owner !== publicId || row.carried || row.skill <= 0) continue
        row.carried = true
        row.holder = bring.holder
        row.carriedAt = at
        carried.push(instanceOf(row))
      }
    }
    return { ok, energy: { ...record }, carried: carried.sort(byRowId) }
  }

  /** The stale return, then the account's rows. Synchronous, like every stash method here. */
  async loadStash (publicId: string): Promise<StashItem[]> {
    if (!this.ids.has(publicId)) throw new Error('accounts: stash for an unknown account')
    const now = this.clock()
    for (const row of this.stashRows.values()) {
      if (row.owner !== publicId || !row.carried) continue
      const seen = row.holder === null ? undefined : this.holders.get(row.holder)
      // pg: `holder NOT IN (SELECT holder FROM gear_holders WHERE seen_at > now() - 15 min)`.
      if (seen === undefined || !(seen > now - STALE_CARRY_MS)) stashed(row)
    }
    return this.stashOf(publicId)
  }

  async settleGear (publicId: string, holder: string, keep: readonly string[], found: readonly GearInstance[]): Promise<Settled> {
    if (!this.ids.has(publicId)) throw new Error('accounts: settle for an unknown account')
    checkHolder(holder)
    const { keepIds, insert } = splitFound(keep, found)
    const kept: string[] = []
    for (const id of keepIds) {
      const row = this.stashRows.get(id)
      if (row === undefined || !row.carried || row.holder !== holder) continue
      row.owner = publicId
      stashed(row)
      kept.push(id)
    }
    let rows = 0
    for (const row of this.stashRows.values()) if (row.owner === publicId) rows++
    const inserted = insert.slice(0, Math.max(0, STASH_MAX - rows))
    for (const item of inserted) {
      const rowId = String(this.nextRowId++)
      this.stashRows.set(rowId, {
        rowId,
        owner: publicId,
        tier: item.tier,
        skill: item.skill,
        rolls: item.rolls.map((r) => ({ stat: r.stat, q: r.q })),
        carried: false,
        holder: null,
        carriedAt: null,
        source: GEAR_SOURCE.found
      })
    }
    return { kept: kept.sort((a, b) => byRowId({ rowId: a }, { rowId: b })), inserted: inserted.length, stash: this.stashOf(publicId) }
  }

  async discardGear (holder: string, rowIds: readonly string[]): Promise<number> {
    checkHolder(holder)
    let n = 0
    for (const id of rowIdsOf(rowIds)) {
      const row = this.stashRows.get(id)
      if (row === undefined || !row.carried || row.holder !== holder) continue
      this.stashRows.delete(id)
      n++
    }
    return n
  }

  async uncarry (holder: string, rowIds: readonly string[]): Promise<number> {
    checkHolder(holder)
    let n = 0
    for (const id of rowIdsOf(rowIds)) {
      const row = this.stashRows.get(id)
      if (row === undefined || !row.carried || row.holder !== holder) continue
      stashed(row)
      n++
    }
    return n
  }

  async heartbeat (holder: string, held: readonly string[]): Promise<number> {
    checkHolder(holder)
    const now = this.clock()
    this.holders.set(holder, now)
    const spared = new Set(rowIdsOf(held))
    let n = 0
    for (const row of this.stashRows.values()) {
      if (!row.carried || row.holder !== holder || spared.has(row.rowId)) continue
      // pg: `carried_at < now() - interval '2 minutes'`.
      if (row.carriedAt !== null && row.carriedAt < now - RECONCILE_AFTER_MS) {
        stashed(row)
        n++
      }
    }
    return n
  }

  async releaseHolder (holder: string): Promise<number> {
    checkHolder(holder)
    let n = 0
    for (const row of this.stashRows.values()) {
      if (!row.carried || row.holder !== holder) continue
      stashed(row)
      n++
    }
    this.holders.delete(holder)
    return n
  }

  private stashOf (publicId: string): StashItem[] {
    const out: StashItem[] = []
    for (const row of this.stashRows.values()) {
      if (row.owner === publicId) out.push({ ...instanceOf(row), carried: row.carried, source: row.source })
    }
    return out.sort(byRowId)
  }

  async refund (publicId: string, nowMs: number): Promise<EnergyRecord> {
    if (!this.ids.has(publicId)) throw new Error('accounts: refund for an unknown account')
    const record = refundAt(this.energy.get(publicId) ?? null, nowMs)
    this.energy.set(publicId, record)
    return { ...record }
  }

  async saveLoadout (publicId: string, robot: string, index: number, skills: number[]): Promise<void> {
    if (!this.ids.has(publicId)) throw new Error('accounts: loadout for an unknown account')
    let rows = this.loadouts.get(publicId)
    if (rows === undefined) {
      rows = new Map()
      this.loadouts.set(publicId, rows)
    }
    rows.set(`${robot}/${index}`, { robot, index, skills: copyOf(skills) })
  }

  async create (): Promise<{ account: Account, token: string }> {
    let publicId = newPublicId()
    while (this.ids.has(publicId)) publicId = newPublicId()
    const token = newToken()
    this.ids.add(publicId)
    this.keys.set(publicId, this.keys.size + 1)
    this.byHash.set(hashToken(token).toString('hex'), publicId)
    return { account: { publicId, persisted: true, xp: 0, loadouts: [], energy: null }, token }
  }

  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> {
    if (!this.ids.has(publicId)) throw new Error('accounts: grant to an unknown account')
    const total = (this.xp.get(publicId) ?? 0) + xp
    this.xp.set(publicId, total)
    // A paid season takes no more entries (pg: `NOT EXISTS (seasons)`).
    if (credit !== undefined && !this.paid.has(credit.season)) {
      let season = this.entries.get(credit.season)
      if (season === undefined) {
        season = new Map()
        this.entries.set(credit.season, season)
      }
      const entry = season.get(publicId) ?? { key: this.keys.get(publicId) ?? 0, banked: 0, bankedAt: null, runs: 0, extractions: 0, xp: 0 }
      entry.banked += credit.banked
      entry.runs += 1
      entry.extractions += credit.extracted ? 1 : 0
      entry.xp += credit.xp
      if (credit.banked > 0) entry.bankedAt = credit.atMs
      // As pg: the last run's name, cut to the column's backstop; none keeps the old one.
      const name = [...(credit.name ?? '')].slice(0, 64).join('')
      if (name !== '') entry.name = name
      season.set(publicId, entry)
    }
    return total
  }

  /** A season's eligible entries in rank order, with their public ids. */
  private ranked (start: string): Array<SeasonEntry & { publicId: string, name?: string }> {
    return [...(this.entries.get(start) ?? new Map<string, SeasonEntry & { name?: string }>()).entries()]
      .filter(([, entry]) => eligible(entry))
      .map(([publicId, entry]) => ({ ...entry, publicId }))
      .sort(compareEntries)
  }

  async season (publicId: string, atMs: number): Promise<SeasonView> {
    if (!this.ids.has(publicId)) throw new Error('accounts: season for an unknown account')
    const start = seasonStart(atMs)
    const entry = this.entries.get(start)?.get(publicId)
    const ranked = this.ranked(start)
    const index = ranked.findIndex((e) => e.publicId === publicId)
    const received = this.payouts.get(publicId)
    // The latest season paid, as pg's `ORDER BY season_start DESC`.
    const latest = received?.reduce((a, b) => (b.start > a.start ? b : a))
    const last = latest === undefined ? undefined : { ...latest }
    return seasonView(start, atMs, entry, ranked.length, index < 0 ? null : index + 1, last)
  }

  async seasonBoard (atMs: number, limit: number): Promise<SeasonBoard> {
    const start = seasonStart(atMs)
    const ranked = this.ranked(start)
    return {
      start,
      endsInMs: Math.max(0, seasonEndMs(start) - atMs),
      ranked: ranked.length,
      places: tierPlaces(ranked.length),
      top: ranked.slice(0, limit).map((e, i) => ({ rank: i + 1, name: e.name ?? '', id: e.publicId, banked: e.banked }))
    }
  }

  /**
   * Synchronous from start to end (no `await`), so two calls at once on one
   * store can't both find a season unpaid.
   */
  async payDue (nowMs: number): Promise<PaidSeason[]> {
    const done: PaidSeason[] = []
    for (const start of dueStarts(nowMs)) {
      if (this.paid.has(start) || (this.entries.get(start)?.size ?? 0) === 0) continue
      const ranked = this.ranked(start)
      const payouts = seasonPayouts(ranked.map((e) => ({ key: e.publicId, xp: e.xp })))
      const result = { start, ranked: ranked.length, paid: payouts.length }
      this.paid.set(start, result)
      for (const p of payouts) {
        this.xp.set(p.key, (this.xp.get(p.key) ?? 0) + p.xp)
        const list = this.payouts.get(p.key) ?? []
        list.push({ start, rank: p.rank, ranked: ranked.length, tier: p.tier, xp: p.xp })
        this.payouts.set(p.key, list)
      }
      done.push(result)
    }
    return done
  }

  async close (): Promise<void> {}

  /** Accounts held. */
  get size (): number {
    return this.byHash.size
  }

  /** What is stored for each account: for the spec that checks the token isn't. */
  get storedHashes (): string[] {
    return [...this.byHash.keys()]
  }
}

/** One stash row in the memory store (pg `stash_items`). */
export interface MemoryStashRow {
  readonly rowId: string
  /** The account's public id (pg `account_id`). */
  owner: string
  readonly tier: GearTier
  readonly skill: number
  readonly rolls: GearRoll[]
  carried: boolean
  holder: string | null
  carriedAt: number | null
  readonly source: number
}

function stashed (row: MemoryStashRow): void {
  row.carried = false
  row.holder = null
  row.carriedAt = null
}

function instanceOf (row: MemoryStashRow): GearInstance & { rowId: string } {
  return { tier: row.tier, skill: row.skill, rolls: row.rolls.map((r) => ({ stat: r.stat, q: r.q })), rowId: row.rowId }
}

/**
 * A copy of a stored array; anything else as it is. The memory store keeps
 * what it is given unchecked, as the database's CHECKs would not, so specs
 * can write forged rows straight to it (network/loadouts.spec.ts).
 */
function copyOf (skills: number[]): number[] {
  return Array.isArray(skills) ? [...skills] : skills
}
