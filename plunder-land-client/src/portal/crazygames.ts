import type { PortalDevice, PortalSdk, PortalUser } from './adapter'
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
 * leaves the no-op behaviour, and **every SDK call goes through `guard`**
 * (or `ask`, its async form for the user module).
 *
 * The user module (g2-6c; docs.crazygames.com/sdk/user, read 2026-11-14):
 * `user.isUserAccountAvailable` (false where another site embeds the game:
 * then no user member is called at all), `getUser()` (null when logged out),
 * `getUserToken({ signingKeyType: 'IN_GAME_AUTH' })` (fresh on every call,
 * "use the same signing key for all the calls"; `userNotAuthenticated` when
 * logged out), `addAuthListener` (a login; a logout reloads the page, no
 * listener), `showAuthPrompt()` and `showAccountLinkPrompt()` (`{ response:
 * 'yes' | 'no' }`). Their errors (`userCancelled`, `...InProgress`) all read
 * as "no". On localhost the `local` environment answers demo values chosen by
 * `?user_response=`, `?token_response=`, `?link_account_response=`,
 * `?show_auth_prompt_response=` and `?user_account_available=`.
 *
 * The platform members (g2-6f; docs.crazygames.com/sdk/game, /sdk/user and
 * /resources/crazygames-app, read 2026-11-13): `user.systemInfo.device.type`
 * (`desktop`, `tablet` or `mobile`; "rely on our system info ... Don't rely on
 * touch detection"), `game.isOfflineMode` (the app plays a downloaded game
 * offline; "available once init() has resolved and does not change"), then
 * `game.updateRoom({ isJoinable: false })` once, `game.setGameContext` /
 * `clearGameContext` (attached to a player's feedback) and `game.happytime()`.
 * Both values are read once, as the SDK settles.
 */

export const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js'
/** The longest the SDK's load and `init` may take before the game plays on without it, ms. */
export const INIT_TIMEOUT_MS = 5000

interface CrazySettings { muteAudio?: boolean }

/** `getUser()`'s answer, as far as it is read. */
interface CrazyUser { username?: unknown, profilePictureUrl?: unknown }

/** `user.systemInfo`, as far as it is read (g2-6f). */
interface CrazySystemInfo { device?: { type?: unknown } }

/** The SDK's user module (g2-6c). Optional: a fake, or an SDK without it, has no accounts. */
export interface CrazyUserModule {
  isUserAccountAvailable: boolean
  /** Set whether or not accounts are available (g2-6f reads only the device type). */
  systemInfo?: CrazySystemInfo
  getUser: () => Promise<CrazyUser | null>
  getUserToken: (options: { signingKeyType: 'IN_GAME_AUTH' }) => Promise<string>
  addAuthListener: (listener: (user: CrazyUser | null) => void) => void
  showAuthPrompt: () => Promise<CrazyUser | null>
  showAccountLinkPrompt: () => Promise<{ response?: unknown } | null>
}

/** The longest token the server reads (`portalTokenOf`, server `network/portaltoken.ts`). */
const TOKEN_MAX = 4096

/** A user as the game reads it: a non-empty username, and the picture only over https. */
export function portalUserOf (raw: unknown): PortalUser | null {
  if (raw === null || typeof raw !== 'object') return null
  const { username, profilePictureUrl } = raw as CrazyUser
  if (typeof username !== 'string' || username.trim() === '') return null
  let avatar: string | undefined
  if (typeof profilePictureUrl === 'string') {
    try {
      if (new URL(profilePictureUrl).protocol === 'https:') avatar = profilePictureUrl
    } catch {
      avatar = undefined
    }
  }
  return { username, avatar }
}

/** The device type in `systemInfo`, or undefined for anything else. */
export function deviceOf (raw: unknown): PortalDevice | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const type = (raw as CrazySystemInfo).device?.type
  return type === 'desktop' || type === 'tablet' || type === 'mobile' ? type : undefined
}

