import { createHash, randomBytes } from 'node:crypto'

/**
 * Guest accounts (decision #48, step 1). The server issues each new player a
 * random secret token on first play; the client keeps it in localStorage and
 * sends it in the socket.io handshake. The player id is the account's
 * `publicId`, never anything the client says.
 *
 * Fail open, no grants: a database that is down, slow or not yet migrated
 * never stops anyone playing. Such a connection gets an offline account
 * (`offlineAccount`), which writes no Redis stats and is sent no token
 * (`Worlds`).
 */
export interface Account {
  /** 16 lowercase hex digits: the player id (Redis keys, /stats, GA `client_id`). */
  publicId: string
  /** False for an offline account: made up for one connection while the store failed. */
  persisted: boolean
}

export interface AccountStore {
  /** The account whose token this is, `null` for none. Throws when the store fails. */
  resolve: (token: string) => Promise<Account | null>
  /** A new account and its token, which is never stored. Throws when the store fails. */
  create: () => Promise<{ account: Account, token: string }>
  close: () => Promise<void>
}

/** A token as `newToken` makes it: 32 bytes, base64url, no padding. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** A public id as `newPublicId` makes it; also the database's CHECK. */
export const PUBLIC_ID_SHAPE = /^[0-9a-f]{16}$/

/** 256 random bits. A slow hash buys nothing for a secret this size. */
export function newToken (): string {
  return randomBytes(32).toString('base64url')
}

/** What is stored for a token: its SHA-256. */
export function hashToken (token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

/** 64 random bits as 16 lowercase hex digits. */
export function newPublicId (): string {
  return randomBytes(8).toString('hex')
}

/** An account for one connection while the store is failing (fail open). */
export function offlineAccount (): Account {
  return { publicId: newPublicId(), persisted: false }
}

/**
 * The token in a handshake's `auth` (`{ token }`), if it has the shape
 * `newToken` gives; anything else is treated as no token at all.
 */
export function tokenOf (auth: unknown): string | undefined {
  if (auth === null || typeof auth !== 'object') return undefined
  const token = (auth as { token?: unknown }).token
  return typeof token === 'string' && TOKEN_SHAPE.test(token) ? token : undefined
}

/**
 * Accounts in a Map, for specs, the load harness and a bare local run (no
 * `DATABASE_URL`). **It never evicts**: about 200 bytes an account, kept until
 * the process ends, which is deliberate for a dev store and wrong for
 * production (every deploy forgets every account; `openAccountStore` reports
 * that on Railway).
 */
export class MemoryAccountStore implements AccountStore {
  /** Public id by token hash (hex). */
  private readonly byHash = new Map<string, string>()
  private readonly ids = new Set<string>()

  async resolve (token: string): Promise<Account | null> {
    const publicId = this.byHash.get(hashToken(token).toString('hex'))
    return publicId === undefined ? null : { publicId, persisted: true }
  }

  async create (): Promise<{ account: Account, token: string }> {
    let publicId = newPublicId()
    while (this.ids.has(publicId)) publicId = newPublicId()
    const token = newToken()
    this.ids.add(publicId)
    this.byHash.set(hashToken(token).toString('hex'), publicId)
    return { account: { publicId, persisted: true }, token }
  }

  async close (): Promise<void> {}

  /** Accounts held. */
  get size (): number {
    return this.byHash.size
  }

  /** What is stored for each account: for the spec that checks the token isn't. */
  get storedHashes (): string[] {
    return [...this.byHash.keys()]
  }
}
