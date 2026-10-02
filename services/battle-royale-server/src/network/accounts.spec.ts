import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import Analytics from '../analytics'
import { type Account, type AccountStore, MemoryAccountStore, PUBLIC_ID_SHAPE, TOKEN_SHAPE } from '../db/accounts'
import { NotReadyError } from '../db/pgstore'
import { onAccount, readToken, handshakeAuth, TOKEN_KEY, type TokenStorage } from '../../../../plunder-land-client/src/net/account'

/**
 * Guest accounts through `Worlds` (decision #48, step 1): the handshake's
 * token is looked up on connect, an account is created on first play and
 * announced (`account { id, token }`) before the run's `hello`, the player id
 * is the account's, and a store that fails or hangs gives an offline account
 * (fail open, no grants): the run plays, no token, no stats, `offline: 1`.
 */

let savedLog: ThrottledLog
let failures: unknown[] = []

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  failures = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), (...args) => { failures.push(args) })
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  World.strict = false
})

/** Every Redis write, as `command key`. */
function redisStub (writes: string[] = []): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async (key: string) => { writes.push(`hincrby ${key}`); return 1 },
    hsetnx: async (key: string) => { writes.push(`hsetnx ${key}`); return 1 },
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

/** A socket that records every emit in order, with a handshake token. */
class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection
  closed = false

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: {
        write: () => {},
        close: () => {
          if (this.closed) return
          this.closed = true
          this.handlers.disconnect?.()
        }
      }
    } as unknown as Socket
  }

  start (id: unknown = 'abcdef'): void {
    this.handlers.start_requested({ id, name: this.id })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }

  /** Event names in the order they were emitted. */
  get order (): string[] {
    return this.emitted.map(([event]) => event)
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

function makeWorlds (accounts: AccountStore, writes?: string[], accountTimeoutMs?: number): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(writes), now: () => 0, accounts, accountTimeoutMs })
}

function connect (worlds: Worlds, id: string, auth?: unknown): Client {
  const client = new Client(id, auth)
  client.connection = worlds.onConnection(client.socket)
  return client
}

/** A store that counts its calls and can be told to fail or hang. */
class TestStore implements AccountStore {
  readonly inner = new MemoryAccountStore()
  resolves = 0
  creates = 0
  mode: 'ok' | 'throw' | 'hang' | 'not-ready' = 'ok'
  /** Resolves `create` only when released (for "while pending" tests). */
  gate: Promise<void> | undefined

  private fail (): Promise<never> {
    if (this.mode === 'hang') return new Promise(() => {})
    if (this.mode === 'not-ready') return Promise.reject(new NotReadyError())
    return Promise.reject(new Error('connection refused (stub)'))
  }

  async resolve (token: string): Promise<Account | null> {
    this.resolves++
    if (this.mode !== 'ok') return await this.fail()
    return await this.inner.resolve(token)
  }

  async create (): Promise<{ account: Account, token: string }> {
    this.creates++
    if (this.mode !== 'ok') return await this.fail()
    if (this.gate !== undefined) await this.gate
    return await this.inner.create()
  }

  async close (): Promise<void> {}
}

// --- the flow ----------------------------------------------------------------

test('no token: account { id, token } arrives before hello, and the run and its stats use that id, not the start\'s', async () => {
  const store = new TestStore()
  const writes: string[] = []
  const worlds = makeWorlds(store, writes)
  const a = connect(worlds, 'a')
  await settle()
  assert.deepEqual(a.events('account'), [], 'no account is made before the first play')
  assert.equal(store.resolves, 0, 'no token, no lookup')

  a.start('abcdef')
  await settle()
  const [account] = a.events('account') as Array<{ id: string, token: string }>
  assert.ok(account !== undefined, 'no account event')
  assert.match(account.id, PUBLIC_ID_SHAPE)
  assert.match(account.token, TOKEN_SHAPE)
  assert.equal(Object.keys(account).sort().join(), 'id,token')
  assert.ok(a.order.indexOf('account') < a.order.indexOf('hello'), `account after hello: ${a.order.join(' ')}`)
  assert.equal(a.order.filter((e) => e === 'hello').length, 1)
  assert.equal(store.creates, 1)

  const player = a.connection.player
  assert.ok(player !== undefined)
  assert.equal(player.playerId, account.id)
  // Disconnect: the stats write is keyed by the account's id.
  writes.length = 0
  a.socket.conn.close()
  await settle()
  assert.ok(writes.length > 0)
  for (const w of writes) assert.equal(w, `hincrby stats-${account.id}`)

  // The token was never kept on the connection.
  assert.ok(!JSON.stringify(Object.entries(a.connection).filter(([key]) => key !== 'socket' && key !== 'player' && key !== 'known' && key !== 'outbox')).includes(account.token))
})

