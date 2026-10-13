import { randomBytes } from 'node:crypto'
import type Redis from 'ioredis'
import Analytics, { type RunInfo } from '../analytics'
import { type Account } from '../db/accounts'

/**
 * A connection as one visit (#56, the itch soft launch): what GA needs for
 * the portal's own measures (conversion, playtime per visit, next-day
 * return) and for why a visit ended. Analytics only; nothing here changes
 * play. Events and params are **append-only**, as in `analytics.ts`.
 *
 * - `visit_start`, once the handshake's account lookup settles: `new_player`
 *   (1: no token at connect, a first visit or cleared storage) and, for a
 *   persisted account, `days_since_first` (since its first run, Redis
 *   `player-<id>` `firstDay`, the same day `run_start` reads).
 * - `visit_end`, on disconnect: `seconds`, `runs` (started on this
 *   connection), `ended_in` (`run`, `lobby`, or `drain`: the server sent it
 *   to the next one), `last_outcome` (the last run's `run_end` outcome, or
 *   `none`), `energy_refusals`, `new_player`.
 * - `energy_out`, each READY refused for no plays left: `runs`, `seconds`.
 *
 * Every event carries `portal` (`portalOf`), as do the run events. A
 * connection with no account yet (a new player before their first READY)
 * is sent under a one-off id that is never stored, so such a visit counts as
 * its own GA user; its `visit_end` uses the account if one was made by then.
 * Each visit is its own GA session (its start, in whole seconds), apart from
 * its runs', unless a run starts in the visit's first second.
 */

/** Where the client says it runs. Anything else reads `other`; none (an old client) reads `web`. */
export const PORTALS: readonly string[] = ['web', 'itch', 'crazygames', 'poki']

export function portalOf (auth: unknown): string {
  const portal = auth !== null && typeof auth === 'object' ? (auth as { portal?: unknown }).portal : undefined
  if (portal === undefined) return 'web'
  return typeof portal === 'string' && PORTALS.includes(portal) ? portal : 'other'
}

export class Visit {
  /** GA's `client_id` while the connection has no account: one-off, never stored. */
  readonly anonId = `anon-${randomBytes(6).toString('hex')}`
  runs = 0
  lastOutcome = 'none'
  energyRefusals = 0

  constructor (
    readonly portal: string,
    /** When it began, ms since the epoch: the visit's GA session. */
    readonly at: number,
    /** No token at connect. */
    readonly newPlayer: boolean
  ) {}

  /** The GA identity for an event now, under `account` if there is one. */
  info (account: Account | null | undefined): RunInfo {
    return {
      playerId: account?.publicId ?? this.anonId,
      startedAt: this.at,
      offline: account !== null && account !== undefined && !account.persisted,
      portal: this.portal
    }
  }
}

const DAY_MS = 86_400_000

/** `visit_start`; reads the first-run day first, so it is sent a moment late with the start's timestamp. */
export function visitStart (visit: Visit, account: Account | null, redis: Redis): void {
  if (Analytics.url === undefined) return
  const run = visit.info(account)
  const params = { new_player: visit.newPlayer ? 1 : 0 }
  if (account === null || !account.persisted) {
    Analytics.send(run, 'visit_start', params, visit.at)
    return
  }
  redis.hget(`player-${account.publicId}`, 'firstDay').then((firstDay) => {
    const today = Math.floor(visit.at / DAY_MS)
    // No first run yet: no `days_since_first`.
    Analytics.send(run, 'visit_start', firstDay === null ? params : { ...params, days_since_first: Math.max(0, today - Number(firstDay)) }, visit.at)
  }).catch(() => { Analytics.send(run, 'visit_start', params, visit.at) })
}

export function visitEnd (visit: Visit, account: Account | undefined, endedIn: 'run' | 'lobby' | 'drain', at: number = Date.now()): void {
  Analytics.send(visit.info(account), 'visit_end', {
    seconds: Math.round((at - visit.at) / 1000),
    runs: visit.runs,
    ended_in: endedIn,
    last_outcome: visit.lastOutcome,
    energy_refusals: visit.energyRefusals,
    new_player: visit.newPlayer ? 1 : 0
  }, at)
}

export function energyOut (visit: Visit, account: Account | undefined, at: number = Date.now()): void {
  visit.energyRefusals++
  Analytics.send(visit.info(account), 'energy_out', { runs: visit.runs, seconds: Math.round((at - visit.at) / 1000) }, at)
}
