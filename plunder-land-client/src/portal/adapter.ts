/**
 * The portal adapter (decision #62: "go full in with adapter"): everything the
 * game asks of a portal's SDK, behind one interface, so the game never names
 * a portal. `none.ts` is the no-op for our own site and itch, `crazygames.ts`
 * the CrazyGames SDK; Poki later is one more file. `index.ts` picks one from
 * `PORTAL`.
 *
 * g2-6a implements the first five members; the rest are declared now and
 * land in g2-6b..d (until then every implementation answers null, false or
 * 'unavailable').
 *
 * Pixi-free and `window`-free.
 */

/** The portal's signed-in player (g2-6b). */
export interface PortalUser {
  username: string
}

export type RewardedResult = 'rewarded' | 'unavailable' | 'failed'

export interface PortalSdk {
  /** Resolves once the SDK is usable or given up on; never rejects, never waits past its timeout. */
  readonly ready: Promise<void>
  /** Loading is done: the lobby is up. */
  loadingStop: () => void
  /** Play begins or resumes: a run started. */
  gameplayStart: () => void
  /** A break in play: the run ended, the lobby is back. */
  gameplayStop: () => void
  /** The portal's own mute, which outranks the game's volume; called with the state now and on each change. */
  onMute: (listener: (muted: boolean) => void) => void
  user: () => Promise<PortalUser | null>
  userToken: () => Promise<string | null>
  onLogin: (listener: () => void) => void
  linkPrompt: () => Promise<boolean>
  rewardedAd: () => Promise<RewardedResult>
  adsAvailable: () => boolean
}

/**
 * The game's calls as the portal should see them: `loadingStop` once a page,
 * and `gameplayStart`/`gameplayStop` only on a change, so the game can call
 * them wherever play may begin or end without counting. A handoff's second
 * `hello` is the same run: no second start. Everything else passes through.
 */
export function withGameplayState (inner: PortalSdk): PortalSdk {
  let loaded = false
  let playing = false
  return {
    ready: inner.ready,
    loadingStop: () => {
      if (loaded) return
      loaded = true
      inner.loadingStop()
    },
    gameplayStart: () => {
      if (playing) return
      playing = true
      inner.gameplayStart()
    },
    gameplayStop: () => {
      if (!playing) return
      playing = false
      inner.gameplayStop()
    },
    onMute: (listener) => { inner.onMute(listener) },
    user: async () => await inner.user(),
    userToken: async () => await inner.userToken(),
    onLogin: (listener) => { inner.onLogin(listener) },
    linkPrompt: async () => await inner.linkPrompt(),
    rewardedAd: async () => await inner.rewardedAd(),
    adsAvailable: () => inner.adsAvailable()
  }
}
