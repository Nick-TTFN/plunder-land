import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import { PROTOCOL } from '../utils/protocol'
import { decideWelcome, MAX_RELOADS, readPending, RETRY_MS } from '../../../../plunder-land-client/src/net/protocol'

/**
 * Deploys without wiping runs (decision #46): a draining server takes no new
 * runs and sends lobby connections on to the next server, while the live runs
 * play out; and the protocol number every connection is welcomed with, which
 * reloads a client from another release.
 */

afterEach(() => {
  World.strict = false
})

function redisStub (writes: string[] = []): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async (key: string, field: string) => { writes.push(`${key} ${field}`); return 1 },
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

/** A socket that records what it was sent and whether its transport was closed. */
class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection
  writes = 0
  closed = false

  constructor (readonly id: string) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' } },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: {
        write: () => { this.writes++ },
        // As socket.io does: a closed transport ends in the socket's disconnect.
        close: () => {
          if (this.closed) return
          this.closed = true
          this.handlers.disconnect?.()
        }
      }
    } as unknown as Socket
  }

  /** A start, then the wait for the account (guest accounts, decision #48). */
  async start (): Promise<void> {
    this.handlers.start_requested({ id: 'abcdef', name: this.id })
    await settle()
  }

  get hellos (): number {
    return this.emitted.filter(([event]) => event === 'hello').length
  }
}

/** Let the account lookup and creation (memory store) finish. */
async function settle (): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

function connect (worlds: Worlds, id: string): Client {
  const client = new Client(id)
  client.connection = worlds.onConnection(client.socket)
  return client
}

function makeWorlds (writes?: string[]): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(writes), now: () => 0 })
}

test('every connection is welcomed with the protocol number, before anything else', async () => {
  const worlds = makeWorlds()
  const a = connect(worlds, 'a')
  assert.deepEqual(a.emitted[0], ['welcome', { protocol: PROTOCOL }])
  await a.start()
  assert.equal(a.hellos, 1, 'the run starts as before')
})

test('draining sends lobby connections on, keeps live runs and run cards, and starts no new run', async () => {
  const worlds = makeWorlds()
  const lobby = connect(worlds, 'lobby')
  const live = connect(worlds, 'live')
  const card = connect(worlds, 'card')
  await live.start()
  await card.start()
  // card's run ends: it is on its run card, between runs, still in its world.
  const world = worlds.worldFor(card.connection)
  assert.ok(world !== undefined && card.connection.player !== undefined)
  const player = card.connection.player
  World.run(world, () => { player.destroy() })
  worlds.tickAll(250)
  assert.equal(card.connection.started, false, 'test setup: card is between runs')

  worlds.drain()
  assert.equal(lobby.closed, true, 'a lobby connection goes to the next server at once')
  assert.equal(live.closed, false, 'a live run stays')
  assert.equal(card.closed, false, 'a run card stays up')
  assert.equal(worlds.drained, false, 'one run is live')

  const before = live.writes
  worlds.tickAll(250)
  assert.ok(live.writes > before, 'the live run is still ticked and sent')

  await card.start()
  assert.equal(card.closed, true, 'asking for the next run sends it on')
  assert.equal(card.hellos, 1, 'and starts no run here')

  const late = connect(worlds, 'late')
  assert.deepEqual(late.emitted[0], ['welcome', { protocol: PROTOCOL }])
  assert.equal(late.closed, true, 'a connection that reaches a draining server is sent on')

  const livePlayer = live.connection.player
  const liveWorld = worlds.worldFor(live.connection)
  assert.ok(livePlayer !== undefined && liveWorld !== undefined)
  World.run(liveWorld, () => { livePlayer.exit() })
  assert.equal(worlds.drained, true, 'once the last run has ended, the process can stop')
  assert.equal(Worlds.activeRuns(worlds), 0)
})

test('closeAll ends live runs as disconnects, so their stats are written', async () => {
  const writes: string[] = []
  const worlds = makeWorlds(writes)
  const a = connect(worlds, 'a')
  const b = connect(worlds, 'b')
  await a.start()
  worlds.drain()
  assert.equal(b.closed, true)
  writes.length = 0
  worlds.closeAll()
  assert.equal(a.closed, true)
  // Under the account's id, not the start's (decision #48).
  const id = a.connection.account?.publicId
  assert.match(id ?? '', /^[0-9a-f]{16}$/)
  assert.ok(writes.some((w) => w.startsWith(`stats-${id} `)), `a disconnect's stats write, got ${JSON.stringify(writes)}`)
  assert.equal(worlds.drained, true)
})

test('a client reloads for another protocol, retries while the new client deploys, then plays on', () => {
  assert.deepEqual(decideWelcome({ protocol: PROTOCOL }, null), { action: 'match' })
  assert.deepEqual(decideWelcome(undefined, null), { action: 'match' }, 'a server from before welcome')
  assert.deepEqual(decideWelcome({}, { protocol: PROTOCOL + 1, reloads: 3 }), { action: 'match' })

  const other = PROTOCOL + 1
  let pending = null
  for (let i = 0; i < MAX_RELOADS; i++) {
    const welcome = decideWelcome({ protocol: other }, pending)
    assert.equal(welcome.action, 'reload')
    if (welcome.action !== 'reload') return
    assert.equal(welcome.delayMs, i === 0 ? 0 : RETRY_MS, 'the first reload is immediate')
    assert.deepEqual(welcome.next, { protocol: other, reloads: i + 1 })
    pending = readPending(JSON.stringify(welcome.next))
  }
  assert.deepEqual(decideWelcome({ protocol: other }, pending), { action: 'give-up', protocol: other })
  const third = decideWelcome({ protocol: other + 1 }, pending)
  assert.equal(third.action, 'reload', 'a newer number starts its own count')
  assert.equal(third.action === 'reload' && third.delayMs, 0)

  assert.equal(readPending(null), null)
  assert.equal(readPending('not json'), null)
  assert.equal(readPending('{"protocol":"2"}'), null)
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
