import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import type Player from '../objects/player'
import GearPickup from '../objects/gearpickup'
import { GameObject, ObjectType } from '../objects/gameobject'
import { SKILL_INFO } from '../utils/skills'
import { GEAR_STATS, type GearInstance } from '../utils/gear'
import { PROTOCOL } from '../utils/protocol'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { decodeRecord, decodeCarried } from '../../../../plunder-land-client/src/net/records'

/**
 * Task 49-2 on the wire: field 25 `gear` on a gear pickup's create, 26
 * `carried` in the owner's create and as a delta, 27 `speed` (maxVelocity in
 * tenths, through `WIRE_NAME`), decoded with the client's own `decodeRecord`.
 */

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

interface Sent { event: string, data: unknown }

function join (multiplayer: Multiplayer, id: string): { player: Player, sent: Sent[] } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const sent: Sent[] = []
  const socket = {
    id,
    handshake: { query: {} },
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string, data: unknown) => { sent.push({ event, data }); return true }
  } as unknown as Socket
  multiplayer.onConnect(socket)
  handlers.start_requested({ id, name: 'WIRE' })
  return { player: World.PLAYERS[World.PLAYERS.length - 1], sent }
}

function records (buffer: Buffer): Buffer[] {
  const out: Buffer[] = []
  let at = 0
  while (at + 2 <= buffer.length) {
    const length = buffer.readUInt16BE(at)
    out.push(buffer.subarray(at + 2, at + 2 + length))
    at += 2 + length
  }
  return out
}

let multiplayer: Multiplayer

beforeEach(() => {
  multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  ;(world as unknown as { refillLayer: () => void }).refillLayer = () => {}
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.GEAR.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  Timers.clear()
})

const T3: GearInstance = Object.freeze({
  tier: 3,
  skill: SKILL_INFO.icicle.id,
  rolls: Object.freeze([{ stat: GEAR_STATS.reach.id, q: 1000 }, { stat: GEAR_STATS.cooldown.id, q: 321 }]),
  rowId: 'stash-row-7'
})

test('gear is field 25, carried 26 and speed 27, appended; maxVelocity goes out as speed; PROTOCOL is 6', () => {
  assert.equal(GameObject.fieldOrder.indexOf('gear'), 25)
  assert.equal(GameObject.fieldOrder.indexOf('carried'), 26)
  assert.equal(GameObject.fieldOrder.indexOf('speed'), 27)
  assert.equal(GameObject.fieldOrder.length, 28)
  // Index 10 stays in the table, never written.
  assert.equal(GameObject.fieldOrder[10], 'maxVelocity')
  assert.equal(GameObject.WIRE_NAME.maxVelocity, 'speed')
  assert.equal(PROTOCOL, 6)
})

test('a gear pickup\'s create carries type 128 and the instance under 25, no item field, and decodes to the instance without its rowId', () => {
  const at = Hex.toPosition(new Vector(20, 20))
  const pickup = new GearPickup(at.x, at.y, 0, T3)
  const record = pickup.serialiseBinary(pickup.allFields) as Buffer
  const data = decodeRecord(new Uint8Array(record), GameObject.fieldOrder)
  assert.equal(data.type, ObjectType.Item)
  assert.ok(!('item' in data), 'a gear pickup sent an item field')
  assert.deepEqual(data.gear, { tier: 3, skill: T3.skill, rolls: [...T3.rolls] })
  assert.equal(data.gear.rowId, undefined, 'rowId went on the wire')
  // [25][n][tier][skill][count]{[stat][q]} at the end of the record.
  const tail = Array.from(record.subarray(record.length - 11))
  assert.deepEqual(tail, [25, 9, 3, T3.skill, 2, GEAR_STATS.reach.id, 3, 232, GEAR_STATS.cooldown.id, 1, 65])
  // A drop carries its lifetime too, for the countdown ring.
  const drop = new GearPickup(at.x, at.y, 0, T3, World.DROPPED_LOOT_LIFETIME)
  assert.equal(decodeRecord(new Uint8Array(drop.serialiseBinary(drop.allFields) as Buffer), GameObject.fieldOrder).lifetime, World.DROPPED_LOOT_LIFETIME)
})

