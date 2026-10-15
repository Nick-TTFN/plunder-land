import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Redis from 'ioredis'
import { Server } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import './multiplayer'
import Worlds from './worlds'
import { bandOf, KEEP, Latency, STALE_MS } from '../../../../plunder-land-client/src/net/latency'
import { framedParser } from '../../../../plunder-land-client/src/net/framedparser'
import { io } from '../../../../plunder-land-client/node_modules/socket.io-client'

/** The HUD's latency readout: the client's reading, and the server's answer over a real socket. */

test('client: the reading is the median of the last answers, and goes stale', () => {
  let now = 0
  const latency = new Latency(() => now)
  assert.equal(latency.ms, undefined, 'no answer yet')
  for (const ms of [40, 500, 60]) latency.record(ms, now)
  assert.equal(latency.ms, 60, 'one slow answer does not move the median')
  for (let i = 0; i < KEEP; i++) latency.record(300, now)
  assert.equal(latency.ms, 300, `only the last ${KEEP} count`)
  now += STALE_MS + 1
  assert.equal(latency.ms, undefined, 'no answer lately reads as none')
  latency.record(80, now)
  latency.reset()
  assert.equal(latency.ms, undefined, 'a reconnect forgets the old answers')
})

test('client: a probe that times out records nothing', () => {
  const latency = new Latency(() => 0)
  latency.measure((done) => { done(false) })
  assert.equal(latency.ms, undefined)
})

test('client: bands', () => {
  assert.equal(bandOf(undefined), 'none')
  assert.equal(bandOf(99), 'good')
  assert.equal(bandOf(100), 'fair')
  assert.equal(bandOf(199), 'fair')
  assert.equal(bandOf(200), 'poor')
})

test('server answers the probe at once, through the framed parser, before any run', async (t) => {
  const redis = Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis, now: () => 0 })
  const http = createServer()
  const server = new Server(http, { transports: ['websocket'] })
  server.on('connection', (socket) => { worlds.onConnection(socket) })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as AddressInfo).port
  const client = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], parser: framedParser, query: { frames: '1' } })
  t.after(async () => {
    client.close()
    await new Promise<void>((resolve) => { void server.close(() => { resolve() }) })
  })
  await new Promise<void>((resolve) => client.on('connect', resolve))

  let now = 0
  const latency = new Latency(() => now)
  const answered = await new Promise<boolean>((resolve) => {
    latency.measure((done) => {
      client.timeout(2000).emit('latency', (err: unknown) => {
        now = 42
        done(err == null)
        resolve(err == null)
      })
    })
  })
  assert.ok(answered, 'the server acked')
  assert.equal(latency.ms, 42)
})
