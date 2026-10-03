/**
 * The guest account (decision #48). Pixi-free, so the server's specs run it.
 *
 * The server issues a secret token on this browser's first play, in an
 * `account { id, token }` event; it is kept in localStorage (`TOKEN_KEY`)
 * and sent in every connection's socket.io handshake (`auth`), which
 * socket.io re-reads on each reconnect, so a token stored during the first
 * run is used from the next connection on. The server then answers
 * `account { id }`. `offline` means the server's account store failed and
 * this connection plays under a made-up id: nothing is stored.
 *
 * Storage that is blocked or cleared means a new account next play: the
 * accepted risk in #48.
 *
 * XP and levels (decision #48 step 3): a persisted account's `account` event
 * carries its standing (`xp`, `level`, `levelAt`, `nextAt`), and after each
 * run the server sends `progress { gained, xp, level, levelAt, nextAt,
 * levelUp }` once the grant is written. The level is the server's: the curve
 * is not copied here. An offline account has no standing and earns nothing.
 */
import { type Loadouts, type SavedAnswer, mergeSaved, parseLoadouts } from './loadout'

export const TOKEN_KEY = 'plunderland_token'

/** The token's shape, as the server makes and checks it (`TOKEN_SHAPE` in its `db/accounts.ts`). */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** What this page needs of localStorage; a failure means "not remembered". */
export interface TokenStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** An account's XP and level, as the server computed them. */
export interface Standing {
  xp: number
  level: number
  /** Total XP at which `level` began. */
  levelAt: number
  /** Total XP at which the next level begins. */
  nextAt: number
}

/** What the server said about this connection's account. */
export interface AccountInfo {
  id: string
  offline: boolean
  /** Undefined offline, or from a server before XP. */
  standing: Standing | undefined
  /**
   * Each robot's saved skill loadouts (decision #48 step 4), as a join would
   * play them, by robot key and loadout index. Undefined offline, before the
   * server has said, or from a server before loadouts; a missing robot or
   * loadout reads as the start kit (`loadoutOf`).
   */
  loadouts: Loadouts | undefined
}

/** A `progress` event: what the run just ended earned, and the standing after it. */
export interface ProgressInfo extends Standing {
  gained: number
  levelUp: boolean
}

/**
 * This connection's account, as last announced, and who wants to hear when
 * it changes (the lobby's level). Cleared on every (re)connect: a new
 * connection's account is announced again, and until then the last one's is
 * not this one's.
 */
export const ACCOUNT: { info: AccountInfo | undefined, listeners: Set<() => void> } = { info: undefined, listeners: new Set() }

/** Replace the announced account and tell the listeners. */
export function setAccountInfo (info: AccountInfo | undefined): void {
  ACCOUNT.info = info
  // forEach, not for-of: the client's tsconfig targets ES5 for typechecking.
  ACCOUNT.listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // One broken listener must not stop the others.
    }
  })
}

/** A whole number that is at least 0, or undefined. */
function count (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** The standing in a message, if it has a whole, consistent one. */
export function standingOf (data: unknown): Standing | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const xp = count(d.xp)
  const level = count(d.level)
  const levelAt = count(d.levelAt)
  const nextAt = count(d.nextAt)
  if (xp === undefined || level === undefined || level < 1 || levelAt === undefined || nextAt === undefined) return undefined
  if (levelAt > xp || nextAt <= xp) return undefined
  return { xp, level, levelAt, nextAt }
}

/** A `progress` event, or undefined for a malformed one. */
export function onProgress (data: unknown): ProgressInfo | undefined {
  const standing = standingOf(data)
  if (standing === undefined) return undefined
  const { gained, levelUp } = data as { gained?: unknown, levelUp?: unknown }
  const g = count(gained)
  if (g === undefined || g > standing.xp) return undefined
  return { ...standing, gained: g, levelUp: levelUp === true }
}

/** A run's XP landed: the announced account's standing moves with it. */
export function applyProgress (progress: ProgressInfo): void {
  const info = ACCOUNT.info
  if (info === undefined || info.offline) return
  const { xp, level, levelAt, nextAt } = progress
  setAccountInfo({ ...info, standing: { xp, level, levelAt, nextAt } })
}

/** The stored token, if there is a well-formed one. */
export function readToken (storage: TokenStorage | undefined): string | undefined {
  try {
    const token = storage?.getItem(TOKEN_KEY) ?? null
    return token !== null && TOKEN_SHAPE.test(token) ? token : undefined
  } catch {
    return undefined
  }
}

/** The handshake's `auth`, read on every (re)connect: `{ token }`, or `{}` with none. */
export function handshakeAuth (storage: () => TokenStorage | undefined): (cb: (data: object) => void) => void {
  return (cb) => {
    const token = readToken(storage())
    cb(token === undefined ? {} : { token })
  }
}

/**
 * An `account` event: stores a token that came with it, and returns what the
 * page may show (the id), or undefined for a malformed one.
 */
export function onAccount (data: unknown, storage: TokenStorage | undefined): AccountInfo | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { id, token, offline } = data as { id?: unknown, token?: unknown, offline?: unknown }
  if (typeof id !== 'string') return undefined
  if (offline !== true && typeof token === 'string' && TOKEN_SHAPE.test(token)) {
    try {
      storage?.setItem(TOKEN_KEY, token)
    } catch {
      // Not remembered: the next play makes a new account.
    }
  }
  if (offline === true) return { id, offline: true, standing: undefined, loadouts: undefined }
  // The mid-run `account` (a grant's) carries no loadouts: keep the ones this
  // id was last sent, never another account's.
  const previous = ACCOUNT.info?.id === id && !ACCOUNT.info.offline ? ACCOUNT.info.loadouts : undefined
  const loadouts = parseLoadouts((data as { loadouts?: unknown }).loadouts) ?? previous
  return { id, offline: false, standing: standingOf(data), loadouts }
}

/**
 * A `loadout_saved` answer landed: the announced account's loadouts take the
 * server's answer (`mergeSaved`), so a lobby built after this run shows it.
 */
export function applySaved (answer: SavedAnswer): void {
  const info = ACCOUNT.info
  if (info === undefined || info.offline || answer.busy) return
  setAccountInfo({ ...info, loadouts: mergeSaved(info.loadouts, answer) })
}

/** localStorage, or undefined where touching it throws. */
export function localTokenStorage (): TokenStorage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/** How long the run card waits for the run's XP before it says it is unavailable. */
export const PROGRESS_WAIT_MS = 6000

/**
 * The run card's XP line (`ui/popups/runsummary.ts`): what it says, and its
 * tone. Here so a spec can run it without pixi.
 */
export function xpLine (progress: ProgressInfo | undefined, waited: boolean, offline: boolean): [string, 'pending' | 'muted' | 'text' | 'accent'] {
  if (progress !== undefined) {
    return progress.levelUp
      ? [`+${progress.gained}  LEVEL UP ${progress.level}`, 'accent']
      : [`+${progress.gained}  LV ${progress.level}`, 'text']
  }
  // An offline run earns nothing, so there is nothing to wait for.
  if (offline || waited) return ['UNAVAILABLE', 'muted']
  return ['...', 'pending']
}
