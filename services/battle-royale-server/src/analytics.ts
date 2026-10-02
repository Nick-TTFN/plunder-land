import type Redis from 'ioredis'

/**
 * Game events to Google Analytics 4 (decision #46), sent by the server through
 * the Measurement Protocol: a browser's ad blocker can't drop them and a
 * modified client can't fake them. On only when GA_MEASUREMENT_ID and
 * GA_API_SECRET are set (Railway), so local runs, specs and the load
 * harness send nothing.
 *
 * Three events, one run each, **append-only** (names and params are what the
 * GA reports are built on; a rename is a removal):
 *
 * - `run_start`: `robot`, `run_number` (this player's runs so far, this one
 *   included), `days_since_first` (since this player's first run; 0 on the
 *   first day), `world_players` (active humans in its world, it included),
 *   `world_bots` (bots in it, decision #47; added the day bots came),
 *   `party_size` (humans already in it with the same party code: friends
 *   from an invite link, #47; added the same day).
 * - `first_loot`: `seconds` from the start to the first loot picked up.
 * - `run_end`: `outcome` (`extracted`, `died`, `left`), `seconds`, `loot`
 *   (carried at the end: banked on an extraction, lost otherwise), `kills`,
 *   `deepest_layer` (1-3), `robot`, and `killed_by` (`robot`, `mob`, `other`)
 *   on a death.
 * - Every event of a run on an offline account (the account store failed,
 *   decision #48) also carries `offline: 1`; it is absent otherwise. Such a
 *   run's `run_start` has no `run_number` or `days_since_first`: its id is
 *   made up for one connection and has no history, and nothing is written
 *   to Redis for it. Added with guest accounts.
 *
 * `client_id` is the player's persistent per-browser id; each run is its own
 * GA session (`session_id`, the run's start in seconds). GA's own "new" and
 * "returning" user counts need events that only its web tag sends, so return
 * is read from `run_number` and `days_since_first`. The first run's day is
 * kept in Redis, `player-<id>` `firstDay` (days since the epoch), outside the
 * public `stats-*` hashes.
 *
 * EU endpoint (`region1`): the data is collected in the EU.
 */
const ENDPOINT = 'https://region1.google-analytics.com/mp/collect'
const DAY_MS = 86_400_000

export type Params = Record<string, string | number>

/** What a run's events need from it. */
export interface RunInfo {
  playerId: string
  /** The run's start, ms since the epoch: its session. */
  startedAt: number
  /** On an offline account: every event gets `offline: 1`. */
  offline?: boolean
}

/** The Measurement Protocol body for one event. Exported for the spec. */
export function payload (run: RunInfo, name: string, params: Params, at: number): unknown {
  return {
    client_id: run.playerId,
    timestamp_micros: at * 1000,
    events: [{
      name,
      params: {
        ...params,
        ...(run.offline === true ? { offline: 1 } : {}),
        session_id: String(Math.floor(run.startedAt / 1000)),
        // GA counts a user as engaged only with some engagement time.
        engagement_time_msec: Math.max(1, at - run.startedAt)
      }
    }]
  }
}

export default class Analytics {
  /** Replaced by specs to see what would be sent. */
  static post: (url: string, body: string) => Promise<unknown> = async (url, body) =>
    await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })

  private static _lastFailureLog = -Infinity

  static get url (): string | undefined {
    const id = process.env.GA_MEASUREMENT_ID
    const secret = process.env.GA_API_SECRET
    if (id === undefined || id === '' || secret === undefined || secret === '') return undefined
    return `${ENDPOINT}?measurement_id=${encodeURIComponent(id)}&api_secret=${encodeURIComponent(secret)}`
  }

  /** Fire and forget; a failure logs at most once a minute and never throws. */
  static send (run: RunInfo, name: string, params: Params, at: number = Date.now()): void {
    const url = Analytics.url
    if (url === undefined) return
    Analytics.post(url, JSON.stringify(payload(run, name, params, at))).catch((e) => {
      const now = Date.now()
      if (now - Analytics._lastFailureLog < 60_000) return
      Analytics._lastFailureLog = now
      console.error('analytics send failed', e)
    })
  }

  /**
   * `run_start`. Reads the player's history from Redis first, so it is sent a
   * moment late; its timestamp is the start's. `redis` is passed in: after an
   * await no world is current (worlds-per-process).
   */
  static runStart (run: RunInfo, redis: Redis, robot: string, worldPlayers: number, worldBots: number = 0, partySize: number = 0): void {
    if (Analytics.url === undefined) return
    const at = Date.now()
    if (run.offline === true) {
      // No history to read, and no `player-<id>` key to leave behind.
      Analytics.send(run, 'run_start', { robot, world_players: worldPlayers, world_bots: worldBots, party_size: partySize }, at)
      return
    }
    const today = Math.floor(at / DAY_MS)
    const history = async (): Promise<void> => {
      await redis.hsetnx(`player-${run.playerId}`, 'firstDay', today)
      const [firstDay, games] = await Promise.all([
        redis.hget(`player-${run.playerId}`, 'firstDay'),
        redis.hget(`stats-${run.playerId}`, 'games')
      ])
      Analytics.send(run, 'run_start', {
        robot,
        run_number: Number(games ?? 0) + 1,
        days_since_first: Math.max(0, today - Number(firstDay ?? today)),
        world_players: worldPlayers,
        world_bots: worldBots,
        party_size: partySize
      }, at)
    }
    // Redis down: still count the run, without its history.
    history().catch(() => { Analytics.send(run, 'run_start', { robot, world_players: worldPlayers, world_bots: worldBots, party_size: partySize }, at) })
  }
}
