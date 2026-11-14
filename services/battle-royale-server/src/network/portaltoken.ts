import { createPublicKey, type KeyObject, verify as verifySignature } from 'node:crypto'

/**
 * CrazyGames user tokens (g2-6b, plan g2-0): who a logged-in CrazyGames
 * player is, so their progress can be linked to their CrazyGames account
 * (`Worlds`, rules 4a-4d in docs/accounts.md, "Portal accounts").
 *
 * The client asks the SDK for `getUserToken({ signingKeyType: "IN_GAME_AUTH" })`
 * and sends it as the handshake's `auth.portalToken`. It is a JWT signed by
 * CrazyGames: payload `userId, gameId, username, profilePictureUrl, iat, exp`,
 * a lifetime of one hour, keys published at `CG_JWKS_URL` (docs.crazygames.com
 * /sdk/user/, read 2026-11-13).
 *
 * **Hand-written on purpose (no JWT library, no new dependency), so every
 * rule is here and the spec matrix pins each one** (portaltoken.spec.ts). A
 * mistake is an account takeover, so it is deliberately narrow and fails
 * closed: anything it does not fully understand is "no token", and the
 * connection plays under today's guest rules.
 *
 * - The header's `alg` must be exactly `RS256` and its `kid` exactly
 *   `ingame-auth`. Everything else is refused before any key is looked at:
 *   `none`, `HS256` (the classic confusion, where the public key is used as an
 *   HMAC secret), every other alg, the legacy key `ingame-auth-legacy`, and a
 *   header with `crit` (an extension we don't implement).
 * - The key is the JWKS entry for that kid, RSA only, at least 2048 bits,
 *   built from `n` and `e` alone; the signature is checked with Node's
 *   `crypto.verify('RSA-SHA256', ...)` (PKCS#1 v1.5, as RS256 is).
 * - Only then is the payload read: `exp` and `iat` must be numbers, `exp` not
 *   past and `iat` not in the future, each by more than `SKEW_S`; `gameId`
 *   must equal our game id as a string; `userId` must be a short printable
 *   string. `username` is kept only if it has CrazyGames' documented shape
 *   (`CG_USERNAME_SHAPE`), else the identity carries none.
 * - **No game id, no tokens**: with `gameId` unset (`CRAZYGAMES_GAME_ID` not
 *   set on the host) every token is refused without a fetch.
 *
 * The JWKS is fetched lazily (the first token), kept, and fetched again
 * (at most once per `refetchMs`, every attempt counted, failed ones too) when
 * the kid is missing from it, when a signature fails against the kept key (a
 * key rotated under the same kid), or when it is older than `maxAgeMs`. Each
 * fetch is bounded by `fetchTimeoutMs`; a fetch that fails or times out keeps
 * the old keys and refuses the token at hand. `verify` never rejects.
 *
 * The JWKS URL, the clock and the fetch are constructor parameters, for the
 * specs; **never an env var** (an override in production would let anyone
 * who can set it mint logins).
 */

/** Where CrazyGames publishes its token keys. */
export const CG_JWKS_URL = 'https://userportal.crazygames.com/.well-known/jwks.json'

/** The only key id accepted: `IN_GAME_AUTH`'s. `ingame-auth-legacy` is refused. */
export const CG_KID = 'ingame-auth'

/** The only signature algorithm accepted. */
export const CG_ALG = 'RS256'

/** Clock skew allowed on `exp` and `iat`, in seconds. */
export const SKEW_S = 60

/** A token longer than this is refused unread (the handshake caps it too). */
export const PORTAL_TOKEN_MAX = 4096

/**
 * A CrazyGames username as documented: 6-20 of letters, digits, `.` and `_`.
 * Anything else is not shown (the run gets its callsign).
 */
export const CG_USERNAME_SHAPE = /^[A-Za-z0-9._]{6,20}$/

/** A user id we key a link on: 1-128 printable ASCII characters, no spaces. */
const USER_ID_SHAPE = /^[\x21-\x7e]{1,128}$/

/** One base64url segment of a JWT. */
const SEGMENT = /^[A-Za-z0-9_-]+$/

/** A JWKS body larger than this is refused. */
const JWKS_MAX_BYTES = 64 * 1024

/** What a verified token says. */
export interface PortalIdentity {
  /** CrazyGames' `userId`: the link's key (never the username, which can change). */
  userId: string
  /** The `username` when it has `CG_USERNAME_SHAPE`; undefined otherwise. */
  username?: string
}

/** Fetches `url`'s body as text, giving up when `signal` aborts. */
export type FetchText = (url: string, signal: AbortSignal) => Promise<string>

