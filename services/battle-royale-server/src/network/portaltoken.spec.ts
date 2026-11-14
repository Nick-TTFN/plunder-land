import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import { Client as PgClient } from 'pg'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import Player from '../objects/player'
import Analytics from '../analytics'
import { type AccountStore, MemoryAccountStore, type PortalStore, portalStoreOf, TOKEN_SHAPE } from '../db/accounts'
import { PgAccountStore } from '../db/pgstore'
import { CG_KID, type FetchText, keysOf, PortalVerifier, portalTokenOf } from './portaltoken'

/**
 * CrazyGames tokens (g2-6b): the verifier's security matrix with a locally
 * generated RSA key pair, then rules 4a-4d through `Worlds` on the memory
 * store and (with `TEST_DATABASE_URL`) on Postgres, in its **own database**
 * (`plunder_portal_spec`): node runs spec files in parallel and
 * pgstore.spec.ts drops the URL database's public schema.
 */

const GAME = '20267'
const T0 = Date.parse('2026-11-14T12:00:00.000Z')
const S0 = T0 / 1000

function rsa (): { privateKey: KeyObject, publicKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
}

const CG = rsa()
const LEGACY = rsa()
const STRANGER = rsa()

function jwk (key: KeyObject, kid: string): Record<string, unknown> {
  return { ...key.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }
}

const JWKS = JSON.stringify({ keys: [jwk(CG.publicKey, CG_KID), jwk(LEGACY.publicKey, 'ingame-auth-legacy')] })

const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

interface Claims { userId?: unknown, gameId?: unknown, username?: unknown, iat?: unknown, exp?: unknown, profilePictureUrl?: unknown }

function claims (over: Claims = {}): Claims {
  return { userId: 'CGuser42', gameId: GAME, username: 'Nova_Rider', profilePictureUrl: 'https://example.invalid/p.png', iat: S0 - 10, exp: S0 + 3590, ...over }
}

