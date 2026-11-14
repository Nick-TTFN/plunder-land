import type { PortalSdk, RewardedResult } from './adapter'

/**
 * The rewarded-video energy refill, client side (g2-6d; decision #62: no
 * midgame, no banner ads, ever; only this). One click in the lobby runs one
 * ad through the portal adapter; only `rewarded` (CrazyGames' `adFinished`)
 * then asks the server for the refill (`energy_ad`), which grants it only
 * within its limits and answers through the acknowledgement. Every ad's
 * outcome goes to the server for GA (`ad_result { result }`).
 *
 * The server can't verify that an ad was watched; it doesn't need this
 * module's honesty, only its limits (server `progress/energy.ts`
 * `AD_REFILL`). Pixi-free and `window`-free: the server's specs run it.
 */

/** How long the server has to answer `energy_ad` before the lobby says plays couldn't be added (an old server, a drain). */
export const GRANT_TIMEOUT_MS = 5000

/** The server's acknowledgement of `energy_ad` (server `EnergyAdAnswer`). */
export interface GrantAnswer {
  ok: boolean
  reason?: string
}

/** How one click ended, for the lobby's note. */
export type RefillOutcome =
  | 'refilled' // watched, and the server refilled
  | 'unavailable' | 'adblock' | 'failed' // the ad didn't play to the end: nothing asked
  | 'limit' // watched, but a limit refused it (another tab got there first): the readout shows the timer
  | 'refused' // watched, but refused for another reason
  | 'no_answer' // watched, and the server never answered

export interface RefillDeps {
  sdk: Pick<PortalSdk, 'rewardedAd'>
  /** `ad_result { result }` to the server. */
  report: (result: RewardedResult) => void
  /** `energy_ad` with an acknowledgement: the answer, or undefined after `GRANT_TIMEOUT_MS` or a malformed one. */
  askGrant: () => Promise<GrantAnswer | undefined>
}

/** One click: the ad, its report, and only on `rewarded` the request. Never rejects. */
export async function watchForPlays (deps: RefillDeps): Promise<RefillOutcome> {
  let result: RewardedResult
  try {
    result = await deps.sdk.rewardedAd()
  } catch {
    result = 'failed'
  }
  try {
    deps.report(result)
  } catch {
    // GA only: never in the way of the refill.
  }
  if (result !== 'rewarded') return result
  let answer: GrantAnswer | undefined
  try {
    answer = await deps.askGrant()
  } catch {
    answer = undefined
  }
  if (answer === undefined) return 'no_answer'
  if (answer.ok) return 'refilled'
  return answer.reason === 'cooldown' || answer.reason === 'daily_cap' || answer.reason === 'plays_left' ? 'limit' : 'refused'
}

/** `energy_ad`'s acknowledgement, or undefined for a malformed one. */
export function grantAnswerOf (data: unknown): GrantAnswer | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { ok, reason } = data as { ok?: unknown, reason?: unknown }
  if (typeof ok !== 'boolean') return undefined
  return typeof reason === 'string' ? { ok, reason } : { ok }
}

/** The lobby's note after a click (CrazyGames: make the reward clear; on no ad, encourage a later try); undefined for none. */
export function refillNote (outcome: RefillOutcome): string | undefined {
  switch (outcome) {
    case 'refilled': return 'Plays refilled'
    case 'unavailable':
    case 'failed': return 'No ad right now, try again later'
    case 'adblock': return 'Ads are blocked'
    case 'refused':
    case 'no_answer': return 'Couldn\'t add plays, try again later'
    case 'limit': return undefined
  }
}

/** The button's label: it says a video plays, and what for. */
export const AD_BUTTON_TEXT = 'Watch an ad: refill plays'