test('reconnecting with the token: account { id } with the same id on connect, no token, no new account', async () => {
  const store = new TestStore()
  const worlds = makeWorlds(store)
  const first = connect(worlds, 'first')
  first.start()
  await settle()
  const [issued] = first.events('account') as Array<{ id: string, token: string }>
  first.socket.conn.close()

  const again = connect(worlds, 'again', { token: issued.token })
  await settle()
  assert.deepEqual(again.events('account'), [{ id: issued.id }], 'announced on connect, before any start')
  assert.equal(store.resolves, 1)
  again.start('fedcba')
  await settle()
  assert.equal(again.connection.player?.playerId, issued.id)
  assert.equal(store.creates, 1, 'a second account was created')
  assert.equal(again.events('account').length, 1, 'announced again at the start')
  // Its next run on the same connection is synchronous: the account is known.
  const player = again.connection.player
  const world = worlds.worldFor(again.connection) as World
  assert.ok(player !== undefined)
  World.run(world, () => { player.destroy() })
  worlds.tickAll(250)
  again.start()
  assert.notEqual(again.connection.player, player, 'the next run did not start at once')
  assert.equal(again.connection.player?.playerId, issued.id)
})

test('a malformed token is treated as none: no lookup, and a new account on first play', async () => {
  for (const auth of [{ token: 'short' }, { token: 'x'.repeat(43) + '=' }, { token: 'a'.repeat(42) + '!' }, { token: 5 }, 'token', null, { token: { length: 43 } }]) {
    const store = new TestStore()
    const worlds = makeWorlds(store)
    const a = connect(worlds, 'a', auth)
    a.start()
    await settle()
    assert.equal(store.resolves, 0, JSON.stringify(auth))
    assert.equal(store.creates, 1, JSON.stringify(auth))
    const [account] = a.events('account') as Array<{ token?: string }>
    assert.match(account.token ?? '', TOKEN_SHAPE)
  }
})

test('an unknown well-formed token: a new account, and its token replaces the old', async () => {
  const store = new TestStore()
  const worlds = makeWorlds(store)
  const stale = 'A'.repeat(43)
  const a = connect(worlds, 'a', { token: stale })
  await settle()
  assert.deepEqual(a.events('account'), [])
  a.start()
  await settle()
  const [account] = a.events('account') as Array<{ token?: string }>
  assert.match(account.token ?? '', TOKEN_SHAPE)
  assert.notEqual(account.token, stale)
})

test('two start_requested while the account is pending: one run', async () => {
  const store = new TestStore()
  let release!: () => void
  store.gate = new Promise((resolve) => { release = resolve })
  const worlds = makeWorlds(store)
  const a = connect(worlds, 'a')
  a.start()
  a.start()
  await settle()
  a.start()
  assert.equal(a.connection.player, undefined, 'started before the account')
  release()
  await settle()
  assert.equal(store.creates, 1)
  assert.equal(a.events('hello').length, 1)
  assert.equal(a.events('account').length, 1)
  const world = worlds.worldFor(a.connection) as World
  assert.equal(World.run(world, () => World.PLAYERS.filter((p) => p.bot === undefined).length), 1)
})