/** A JWT signed RS256 by `key` (CrazyGames' by default) under `header`. */
function token (payload: Claims = claims(), header: Record<string, unknown> = { alg: 'RS256', kid: CG_KID, typ: 'JWT' }, key: KeyObject = CG.privateKey): string {
  const signed = `${b64(header)}.${b64(payload)}`
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`
}

/** A JWKS fetcher that counts and can be told to fail or hang. */
function fetcher (body: () => string = () => JWKS): FetchText & { calls: number, mode: 'ok' | 'throw' | 'hang' } {
  const f = Object.assign(async (url: string, signal: AbortSignal): Promise<string> => {
    void url
    void signal
    f.calls++
    if (f.mode === 'throw') throw new Error('network down (stub)')
    if (f.mode === 'hang') return await new Promise<string>(() => {})
    return body()
  }, { calls: 0, mode: 'ok' as 'ok' | 'throw' | 'hang' })
  return f
}

const quiet = (): void => {}

function verifier (over: Partial<ConstructorParameters<typeof PortalVerifier>[0]> = {}, now: { t: number } = { t: T0 }): PortalVerifier {
  return new PortalVerifier({ gameId: GAME, now: () => now.t, fetchText: fetcher(), onFetchError: quiet, ...over })
}

let unhandled: unknown[] = []
const onUnhandled = (e: unknown): void => { unhandled.push(e) }
beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})
afterEach(() => {
  process.removeListener('unhandledRejection', onUnhandled)
  assert.deepEqual(unhandled, [], 'an unhandled rejection')
})

// ---------------------------------------------------------------- the verifier

test('a valid token verifies: user id and username, nothing else', async () => {
  const v = verifier()
  assert.deepEqual(await v.verify(token()), { userId: 'CGuser42', username: 'Nova_Rider' })
  // A numeric gameId is compared by its decimal form.
  assert.deepEqual(await v.verify(token(claims({ gameId: 20267 }))), { userId: 'CGuser42', username: 'Nova_Rider' })
})

test('alg none is refused, with no signature or with any signature', async () => {
  const v = verifier()
  const head = b64({ alg: 'none', kid: CG_KID, typ: 'JWT' })
  const body = b64(claims())
  assert.equal(await v.verify(`${head}.${body}.`), null)
  assert.equal(await v.verify(`${head}.${body}.AAAA`), null)
  // Even signed correctly with CrazyGames' key: the header says none, so no.
  assert.equal(await v.verify(token(claims(), { alg: 'none', kid: CG_KID })), null)
  for (const alg of ['None', 'NONE', '', null, undefined]) assert.equal(await v.verify(`${b64({ alg, kid: CG_KID })}.${body}.`), null, String(alg))
})

test('HS256 signed with the public key as the secret (key confusion) is refused, and so is every other alg', async () => {
  const v = verifier()
  const body = b64(claims())
  const pem = CG.publicKey.export({ format: 'pem', type: 'spki' }) as string
  for (const secret of [pem, Buffer.from(String(jwk(CG.publicKey, CG_KID).n), 'base64url'), JWKS]) {
    for (const alg of ['HS256', 'HS384', 'HS512']) {
      const head = b64({ alg, kid: CG_KID, typ: 'JWT' })
      const mac = createHmac(`sha${alg.slice(2)}`, secret).update(`${head}.${body}`).digest('base64url')
      assert.equal(await v.verify(`${head}.${body}.${mac}`), null, alg)
    }
  }
  for (const alg of ['RS384', 'RS512', 'PS256', 'ES256', 'rs256']) assert.equal(await v.verify(token(claims(), { alg, kid: CG_KID })), null, alg)
})

test('a wrong gameId, or none, is refused', async () => {
  const v = verifier()
  for (const gameId of ['99999', '020267', ' 20267', 20268, undefined, null, ['20267'], { id: GAME }]) {
    assert.equal(await v.verify(token(claims({ gameId }))), null, JSON.stringify(gameId))
  }
})

test('expired beyond the 60 s skew is refused; within it accepted; a missing or non-numeric exp is refused', async () => {
  const v = verifier()
  assert.equal(await v.verify(token(claims({ exp: S0 - 61 }))), null)
  assert.notEqual(await v.verify(token(claims({ exp: S0 - 59 }))), null)
  for (const exp of [undefined, '9999999999', null, Infinity]) assert.equal(await v.verify(token(claims({ exp }))), null, String(exp))
})

test('iat in the future beyond the skew is refused; a missing iat is refused', async () => {
  const v = verifier()
  assert.equal(await v.verify(token(claims({ iat: S0 + 61 }))), null)
  assert.notEqual(await v.verify(token(claims({ iat: S0 + 59 }))), null)
  assert.equal(await v.verify(token(claims({ iat: undefined }))), null)
})

test('a bad signature is refused: another key, a tampered payload, a cut signature', async () => {
  const v = verifier()
  assert.equal(await v.verify(token(claims(), undefined, STRANGER.privateKey)), null)
  const good = token()
  const [h, , s] = good.split('.')
  assert.equal(await v.verify(`${h}.${b64(claims({ userId: 'someoneElse' }))}.${s}`), null)
  assert.equal(await v.verify(`${h}.${good.split('.')[1]}.${s.slice(0, -4)}`), null)
  assert.notEqual(await v.verify(good), null)
})

test('the legacy key is refused even when the JWKS has it; any kid but ingame-auth is refused without a fetch', async () => {
  const fetch = fetcher()
  const v = verifier({ fetchText: fetch })
  assert.equal(await v.verify(token(claims(), { alg: 'RS256', kid: 'ingame-auth-legacy' }, LEGACY.privateKey)), null)
  assert.equal(await v.verify(token(claims(), { alg: 'RS256', kid: 'whatever' })), null)
  assert.equal(await v.verify(token(claims(), { alg: 'RS256' })), null)
  assert.equal(fetch.calls, 0, 'a refused header fetched the JWKS')
  // A token signed by the legacy key but claiming the current kid fails the signature.
  assert.equal(await v.verify(token(claims(), undefined, LEGACY.privateKey)), null)
})

test('unknown kid (missing from the JWKS): one fetch, refuse; again within the minute, no fetch; after it, one more', async () => {
  const now = { t: T0 }
  const fetch = fetcher(() => JSON.stringify({ keys: [jwk(STRANGER.publicKey, 'some-other-kid')] }))
  const v = verifier({ fetchText: fetch, now: () => now.t })
  assert.equal(await v.verify(token()), null)
  assert.equal(fetch.calls, 1)
  now.t += 30_000
  assert.equal(await v.verify(token(claims({ iat: S0 + 20 }))), null)
  assert.equal(fetch.calls, 1, 'a second unknown kid within the minute fetched again')
  now.t += 31_000
  assert.equal(await v.verify(token(claims({ iat: S0 + 50 }))), null)
  assert.equal(fetch.calls, 2)
})

test('the JWKS is fetched once and kept; a key rotated under the same kid is picked up by one refetch', async () => {
  const now = { t: T0 }
  let current = JWKS
  const fetch = fetcher(() => current)
  const v = verifier({ fetchText: fetch, now: () => now.t })
  for (let i = 0; i < 5; i++) assert.notEqual(await v.verify(token()), null)
  assert.equal(fetch.calls, 1)
  // Rotation: the new key under ingame-auth.
  const next = rsa()
  current = JSON.stringify({ keys: [jwk(next.publicKey, CG_KID)] })
  now.t += 61_000
  assert.notEqual(await v.verify(token(claims({ iat: S0 + 60 }), undefined, next.privateKey)), null)
  assert.equal(fetch.calls, 2)
  // Bad signatures can't make it fetch more than once a minute.
  for (let i = 0; i < 5; i++) assert.equal(await v.verify(token(claims({ iat: S0 + 60 }), undefined, STRANGER.privateKey)), null)
  assert.equal(fetch.calls, 2)
})

test('concurrent first tokens share one JWKS fetch', async () => {
  const fetch = fetcher()
  const v = verifier({ fetchText: fetch })
  const results = await Promise.all(Array.from({ length: 10 }, async () => await v.verify(token())))
  assert.ok(results.every((r) => r !== null))
  assert.equal(fetch.calls, 1)
})

test('JWKS fetch failing or hanging: refuse, no throw, no unhandled rejection; the keys kept from before still work', async () => {
  const now = { t: T0 }
  const fetch = fetcher()
  const errors: unknown[] = []
  const v = verifier({ fetchText: fetch, now: () => now.t, fetchTimeoutMs: 50, onFetchError: (e) => { errors.push(e) } })
  fetch.mode = 'throw'
  assert.equal(await v.verify(token()), null)
  fetch.mode = 'hang'
  now.t += 61_000
  const started = Date.now()
  assert.equal(await v.verify(token(claims({ iat: S0 + 60 }))), null)
  assert.ok(Date.now() - started < 2000, 'the timeout did not bound the fetch')
  assert.equal(errors.length, 2)
  // Recovered: keys arrive, then a later failure leaves them in place.
  fetch.mode = 'ok'
  now.t += 61_000
  assert.notEqual(await v.verify(token(claims({ iat: S0 + 120 }))), null)
  fetch.mode = 'throw'
  now.t += 61_000
  assert.equal(await v.verify(token(claims({ iat: S0 + 180 }), undefined, STRANGER.privateKey)), null)
  assert.notEqual(await v.verify(token(claims({ iat: S0 + 180 }))), null)
})

test('JWKS over real HTTP (the default fetch): a 500, a garbage body and a server that never answers are refused, a good one verifies', async () => {
  let mode: 'ok' | '500' | 'garbage' | 'hang' = '500'
  const server: Server = createServer((req, res) => {
    if (mode === 'hang') return
    if (mode === '500') {
      res.writeHead(500)
      res.end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(mode === 'garbage' ? '{"keys": [{"kty": "RSA", "n": 5}' : JWKS)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`
  try {
    for (const m of ['500', 'garbage', 'hang', 'ok'] as const) {
      mode = m
      const v = new PortalVerifier({ gameId: GAME, jwksUrl: url, now: () => T0, fetchTimeoutMs: 200, onFetchError: quiet })
      const result = await v.verify(token())
      if (m === 'ok') assert.deepEqual(result, { userId: 'CGuser42', username: 'Nova_Rider' })
      else assert.equal(result, null, m)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})

test('no game id: every token is refused without a fetch', async () => {
  for (const gameId of [undefined, '']) {
    const fetch = fetcher()
    const v = verifier({ gameId, fetchText: fetch })
    assert.equal(v.enabled, false)
    assert.equal(await v.verify(token()), null)
    assert.equal(fetch.calls, 0)
  }
})

test('malformed tokens are refused, never thrown: shapes, sizes, crit, non-objects', async () => {
  const v = verifier()
  const good = token()
  for (const bad of [undefined, null, 42, {}, '', 'a.b', 'a.b.c.d', good + '.', `${good}=`, 'é.é.é', 'x'.repeat(5000), `${b64('[]')}.${b64(claims())}.AA`]) {
    assert.equal(await v.verify(bad), null, String(bad).slice(0, 30))
  }
  assert.equal(await v.verify(token(claims(), { alg: 'RS256', kid: CG_KID, crit: ['exp'] })), null)
  for (const userId of ['', 'a b', 'x'.repeat(129), 7, undefined]) assert.equal(await v.verify(token(claims({ userId }))), null, String(userId))
})

test('a username outside CrazyGames\' shape is dropped, the identity kept', async () => {
  const v = verifier()
  for (const username of ['ab', 'x'.repeat(21), 'has space', '<b>hi</b>', 'Ünicode_1', 42, undefined]) {
    assert.deepEqual(await v.verify(token(claims({ username }))), { userId: 'CGuser42' }, String(username))
  }
  assert.deepEqual(await v.verify(token(claims({ username: 'a.b_C9x' }))), { userId: 'CGuser42', username: 'a.b_C9x' })
})

test('keysOf keeps only usable RSA signing keys of 2048 bits or more', () => {
  const small = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const keys = keysOf(JSON.stringify({
    keys: [
      jwk(CG.publicKey, CG_KID), jwk(small.publicKey, 'small'), { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec' },
      { ...jwk(STRANGER.publicKey, 'enc'), use: 'enc' }, { ...jwk(STRANGER.publicKey, 'hs'), alg: 'HS256' }, { kty: 'RSA', kid: 'broken', n: '!!', e: 'AQAB' }, null, 7
    ]
  }))
  assert.deepEqual([...keys.keys()], [CG_KID])
  assert.equal(keysOf('not json').size, 0)
  assert.equal(keysOf('{"keys": 5}').size, 0)
})

test('portalTokenOf: a string of 1-4096 characters, nothing else', () => {
  assert.equal(portalTokenOf({ portalToken: 'abc' }), 'abc')
  for (const auth of [undefined, null, 'x', {}, { portalToken: '' }, { portalToken: 5 }, { portalToken: 'x'.repeat(4097) }]) assert.equal(portalTokenOf(auth), undefined)
})

// ---------------------------------------------------------------- rules 4a-4d through Worlds

let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
let ga: Array<{ name: string, params: Record<string, unknown>, clientId: string }> = []
const realPost = Analytics.post

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = () => {}
  Worlds.accountSuccess()
  ga = []
  Analytics.post = async (url, body) => {
    void url
    const parsed = JSON.parse(body) as { client_id: string, events: Array<{ name: string, params: Record<string, unknown> }> }
    for (const e of parsed.events) ga.push({ name: e.name, params: e.params, clientId: parsed.client_id })
  }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  Analytics.post = realPost
  delete process.env.GA_MEASUREMENT_ID
  delete process.env.GA_API_SECRET
  World.strict = false
})

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

