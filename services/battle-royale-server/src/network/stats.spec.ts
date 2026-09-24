import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer, { ThrottledLog } from './multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Mob from '../objects/mob'
import type Player from '../objects/player'

/**
 * `redis-rejection-crash`: with Redis unreachable, a player disconnecting ended
 * the process with `MaxRetriesPerRequestError`, because the stats write on
 * destroy was a bare `void` promise and its rejection went unhandled. Nothing is
 * persisted, so that wiped the world. These run the real disconnect path against
 * a Redis stub whose every command rejects.
 */

/** Every command rejects, the way ioredis does once it gives up retrying. */
function deadRedis (): { client: Redis, calls: number } {
  const stub = {
    calls: 0,
    client: {
      on: () => stub.client,
      hincrby: async () => {
        stub.calls++
        throw new Error('Reached the max retries per request limit (stub)')
      }
    } as unknown as Redis
  }
  return stub
}

/** Enough of a socket.io Socket for Multiplayer: handlers, emit and an id. */
function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  return { socket, fire: (event, data) => { handlers[event](data) } }
}

/** Let a rejected promise settle and any unhandled-rejection report fire. */
async function settle (): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

let unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
let logged: unknown[][] = []
const savedStatsLog = Multiplayer.STATS_LOG

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()

  unhandled = []
  process.on('unhandledRejection', onUnhandled)
  logged = []
  Multiplayer.STATS_LOG = new ThrottledLog('stats write failed', 60_000, () => Date.now(), (...args) => { logged.push(args) })
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  Multiplayer.STATS_LOG = savedStatsLog
})

test('a disconnect with Redis down leaves the world running', async () => {
  const redis = deadRedis()
  const multiplayer = new Multiplayer(250, redis.client)
  const world = new World(4000)
  // This ticks a real world, which places exits, portals and mobs at random.
  // A player that spawns next to an exit extracts within the four ticks below
  // and fails the count at the end: 6 of 1500 replays did (main session,
  // 2026-09-24). This test is about Redis, not the map, so it gets an empty one.
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0

  const { socket, fire } = fakeSocket('s1')
  multiplayer.onConnect(socket)
  fire('start_requested', 'p1')
  await settle()
  assert.equal(World.PLAYERS.length, 1)

  multiplayer.onDisconnect(socket)
  await settle()

  assert.equal(redis.calls, 1, 'the stats write was attempted')
  assert.deepEqual(unhandled, [], 'the rejection was handled')
  assert.equal(logged.length, 1, 'and logged')
  // The world drops destroyed players on its next tick.
  world.update(0.25)
  multiplayer.flushAll(1, 250)
  assert.equal(World.PLAYERS.length, 0)

  // The world goes on: a new player joins and the tick keeps running.
  const next = fakeSocket('s2')
  multiplayer.onConnect(next.socket)
  next.fire('start_requested', 'p2')
  for (let tick = 2; tick <= 5; tick++) {
    world.update(0.25)
    multiplayer.flushAll(tick, 250)
  }
  await settle()
  assert.equal(World.PLAYERS.length, 1)
  assert.deepEqual(unhandled, [])
})

test('a kill with Redis down is handled too', async () => {
  const redis = deadRedis()
  const multiplayer = new Multiplayer(250, redis.client)
  new World(4000) // eslint-disable-line no-new

  const { socket, fire } = fakeSocket('s1')
  multiplayer.onConnect(socket)
  fire('start_requested', 'killer')
  const player = World.PLAYERS[0] as Player
  const mob = new Mob(player.position.x, player.position.y, player.tag)

  player.onKill(mob)
  await settle()

  assert.ok(redis.calls >= 1, 'the kill stats write was attempted')
  assert.deepEqual(unhandled, [])
  assert.equal(logged.length, 1)
})

test('repeated failures log once per window, then report how many were dropped', () => {
  let now = 1_000_000
  const lines: unknown[][] = []
  const log = new ThrottledLog('stats write failed', 60_000, () => now, (...args) => { lines.push(args) })

  log.report(new Error('a'))
  for (let i = 0; i < 50; i++) { now += 1000; log.report(new Error('b')) }
  assert.equal(lines.length, 1, '51 failures inside a minute are one line')

  now += 10_000 // 60s since the first line
  log.report(new Error('c'))
  assert.equal(lines.length, 2)
  assert.match(String(lines[1][0]), /50 more in the last 60s/)
})