test('a disconnect while the account is pending: no run, no account, no throw', async () => {
  const store = new TestStore()
  let release!: () => void
  store.gate = new Promise((resolve) => { release = resolve })
  const worlds = makeWorlds(store)
  const a = connect(worlds, 'a')
  a.start()
  await settle()
  a.socket.conn.close()
  release()
  await settle()
  assert.equal(a.events('hello').length, 0)
  assert.equal(worlds.worldFor(a.connection), undefined)
  assert.equal(World.run(worlds.worlds[0], () => World.PLAYERS.length), 0)

  // Closed before the lookup finished: the account is never created.
  const store2 = new TestStore()
  const worlds2 = makeWorlds(store2)
  const b = connect(worlds2, 'b')
  b.start()
  b.socket.conn.close()
  await settle()
  assert.equal(store2.creates, 0)
  assert.equal(b.events('hello').length, 0)
})

test('a drain while the account is pending: sent on, no run', async () => {
  const store = new TestStore()
  let release!: () => void
  store.gate = new Promise((resolve) => { release = resolve })
  const worlds = makeWorlds(store)
  const a = connect(worlds, 'a')
  // A live run elsewhere, so the drain keeps `a` (it has asked for a run).
  a.start()
  await settle()
  assert.equal(a.connection.starting, true)
  worlds.drain()
  // Not started and in no world: drain sends it on at once, and the pending
  // start must not then begin a run on the draining server.
  release()
  await settle()
  assert.equal(a.closed, true, 'not sent on')
  assert.equal(a.events('hello').length, 0, 'a run started on a draining server')
})

test('a drain that lands between the lookup and the start still sends it on', async () => {
  const store = new TestStore()
  let release!: () => void
  store.gate = new Promise((resolve) => { release = resolve })
  const worlds = makeWorlds(store)
  const a = connect(worlds, 'a')
  a.start()
  await settle()
  // Draining set without the lobby sweep (as if the start had been in flight
  // when the sweep ran): only the post-await check can catch it.
  worlds.draining = true
  release()
  await settle()
  assert.equal(a.closed, true, 'not sent on')
  assert.equal(a.events('hello').length, 0, 'a run started on a draining server')
})

// --- failure: fail open, no grants ----------------------------------------------

for (const mode of ['throw', 'not-ready', 'hang'] as const) {
  test(`a store that ${mode === 'hang' ? 'never answers' : mode === 'throw' ? 'throws' : 'is not migrated'}: the run plays offline, no token, no stats, analytics says offline`, async () => {
    const sent: Array<{ name: string, params: Record<string, unknown> }> = []
    const realPost = Analytics.post
    Analytics.post = async (_url, body) => { sent.push(...JSON.parse(body).events) }
    process.env.GA_MEASUREMENT_ID = 'G-TEST'
    process.env.GA_API_SECRET = 'secret'
    try {
      const store = new TestStore()
      store.mode = mode
      const writes: string[] = []
      const worlds = makeWorlds(store, writes, 30)
      const a = connect(worlds, 'a')
      a.start()
      await settle()
      if (mode === 'hang') await new Promise((resolve) => setTimeout(resolve, 60))
      await settle()

      const [account] = a.events('account') as Array<{ id: string, token?: string, offline?: boolean }>
      assert.ok(account !== undefined)
      assert.deepEqual(Object.keys(account).sort(), ['id', 'offline'], 'an offline account was sent a token')
      assert.equal(account.offline, true)
      assert.equal(a.events('hello').length, 1, 'the run did not start')
      const player = a.connection.player
      assert.ok(player !== undefined)
      assert.equal(player.playerId, account.id)
      assert.equal(a.connection.account?.persisted, false)
      assert.ok(failures.length > 0, 'the failure was not logged')

      const world = worlds.worldFor(a.connection) as World
      World.run(world, () => {
        player.addLoot(5)
        player.onKill(player) // a kill credit writes kill stats for a persisted account
        player.exit()
      })
      await settle()
      assert.deepEqual(writes, [], 'an offline run wrote to Redis')
      assert.deepEqual(sent.map((e) => e.name).sort(), ['first_loot', 'run_end', 'run_start'])
      for (const event of sent) assert.equal(event.params.offline, 1, `${event.name} without offline: 1`)
    } finally {
      Analytics.post = realPost
      delete process.env.GA_MEASUREMENT_ID
      delete process.env.GA_API_SECRET
    }
  })
}

