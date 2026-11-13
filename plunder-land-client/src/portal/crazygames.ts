import type { PortalSdk } from './adapter'
import { noPortalSdk } from './none'

/**
 * The CrazyGames SDK v3 behind the portal adapter (decision #62, g2-6a).
 * Facts from docs.crazygames.com/sdk/intro and /sdk/game (read 2026-11-13):
 *
 * - `await SDK.init()` before anything else.
 * - `SDK.environment`: `crazygames` on their domains, `local` on localhost
 *   (demo data, the SDK logs to the console), `disabled` anywhere else, where
 *   "all the calls to the SDK methods will throw an error".
 * - `game.loadingStart`/`loadingStop` around loading; `gameplayStart` when
 *   play begins or resumes, `gameplayStop` at every break (menus, level end),
 *   but **not** when the tab is hidden or focus is lost: the platform handles
 *   that, so the game never calls it for that.
 * - `game.settings.muteAudio` outranks the game's own volume, and a settings
 *   change arrives through `game.addSettingsChangeListener`.
 *
 * The script is added at run time, only when `PORTAL` is `crazygames`
 * (`loadCrazyGamesScript`). Their docs show a static `<head>` tag; whether
 * their QA accepts a runtime one is unverified (g2-7/g2-8: switch to a
 * build-time variant if it doesn't).
 *
 * The game never waits on it longer than `INIT_TIMEOUT_MS`, and nothing here
 * throws: an SDK that fails to load, to init, or reports another environment
 * leaves the no-op behaviour, and **every SDK call goes through `guard`**.
 */

export const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js'
/** The longest the SDK's load and `init` may take before the game plays on without it, ms. */
export const INIT_TIMEOUT_MS = 5000

interface CrazySettings { muteAudio?: boolean }

/** The part of `window.CrazyGames.SDK` used so far. */
export interface CrazySdk {
  init: () => Promise<void>
  environment: string
  game: {
    loadingStart: () => void
    loadingStop: () => void
    gameplayStart: () => void
    gameplayStop: () => void
    settings: CrazySettings
    addSettingsChangeListener: (listener: (settings: CrazySettings) => void) => void
  }
}

export interface CrazyOptions {
  timeoutMs?: number
  /** The `local` environment's call log ("the calls are logged in order"). */
  log?: (line: string) => void
  /** A failed SDK call, once per method. */
  warn?: (line: string) => void
}

/** Resolves `promise`, or rejects after `ms`. */
async function within<T> (promise: Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`no answer in ${ms} ms`)) }, ms)
    promise.then((value) => { clearTimeout(timer); resolve(value) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/**
 * The adapter over a CrazyGames SDK that `load` fetches (the script tag in
 * the browser, a fake in the spec). Calls made before it is ready wait, in
 * order, and are dropped if it never becomes usable.
 */
export function crazyGamesSdk (load: () => Promise<CrazySdk | undefined>, options: CrazyOptions = {}): PortalSdk {
  const timeoutMs = options.timeoutMs ?? INIT_TIMEOUT_MS
  const log = options.log ?? ((line: string) => { console.info(line) })
  const warn = options.warn ?? ((line: string) => { console.warn(line) })
  const none = noPortalSdk()

  /** Set only once init resolved in a usable environment. */
  let sdk: CrazySdk | undefined
  let local = false
  let settled = false
  const pending: Array<() => void> = []
  const warned = new Set<string>()
  let muted = false
  const muteListeners: Array<(muted: boolean) => void> = []

  /** Every SDK call: only on a usable SDK, never throws. */
  const guard = (name: string, call: (sdk: CrazySdk) => void): void => {
    if (sdk === undefined) return
    try {
      if (local) log(`portal sdk: ${name}`)
      call(sdk)
    } catch (e) {
      if (warned.has(name)) return
      warned.add(name)
      warn(`portal sdk: ${name} failed: ${String(e)}`)
    }
  }
  /** A call now if the SDK has settled, else after it does, in order. */
  const whenReady = (name: string, call: (sdk: CrazySdk) => void): void => {
    if (settled) guard(name, call)
    else pending.push(() => { guard(name, call) })
  }
  const tellMute = (listener: (muted: boolean) => void): void => {
    try {
      listener(muted)
    } catch (e) {
      warn(`portal sdk: a mute listener failed: ${String(e)}`)
    }
  }

  const ready = (async (): Promise<void> => {
    let candidate: CrazySdk | undefined
    try {
      candidate = await within((async () => {
        const loaded = await load()
        if (loaded !== undefined) await loaded.init()
        return loaded
      })(), timeoutMs)
    } catch {
      candidate = undefined
    }
    let environment: unknown
    try {
      environment = candidate?.environment
    } catch {
      environment = undefined
    }
    if (candidate !== undefined && (environment === 'crazygames' || environment === 'local')) {
      sdk = candidate
      local = environment === 'local'
    }
    settled = true
    // Loading began before the SDK could hear it; a `loadingStop` already asked for follows.
    guard('loadingStart', (s) => { s.game.loadingStart() })
    guard('settings', (s) => {
      muted = s.game.settings?.muteAudio === true
      s.game.addSettingsChangeListener((settings) => {
        const now = settings?.muteAudio === true
        if (now === muted) return
        muted = now
        muteListeners.forEach(tellMute)
      })
    })
    if (muted) muteListeners.forEach(tellMute)
    pending.splice(0).forEach((call) => { call() })
  })()

  return {
    ready,
    loadingStop: () => { whenReady('loadingStop', (s) => { s.game.loadingStop() }) },
    gameplayStart: () => { whenReady('gameplayStart', (s) => { s.game.gameplayStart() }) },
    gameplayStop: () => { whenReady('gameplayStop', (s) => { s.game.gameplayStop() }) },
    onMute: (listener) => {
      muteListeners.push(listener)
      // After settling, the state now; before, the settle tells it if muted.
      if (settled && muted) tellMute(listener)
    },
    // g2-6b..d.
    user: none.user,
    userToken: none.userToken,
    onLogin: none.onLogin,
    linkPrompt: none.linkPrompt,
    rewardedAd: none.rewardedAd,
    adsAvailable: none.adsAvailable
  }
}

/** The SDK's script, added to the page; resolves the SDK object, or undefined if the script failed (an ad blocker). */
export async function loadCrazyGamesScript (): Promise<CrazySdk | undefined> {
  return await new Promise<CrazySdk | undefined>((resolve) => {
    const script = document.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.onload = () => { resolve((window as unknown as { CrazyGames?: { SDK?: CrazySdk } }).CrazyGames?.SDK) }
    script.onerror = () => { resolve(undefined) }
    document.head.appendChild(script)
  })
}
