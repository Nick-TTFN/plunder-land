import test from 'node:test'
import assert from 'node:assert/strict'
import type { Socket } from 'socket.io'
import Multiplayer, { Connection } from './multiplayer'
import type Player from '../objects/player'
import { FRAME_KINDS, unpackFrame } from '../../../../plunder-land-client/src/net/framedparser'

/**
 * server-cpu-trim: a framed connection (`?frames=1`) gets one engine.io
 * message per flush instead of up to six socket.io events. Split by the
 * client's own decoder, it must give exactly the events an unframed
 * connection gets from the same outbox: same names, same order, same bytes.
 */

type Outbox = NonNullable<Connection['outbox']>

function record (rand: () => number): Buffer {
  const bytes = Buffer.alloc(1 + Math.floor(rand() * 40))
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256)
  return bytes
}

function lcg (seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

function connection (framed: boolean, sent: Array<[string, Buffer]>): Connection {
  const c = new Connection()
  c.framed = framed
  c.player = { destroyed: false, exited: false } as unknown as Player
  c.socket = {
    id: framed ? 'f' : 'u',
    emit: (event: string, data: Buffer) => { sent.push([event, Buffer.from(data)]); return true },
    conn: {
      write: (frame: Buffer) => {
        const events = unpackFrame(new Uint8Array(frame))
        assert.ok(events !== undefined, 'the client could not read the frame')
        for (const [event, data] of events) sent.push([event, Buffer.from(data)])
      }
    }
  } as unknown as Socket
  return c
}

test('a frame splits into exactly the events the same outbox sends unframed', () => {
  const mp = Object.create(Multiplayer.prototype) as Multiplayer
  const rand = lcg(7)
  for (let round = 0; round < 300; round++) {
    const outbox: Outbox = { create: [], create_own: [], effect: [], update: [], destroy: [] }
    for (const key of Object.keys(outbox) as Array<keyof Outbox>) {
      // Often empty, so every combination of missing sections comes up.
      const n = rand() < 0.5 ? 0 : Math.floor(rand() * 6)
      for (let i = 0; i < n; i++) outbox[key].push(record(rand))
    }
    const standings = rand() < 0.3 ? Multiplayer.packRecords([record(rand), record(rand)]) : undefined
    const tick = Math.floor(rand() * 2 ** 32)
    const seq = Math.floor(rand() * 65536)
    const ack = rand() * 70_000

    const unframed: Array<[string, Buffer]> = []
    const framed: Array<[string, Buffer]> = []
    const u = connection(false, unframed)
    const f = connection(true, framed)
    for (const c of [u, f]) {
      c.lastInputSeq = seq
      c.ackElapsedMs = ack
      c.outbox = { create: [...outbox.create], create_own: [...outbox.create_own], effect: [...outbox.effect], update: [...outbox.update], destroy: [...outbox.destroy] }
      mp.flush(c, tick, standings)
      assert.equal(c.outbox, undefined, 'the outbox was not dropped')
    }
    assert.deepEqual(framed, unframed, `round ${round}`)
    assert.equal(framed[framed.length - 1][0], 'update', 'update is not last')
  }
})

test('the section kinds match on both sides', () => {
  const server = Object.fromEntries(Multiplayer.FRAME_KINDS.map(([name, code]) => [code, name]))
  assert.deepEqual(server, FRAME_KINDS)
})

test('the client drops a frame of another version, and skips a section of an unknown kind', () => {
  const frame = Multiplayer.packFrame({ create: [Buffer.from([0, 0, 1])], create_own: [], effect: [], update: [], destroy: [] }, undefined, 5, 1, 0)
  const other = Buffer.from(frame)
  other[0] = 2
  assert.equal(unpackFrame(new Uint8Array(other)), undefined)

  // A kind-99 section in front of the create section.
  const extra = Buffer.from([99, 0, 0, 0, 3, 1, 2, 3])
  const withUnknown = Buffer.concat([frame.subarray(0, 9), extra, frame.subarray(9)])
  const events = unpackFrame(new Uint8Array(withUnknown))
  assert.deepEqual(events?.map(([name]) => name), ['create', 'update'])
})
