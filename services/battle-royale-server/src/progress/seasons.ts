import { SEASON } from './xp'

/**
 * Weekly seasons (decision #48 step 6). Everything both account stores and
 * the specs share: the calendar, the one ranking order, eligibility, the
 * places per tier and the payout. No pg, no pixi, no `World`. The numbers are
 * `SEASON` in `progress/xp.ts`; what is here is mechanism.
 *
 * A season runs Monday 00:00 UTC to the next Monday and is named by its start
 * date (`YYYY-MM-DD`). A run counts in the season of its **end** time. Its
 * score is the banked loot of its extractions, at most `SEASON.creditCap` a
 * run. At the end, the top `max(1, floor(0.01 N))` / `floor(0.10 N)` /
 * `floor(0.25 N)` of the N ranked players (cumulative, each at least the one
 * before) are paid 1,000 / 500 / 250 XP, each at most the XP the player
 * earned from runs that season. Places are never shared: ties go to whoever
 * reached the score first, then to the older account.
 */

/** How long after a season's end it is paid: every run that ended in it has written its credit. */
export const PAYOUT_DELAY_MS = 10 * 60_000
/** How often each server checks for a season to pay. */
export const CHECK_EVERY_MS = 5 * 60_000
/** How many past seasons a check looks back over. */
export const LOOKBACK_WEEKS = 8
/** Rows on the public `/season` board. */
export const BOARD_SIZE = 10

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

export type Tier = 1 | 10 | 25

/** One run's contribution to its season, as `Worlds.grant` passes it to the store. */
export interface SeasonCredit {
  /** The season's start date, from the run's end time. */
  season: string
  /** The run's end time (ms): the tie-break, stored as `banked_at` when the run banked. */
  atMs: number
  /** Banked loot, already capped; 0 unless the run extracted. */
  banked: number
  extracted: boolean
  /** The run's XP: the payout's cap. */
  xp: number
  /**
   * The name the run played under: `Player.name`, already sanitised
   * (`Player.displayName`: `sanitiseName`, or the id's callsign). Never a raw
   * name. The entry keeps the name of the run that last credited it, and the
   * public board shows it (decision #48, 2026-10-04).
   */
  name: string
}

/** One account's season so far, as the stores rank it. */
export interface SeasonEntry {
  /** The account's internal key: creation order (pg `account_id`). The last tie-break. */
  key: number
  banked: number
  /** When `banked` was last raised (ms); null while it is 0. */
  bankedAt: number | null
  runs: number
  extractions: number
  xp: number
}

/** A season's paid place. */
export interface SeasonPayout<K> {
  key: K
  rank: number
  tier: Tier
  xp: number
}

/** What a payout check paid. */
export interface PaidSeason {
  start: string
  ranked: number
  paid: number
}

/** The latest payout an account received. */
export interface LastPayout {
  start: string
  rank: number
  ranked: number
  tier: Tier
  xp: number
}

/** The `season` event: one account's view of the current season. */
export interface SeasonView {
  start: string
  /** Until the season ends, relative, so a wrong client clock doesn't matter. */
  endsInMs: number
  banked: number
  runs: number
  extractions: number
  xp: number
  /** Eligible players now. */
  ranked: number
  /** Null until this account is eligible. */
  rank: number | null
  tier: Tier | null
  /** What this account would be paid if the season ended now; 0 without a tier. */
  payout: number
  minRuns: number
  minExtractions: number
  last?: LastPayout
}

/** `/season`: the current season's top: rank, sanitised name, public id and banked loot. */
export interface SeasonBoard {
  start: string
  endsInMs: number
  ranked: number
  places: [number, number, number]
  /** The name is the entry's last run's (names aren't unique, so the public id stays beside it). */
  top: Array<{ rank: number, name: string, id: string, banked: number }>
}

