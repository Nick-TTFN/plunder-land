import { createHash, randomBytes } from 'node:crypto'
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
  /** Waits for grants and saves in flight, then lets go of the store. */
  close: () => Promise<void>
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
  return { publicId: newPublicId(), persisted: false, xp: 0, loadouts: [] }
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
export class MemoryAccountStore implements AccountStore {
  /** Public id by token hash (hex). */
  private readonly byHash = new Map<string, string>()
  private readonly ids = new Set<string>()
  /** Total XP by public id; an account with none yet has 0. */
  private readonly xp = new Map<string, number>()
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
    return { publicId, persisted: true, xp: this.xp.get(publicId) ?? 0, loadouts }
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
    return { account: { publicId, persisted: true, xp: 0, loadouts: [] }, token }
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

/**
 * A copy of a stored array; anything else as it is. The memory store keeps
 * what it is given unchecked, as the database's CHECKs would not, so specs
 * can write forged rows straight to it (network/loadouts.spec.ts).
 */
function copyOf (skills: number[]): number[] {
  return Array.isArray(skills) ? [...skills] : skills
}
