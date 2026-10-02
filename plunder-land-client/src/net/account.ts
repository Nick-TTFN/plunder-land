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
 */
export const TOKEN_KEY = 'plunderland_token'

/** The token's shape, as the server makes and checks it (`TOKEN_SHAPE` in its `db/accounts.ts`). */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** What this page needs of localStorage; a failure means "not remembered". */
export interface TokenStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** What the server said about this connection's account. */
export interface AccountInfo {
  id: string
  offline: boolean
}

/** This connection's account, as last announced; read by later steps (level, energy). */
export const ACCOUNT: { info: AccountInfo | undefined } = { info: undefined }

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
  return { id, offline: offline === true }
}

/** localStorage, or undefined where touching it throws. */
export function localTokenStorage (): TokenStorage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
