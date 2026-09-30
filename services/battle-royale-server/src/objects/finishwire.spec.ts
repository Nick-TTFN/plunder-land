import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Player from './player'
import { GameObject } from './gameobject'
import {
  DEFAULT_FINISH, FINISH_BYTES, FINISH_PRESETS, PALETTE, PATTERNS,
  colourById, finishFromBytes, finishToBytes, patternById
} from '../utils/finishes'
import { decodeRecord } from '../../../../plunder-land-client/src/net/records'

/**
 * robot-finishes (#41): a player's finish, colour and pattern for head, body
 * and limbs, comes in with `start_requested` and goes out as field `finish`,
 * counted bytes appended at 23, in every create of that player. Decoded here
 * with the client's own `decodeRecord` over `fieldOrder`, which
 * `fieldtable.spec.ts` holds identical to the client's `allFields`.
 */

const FINISH_INDEX = 23

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  return { socket, fire: (event, data) => { handlers[event](data) } }
}

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.FINISHED.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
})

function setup (): Multiplayer {
  const multiplayer = new Multiplayer(250, okRedis())
  // eslint-disable-next-line no-new
  new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  return multiplayer
}

let joins = 0
/** Joins with `start` as the payload's extra fields; the id is made up here. */
function join (multiplayer: Multiplayer, extra: Record<string, unknown>): Player {
  const s = fakeSocket(`fin${joins}`)
  multiplayer.onConnect(s.socket)
  const before = World.PLAYERS.length
  s.fire('start_requested', { id: (0xf10000 + joins++).toString(16), name: 'FIN', ...extra })
  assert.equal(World.PLAYERS.length, before + 1, 'the join was refused')
  return World.PLAYERS[World.PLAYERS.length - 1]
}

/** The finish a client reads from this record, through the client's decoder. */
function clientReads (record: Buffer): unknown {
  return decodeRecord(new Uint8Array(record), GameObject.fieldOrder).finish
}

test('finish is appended at 23, after projectile', () => {
  assert.equal(GameObject.fieldOrder.indexOf('finish'), FINISH_INDEX)
  assert.equal(GameObject.fieldOrder.indexOf('projectile'), FINISH_INDEX - 1)
})

test('the table: ids unique, the presets and the default use only known ids', () => {
  assert.equal(new Set(PALETTE.map((c) => c.id)).size, PALETTE.length)
  assert.equal(new Set(PATTERNS.map((p) => p.id)).size, PATTERNS.length)
  assert.ok(!PALETTE.some((c) => c.id === 0), 'colour 0 must stay invalid')
  assert.equal(patternById(0)?.key, 'none')
  for (const { key, finish } of FINISH_PRESETS) {
    for (const [colour, pattern] of [[finish.head.colour, finish.head.pattern], [finish.body.colour, finish.body.pattern], [finish.limbs.colour, finish.limbs.pattern]]) {
      assert.ok(colourById(colour) !== undefined, `${key}: colour ${colour}`)
      assert.ok(patternById(pattern) !== undefined, `${key}: pattern ${pattern}`)
    }
  }
  assert.equal(FINISH_PRESETS[0].key, 'mint')
  assert.deepEqual(DEFAULT_FINISH, FINISH_PRESETS[0].finish)
})

test('a chosen finish reaches everyone\'s create and the owner\'s, and the client reads it back', () => {
  const multiplayer = setup()
  const chosen = FINISH_PRESETS.find((p) => p.key === 'arcade')!.finish
  const player = join(multiplayer, { finish: finishToBytes(chosen) })
  assert.deepEqual(player.finish, chosen)

  for (const [label, fields] of [['create', player.allFields], ['create_own', player.allFieldsOwn]] as const) {
    const record = player.serialiseBinary(fields)
    assert.ok(record !== null)
    const read = clientReads(record)
    assert.deepEqual(read, finishToBytes(chosen), label)
    assert.deepEqual(finishFromBytes(read), chosen, label)
    // Counted: [23][6][6 ids].
    const at = record.indexOf(Buffer.from([FINISH_INDEX, FINISH_BYTES, ...finishToBytes(chosen)]), 3)
    assert.ok(at >= 0, `${label}: no counted finish in the record`)
  }
})

