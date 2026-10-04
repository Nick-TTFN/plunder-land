/**
 * Weekly seasons (decision #48 step 6). Pixi-free, so the server's specs run
 * it (`network/seasons.spec.ts` there).
 *
 * The server sends `season` (its `SeasonView`) after `account` for a
 * persisted account and after each run's XP lands: this account's banked
 * loot, runs and extractions this season, its rank among the ranked players
 * (null until it has `minRuns` runs and `minExtractions` extractions with
 * some loot banked), the tier and payout it would get if the season ended
 * now, and its latest payout (`last`). Every number is the server's; no
 * threshold is copied here. `endsInMs` is relative, so a wrong clock on this
 * machine doesn't matter. No view (an offline account, a server from before
 * seasons, a failed read) means no season line.
 */

export interface LastPayout {
  start: string
  rank: number
  ranked: number
  tier: 1 | 10 | 25
  xp: number
}

export interface SeasonView {
  start: string
  endsInMs: number
  banked: number
  runs: number
  extractions: number
  xp: number
  ranked: number
  rank: number | null
  tier: 1 | 10 | 25 | null
  payout: number
  minRuns: number
  minExtractions: number
  last?: LastPayout
}

/** What the lobby needs of localStorage; a failure means "not remembered". */
export interface SeenStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** The last season whose payout notice this browser has shown. */
export const SEEN_KEY = 'plunderland_season_seen'

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/
const DOT = ' · '

/**
 * This connection's season, as last sent, when it arrived (for the
 * countdown), and who wants to hear when it changes (the lobby). Cleared on
 * every (re)connect, like `ACCOUNT`.
 */
export const SEASON: { view: SeasonView | undefined, receivedAt: number, listeners: Set<() => void> } = { view: undefined, receivedAt: 0, listeners: new Set() }

/** Replace the season view and tell the listeners. */
export function setSeason (view: SeasonView | undefined, now: number): void {
  SEASON.view = view
  SEASON.receivedAt = now
  // forEach, not for-of: the client's tsconfig targets ES5 for typechecking.
  SEASON.listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // One broken listener must not stop the others.
    }
  })
}

function count (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tierOf (value: unknown): 1 | 10 | 25 | undefined {
  return value === 1 || value === 10 || value === 25 ? value : undefined
}

function lastOf (data: unknown): LastPayout | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const rank = count(d.rank)
  const ranked = count(d.ranked)
  const tier = tierOf(d.tier)
  const xp = count(d.xp)
  if (typeof d.start !== 'string' || !DATE_SHAPE.test(d.start)) return undefined
  if (rank === undefined || ranked === undefined || rank < 1 || rank > ranked || tier === undefined || xp === undefined || xp < 1) return undefined
  return { start: d.start, rank, ranked, tier, xp }
}

/** A `season` event, or undefined for anything malformed. */
export function onSeason (data: unknown): SeasonView | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (typeof d.start !== 'string' || !DATE_SHAPE.test(d.start)) return undefined
  const numbers = ['endsInMs', 'banked', 'runs', 'extractions', 'xp', 'ranked', 'payout', 'minRuns', 'minExtractions'].map((key) => count(d[key]))
  if (numbers.some((n) => n === undefined)) return undefined
  const [endsInMs, banked, runs, extractions, xp, ranked, payout, minRuns, minExtractions] = numbers as number[]
  let rank: number | null = null
  if (d.rank !== null) {
    const r = count(d.rank)
    if (r === undefined || r < 1 || r > ranked) return undefined
    rank = r
  }
  let tier: 1 | 10 | 25 | null = null
  if (d.tier !== null) {
    const t = tierOf(d.tier)
    if (t === undefined || rank === null) return undefined
    tier = t
  }
  const view: SeasonView = { start: d.start, endsInMs, banked, runs, extractions, xp, ranked, rank, tier, payout, minRuns, minExtractions }
  if (d.last !== undefined) {
    const last = lastOf(d.last)
    if (last === undefined) return undefined
    view.last = last
  }
  return view
}

/** Time left as the lobby shows it: `2D 4H`, `5H 12M`, `12M`, `<1M`. */
export function resetsIn (ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}D ${hours}H`
  if (hours > 0) return `${hours}H ${minutes % 60}M`
  if (minutes > 0) return `${minutes}M`
  return '<1M'
}

function plural (n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 'S'}`
}

/** The lobby's season line, `msSinceReceived` after the view arrived. */
export function seasonLine (view: SeasonView, msSinceReceived: number): string {
  const resets = `RESETS IN ${resetsIn(view.endsInMs - msSinceReceived)}`
  if (view.rank === null) {
    const needs: string[] = []
    const runs = Math.max(0, view.minRuns - view.runs)
    const extractions = Math.max(0, view.minExtractions - view.extractions)
    if (runs > 0) needs.push(plural(runs, 'RUN'))
    if (extractions > 0) needs.push(plural(extractions, 'EXTRACTION'))
    const what = needs.length > 0 ? `${needs.join(' + ')} TO RANK` : 'BANK LOOT TO RANK'
    return ['SEASON', what, resets].join(DOT)
  }
  const place = `#${view.rank} OF ${view.ranked}`
  if (view.tier === null) return ['SEASON', place, resets].join(DOT)
  return ['SEASON', place, `TOP ${view.tier}% +${view.payout} XP`, resets].join(DOT)
}

/**
 * The last payout's notice, once per season: undefined when there is none or
 * this browser has shown it (`SEEN_KEY`), else its text, and the season is
 * marked shown. Storage that throws shows it and remembers nothing.
 */
export function lastNotice (view: SeasonView, storage: SeenStorage | undefined): string | undefined {
  const last = view.last
  if (last === undefined) return undefined
  let seen: string | null = null
  try {
    seen = storage?.getItem(SEEN_KEY) ?? null
  } catch {
    seen = null
  }
  if (seen === last.start) return undefined
  try {
    storage?.setItem(SEEN_KEY, last.start)
  } catch {
    // Not remembered: shown again next time.
  }
  return ['LAST SEASON', `#${last.rank} OF ${last.ranked}`, `TOP ${last.tier}%`, `+${last.xp} XP`].join(DOT)
}