class FakeClient {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
  }

  start (): void {
    this.handlers.start_requested({ id: 'abcdef', name: 'TypedName' })
  }

  accounts (): Array<Record<string, unknown>> {
    return this.emitted.filter(([e]) => e === 'account').map(([, d]) => d as Record<string, unknown>)
  }
}

async function until (what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(ok(), `timed out waiting for ${what}`)
}

async function settle (): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Tokens are made at real time here: the verifier's clock is the wall clock. */
function liveToken (userId: string, username: string | undefined = 'Nova_Rider'): string {
  const s = Math.floor(Date.now() / 1000)
  return token(claims({ userId, username, iat: s - 5, exp: s + 3600 }))
}

type Store = AccountStore & PortalStore

interface Harness {
  worlds: Worlds
  store: Store
  connect: (auth?: unknown) => FakeClient
}

function harness (store: Store, gameId: string | null = GAME): Harness {
  const worlds = new Worlds({
    privateRuns: false,
    tickLengthMs: 250,
    cap: 10,
    idleMs: 300_000,
    redis: redisStub(),
    accounts: store,
    accountTimeoutMs: 3000,
    portal: new PortalVerifier({ gameId: gameId ?? undefined, fetchText: fetcher(), onFetchError: quiet })
  })
  let n = 0
  return {
    worlds,
    store,
    connect: (auth?: unknown) => {
      const client = new FakeClient(`s${++n}`, auth)
      client.connection = worlds.onConnection(client.socket)
      return client
    }
  }
}