test('the finish is never dirty: a tick\'s deltas don\'t carry it', () => {
  const multiplayer = setup()
  const player = join(multiplayer, { finish: [9, 3, 9, 3, 9, 3] })
  assert.ok(!player.dirtyFields.has('finish'))
})

test('a join without a finish (a client from before finishes) gets the default', () => {
  const multiplayer = setup()
  const player = join(multiplayer, {})
  assert.deepEqual(player.finish, DEFAULT_FINISH)
  const record = player.serialiseBinary(player.allFields)
  assert.ok(record !== null)
  assert.deepEqual(clientReads(record), finishToBytes(DEFAULT_FINISH))
})

test('parseStart passes the finish on raw, and leaves it out when none was sent', () => {
  assert.deepEqual(Multiplayer.parseStart({ id: 'abc123', name: 'N', finish: [1, 2, 3, 4, 5, 6] }), { id: 'abc123', name: 'N', finish: [1, 2, 3, 4, 5, 6] })
  assert.deepEqual(Multiplayer.parseStart({ id: 'abc123', name: 'N' }), { id: 'abc123', name: 'N' })
})

test('junk never refuses a join; the unreadable becomes the default', () => {
  const multiplayer = setup()
  const junk: unknown[] = [
    null, 7, 'mint', {}, [], [1, 1, 1], [1.5, 0, 1, 0, 1, 0], ['1', 0, 1, 0, 1, 0],
    [NaN, 0, 1, 0, 1, 0], [-1, 0, 1, 0, 1, 0], { length: 6 }, new Array(1e6).fill(1).map((_, i) => i)
  ]
  for (const finish of junk) {
    const player = join(multiplayer, { finish })
    const record = player.serialiseBinary(player.allFields)
    assert.ok(record !== null)
    const read = clientReads(record) as number[]
    assert.equal(read.length, FINISH_BYTES, JSON.stringify(finish)?.slice(0, 40))
    for (let i = 0; i < FINISH_BYTES; i += 2) {
      assert.ok(colourById(read[i]) !== undefined)
      assert.ok(patternById(read[i + 1]) !== undefined)
    }
  }
  // Whole-number junk isn't all-or-nothing: an unknown id falls back for its group only.
  const partial = join(multiplayer, { finish: [9, 3, 200, 3, 9, 77] })
  assert.deepEqual(partial.finish, {
    head: { colour: 9, pattern: 3 },
    body: { colour: DEFAULT_FINISH.body.colour, pattern: 3 },
    limbs: { colour: 9, pattern: DEFAULT_FINISH.limbs.pattern }
  })
})

test('a longer finish is read for its first six bytes (room for later additions)', () => {
  assert.deepEqual(finishFromBytes([9, 3, 9, 3, 9, 3, 1, 2, 3]), finishFromBytes([9, 3, 9, 3, 9, 3]))
  assert.deepEqual(finishFromBytes(new Uint8Array([9, 3, 9, 3, 9, 3])), finishFromBytes([9, 3, 9, 3, 9, 3]))
})

test('finish is the last field of a player\'s creates, so a client from before it loses only the finish', () => {
  // An old client stops reading a record at an index it doesn't know; fields
  // go out in the order the snapshot sets were filled.
  const multiplayer = setup()
  const player = join(multiplayer, { finish: [9, 3, 9, 3, 9, 3] })
  for (const fields of [player.allFields, player.allFieldsOwn]) {
    const record = player.serialiseBinary(fields)
    assert.ok(record !== null)
    const oldFields = GameObject.fieldOrder.slice(0, FINISH_INDEX)
    const old = decodeRecord(new Uint8Array(record), oldFields)
    const now = decodeRecord(new Uint8Array(record), GameObject.fieldOrder)
    delete now.finish
    assert.deepEqual(old, now)
  }
})
