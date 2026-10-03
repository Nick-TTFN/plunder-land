import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import Timers from '../objects/timers'
import Analytics from '../analytics'
import { type Account, type AccountStore, MemoryAccountStore } from '../db/accounts'

/**
 * A run that extracted is ended once, even when a disconnect follows before
 * the flush that lets the player go (48-3 review). `exit` never sets
 * `destroyed`, and when a world's tick throws after an extraction,
 * `Worlds.tickAll`'s catch skips that world's flush, so `connection.player`
 * stays the exited player. `Multiplayer.drop` used to destroy it again on a
 * disconnect: `updateStats` twice (games +2, the loot banked twice),
 * `run_end` twice and the id freed twice.
 */

function redisStub (writes: string[]): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async (key: string, field: string, n: number) => { writes.push(`${key} ${field} ${n}`); return 1 },
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

/** The memory store, counting grants. */
class CountingStore implements AccountStore {
  readonly inner = new MemoryAccountStore()
  grants = 0
  async resolve (token: string): Promise<Account | null> { return await this.inner.resolve(token) }
  async create (): Promise<{ account: Account, token: string }> { return await this.inner.create() }
  async grant (publicId: string, xp: number): Promise<number> {
    this.grants++
    return await this.inner.grant(publicId, xp)
  }

  async close (): Promise<void> {}
}

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('an extraction whose tick throws before the flush, then a disconnect: the run ends once (stats, run_end, id, grant)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const events: Array<{ name: string, params: Record<string, unknown> }> = []
  const realPost = Analytics.post
  Analytics.post = async (_url, body) => { events.push(...JSON.parse(body).events) }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
  t.after(() => {
    Analytics.post = realPost
    delete process.env.GA_MEASUREMENT_ID
    delete process.env.GA_API_SECRET
    World.strict = false
  })

  const writes: string[] = []
  const store = new CountingStore()
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(writes), now: () => Date.now(), accounts: store })
  const handlers: Record<string, (data?: unknown) => void> = {}
  let closed = false
  const socket = {
    id: 'a',
    handshake: { query: { frames: '1' }, auth: {} },
    on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
    emit: () => true,
    conn: {
      write: () => {},
      close: () => {
        if (closed) return
        closed = true
        handlers.disconnect?.()
      }
    }
  } as unknown as Socket
  const connection: Connection = worlds.onConnection(socket)
  handlers.start_requested({ id: 'abcdef', name: 'A' })
  await settle()
  const player = connection.player
  assert.ok(player !== undefined, 'the run did not start')
  const world = worlds.worldFor(connection) as World
  World.run(world, () => {
    World.MOBS.length = 0
    World.OBSTACLES.length = 0
    player.addLoot(500)
  })
  t.mock.timers.tick(60_000)

  // The tick extracts the player, then throws before its flush.
  const update = world.update
  world.update = function (this: World, dt: number) {
    update.call(this, dt)
    player.exit()
    throw new Error('the tick threw after an extraction (spec)')
  }
  worlds.tickAll(250)
  world.update = update
  assert.equal(player.exited, true)
  assert.equal(connection.player, player, 'the flush ran: the window this spec is about never opened')

  // A disconnect before the next good flush.
  socket.conn.close()
  await settle()
  // The id frees fall due a second later; run them without a tick (a tick
  // would refill mobs, which take freed ids back).
  t.mock.timers.tick(2000)
  World.run(world, () => { Timers.run(Date.now()) })
  await settle()

  const id = player.playerId
  const runEnds = events.filter((e) => e.name === 'run_end')
  // One summary, so a failure shows every count at once.
  assert.deepEqual({
    games: writes.filter((w) => w.startsWith(`stats-${id} games `)),
    lootCollected: writes.filter((w) => w.startsWith(`stats-${id} lootCollected `)),
    runEnds: runEnds.map((e) => e.params.outcome),
    idFreed: world.ids.freed.filter((freed) => freed === player.id).length,
    grants: store.grants
  }, {
    games: [`stats-${id} games 1`],
    lootCollected: [`stats-${id} lootCollected 500`],
    runEnds: ['extracted'],
    idFreed: 1,
    grants: 1
  })
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
