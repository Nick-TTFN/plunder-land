import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { generateKeyPairSync, sign } from 'node:crypto'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import { MemoryAccountStore } from '../db/accounts'
import { CG_KID, PortalVerifier } from './portaltoken'
import { type AccountInfo, handshakeAuth, linkOfferOf, onAccount, TOKEN_KEY, type TokenStorage } from '../../../../plunder-land-client/src/net/account'
import { type CrazySdk, crazyGamesSdk } from '../../../../plunder-land-client/src/portal/crazygames'
import { type PortalSdk, withGameplayState } from '../../../../plunder-land-client/src/portal/adapter'
import { LINK, answerLinkOffer, shownName } from '../../../../plunder-land-client/src/portal/identity'
import { callsign } from '../../../../plunder-land-client/src/utils/callsign'

/**
 * The CrazyGames login end to end, client code against the server (g2-6c on
 * g2-6b): the client's `handshakeAuth`, `account` handling and link answer
 * (as `index.ts` wires them) drive a real `Worlds` on the memory store, whose
 * verifier trusts a locally generated key pair standing in for CrazyGames'
 * JWKS. The SDK is a fake whose token is signed with that key. No browser,
 * no socket.io: a stand-in socket carries the events. Whether CrazyGames'
 * own `local` demo tokens verify is not known (they are signed by CrazyGames,
 * not by a key we hold; a demo token's `gameId` would not be ours either).
 */

