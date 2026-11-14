import type { PortalDevice, PortalRoom, PortalSdk, PortalUser, RewardedResult } from './adapter'

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
 *
 * The ad module (g2-6d; docs.crazygames.com/sdk/video-ads and
 * /requirements/ads, read 2026-11-13): `ad.requestAd('rewarded', { adStarted,
 * adFinished, adError })`, the reward only on `adFinished`, never on
 * `adError`, whose `code` is `adsDisabled` (no ads this session: Basic
 * Launch, kids mode, offline), `unfilled`, `adblock`, `adCooldown` or
 * `other`; "mute the audio ... when the ad starts (adStarted)", "Only mute
 * the audio when the ad actually starts playing, and not when you request
 * an ad", and unmute on `adFinished` or `adError`; `ad.hasAdblock()` (a
 * promise of a boolean). The SDK exposes no "ads enabled" flag before a
 * request, so `adsAvailable` stays true until an `adsDisabled` answer
 * (the server's `AD_REFILL_PORTALS` switch is what keeps the button away
 * during Basic Launch). Only `'rewarded'` is ever requested here.
 *
 * The room (g2-6e; docs.crazygames.com/sdk/game "Multiplayer" and
 * /requirements/multiplayer, read 2026-11-13 and 2026-11-14):
 * `game.updateRoom({ roomId, isJoinable, inviteParams })` ("The room doesn't
 * have to exist on the server"), `game.leftRoom()`, `game.inviteParams`
 * ("null if the game wasn't started from an invite link"),
 * `game.addJoinRoomListener(listener(inviteParams))` (a join while the game is
 * open), `game.inviteLink(params)` (returns the link) and
 * `game.isInstantMultiplayer`. The deprecated `showInviteButton` /
 * `hideInviteButton` are never used. **On an offline launch no room call goes
 * out at all** (`whenOnline`, `updateRoom`'s own check), so g2-6f's one `updateRoom({ isJoinable:
 * false })` is never undone, and no invite is read or made.
 */

export const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js'
/** The longest the SDK's load and `init` may take before the game plays on without it, ms. */
export const INIT_TIMEOUT_MS = 5000
/**
 * The longest a rewarded ad may leave the lobby waiting for `adFinished` or
 * `adError` before it reads as `failed` (and the sound comes back): a safety
 * for an SDK that never calls back, well past any ad's length. An
 * `adFinished` after it rewards nothing.
 */
export const AD_MAX_MS = 180_000
/**
 * The SDK's throttle on `game.updateRoom` (g2-6e-1; read in
 * crazygames-sdk-v3.js 2026-11-14): a call goes out only when more than 250 ms
 * (by `Date`) passed since the last one that went out, and a faster one throws
 * `rateLimited` (the `local` environment doesn't throttle). So the adapter
 * holds a room asked for sooner and sends the latest one once the window is up.
 */
export const ROOM_GAP_MS = 250

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

/** `adError`'s `code` as the game reads it (g2-6d). `adsDisabled` and `adblock` also change what the adapter says afterwards. */
export function rewardedResultOf (error: unknown): RewardedResult {
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'adsDisabled' || code === 'unfilled' || code === 'adCooldown') return 'unavailable'
  if (code === 'adblock') return 'adblock'
  return 'failed'
}

/** The most invite params read, and the longest key or value: an invite is anyone's to craft. */
const PARAMS_MAX = 16
const PARAM_MAX = 256

/**
 * Invite params as the game reads them (g2-6e): an object's own string
 * values (keys and values at most `PARAM_MAX` long, at most `PARAMS_MAX`),
 * or null for anything else or nothing left.
 */
export function inviteParamsOf (raw: unknown): Record<string, string> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= PARAMS_MAX) break
    if (typeof value !== 'string' || key.length > PARAM_MAX || value.length > PARAM_MAX) continue
    out[key] = value
    count++
  }
  return count === 0 ? null : out
}

/** The longest invite link taken from the SDK. */
const LINK_MAX = 2048

/** `inviteLink`'s answer as the game uses it: a non-empty string, or null. */
export function inviteLinkOf (raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= LINK_MAX ? raw : null
}