const uid = (tag: string): string => `CG${tag}${Math.random().toString(36).slice(2, 10)}`
const cgAuth = (extra: Record<string, unknown>): Record<string, unknown> => ({ portal: 'crazygames', ...extra })

function linkResults (): string[] {
  return ga.filter((e) => e.name === 'portal_link').map((e) => String(e.params.result))
}

/**
 * `store` with every method named in `down` rejecting at once, as a store
 * that is down does (the timeout path ends the same way, slower). Everything
 * else is the real store's, called on the real store.
 */
function flaky (store: Store): { store: Store, down: Set<string> } {
  const down = new Set<string>()
  const proxy = new Proxy(store, {
    get (target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (typeof prop === 'string' && down.has(prop)) return async () => { throw new Error(`store down: ${prop}`) }
      return (value as (...args: unknown[]) => unknown).bind(target)
    }
  })
  return { store: proxy, down }
}

const hellos = (c: FakeClient): number => c.emitted.filter(([e]) => e === 'hello').length

/** Start a run and wait for its `hello`. */
async function play (c: FakeClient): Promise<Player> {
  const before = hellos(c)
  c.start()
  await until('the run', () => hellos(c) > before && c.connection.player !== undefined)
  return c.connection.player as Player
}

/** End the connection's run (as accounts.spec does), so PLAY AGAIN can start another on the same socket. */
async function endRun (h: Harness, c: FakeClient): Promise<void> {
  const player = c.connection.player
  assert.ok(player !== undefined, 'no run to end')
  World.run(h.worlds.worldFor(c.connection) as World, () => { player.exit() })
  h.worlds.tickAll(250)
  await settle()
}

