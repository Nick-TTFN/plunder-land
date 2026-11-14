/**
 * The portal adapter (decision #62: "go full in with adapter"): everything the
 * game asks of a portal's SDK, behind one interface, so the game never names
 * a portal. `none.ts` is the no-op for our own site and itch, `crazygames.ts`
 * the CrazyGames SDK; Poki later is one more file. `index.ts` picks one from
 * `PORTAL`.
 *
 * g2-6a implements the first five members, g2-6c the user's (`user` to
 * `accountsAvailable`); the ad members land in g2-6d (until then every
 * implementation answers 'unavailable' or false).
 *
 * Pixi-free and `window`-free.
 */

/** The portal's signed-in player (g2-6c), as its SDK describes them; nothing here is verified. */
export interface PortalUser {
  username: string
  /** An `https:` picture URL, or undefined. Shown only in this player's own lobby. */
  avatar: string | undefined
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
  /** The signed-in player, or null: logged out, accounts unavailable here, no SDK, any error. Waits for `ready`. */
  user: () => Promise<PortalUser | null>
  /** A fresh signed token for the server (never stored), or null as for `user`. Waits for `ready`. */
  userToken: () => Promise<string | null>
  /** Called when a guest logs in while the page is open (a logout reloads the page: the portal does it). */
  onLogin: (listener: () => void) => void
  /** The portal's own "link your progress" modal: true for yes; false for no, any error, or no SDK. */
  linkPrompt: () => Promise<boolean>
  /** The portal's login modal. **Only ever from a click** (CrazyGames: never open it by itself). True if a user came back. */
  authPrompt: () => Promise<boolean>
  /** Whether the portal's accounts can be used on this page (false before `ready`, off the portal, embedded elsewhere). */
  accountsAvailable: () => boolean
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
    authPrompt: async () => await inner.authPrompt(),
    accountsAvailable: () => inner.accountsAvailable(),
    rewardedAd: async () => await inner.rewardedAd(),
    adsAvailable: () => inner.adsAvailable()
  }
}