/** The start (`YYYY-MM-DD`) of the season holding `ms`: the Monday 00:00 UTC at or before it. */
export function seasonStart (ms: number): string {
  const day = new Date(ms)
  const sinceMonday = (day.getUTCDay() + 6) % 7
  const monday = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - sinceMonday * DAY_MS
  return new Date(monday).toISOString().slice(0, 10)
}

/** When the season starting `start` ends (ms): a week after its start. */
export function seasonEndMs (start: string): number {
  return Date.parse(`${start}T00:00:00.000Z`) + WEEK_MS
}

/** Whether the season starting `start` may be paid at `nowMs`: ended `PAYOUT_DELAY_MS` ago. */
export function payable (start: string, nowMs: number): boolean {
  return nowMs >= seasonEndMs(start) + PAYOUT_DELAY_MS
}

/** The payable seasons a check at `nowMs` looks at, oldest first: up to `LOOKBACK_WEEKS` back. */
export function dueStarts (nowMs: number): string[] {
  const current = Date.parse(`${seasonStart(nowMs)}T00:00:00.000Z`)
  const starts: string[] = []
  for (let k = LOOKBACK_WEEKS; k >= 1; k--) {
    const start = new Date(current - k * WEEK_MS).toISOString().slice(0, 10)
    if (payable(start, nowMs)) starts.push(start)
  }
  return starts
}

/** Cumulative places for the 1% / 10% / 25% tiers among `n` ranked players. */
export function tierPlaces (n: number): [number, number, number] {
  if (n <= 0) return [0, 0, 0]
  const [top1, top10, top25] = SEASON.tiers
  const p1 = Math.max(1, Math.floor(top1.share * n))
  const p10 = Math.max(p1, Math.floor(top10.share * n))
  const p25 = Math.max(p10, Math.floor(top25.share * n))
  return [p1, p10, p25]
}

/** The tier rank `rank` (1-based) of `n` ranked players is in, if any. */
export function tierOf (rank: number, n: number): Tier | null {
  const places = tierPlaces(n)
  for (let i = 0; i < places.length; i++) {
    if (rank >= 1 && rank <= places[i]) return SEASON.tiers[i].top
  }
  return null
}

/** The XP a tier pays. */
export function tierXp (tier: Tier): number {
  return SEASON.tiers.find((t) => t.top === tier)?.xp ?? 0
}

/**
 * **The one ranking order**: banked descending, then whoever reached it first
 * (`bankedAt` ascending, none last), then the older account (`key`
 * ascending). Postgres ranks by `banked DESC, banked_at, account_id`, the
 * same order (`db/pgstore.ts` `RANK_ORDER`), which the store contract checks.
 */
export function compareEntries (a: SeasonEntry, b: SeasonEntry): number {
  if (a.banked !== b.banked) return b.banked - a.banked
  if (a.bankedAt !== b.bankedAt) {
    if (a.bankedAt === null) return 1
    if (b.bankedAt === null) return -1
    return a.bankedAt - b.bankedAt
  }
  return a.key - b.key
}

/** Whether an entry is ranked: enough runs, an extraction, and some banked loot. */
export function eligible (entry: { runs: number, extractions: number, banked: number }): boolean {
  return entry.runs >= SEASON.minRuns && entry.extractions >= SEASON.minExtractions && entry.banked >= SEASON.minBanked
}

/**
 * Every paid place of a season, given its eligible entries **in rank order**
 * (only their keys and season XP are read): each place pays its tier's XP,
 * at most the XP the entry earned from runs that season; a place that would
 * pay 0 is left out. `n` is the number ranked, `ranked.length` by default
 * (Postgres reads only the paid places, so it passes the count).
 */