/** Every rule, against one store. */
async function rules (t: { test: (name: string, fn: () => Promise<void>) => Promise<void> }, makeStore: () => Promise<Store>): Promise<void> {
  await t.test('4a: a linked user gets their account at connect, whatever guest token comes along; no token is sent', async () => {
    const h = harness(await makeStore())
    const user = uid('a')
    const linked = await h.store.createLinked('crazygames', user)
    const sibling = await h.store.create()
    const c = h.connect(cgAuth({ token: sibling.token, portalToken: liveToken(user) }))
    await until('account', () => c.accounts().length > 0)
    const [msg] = c.accounts()
    assert.equal(msg.id, linked.publicId)
    assert.equal(msg.portal, 'crazygames')
    assert.ok(!('token' in msg), 'a linked account was sent a token')
    assert.ok(!('linkable' in msg))
    c.start()
    await until('a player', () => c.connection.player !== undefined)
    assert.equal(c.connection.player?.playerId, linked.publicId)
    assert.equal(c.connection.player?.name, 'Nova_Rider', 'the verified username is not the run\'s name')
  })

  await t.test('4b accept: the guest account is offered (linkable), portal_link accept links it, and it plays as that account', async () => {
    const h = harness(await makeStore())
    const user = uid('b')
    const guest = await h.store.create()
    await h.store.grant(guest.account.publicId, 55)
    const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    await until('the offer', () => c.accounts().length > 0)
    const [offer] = c.accounts()
    assert.equal(offer.id, guest.account.publicId)
    assert.equal(offer.linkable, true)
    assert.equal(offer.xp, 55)
    assert.ok(!('token' in offer) && !('portal' in offer))
    assert.equal(c.connection.account, undefined, 'the offered account was set before the answer')
    c.handlers.portal_link({ accept: true })
    await until('the link', () => c.accounts().length > 1)
    const msg = c.accounts()[1]
    assert.equal(msg.id, guest.account.publicId)
    assert.equal(msg.portal, 'crazygames')
    assert.ok(!('token' in msg))
    assert.equal((await h.store.resolvePortal('crazygames', user))?.publicId, guest.account.publicId)
    c.start()
    await until('a player', () => c.connection.player !== undefined)
    assert.equal(c.connection.player?.playerId, guest.account.publicId)
    assert.deepEqual(linkResults(), ['linked'])
    // The next connection is rule 4a.
    const again = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    await until('account', () => again.accounts().length > 0)
    assert.equal(again.accounts()[0].id, guest.account.publicId)
    assert.ok(!('linkable' in again.accounts()[0]))
  })

  await t.test('4b decline: a new linked account at READY, the guest left unlinked; a late accept does nothing', async () => {
    const h = harness(await makeStore())
    const user = uid('c')
    const guest = await h.store.create()
    const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    await until('the offer', () => c.accounts().length > 0)
    c.handlers.portal_link({ accept: false })
    c.handlers.portal_link({ accept: true })
    c.start()
    await until('a player', () => c.connection.player !== undefined)
    const id = c.connection.player?.playerId
    assert.notEqual(id, guest.account.publicId)
    assert.equal((await h.store.resolvePortal('crazygames', user))?.publicId, id)
    assert.equal(await h.store.linkedPortal(guest.account.publicId), null, 'the declined guest was linked')
    const last = c.accounts().at(-1) as Record<string, unknown>
    assert.equal(last.id, id)
    assert.equal(last.portal, 'crazygames')
    assert.ok(!('token' in last))
    assert.deepEqual(linkResults(), ['declined'])
  })

  await t.test('4b READY before an answer is a decline; an accept after it changes nothing', async () => {
    const h = harness(await makeStore())
    const user = uid('d')
    const guest = await h.store.create()
    const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    c.start()
    await until('a player', () => c.connection.player !== undefined)
    c.handlers.portal_link({ accept: true })
    await settle()
    assert.notEqual(c.connection.player?.playerId, guest.account.publicId)
    assert.equal(await h.store.linkedPortal(guest.account.publicId), null)
    assert.equal((await h.store.resolvePortal('crazygames', user))?.publicId, c.connection.player?.playerId)
    assert.deepEqual(linkResults(), ['declined'])
  })

  await t.test('4c: no guest token (or an unknown one): nothing at connect, a new linked account at READY with no prompt', async () => {
    const h = harness(await makeStore())
    for (const [i, auth] of [cgAuth({}), cgAuth({ token: 'A'.repeat(43) })].entries()) {
      const user = uid(`e${i}`)
      const c = h.connect({ ...auth, portalToken: liveToken(user) })
      await settle()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(c.accounts().length, 0, 'an account before READY')
      c.start()
      await until('a player', () => c.connection.player !== undefined)
      const [msg] = c.accounts()
      assert.equal(msg.portal, 'crazygames')
      assert.ok(!('token' in msg) && !('linkable' in msg))
      assert.equal((await h.store.resolvePortal('crazygames', user))?.publicId, msg.id)
    }
    assert.deepEqual(linkResults(), ['auto', 'auto'])
  })

  await t.test('4c with a guest token already linked to another CG user: no offer, a new linked account', async () => {
    const h = harness(await makeStore())
    const guest = await h.store.create()
    assert.equal(await h.store.linkPortal('crazygames', uid('other'), guest.account.publicId), 'linked')
    const user = uid('f')
    const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    c.start()
    await until('a player', () => c.connection.player !== undefined)
    assert.ok(c.accounts().every((m) => m.linkable === undefined))
    assert.notEqual(c.connection.player?.playerId, guest.account.publicId)
  })

  await t.test('4d: a guest token whose account is linked, with no or a bad portal token, is a new guest, never the linked account', async () => {
    const h = harness(await makeStore())
    const user = uid('g')
    const guest = await h.store.create()
    assert.equal(await h.store.linkPortal('crazygames', user, guest.account.publicId), 'linked')
    const forged = token(claims({ userId: user }), undefined, STRANGER.privateKey)
    for (const auth of [{ token: guest.token }, cgAuth({ token: guest.token }), cgAuth({ token: guest.token, portalToken: forged }), { portal: 'poki', token: guest.token, portalToken: liveToken(user) }]) {
      const c = h.connect(auth)
      await settle()
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(c.accounts().length, 0, `the linked account was announced for ${JSON.stringify(Object.keys(auth))}`)
      c.start()
      await until('a player', () => c.connection.player !== undefined)
      const [msg] = c.accounts()
      assert.notEqual(msg.id, guest.account.publicId, 'a guest token reached the linked account')
      assert.match(String(msg.token), TOKEN_SHAPE)
      assert.ok(!('portal' in msg))
      assert.equal(c.connection.player?.name, Player.callsign(String(msg.id)))
    }
  })

  // ---- the store failing (Archie's g2-6b review, finding 1) ----

  await t.test('4d on a retry: a linked guest token whose lookup failed at connect is a new guest at PLAY AGAIN, never the linked account', async () => {
    const base = await makeStore()
    const f = flaky(base)
    const h = harness(f.store)
    const user = uid('r')
    const guest = await base.create()
    assert.equal(await base.linkPortal('crazygames', user, guest.account.publicId), 'linked')
    const forged = token(claims({ userId: user }), undefined, STRANGER.privateKey)
    for (const auth of [{ token: guest.token }, cgAuth({ token: guest.token, portalToken: forged })]) {
      f.down.add('resolve')
      f.down.add('create')
      const c = h.connect(auth)
      await until('the offline account', () => c.accounts().length > 0)
      const [offline] = c.accounts()
      assert.equal(offline.offline, true)
      assert.notEqual(offline.id, guest.account.publicId)
      // The first start retries (`retryAccount`) and still fails: offline.
      const first = await play(c)
      assert.equal(first.playerId, offline.id)
      await endRun(h, c)
      f.down.clear()
      // PLAY AGAIN: the store answers now, and the guest token leads to a linked account.
      const again = await play(c)
      const msg = c.accounts().at(-1) as Record<string, unknown>
      assert.notEqual(msg.id, guest.account.publicId, 'a guest token reached the linked account on a retry')
      assert.notEqual(again.playerId, guest.account.publicId, 'played the linked account on a retry')
      assert.equal(again.playerId, msg.id)
      assert.match(String(msg.token), TOKEN_SHAPE)
      assert.ok(!('portal' in msg))
      assert.equal(c.connection.account?.persisted, true)
    }
  })

  await t.test('portal lookup failing at connect: offline (no token, no portal, no offer); PLAY AGAIN gives the linked account, or a new linked one, never the guest token\'s', async () => {
    const base = await makeStore()
    const f = flaky(base)
    const h = harness(f.store)
    const linkedUser = uid('s')
    const linked = await base.createLinked('crazygames', linkedUser)
    for (const [user, expected] of [[linkedUser, linked.publicId], [uid('t'), undefined]] as const) {
      // A sibling's unlinked guest token comes along: rule 4b would offer it,
      // but a retry never offers, and must not just play it either.
      const sibling = await base.create()
      f.down.add('resolvePortal')
      f.down.add('createLinked')
      const c = h.connect(cgAuth({ token: sibling.token, portalToken: liveToken(user) }))
      await until('the offline account', () => c.accounts().length > 0)
      const [offline] = c.accounts()
      assert.deepEqual(Object.keys(offline).sort(), ['id', 'offline'])
      assert.equal(c.connection.account?.persisted, false)
      const first = await play(c)
      assert.equal(first.playerId, offline.id, 'not offline while the store is down')
      assert.equal(first.name, 'Nova_Rider', 'the verified username is lost while offline')
      await endRun(h, c)
      f.down.clear()
      const again = await play(c)
      const msg = c.accounts().at(-1) as Record<string, unknown>
      assert.notEqual(msg.id, sibling.account.publicId, 'a verified CG user played the guest token\'s account on a retry')
      assert.equal(msg.portal, 'crazygames')
      assert.ok(!('token' in msg) && !('linkable' in msg) && !('offline' in msg))
      assert.equal(again.playerId, msg.id)
      assert.equal((await base.resolvePortal('crazygames', user))?.publicId, expected ?? msg.id)
      assert.equal(await base.linkedPortal(sibling.account.publicId), null, 'the sibling\'s guest was linked')
      assert.ok(c.accounts().every((m) => m.linkable === undefined), 'an offer on a retry')
    }
  })

  await t.test('the guest lookup failing in a portal lookup: offline, no offer; PLAY AGAIN gives a new linked account and the guest stays unlinked', async () => {
    const base = await makeStore()
    const f = flaky(base)
    const h = harness(f.store)
    const user = uid('u')
    const guest = await base.create()
    f.down.add('resolve')
    const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    await until('the offline account', () => c.accounts().length > 0)
    assert.deepEqual(Object.keys(c.accounts()[0]).sort(), ['id', 'offline'])
    f.down.clear()
    // The first start is already the retry, and the store answers.
    const player = await play(c)
    const msg = c.accounts().at(-1) as Record<string, unknown>
    assert.equal(msg.portal, 'crazygames')
    assert.notEqual(msg.id, guest.account.publicId)
    assert.equal(player.playerId, msg.id)
    assert.equal((await base.resolvePortal('crazygames', user))?.publicId, msg.id)
    assert.equal(await base.linkedPortal(guest.account.publicId), null)
    assert.ok(c.accounts().every((m) => m.linkable === undefined))
  })

  await t.test('createLinked failing on a retry: offline again and nothing linked; the next PLAY AGAIN creates it', async () => {
    const base = await makeStore()
    const f = flaky(base)
    const h = harness(f.store)
    const user = uid('v')
    f.down.add('resolvePortal')
    const c = h.connect(cgAuth({ portalToken: liveToken(user) }))
    await until('the offline account', () => c.accounts().length > 0)
    const offlineId = c.accounts()[0].id
    f.down.clear()
    f.down.add('createLinked')
    const first = await play(c)
    assert.equal(first.playerId, offlineId)
    assert.equal(c.connection.account?.persisted, false)
    assert.equal(await base.resolvePortal('crazygames', user), null, 'linked although the creation failed')
    assert.equal(c.accounts().length, 1, 'announced again while still offline')
    await endRun(h, c)
    f.down.clear()
    const again = await play(c)
    const msg = c.accounts().at(-1) as Record<string, unknown>
    assert.equal(msg.portal, 'crazygames')
    assert.equal(again.playerId, msg.id)
    assert.equal((await base.resolvePortal('crazygames', user))?.publicId, msg.id)
  })

  await t.test('createLinked failing at the first READY (4c): offline, nothing linked', async () => {
    const base = await makeStore()
    const f = flaky(base)
    const h = harness(f.store)
    const user = uid('w')
    f.down.add('createLinked')
    const c = h.connect(cgAuth({ portalToken: liveToken(user) }))
    const player = await play(c)
    const [msg] = c.accounts()
    assert.deepEqual(Object.keys(msg).sort(), ['id', 'offline'])
    assert.equal(player.playerId, msg.id)
    assert.equal(await base.resolvePortal('crazygames', user), null)
    assert.deepEqual(linkResults(), [])
  })

  await t.test('4b accept with linkPortal failing: nothing set, the guest stays unlinked, READY makes a new linked account', async () => {
    const base = await makeStore()
    const f = flaky(base)
    const h = harness(f.store)
    const user = uid('x')
    const guest = await base.create()
    const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    await until('the offer', () => c.accounts().length > 0)
    f.down.add('linkPortal')
    c.handlers.portal_link({ accept: true })
    await settle()
    assert.equal(c.connection.account, undefined, 'an account set by a failed link')
    assert.equal(c.accounts().length, 1)
    f.down.clear()
    const player = await play(c)
    const msg = c.accounts().at(-1) as Record<string, unknown>
    assert.notEqual(msg.id, guest.account.publicId)
    assert.equal(msg.portal, 'crazygames')
    assert.equal(player.playerId, msg.id)
    assert.equal(await base.linkedPortal(guest.account.publicId), null)
    assert.equal((await base.resolvePortal('crazygames', user))?.publicId, msg.id)
  })

  await t.test('CRAZYGAMES_GAME_ID unset: a valid token is ignored; the connection plays as today\'s guest', async () => {
    const h = harness(await makeStore(), null)
    const user = uid('h')
    const guest = await h.store.create()
    const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
    await until('account', () => c.accounts().length > 0)
    assert.equal(c.accounts()[0].id, guest.account.publicId)
    assert.ok(!('linkable' in c.accounts()[0]) && !('portal' in c.accounts()[0]))
    c.start()
    await until('a player', () => c.connection.player !== undefined)
    assert.equal(c.connection.player?.name, Player.callsign(guest.account.publicId))
    assert.equal(await h.store.resolvePortal('crazygames', user), null)
    const fresh = h.connect(cgAuth({ portalToken: liveToken(uid('i')) }))
    fresh.start()
    await until('a player', () => fresh.connection.player !== undefined)
    assert.match(String(fresh.accounts()[0].token), TOKEN_SHAPE)
    assert.deepEqual(linkResults(), [])
  })

  await t.test('names: a filtered or malformed CG username falls back to the callsign; a client-sent name never shows', async () => {
    const h = harness(await makeStore())
    for (const [username, shown] of [['Nova_Rider', 'Nova_Rider'], ['shithead99', undefined], ['you.you', 'you.you'], ['ab', undefined], ['<script>', undefined]] as const) {
      const c = h.connect(cgAuth({ portalToken: liveToken(uid('n'), username) }))
      c.start()
      await until('a player', () => c.connection.player !== undefined)
      const player = c.connection.player as Player
      assert.equal(player.name, shown ?? Player.callsign(player.playerId), username)
      assert.notEqual(player.name, 'TypedName')
    }
  })
}