test('speed goes out as tenths in a uint16 and comes back exact: 147.0 and 73.5', () => {
  const { player } = join(multiplayer, 'abcdef01')
  for (const speed of [147, 73.5, 148.4, 140]) {
    player.maxVelocity = speed
    const record = player.serialiseBinary(new Set(['id', 'maxVelocity'])) as Buffer
    const tenths = Math.round(speed * 10)
    assert.deepEqual(Array.from(record.subarray(3)), [27, tenths >> 8, tenths & 0xff], `${speed} not as [27][uint16 tenths]`)
    assert.equal(decodeRecord(new Uint8Array(record), GameObject.fieldOrder).maxVelocity, speed)
  }
})

test('the owner\'s create carries carried and speed; another client\'s create of it carries neither', () => {
  const { player, sent } = join(multiplayer, 'abcdef02')
  const own = sent.filter((s) => s.event === 'create_own').flatMap((s) => records(s.data as Buffer))
  assert.equal(own.length, 1)
  const data = decodeRecord(new Uint8Array(own[0]), GameObject.fieldOrder)
  assert.deepEqual(data.carried, [null, null, null, null, null, null])
  assert.equal(data.maxVelocity, player.maxVelocity)

  const other = decodeRecord(new Uint8Array(player.serialiseBinary(player.allFields) as Buffer), GameObject.fieldOrder)
  assert.ok(!('carried' in other) && !('maxVelocity' in other), 'carried or speed in everyone\'s create')
})

test('a pickup goes out as a carried delta, and a geared speed as a speed delta, both decoding exactly', () => {
  const { player } = join(multiplayer, 'abcdef03')
  const fire: GearInstance = { tier: 2, skill: SKILL_INFO.fireball.id, rolls: [{ stat: GEAR_STATS.speed.id, q: 1000 }, { stat: GEAR_STATS.hp.id, q: 0 }] }
  const part: GearInstance = { tier: 1, skill: 0, rolls: [] }
  player.dirtyFields.clear()
  assert.ok(player.addGear(fire))
  assert.ok(player.addGear(part))
  assert.ok(player.dirtyFields.has('carried') && player.dirtyFields.has('maxVelocity'))
  const data = decodeRecord(new Uint8Array(player.serialiseBinary(player.dirtyFields) as Buffer), GameObject.fieldOrder)
  assert.deepEqual(data.carried, [fire, null, part, null, null, null])
  // Peep 140 + 5% at T2's max = 147.
  assert.equal(data.maxVelocity, 147)
  assert.equal(player.maxVelocity, 147)
})

test('decodeCarried pads a short list, ignores extra entries and skips one it cannot read', () => {
  assert.deepEqual(decodeCarried(new Uint8Array([0])), [null, null, null, null, null, null])
  // An entry with an unknown skill id (99) reads as null; the rest still read.
  const bytes = new Uint8Array([7, 3, 1, 99, 0, 0, 3, 1, 0, 0, 0, 0, 0, 3, 2, 0, 0])
  assert.deepEqual(decodeCarried(bytes), [null, null, { tier: 1, skill: 0, rolls: [] }, null, null, null])
})

test('a whole create of a carrying player stays parseable to its end with the client\'s table', () => {
  const { player } = join(multiplayer, 'abcdef04')
  player.addGear(T3)
  player.addGear({ tier: 1, skill: SKILL_INFO.dash.id, rolls: [{ stat: GEAR_STATS.armor.id, q: 999 }] })
  for (let i = 0; i < 4; i++) player.addGear({ tier: 2, skill: 0, rolls: [] })
  const record = player.serialiseBinary(player.allFieldsOwn) as Buffer
  const data = decodeRecord(new Uint8Array(record), GameObject.fieldOrder)
  assert.equal(data.carried.filter((c: GearInstance | null) => c !== null).length, 6)
  // Fields after carried still decoded: kills and finish are in the own create.
  assert.equal(typeof data.kills, 'number')
  assert.ok(Array.isArray(data.finish))
})