/** An SDK method that must be there: one that isn't throws, so `guard` warns about it once. */
function required<T> (method: T | undefined, name: string): T {
  if (method === undefined) throw new Error(`${name} is not in this SDK`)
  return method
}

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
    // g2-6f. Optional for an older SDK or a fake: a missing method throws in `required` and `guard` warns once.
    isOfflineMode?: boolean
    updateRoom?: (room: { isJoinable: boolean }) => void
    setGameContext?: (context: Record<string, string>) => void
    clearGameContext?: () => void
    happytime?: () => void
  }
  user?: CrazyUserModule
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
  /** Read once as the SDK settles (g2-6f). */
  let device: PortalDevice | undefined
  let offline = false
  const muteListeners: Array<(muted: boolean) => void> = []
  const loginListeners: Array<() => void> = []
  /**
   * A login was told: once a page, since a logout reloads it. Both the SDK's
   * auth listener and a login modal answering with a user tell it (whether
   * the SDK also calls its listener for its own modal is not documented).
   */
  let loginTold = false
  const tellLogin = (): void => {
    if (loginTold) return
    loginTold = true
    loginListeners.forEach((listener) => {
      try {
        listener()
      } catch (e) {
        warn(`portal sdk: a login listener failed: ${String(e)}`)
      }
    })
  }
  /** CrazyGames' documented "no" answers: a logged-out user, a cancel, a modal already open. Not warned. */
  const expected = new Set(['userNotAuthenticated', 'userCancelled', 'userAlreadySignedIn', 'showAuthPromptInProgress', 'showAccountLinkPromptInProgress'])

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
  /** A value read off a usable SDK (not a call: not logged); `fallback` without one or on a throw (warned once). */
  const peek = <T>(name: string, read: (sdk: CrazySdk) => T, fallback: T): T => {
    if (sdk === undefined) return fallback
    try {
      return read(sdk)
    } catch (e) {
      if (!warned.has(name)) {
        warned.add(name)
        warn(`portal sdk: ${name} failed: ${String(e)}`)
      }
      return fallback
    }
  }
  /** The user module, only where accounts are available; never throws. */
  const accounts = (): CrazyUserModule | undefined => {
    try {
      const module = sdk?.user
      return module?.isUserAccountAvailable === true ? module : undefined
    } catch {
      return undefined
    }
  }
  /**
   * An async user-module call once the SDK has settled: `fallback` without
   * accounts, and on any throw or rejection (warned once per method).
   */
  const ask = async <T>(name: string, call: (module: CrazyUserModule) => Promise<T>, fallback: T): Promise<T> => {
    await ready
    const module = accounts()
    if (module === undefined) return fallback
    try {
      if (local) log(`portal sdk: ${name}`)
      return await call(module)
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code
      if (typeof code === 'string' && expected.has(code)) return fallback
      if (!warned.has(name)) {
        warned.add(name)
        warn(`portal sdk: ${name} failed: ${String(code ?? e)}`)
      }
      return fallback
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
    // g2-6f: the device the portal reads, and an offline launch (no room to join then).
    device = peek('systemInfo', (s) => deviceOf(s.user?.systemInfo), undefined)
    offline = peek('isOfflineMode', (s) => s.game.isOfflineMode === true, false)
    if (offline) guard('updateRoom', (s) => { required(s.game.updateRoom, 'updateRoom').call(s.game, { isJoinable: false }) })
    // One SDK listener for every `onLogin` (CrazyGames keeps one auth listener).
    if (accounts() !== undefined) {
      guard('addAuthListener', (s) => {
        s.user?.addAuthListener((user) => {
          if (user !== null && user !== undefined) tellLogin()
        })
      })
    }
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
    // g2-6c.
    user: async () => await ask('getUser', async (m) => portalUserOf(await m.getUser()), null),
    userToken: async () => await ask('getUserToken', async (m) => {
      const token: unknown = await m.getUserToken({ signingKeyType: 'IN_GAME_AUTH' })
      return typeof token === 'string' && token.length > 0 && token.length <= TOKEN_MAX ? token : null
    }, null),
    onLogin: (listener) => { loginListeners.push(listener) },
    linkPrompt: async () => await ask('showAccountLinkPrompt', async (m) => (await m.showAccountLinkPrompt())?.response === 'yes', false),
    authPrompt: async () => {
      const user = await ask('showAuthPrompt', async (m) => portalUserOf(await m.showAuthPrompt()), null)
      if (user !== null) tellLogin()
      return user !== null
    },
    accountsAvailable: () => accounts() !== undefined,
    // g2-6f.
    deviceType: () => device,
    offline: () => offline,
    setContext: (context) => {
      const copy = { ...context }
      whenReady('setGameContext', (s) => { required(s.game.setGameContext, 'setGameContext').call(s.game, copy) })
    },
    clearContext: () => { whenReady('clearGameContext', (s) => { required(s.game.clearGameContext, 'clearGameContext').call(s.game) }) },
    happytime: () => { whenReady('happytime', (s) => { required(s.game.happytime, 'happytime').call(s.game) }) },
    // g2-6d.
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