test('rules 4a-4d on the memory store', async (t) => {
  await rules(t, async () => new MemoryAccountStore())
})

const URL = process.env.TEST_DATABASE_URL
const DB = 'plunder_portal_spec'

/** `URL` pointed at `DB`, created if missing, with an empty public schema. */
async function ownDatabase (): Promise<string> {
  const admin = new PgClient({ connectionString: URL })
  await admin.connect()
  try {
    await admin.query(`CREATE DATABASE ${DB}`)
  } catch (e) {
    if ((e as { code?: string }).code !== '42P04') throw e
  } finally {
    await admin.end()
  }
  const url = new globalThis.URL(URL as string)
  url.pathname = `/${DB}`
  const own = new PgClient({ connectionString: url.toString() })
  await own.connect()
  try {
    await own.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  } finally {
    await own.end()
  }
  return url.toString()
}

test('rules 4a-4d on Postgres', async (t) => {
  if (URL === undefined || URL === '') {
    t.skip('TEST_DATABASE_URL not set')
    return
  }
  const host = new globalThis.URL(URL).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'TEST_DATABASE_URL is not local: refusing to touch it')
  const store = new PgAccountStore({ connectionString: await ownDatabase() })
  await store.migrateOnce()
  store.ready = true
  try {
    const portal = portalStoreOf(store)
    assert.ok(portal !== undefined)
    await rules(t, async () => portal)
  } finally {
    await store.close()
  }
})