const GAME = '20267'
const CG = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWKS = JSON.stringify({ keys: [{ ...CG.publicKey.export({ format: 'jwk' }), kid: CG_KID, use: 'sig', alg: 'RS256' }] })
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A CrazyGames IN_GAME_AUTH token for `userId`, signed with the stand-in key. */
function cgToken (userId: string, username: string): string {
  const s = Math.floor(Date.now() / 1000)
  const signed = `${b64({ alg: 'RS256', kid: CG_KID, typ: 'JWT' })}.${b64({ userId, gameId: GAME, username, profilePictureUrl: 'https://images.crazygames.com/p.png', iat: s - 5, exp: s + 3600 })}`
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), CG.privateKey).toString('base64url')}`
}

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

function memoryStorage (): TokenStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v }, removeItem: (k) => { delete data[k] } }
}

/** A CrazyGames SDK on the portal, logged in as `user` (or logged out), answering the link modal with `link`. */
function cgSdk (user: { id: string, name: string } | undefined, link: 'yes' | 'no' = 'yes'): PortalSdk {
  const fake: CrazySdk = {
    init: async () => {},
    environment: 'crazygames',
    game: { loadingStart: () => {}, loadingStop: () => {}, gameplayStart: () => {}, gameplayStop: () => {}, settings: {}, addSettingsChangeListener: () => {} },
    user: {
      isUserAccountAvailable: true,
      getUser: async () => user === undefined ? null : { username: user.name, profilePictureUrl: 'https://images.crazygames.com/p.png' },
      getUserToken: async () => {
        if (user === undefined) throw Object.assign(new Error('userNotAuthenticated'), { code: 'userNotAuthenticated' })
        return cgToken(user.id, user.name)
      },
      addAuthListener: () => {},
      showAuthPrompt: async () => null,
      showAccountLinkPrompt: async () => ({ response: link })
    }
  }
  return withGameplayState(crazyGamesSdk(async () => fake, { log: () => {}, warn: () => {} }))
}

/**
 * One browser profile: its localStorage, and a page that connects with the
 * client's handshake and handles `account` as `index.ts` does.
 */
class Browser {
  readonly storage = memoryStorage()
  info: AccountInfo | undefined
  constructor (readonly worlds: Worlds) {}

  /** A page load (or a reconnect after a login): a new connection. */
  async open (sdk: PortalSdk): Promise<Page> {
    const auth = await new Promise<object>((resolve) => { handshakeAuth(() => this.storage, 'crazygames', sdk)(resolve) })
    return new Page(this, sdk, auth)
  }
}

let socketN = 0
class Page {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly linkAnswers: boolean[] = []
  readonly connection: Connection
  info: AccountInfo | undefined

  constructor (readonly browser: Browser, readonly sdk: PortalSdk, readonly auth: object) {
    const socket = {
      id: `s${++socketN}`,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => {
        if (event === 'account') this.onAccountEvent(data)
        return true
      },
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
    this.connection = browser.worlds.onConnection(socket)
  }

  /** `index.ts`'s `account` handler, minus the pixi. */
  private onAccountEvent (data: unknown): void {
    const offered = linkOfferOf(data)
    if (offered !== undefined) {
      void answerLinkOffer(offered, this.sdk, (accept) => {
        this.linkAnswers.push(accept)
        this.handlers.portal_link({ accept })
      })
      return
    }
    const info = onAccount(data, this.browser.storage, LINK.accepted)
    if (info !== undefined) this.info = info
  }

  ready (): void {
    this.handlers.start_requested({ id: 'abcdef' })
  }

  close (): void {
    this.handlers.disconnect()
  }
}

async function until (what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(ok(), `timed out waiting for ${what}`)
}

let savedLog: ThrottledLog
beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  LINK.accepted = undefined
})
afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  World.strict = false
  LINK.accepted = undefined
})

function worldsOn (store: MemoryAccountStore, gameId: string | null = GAME): Worlds {
  return new Worlds({
    privateRuns: false,
    tickLengthMs: 250,
    cap: 10,
    idleMs: 300_000,
    redis: redisStub(),
    accounts: store,
    accountTimeoutMs: 3000,
    portal: new PortalVerifier({ gameId: gameId ?? undefined, fetchText: async () => JWKS, onFetchError: () => {} })
  })
}

test('a guest plays, logs in, is offered the link, accepts and keeps its level; another profile of the same user gets it; logged out is a fresh guest', async () => {
  const store = new MemoryAccountStore()
  const worlds = worldsOn(store)
  const user = { id: 'CGuser77', name: 'Nova_Rider' }

  // 1. A CrazyGames guest (logged out) plays: an account and a stored token.
  const browser = new Browser(worlds)
  const guestPage = await browser.open(cgSdk(undefined))
  assert.ok(!('portalToken' in guestPage.auth), 'a logged-out player sent a portal token')
  guestPage.ready()
  await until('the guest account', () => guestPage.info !== undefined)
  const guestToken = browser.storage.data[TOKEN_KEY]
  assert.ok(guestToken !== undefined, 'no guest token stored')
  const guestId = guestPage.info?.id as string
  assert.equal(guestPage.info?.portal, undefined)
  await store.grant(guestId, 300)
  guestPage.close()

  // 2. They log in on CrazyGames: the page reconnects; the offer, CrazyGames' modal, yes.
  const loggedIn = await browser.open(cgSdk(user, 'yes'))
  assert.equal(typeof (loggedIn.auth as { portalToken?: unknown }).portalToken, 'string')
  await until('the link', () => loggedIn.info !== undefined)
  assert.deepEqual(loggedIn.linkAnswers, [true])
  assert.equal(loggedIn.info?.id, guestId, 'the guest account is now the user\'s')
  assert.equal(loggedIn.info?.portal, 'crazygames')
  assert.ok((loggedIn.info?.standing?.xp ?? 0) >= 300, 'the level was not kept')
  assert.equal(browser.storage.data[TOKEN_KEY], undefined, 'the guest token was kept after the link')
  assert.equal(shownName(loggedIn.info, await loggedIn.sdk.user())?.text, 'Nova_Rider')
  loggedIn.ready()
  await until('a player', () => loggedIn.connection.player !== undefined)
  assert.equal(loggedIn.connection.player?.playerId, guestId)
  loggedIn.close()

  // 3. A second browser profile, same CrazyGames user: the same account at connect, no offer.
  const other = new Browser(worlds)
  const otherPage = await other.open(cgSdk(user))
  await until('the account', () => otherPage.info !== undefined)
  assert.equal(otherPage.info?.id, guestId)
  assert.deepEqual(otherPage.linkAnswers, [])
  otherPage.close()

  // 4. Logged out again on the first profile: no token left, so a fresh guest at READY.
  const loggedOut = await browser.open(cgSdk(undefined))
  loggedOut.ready()
  await until('a fresh guest', () => loggedOut.info !== undefined)
  assert.notEqual(loggedOut.info?.id, guestId)
  assert.equal(loggedOut.info?.portal, undefined)
  assert.equal(shownName(loggedOut.info, null)?.text, callsign(loggedOut.info?.id as string))
  loggedOut.close()
})

test('a guest who says no keeps its guest token and gets a new linked account at READY', async () => {
  const store = new MemoryAccountStore()
  const worlds = worldsOn(store)
  const browser = new Browser(worlds)
  const guestPage = await browser.open(cgSdk(undefined))
  guestPage.ready()
  await until('the guest account', () => guestPage.info !== undefined)
  const guestId = guestPage.info?.id as string
  const guestToken = browser.storage.data[TOKEN_KEY]
  guestPage.close()

  const page = await browser.open(cgSdk({ id: 'CGuser78', name: 'Other.Name' }, 'no'))
  await until('the answer', () => page.linkAnswers.length > 0)
  assert.deepEqual(page.linkAnswers, [false])
  assert.equal(page.info, undefined, 'the offered account was taken as this connection\'s')
  page.ready()
  await until('the new account', () => page.info !== undefined)
  assert.notEqual(page.info?.id, guestId)
  assert.equal(page.info?.portal, 'crazygames')
  assert.equal(browser.storage.data[TOKEN_KEY], guestToken, 'the declined guest\'s token was dropped')
  page.close()
})

test('before CRAZYGAMES_GAME_ID is set a logged-in CrazyGames player is a plain guest: token stored, callsign shown', async () => {
  const worlds = worldsOn(new MemoryAccountStore(), null)
  const browser = new Browser(worlds)
  const page = await browser.open(cgSdk({ id: 'CGuser79', name: 'Nova_Rider' }))
  assert.equal(typeof (page.auth as { portalToken?: unknown }).portalToken, 'string', 'the client still sends it')
  page.ready()
  await until('the guest account', () => page.info !== undefined)
  assert.equal(page.info?.portal, undefined)
  assert.ok(browser.storage.data[TOKEN_KEY] !== undefined)
  assert.equal(shownName(page.info, await page.sdk.user())?.text, callsign(page.info?.id as string))
  page.close()
})