export function seasonPayouts<K> (ranked: ReadonlyArray<{ key: K, xp: number }>, n: number = ranked.length): Array<SeasonPayout<K>> {
  const out: Array<SeasonPayout<K>> = []
  const last = Math.min(tierPlaces(n)[2], ranked.length)
  for (let i = 0; i < last; i++) {
    const tier = tierOf(i + 1, n)
    if (tier === null) break
    const xp = Math.min(tierXp(tier), Math.max(0, Math.floor(ranked[i].xp)))
    if (xp > 0) out.push({ key: ranked[i].key, rank: i + 1, tier, xp })
  }
  return out
}

/** A run's season credit: its banked loot capped at `SEASON.creditCap`, counted in the season of `atMs`. */
export function creditOf (player: { extracted: boolean, loot: number, name: string }, xp: number, atMs: number): SeasonCredit {
  return {
    season: seasonStart(atMs),
    atMs,
    banked: player.extracted ? Math.min(SEASON.creditCap, Math.floor(Math.max(0, player.loot))) : 0,
    extracted: player.extracted,
    xp,
    name: player.name
  }
}

/** An account's view of the season `start` at `atMs`, from its entry (none: zeros) and its rank. */
export function seasonView (start: string, atMs: number, entry: { banked: number, runs: number, extractions: number, xp: number } | undefined, ranked: number, rank: number | null, last: LastPayout | undefined): SeasonView {
  const tier = rank === null ? null : tierOf(rank, ranked)
  const xp = entry?.xp ?? 0
  const view: SeasonView = {
    start,
    endsInMs: Math.max(0, seasonEndMs(start) - atMs),
    banked: entry?.banked ?? 0,
    runs: entry?.runs ?? 0,
    extractions: entry?.extractions ?? 0,
    xp,
    ranked,
    rank,
    tier,
    payout: tier === null ? 0 : Math.min(tierXp(tier), xp),
    minRuns: SEASON.minRuns,
    minExtractions: SEASON.minExtractions
  }
  if (last !== undefined) view.last = last
  return view
}

/**
 * Pays due seasons: one check `FIRST_CHECK_MS` after `start`, then every
 * `CHECK_EVERY_MS`, each calling `store.payDue(now)`. Every server runs one;
 * the store makes the payout idempotent across them (`PgAccountStore.payDue`).
 *
 * **A plain timer, on purpose.** The "never `setTimeout`" rule is about world
 * work, which must sit inside the tick's error boundary; this touches no
 * world. It is store work, like the store's migration retry. Both timers are
 * `unref()`'d, and every rejection is caught and handed to `report` (an
 * unhandled rejection would end the process). `stop` before the store's
 * `close`.
 */
export class SeasonPayer {
  static FIRST_CHECK_MS = 30_000
  private first: NodeJS.Timeout | undefined
  private every: NodeJS.Timeout | undefined
  /** The check in flight, so two never overlap on one server. */
  private running: Promise<void> | undefined

  constructor (
    private readonly store: { payDue: (nowMs: number) => Promise<PaidSeason[]> },
    private readonly report: (e: unknown) => void,
    private readonly clock: () => number = () => Date.now(),
    private readonly log: (line: string) => void = (line) => { console.log(line) }
  ) {}

  start (): void {
    this.stop()
    this.first = setTimeout(() => { void this.check() }, SeasonPayer.FIRST_CHECK_MS)
    this.first.unref()
    this.every = setInterval(() => { void this.check() }, CHECK_EVERY_MS)
    this.every.unref()
  }

  stop (): void {
    if (this.first !== undefined) clearTimeout(this.first)
    if (this.every !== undefined) clearInterval(this.every)
    this.first = undefined
    this.every = undefined
  }

  /** One check. Never rejects. */
  async check (): Promise<void> {
    if (this.running !== undefined) return await this.running
    this.running = (async () => {
      try {
        for (const paid of await this.store.payDue(this.clock())) {
          this.log(`seasons: paid ${paid.start}, ${paid.paid} of ${paid.ranked} ranked`)
        }
      } catch (e) {
        try { this.report(e) } catch {}
      } finally {
        this.running = undefined
      }
    })()
    return await this.running
  }
}