test('a store without the portal half plays a verified CG user as a guest', async () => {
  const inner = new MemoryAccountStore()
  const plain: AccountStore = {
    resolve: async (token) => await inner.resolve(token),
    create: async () => await inner.create(),
    grant: async (id, xp, credit) => await inner.grant(id, xp, credit),
    season: async (id, at) => await inner.season(id, at),
    seasonBoard: async (at, limit) => await inner.seasonBoard(at, limit),
    payDue: async (at) => await inner.payDue(at),
    saveLoadout: async (id, robot, index, skills) => { await inner.saveLoadout(id, robot, index, skills) },
    spend: async (id, at, bring) => await inner.spend(id, at, bring),
    refund: async (id, at) => await inner.refund(id, at),
    close: async () => {}
  }
  const h = harness(plain as Store)
  const c = h.connect(cgAuth({ portalToken: liveToken(uid('p')) }))
  c.start()
  await until('a player', () => c.connection.player !== undefined)
  assert.match(String(c.accounts()[0].token), TOKEN_SHAPE)
  assert.equal(c.connection.player?.name, Player.callsign(String(c.accounts()[0].id)))
  void Multiplayer
})

// Two guards no path reaches today (Archie's review: equivalent mutants). Pinned
// directly, so a later path that does reach them can't drop them unnoticed.