test('a lookup that fails: offline at once, announced on connect, and the store is not asked to create', async () => {
  const store = new TestStore()
  const good = await store.inner.create()
  store.mode = 'throw'
  const worlds = makeWorlds(store)
  const a = connect(worlds, 'a', { token: good.token })
  await settle()
  const [account] = a.events('account') as Array<{ id: string, offline?: boolean }>
  assert.equal(account.offline, true)
  assert.notEqual(account.id, good.account.publicId)
  a.start()
  await settle()
  assert.equal(store.creates, 0)
  assert.equal(a.connection.player?.playerId, account.id)
})

test('an issued id without ID_SHAPE is never played under', async () => {
  const store = new TestStore()
  store.inner.create = async () => ({ account: { publicId: 'stats-*', persisted: true }, token: 'T'.repeat(43) })
  const worlds = makeWorlds(store)
  const a = connect(worlds, 'a')
  a.start()
  await settle()
  const [account] = a.events('account') as Array<{ id: string, token?: string, offline?: boolean }>
  assert.equal(account.offline, true)
  assert.equal(account.token, undefined)
  assert.match(a.connection.player?.playerId ?? '', PUBLIC_ID_SHAPE)
})

test('bots join with bot-N ids and never touch the store', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const store = new TestStore()
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), bots: 4, now: () => Date.now(), accounts: store })
  const a = connect(worlds, 'a')
  a.start()
  await settle()
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); worlds.tickAll(250) }
  const world = worlds.worlds[0]
  const bots = World.run(world, () => World.PLAYERS.filter((p) => p.bot !== undefined))
  assert.ok(bots.length >= 3)
  for (const bot of bots) assert.match(bot.playerId, /^bot-\d+$/)
  assert.equal(store.creates, 1, 'only the human')
  assert.equal(store.resolves, 0)
})

// --- the client half (plunder-land-client/src/net/account.ts) ---------------------

function memoryStorage (): TokenStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) } }
}

test('client: a token from account is stored, sent in every handshake after, and an offline or malformed one is not', async () => {
  const storage = memoryStorage()
  const auth = handshakeAuth(() => storage)
  const read = (): unknown => { let out: unknown; auth((data) => { out = data }); return out }
  assert.deepEqual(read(), {}, 'no token yet')

  const worlds = makeWorlds(new MemoryAccountStore())
  const a = connect(worlds, 'a', read())
  a.start()
  await settle()
  const [message] = a.events('account')
  assert.deepEqual(onAccount(message, storage), { id: (message as { id: string }).id, offline: false })
  const token = storage.items.get(TOKEN_KEY) as string
  assert.match(token, TOKEN_SHAPE)
  assert.deepEqual(read(), { token }, 'the next handshake carries it')

  // The server knows it: same id, nothing new stored.
  const b = connect(worlds, 'b', read())
  await settle()
  assert.deepEqual(b.events('account'), [{ id: (message as { id: string }).id }])
  assert.equal(onAccount(b.events('account')[0], storage)?.id, (message as { id: string }).id)
  assert.equal(storage.items.get(TOKEN_KEY), token)

  // Offline: nothing stored, so the real token survives the outage.
  assert.deepEqual(onAccount({ id: 'ffffffffffffffff', token: 'B'.repeat(43), offline: true }, storage), { id: 'ffffffffffffffff', offline: true })
  assert.equal(storage.items.get(TOKEN_KEY), token)
  // Malformed: ignored.
  assert.equal(onAccount(null, storage), undefined)
  assert.equal(onAccount({ token: 'C'.repeat(43) }, storage), undefined)
  onAccount({ id: 'x', token: 'short' }, storage)
  assert.equal(storage.items.get(TOKEN_KEY), token)

  // Storage that throws: no token, no throw.
  const broken: TokenStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readToken(broken), undefined)
  assert.doesNotThrow(() => onAccount({ id: 'a', token: 'D'.repeat(43) }, broken))
  storage.items.set(TOKEN_KEY, 'tampered')
  assert.deepEqual(read(), {}, 'a stored token of the wrong shape is not sent')
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