export interface PortalVerifierOptions {
  /** Our CrazyGames game id (`CRAZYGAMES_GAME_ID`). Unset or '': every token is refused. */
  gameId: string | undefined
  /** Specs only. Default `CG_JWKS_URL`. */
  jwksUrl?: string
  /** ms since the epoch. Specs pass their own. */
  now?: () => number
  /** Default 3000. */
  fetchTimeoutMs?: number
  /** At most one JWKS fetch per this many ms. Default 60 000. */
  refetchMs?: number
  /** Keys older than this are fetched again (rate-limited as above). Default one hour. */
  maxAgeMs?: number
  /** Specs only. Default: the global `fetch`, status 200 only, body capped. */
  fetchText?: FetchText
  /** Where a failed fetch is reported (throttled by the caller if it wants). Default: console.error. */
  onFetchError?: (e: unknown) => void
}

async function defaultFetchText (url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, redirect: 'error', headers: { accept: 'application/json' } })
  if (res.status !== 200) throw new Error(`portal: JWKS answered ${res.status}`)
  const length = Number(res.headers.get('content-length') ?? '0')
  if (length > JWKS_MAX_BYTES) throw new Error('portal: JWKS too large')
  const text = await res.text()
  if (text.length > JWKS_MAX_BYTES) throw new Error('portal: JWKS too large')
  return text
}

/** A JSON object out of one base64url segment, or undefined. */
function segmentJson (segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The RS256 keys of a JWKS body by kid; entries that aren't usable RSA signing keys are skipped. */
export function keysOf (body: string): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return keys
  }
  const list = parsed !== null && typeof parsed === 'object' ? (parsed as { keys?: unknown }).keys : undefined
  if (!Array.isArray(list)) return keys
  for (const jwk of list) {
    if (jwk === null || typeof jwk !== 'object') continue
    const { kid, kty, n, e, use, alg } = jwk as Record<string, unknown>
    if (typeof kid !== 'string' || kty !== 'RSA' || typeof n !== 'string' || typeof e !== 'string') continue
    if (use !== undefined && use !== 'sig') continue
    if (alg !== undefined && alg !== CG_ALG) continue
    try {
      // `n` and `e` only: nothing else in the entry can change what key this is.
      const key = createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' })
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue
      keys.set(kid, key)
    } catch {
      // A malformed entry is skipped, never fatal.
    }
  }
  return keys
}

export class PortalVerifier {
  readonly gameId: string | undefined
  private readonly jwksUrl: string
  private readonly now: () => number
  private readonly fetchTimeoutMs: number
  private readonly refetchMs: number
  private readonly maxAgeMs: number
  private readonly fetchText: FetchText
  private readonly onFetchError: (e: unknown) => void
  private keys = new Map<string, KeyObject>()
  /** When the kept keys were fetched; undefined before the first success. */
  private keysAt: number | undefined
  /** When the last fetch was started, failed ones included. */
  private fetchedAt: number | undefined
  private inFlight: Promise<void> | undefined
  /** Successful fetches so far: tells `refresh` whether its fetch brought keys. */
  private generation = 0
  /** JWKS fetches started: for the specs. */
  fetches = 0

  constructor (options: PortalVerifierOptions) {
    this.gameId = options.gameId === '' ? undefined : options.gameId
    this.jwksUrl = options.jwksUrl ?? CG_JWKS_URL
    this.now = options.now ?? (() => Date.now())
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 3000
    this.refetchMs = options.refetchMs ?? 60_000
    this.maxAgeMs = options.maxAgeMs ?? 3_600_000
    this.fetchText = options.fetchText ?? defaultFetchText
    this.onFetchError = options.onFetchError ?? ((e) => { console.error('portal: JWKS fetch failed:', e) })
  }

  /** Whether tokens can be verified at all (a game id is set). */
  get enabled (): boolean {
    return this.gameId !== undefined
  }

  /** The identity `token` proves, or null. Never rejects. */
  async verify (token: unknown): Promise<PortalIdentity | null> {
    try {
      return await this.check(token)
    } catch {
      return null
    }
  }