test('guard: an account message for a linked account never carries a token, even when handed one', async () => {
  const h = harness(new MemoryAccountStore())
  const linked = await h.store.createLinked('crazygames', uid('y'))
  const message = (h.worlds as unknown as { accountMessage: (account: unknown, token?: string) => Record<string, unknown> }).accountMessage(linked, 'B'.repeat(43))
  assert.equal(message.portal, 'crazygames')
  assert.ok(!('token' in message), 'a linked account was sent a token')
})

test('guard: a link answer reaching a connection that already plays an account links nothing', async () => {
  const h = harness(new MemoryAccountStore())
  const user = uid('z')
  const guest = await h.store.create()
  const c = h.connect(cgAuth({ token: guest.token, portalToken: liveToken(user) }))
  await until('the offer', () => c.accounts().length > 0)
  // No path sets an account while an offer is pending; stand in for one that would.
  const other = await h.store.create()
  c.connection.account = other.account
  c.handlers.portal_link({ accept: true })
  await settle()
  assert.equal(c.connection.account, other.account)
  assert.equal(await h.store.linkedPortal(guest.account.publicId), null, 'the guest was linked behind the playing account')
  assert.equal(await h.store.resolvePortal('crazygames', user), null)
  assert.deepEqual(linkResults(), [])
})