/** The SDK's ad module, as far as it is used (g2-6d). Optional on `CrazySdk`: a fake, or an SDK without it, has no ads. */
export interface CrazyAdModule {
  requestAd: (type: 'rewarded', callbacks: { adStarted?: () => void, adFinished?: () => void, adError?: (error: unknown) => void }) => unknown
  hasAdblock?: () => Promise<boolean>
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
    updateRoom?: (room: { roomId?: string, isJoinable?: boolean, inviteParams?: Record<string, string> }) => void
    // g2-6e, optional likewise.
    leftRoom?: () => void
    inviteParams?: unknown
    addJoinRoomListener?: (listener: (params: unknown) => void) => void
    inviteLink?: (params: Record<string, string>) => unknown
    isInstantMultiplayer?: boolean
    setGameContext?: (context: Record<string, string>) => void
    clearGameContext?: () => void
    happytime?: () => void
  }
  user?: CrazyUserModule
  ad?: CrazyAdModule
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

  /** Set only once init resolved in a usable environment. */
  let sdk: CrazySdk | undefined
  let local = false
  let settled = false
  const pending: Array<() => void> = []
  const warned = new Set<string>()
  /** The portal's own mute (`settings.muteAudio`). */
  let muted = false
  /** A rewarded ad is playing (g2-6d): from `adStarted` to its end. */
  let adPlaying = false
  /** What the mute listeners were last told: the portal's mute or an ad playing. */
  const heard = (): boolean => muted || adPlaying
  /** `adsDisabled` was answered once: no ads for the rest of the page (g2-6d). */
  let adsDisabled = false
  /** An ad blocker is known (the script blocked, `hasAdblock`, an `adblock` answer). */
  let adBlocked = false
  /** The rewarded ad in flight, if any: a second call gets the same promise. */
  let adInFlight: Promise<RewardedResult> | undefined
  /** Read once as the SDK settles (g2-6f). */
  let device: PortalDevice | undefined
  let offline = false
  /** Read once as the SDK settles (g2-6e). */
  let instant = false
  const joinListeners: Array<(params: Record<string, string>) => void> = []
  const tellJoin = (params: Record<string, string>): void => {
    joinListeners.forEach((listener) => {
      try {
        listener({ ...params })
      } catch (e) {
        warn(`portal sdk: a join listener failed: ${String(e)}`)
      }
    })
  }
  /**
   * The room waiting for `ROOM_GAP_MS` to pass (g2-6e-1): only the latest is
   * kept. `roomSentAt` is when the SDK was last called with one (`Date.now()`).
   */
  let roomHeld: { roomId?: string, isJoinable: boolean, inviteParams?: Record<string, string> } | undefined
  let roomSentAt: number | undefined
  let roomTimer: ReturnType<typeof setTimeout> | undefined
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
  /** A room call (g2-6e): as `whenReady`, but never on an offline launch (g2-6f told the portal the room can't be joined). */
  const whenOnline = (name: string, call: (sdk: CrazySdk) => void): void => {
    const run = (): void => { if (!offline) guard(name, call) }
    if (settled) run()
    else pending.push(run)
  }
  /**
   * Sends the held room if the SDK's window is up, else once it is (a trailing
   * send: the latest room asked for by then). A `rateLimited` throw anyway
   * holds it again, unless a newer one is held, and retries after the window.
   * Only once settled and never offline (the callers check; offline never
   * changes after settling, so a timer set online stays online).
   */
  const sendRoom = (): void => {
    if (roomTimer !== undefined || roomHeld === undefined) return
    if (roomSentAt !== undefined) {
      const wait = roomSentAt + ROOM_GAP_MS - Date.now()
      if (wait >= 0) {
        // Capped: a clock set back must not hold the room for longer than a window.
        roomTimer = setTimeout(() => { roomTimer = undefined; sendRoom() }, Math.min(wait, ROOM_GAP_MS) + 1)
        return
      }
    }
    const room = roomHeld
    roomHeld = undefined
    roomSentAt = Date.now()
    guard('updateRoom', (s) => {
      try {
        required(s.game.updateRoom, 'updateRoom').call(s.game, room)
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== 'rateLimited') throw e
        if (roomHeld === undefined) roomHeld = room
        sendRoom()
      }
    })
  }
  const tellMute = (listener: (muted: boolean) => void): void => {
    try {
      listener(heard())
    } catch (e) {
      warn(`portal sdk: a mute listener failed: ${String(e)}`)
    }
  }
  /** Whether an ad plays, telling the mute listeners when what they hear changes. */
  const setAdPlaying = (playing: boolean): void => {
    const before = heard()
    adPlaying = playing
    if (heard() !== before) muteListeners.forEach(tellMute)
  }
  /** One rewarded ad on a usable SDK; see `PortalSdk.rewardedAd`. */
  const requestRewarded = async (): Promise<RewardedResult> => {
    await ready
    if (sdk === undefined) return adBlocked ? 'adblock' : 'unavailable'
    if (adsDisabled) return 'unavailable'
    const ad = peek('ad', (s) => s.ad, undefined)
    if (ad === undefined) return 'unavailable'
    return await new Promise<RewardedResult>((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const end = (result: RewardedResult): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        setAdPlaying(false)
        if (local) log(`portal sdk: rewarded ad ${result}`)
        resolve(result)
      }
      timer = setTimeout(() => { end('failed') }, AD_MAX_MS)
      try {
        if (local) log('portal sdk: requestAd rewarded')
        ad.requestAd('rewarded', {
          // Muted only once it plays, never at the request (CrazyGames' rule).
          adStarted: () => { if (!done) setAdPlaying(true) },
          adFinished: () => { end('rewarded') },
          adError: (error: unknown) => {
            const result = rewardedResultOf(error)
            const code = (error as { code?: unknown } | null)?.code
            if (code === 'adsDisabled') adsDisabled = true
            if (result === 'adblock') adBlocked = true
            end(result)
          }
        })
      } catch (e) {
        if (!warned.has('requestAd')) {
          warned.add('requestAd')
          warn(`portal sdk: requestAd failed: ${String(e)}`)
        }
        end('failed')
      }
    })
  }

  const ready = (async (): Promise<void> => {
    let candidate: CrazySdk | undefined
    try {
      candidate = await within((async () => {
        const loaded = await load()
        // The script didn't load (its `onerror`): on CrazyGames that is
        // almost always an ad blocker (g2-6d says so where an ad is offered).
        if (loaded === undefined) adBlocked = true
        else await loaded.init()
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
        const before = heard()
        muted = settings?.muteAudio === true
        if (heard() !== before) muteListeners.forEach(tellMute)
      })
    })
    if (heard()) muteListeners.forEach(tellMute)
    // g2-6f: the device the portal reads, and an offline launch (no room to join then).
    device = peek('systemInfo', (s) => deviceOf(s.user?.systemInfo), undefined)
    offline = peek('isOfflineMode', (s) => s.game.isOfflineMode === true, false)
    if (offline) {
      roomSentAt = Date.now()
      guard('updateRoom', (s) => { required(s.game.updateRoom, 'updateRoom').call(s.game, { isJoinable: false }) })
    }
    // g2-6e: launched from the portal's multiplayer flow, and joins while the
    // page is open (one SDK listener for every `onJoinRoom`). Not offline.
    instant = peek('isInstantMultiplayer', (s) => s.game.isInstantMultiplayer === true, false)
    if (!offline && peek('addJoinRoomListener', (s) => typeof s.game.addJoinRoomListener === 'function', false)) {
      guard('addJoinRoomListener', (s) => {
        s.game.addJoinRoomListener?.call(s.game, (raw) => {
          if (offline) return
          const params = inviteParamsOf(raw)
          if (local) log(`portal sdk: join room ${JSON.stringify(params)}`)
          if (params !== null) tellJoin(params)
        })
      })
    }
    // One SDK listener for every `onLogin` (CrazyGames keeps one auth listener).
    if (accounts() !== undefined) {
      guard('addAuthListener', (s) => {
        s.user?.addAuthListener((user) => {
          if (user !== null && user !== undefined) tellLogin()
        })
      })
    }
    // g2-6d: the portal's own ad-blocker check, once; its answer arrives later.
    const adModule = peek('ad', (s) => s.ad, undefined)
    if (adModule?.hasAdblock !== undefined) {
      guard('hasAdblock', () => {
        void adModule.hasAdblock?.call(adModule).then((present) => { if (present === true) adBlocked = true }, () => {})
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
      if (settled && heard()) tellMute(listener)
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
    rewardedAd: async () => {
      if (adInFlight !== undefined) return await adInFlight
      const request = requestRewarded()
      adInFlight = request
      try {
        return await request
      } finally {
        if (adInFlight === request) adInFlight = undefined
      }
    },
    adsAvailable: () => settled && !adsDisabled && peek('ad', (s) => s.ad !== undefined, false),
    adBlocked: () => adBlocked,
    // g2-6e.
    // Held and sent at most once per `ROOM_GAP_MS`, the latest room winning (g2-6e-1).
    updateRoom: (room: PortalRoom) => {
      roomHeld = { roomId: room.roomId, isJoinable: room.isJoinable, inviteParams: { ...room.inviteParams } }
      const run = (): void => { if (!offline) sendRoom() }
      if (settled) run()
      else pending.push(run)
    },
    leftRoom: () => { whenOnline('leftRoom', (s) => { required(s.game.leftRoom, 'leftRoom').call(s.game) }) },
    inviteParams: async () => {
      await ready
      if (offline) return null
      const params = peek('inviteParams', (s) => inviteParamsOf(s.game.inviteParams), null)
      if (local) log(`portal sdk: inviteParams ${JSON.stringify(params)}`)
      return params
    },
    onJoinRoom: (listener) => { joinListeners.push(listener) },
    inviteLink: (params) => {
      if (!settled || offline) return null
      const copy = { ...params }
      const link = peek('inviteLink', (s) => typeof s.game.inviteLink === 'function' ? inviteLinkOf(s.game.inviteLink(copy)) : null, null)
      if (local) log(`portal sdk: inviteLink ${JSON.stringify(copy)} -> ${String(link)}`)
      return link
    },
    instantMultiplayer: () => instant
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
