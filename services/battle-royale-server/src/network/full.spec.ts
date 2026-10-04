import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from './multiplayer'
import Worlds, { FULL_RETRY_MS } from './worlds'
import World from '../objects/world'
import { MemoryAccountStore } from '../db/accounts'
import { FULL, RETRY, clearFull, fullLine, onFull, retryDelay, retryDue } from '../../../../plunder-land-client/src/net/full'

/**
 * A process's cap (burst-capacity, `MAX_PLAYERS`): a start over it is sent
 * `full` and its transport closed; none under it is; a run that ends frees a
 * place; no cap means none is ever refused. And the client's retry
 * (plunder-land-client/src/net/full.ts).
 */

void Multiplayer

afterEach(() => { World.strict = false })

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null, keys: async () => [], hgetall: async () => ({})
  }) as unknown as Redis
}

class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection
  closed = false
  constructor (readonly id: string) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' } },
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

  start (): void { this.handlers.start_requested({ id: 'abcdef', name: this.id }) }
  events (name: string): unknown[] { return this.emitted.filter(([e]) => e === name).map(([, d]) => d) }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function makeWorlds (maxPlayers?: number): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 2, idleMs: 300_000, redis: redisStub(), accounts: new MemoryAccountStore(), maxPlayers })
}

async function connectAndStart (worlds: Worlds, id: string): Promise<Client> {
  const client = new Client(id)
  client.connection = worlds.onConnection(client.socket)
  client.start()
  await settle()
  return client
}

test('MAX_PLAYERS: runs up to the cap start, across worlds; the next is sent full and its transport closed; nothing spent', async () => {
  const worlds = makeWorlds(3)
  const runs = []
  for (let i = 0; i < 3; i++) runs.push(await connectAndStart(worlds, `p${i}`))
  assert.ok(runs.every((c) => c.connection.player !== undefined && c.events('full').length === 0))
  assert.equal(worlds.worlds.length, 2, 'world cap 2: the third run opened a second world')
  assert.equal(Worlds.activeRuns(worlds), 3)
  const over = await connectAndStart(worlds, 'over')
  assert.deepEqual(over.events('full'), [{ retryMs: FULL_RETRY_MS }])
  assert.equal(over.closed, true, 'the transport is closed so the client reconnects')
  assert.equal(over.connection.player, undefined)
  assert.equal(over.events('account').length, 0, 'refused before the account: no row, no play spent')

  // A run that ends frees a place.
  const first = runs[0].connection.player
  assert.ok(first !== undefined)
  World.run(worlds.worldFor(runs[0].connection) as World, () => { first.exit() })
  worlds.tickAll(250)
  const next = await connectAndStart(worlds, 'next')
  assert.ok(next.connection.player !== undefined, 'a place freed by an extraction was not taken')
  assert.equal(next.events('full').length, 0)
})

test('MAX_PLAYERS unset or 0: never full', async () => {
  for (const cap of [undefined, 0]) {
    const worlds = makeWorlds(cap)
    for (let i = 0; i < 6; i++) {
      const c = await connectAndStart(worlds, `p${i}`)
      assert.equal(c.events('full').length, 0)
      assert.ok(c.connection.player !== undefined)
    }
    assert.equal(worlds.full, false)
  }
})

test('MAX_PLAYERS counts humans only: bots fill worlds and never make a process full', async () => {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(), accounts: new MemoryAccountStore(), maxPlayers: 2, bots: 8 })
  await connectAndStart(worlds, 'a')
  for (let i = 0; i < 40; i++) worlds.tickAll(250)
  const second = await connectAndStart(worlds, 'b')
  assert.ok(second.connection.player !== undefined, 'refused because of bots')
})

test('client: the retry waits longer each time, never under the server\'s retryMs, jittered, capped; a run clears it', () => {
  clearFull()
  assert.equal(retryDelay(0, 0, 0.5), RETRY.baseMs)
  assert.equal(retryDelay(1, 0, 0.5), 2 * RETRY.baseMs)
  assert.equal(retryDelay(10, 0, 0.5), RETRY.capMs)
  assert.equal(retryDelay(0, 2000, 0.5), 2000, 'the server\'s suggestion is the floor')
  assert.equal(retryDelay(0, 2000, 0), 1400)
  assert.equal(retryDelay(0, 2000, 0.999999), 2600)
  onFull({ retryMs: 2000 }, 10_000, 0.5)
  assert.deepEqual({ ...FULL }, { attempt: 1, retryAt: 12_000 })
  assert.equal(fullLine(10_000), 'SERVER FULL · RETRYING IN 2S')
  assert.equal(retryDue(11_999), false)
  assert.equal(retryDue(12_000), true)
  onFull({ retryMs: 2000 }, 20_000, 0.5)
  onFull({ retryMs: 2000 }, 30_000, 0.5)
  assert.deepEqual({ ...FULL }, { attempt: 3, retryAt: 34_000 }, 'the third refusal waits 4 s')
  onFull({ retryMs: 'soon' }, 40_000, 0.5)
  assert.equal(FULL.retryAt, 48_000, 'a malformed retryMs is no floor: the backoff alone')
  clearFull()
  assert.deepEqual({ ...FULL }, { attempt: 0, retryAt: undefined })
  assert.equal(fullLine(0), undefined)
  assert.equal(retryDue(1e12), false)
})