  private async check (token: unknown): Promise<PortalIdentity | null> {
    const gameId = this.gameId
    if (gameId === undefined) return null
    if (typeof token !== 'string' || token.length > PORTAL_TOKEN_MAX) return null
    const parts = token.split('.')
    if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return null
    const [head, body, signature] = parts
    const header = segmentJson(head)
    if (header === undefined) return null
    // The algorithm and the key are ours to choose, never the token's: exact
    // values only, checked before any key is touched.
    if (header.alg !== CG_ALG || header.kid !== CG_KID || 'crit' in header) return null
    const signed = Buffer.from(`${head}.${body}`, 'ascii')
    const sig = Buffer.from(signature, 'base64url')
    if (!(await this.signedByCg(signed, sig))) return null

    const payload = segmentJson(body)
    if (payload === undefined) return null
    const nowS = this.now() / 1000
    const { exp, iat, userId, username } = payload
    if (typeof exp !== 'number' || !Number.isFinite(exp) || nowS > exp + SKEW_S) return null
    if (typeof iat !== 'number' || !Number.isFinite(iat) || iat > nowS + SKEW_S) return null
    // A string compare: the docs' example `gameId` is a string ("20267"); a
    // number is compared by its decimal form.
    const tokenGame = typeof payload.gameId === 'string' ? payload.gameId : typeof payload.gameId === 'number' ? String(payload.gameId) : undefined
    if (tokenGame !== gameId) return null
    if (typeof userId !== 'string' || !USER_ID_SHAPE.test(userId)) return null
    const identity: PortalIdentity = { userId }
    if (typeof username === 'string' && CG_USERNAME_SHAPE.test(username)) identity.username = username
    return identity
  }

  /**
   * Whether `sig` is CrazyGames' RS256 signature of `signed` under `CG_KID`.
   * Fetches the keys when there are none, when the kid is missing, when they
   * are older than `maxAgeMs`, or (once) when the kept key fails, all within
   * the refetch limit.
   */
  private async signedByCg (signed: Buffer, sig: Buffer): Promise<boolean> {
    const stale = this.keysAt === undefined || this.now() - this.keysAt > this.maxAgeMs
    if (stale || !this.keys.has(CG_KID)) await this.refresh()
    const key = this.keys.get(CG_KID)
    if (key === undefined) return false
    if (verifySignature('RSA-SHA256', signed, key, sig)) return true
    // Perhaps rotated under the same kid: fetch once more if allowed.
    if (!(await this.refresh())) return false
    const again = this.keys.get(CG_KID)
    return again !== undefined && again !== key && verifySignature('RSA-SHA256', signed, again, sig)
  }

  /**
   * Fetch the JWKS if the limit allows (one in flight at a time, shared);
   * true when a fetch ran (or was joined) and succeeded. A failure keeps the
   * old keys.
   */
  private async refresh (): Promise<boolean> {
    if (this.inFlight === undefined) {
      const now = this.now()
      if (this.fetchedAt !== undefined && now - this.fetchedAt < this.refetchMs) return false
      this.fetchedAt = now
      this.fetches++
      this.inFlight = this.fetchKeys().finally(() => { this.inFlight = undefined })
    }
    const before = this.generation
    await this.inFlight
    return this.generation !== before
  }

  private async fetchKeys (): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error(`portal: JWKS fetch timed out after ${this.fetchTimeoutMs} ms`)) }, this.fetchTimeoutMs)
    timer.unref()
    try {
      const fetched = this.fetchText(this.jwksUrl, controller.signal)
      // A fetch that ignores the signal still loses the race.
      const aborted = new Promise<never>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => { reject(controller.signal.reason) }, { once: true })
      })
      const body = await Promise.race([fetched, aborted])
      fetched.catch(() => {})
      const keys = keysOf(body)
      if (keys.size === 0) throw new Error('portal: JWKS holds no usable key')
      this.keys = keys
      this.keysAt = this.now()
      this.generation++
    } catch (e) {
      this.onFetchError(e)
    } finally {
      clearTimeout(timer)
    }
  }
}

let unsetLogged = false

/**
 * The server's verifier: `CRAZYGAMES_GAME_ID` from `env`, CrazyGames' real
 * JWKS. Unset, every portal token is ignored (guest play), and that is
 * logged once per process.
 */
export function portalVerifierFromEnv (env: NodeJS.ProcessEnv = process.env): PortalVerifier {
  const verifier = new PortalVerifier({ gameId: env.CRAZYGAMES_GAME_ID })
  if (!verifier.enabled && !unsetLogged) {
    unsetLogged = true
    console.log('portal: CRAZYGAMES_GAME_ID unset; CrazyGames tokens are ignored (guest play)')
  }
  return verifier
}

/**
 * The handshake's `auth.portalToken`, if it is a string no longer than
 * `PORTAL_TOKEN_MAX`. Whether to read it at all is the caller's
 * (`portalOf(auth) === 'crazygames'`).
 */
export function portalTokenOf (auth: unknown): string | undefined {
  if (auth === null || typeof auth !== 'object') return undefined
  const token = (auth as { portalToken?: unknown }).portalToken
  return typeof token === 'string' && token.length > 0 && token.length <= PORTAL_TOKEN_MAX ? token : undefined
}
