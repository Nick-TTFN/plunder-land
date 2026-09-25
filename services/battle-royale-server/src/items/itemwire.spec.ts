import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { ThrottledLog } from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import type Player from '../objects/player'
import ItemPickup from '../objects/itempickup'
import { GameObject, ObjectType } from '../objects/gameobject'
import { ITEMS } from '../archetypes/archetypes'
import { BOMB_FUSE_EFFECT } from './bomb'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * usable-items on the wire: the `item` (17) and `inventory` (18) fields, the
 * unsigned `type` byte that ObjectType.Item (128) needs, the `use_item`
 * message and the bomb's cell-anchored effect.
 */

interface FakeSocket {
  socket: Socket
  fire: (event: string, data?: unknown) => void
  emitted: Array<{ event: string, data: unknown }>
}

function fakeSocket (id: string): FakeSocket {
  const handlers: Record<string, (data: unknown) => void> = {}
  const emitted: Array<{ event: string, data: unknown }> = []
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string, data: unknown) => { emitted.push({ event, data }); return true }
  } as unknown as Socket
  return { socket, emitted, fire: (event, data) => { handlers[event](data) } }
}

function okRedis (): Redis {
  const client = { on: () => client, hincrby: async () => 1 }
  return client as unknown as Redis
}

/** Split a packed batch (`Multiplayer.packRecords`) back into records. */
function records (buffer: Buffer, start = 0): Buffer[] {
  const out: Buffer[] = []
  let at = start
  while (at + 2 <= buffer.length) {
    const length = buffer.readUInt16BE(at)
    out.push(buffer.subarray(at + 2, at + 2 + length))
    at += 2 + length
  }
  return out
}

let logged: unknown[][] = []
const savedHandlerLog = Multiplayer.HANDLER_LOG

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
  logged = []
  Multiplayer.HANDLER_LOG = new ThrottledLog('socket handler threw', 0, () => Date.now(), (...args) => { logged.push(args) })
})

afterEach(() => {
  Multiplayer.HANDLER_LOG = savedHandlerLog
})

function setup (): Multiplayer {
  const multiplayer = new Multiplayer(250, okRedis())
  // eslint-disable-next-line no-new
  new World(4000)
  World.OBSTACLES.length = 0
  World.CONSUMABLES.length = 0
  World.MOBS.length = 0
  World.BLOCKED.clear()
  return multiplayer
}

const MID = Hex.toCell(new Vector(2000, 2000))

function join (multiplayer: Multiplayer, id: string, cell: Vector = MID): FakeSocket & { player: Player } {
  const fake = fakeSocket(id)
  multiplayer.onConnect(fake.socket)
  fake.fire('start_requested', id)
  const player = World.PLAYERS[World.PLAYERS.length - 1] as Player
  player.position = Hex.toPosition(cell)
  return { ...fake, player }
}

/** `[uint8 slot][int16 q][int16 r]`, big-endian: a skill press, and a `use_item`. */
function press (slot: number, cell: Vector): Buffer {
  const buf = Buffer.alloc(5)
  buf.writeUInt8(slot, 0)
  buf.writeInt16BE(cell.x, 1)
  buf.writeInt16BE(cell.y, 3)
  return buf
}

// --- fields -------------------------------------------------------------------------

test('item is field 17 and inventory 18, appended after archetype', () => {
  assert.equal(GameObject.fieldOrder.indexOf('archetype'), 16)
  assert.equal(GameObject.fieldOrder.indexOf('item'), 17)
  assert.equal(GameObject.fieldOrder.indexOf('inventory'), 18)
})

test('an item pickup\'s create carries type 128 unsigned and ends with [17, id]; a drop carries its lifetime', () => {
  setup()
  const pickup = new ItemPickup(1000, 1000, 0, ITEMS.bomb)
  const bytes = [...(pickup.serialiseBinary(pickup.allFields) as Buffer)]
  // [0][uint16 id][1][type]...
  assert.deepEqual(bytes.slice(3, 5), [1, ObjectType.Item])
  assert.equal(ObjectType.Item, 128)
  assert.deepEqual(bytes.slice(-2), [17, ITEMS.bomb.id])
  assert.equal(pickup.dirtyFields.size, 0, 'something on a pickup is dirty after its create')

  const drop = new ItemPickup(1000, 1000, 0, ITEMS.medkit, 30000)
  const fields = drop.serialise(drop.allFields) as Record<string, unknown>
  assert.equal(fields.lifetime, 30000)
  assert.equal(fields.item, ITEMS.medkit.id)
})

test('every older type still encodes as the same byte', () => {
  for (const type of [ObjectType.Obstacle, ObjectType.Consumable, ObjectType.Player, ObjectType.Portal, ObjectType.Throwable, ObjectType.Mob, ObjectType.Exit]) {
    const obj = new GameObject(type, 10, 10, 10, 0)
    assert.deepEqual([...(obj.serialiseBinary(new Set(['type'])) as Buffer)].slice(3), [1, type])
  }
})

test('a change to the inventory goes out as [18, 5, counts...], and only the owner\'s create has it', () => {
  const multiplayer = setup()
  const a = join(multiplayer, 'a')
  a.player.dirtyFields.clear()
  a.player.addItem(ITEMS.bomb)
  const delta = [...(a.player.serialiseBinary(a.player.dirtyFields) as Buffer)]
  assert.deepEqual(delta.slice(3), [18, 5, 0, 1, 0, 0, 0])
  assert.equal(a.player.allFields.has('inventory'), false)
  assert.equal(a.player.allFieldsOwn.has('inventory'), true)
})

// --- the join snapshot ------------------------------------------------------------

test('a joining player is sent every item on the ground', () => {
  const multiplayer = setup()
  const pickup = new ItemPickup(500, 500, -1, ITEMS.medkit)
  World.ITEMS.push(pickup)
  const a = join(multiplayer, 'a')
  const created = a.emitted.filter((e) => e.event === 'create').flatMap((e) => records(e.data as Buffer))
  const ids = created.map((r) => r.readUInt16BE(1))
  assert.ok(ids.includes(pickup.id), 'the item was not in the join snapshot')
})

// --- use_item -------------------------------------------------------------------------

test('use_item with a bare number uses that slot unaimed, and with 5 bytes aims at the cell', () => {
  const multiplayer = setup()
  const a = join(multiplayer, 'a')
  const calls: Array<[number, Vector | undefined]> = []
  a.player.tryUseItem = (slot, aim) => { calls.push([slot, aim]); return true }

  a.fire('use_item', 0)
  a.fire('use_item', press(1, new Vector(12, -3)))
  a.fire('use_item', Buffer.from([1, 0])) // short: ignored
  a.fire('use_item', 'medkit') // not a press: ignored
  assert.deepEqual(calls, [[0, undefined], [1, new Vector(12, -3)]])
})

test('use_item really spends a bomb and lights the fuse', () => {
  const multiplayer = setup()
  const a = join(multiplayer, 'a')
  a.player.addItem(ITEMS.bomb)
  a.fire('use_item', press(1, MID.add(new Vector(3, 0))))
  assert.equal(a.player.countOf(ITEMS.bomb), 0)
  assert.equal(Timers.size > 0, true, 'no fuse was scheduled')
})

test('a use_item that throws is contained, and the next input still applies', () => {
  const multiplayer = setup()
  const a = join(multiplayer, 'a')
  const b = join(multiplayer, 'b', MID.add(new Vector(5, 0)))
  a.player.tryUseItem = () => { throw new Error('broken item') }
  b.player.addItem(ITEMS.bomb)

  assert.doesNotThrow(() => { a.fire('use_item', 1) })
  assert.equal(logged.length, 1)
  b.fire('use_item', 1)
  assert.equal(b.player.countOf(ITEMS.bomb), 0)
})

test('use_item before a start, or from a dead player, does nothing', () => {
  const multiplayer = setup()
  const fake = fakeSocket('early')
  multiplayer.onConnect(fake.socket)
  assert.doesNotThrow(() => { fake.fire('use_item', 0) })
  assert.equal(logged.length, 0)

  const a = join(multiplayer, 'a')
  a.player.addItem(ITEMS.bomb)
  a.player.armor = 0
  a.player.hit(1000)
  a.fire('use_item', 1)
  assert.equal(a.player.countOf(ITEMS.bomb), 1)
})

// --- the bomb's effect -------------------------------------------------------------

test('effectAt goes to players on the bomb\'s layer near the bomb\'s cell, not near the thrower', () => {
  const multiplayer = setup()
  const cell = MID
  const near = join(multiplayer, 'near', cell.add(new Vector(4, 0)))
  const farOnLayer = join(multiplayer, 'far', cell.add(new Vector(20, 0)))
  const otherLayer = join(multiplayer, 'other', cell.add(new Vector(1, 0)))
  otherLayer.player.tag = -1

  multiplayer.effectAt(BOMB_FUSE_EFFECT, 4321, 1500, cell, 0)
  multiplayer.flushAll(1)

  const effects = (s: FakeSocket): Buffer[] =>
    s.emitted.filter((e) => e.event === 'effect').flatMap((e) => records(e.data as Buffer))
  const got = effects(near)
  assert.equal(got.length, 1)
  const r = got[0]
  assert.equal(r.length, 8)
  assert.deepEqual([r.readInt8(0), r.readUInt16BE(1), r.readInt8(3), r.readInt16BE(4), r.readInt16BE(6)],
    [BOMB_FUSE_EFFECT, 4321, 15, cell.x, cell.y])
  assert.equal(effects(farOnLayer).length, 0, '900 units away saw it')
  assert.equal(effects(otherLayer).length, 0, 'another layer saw it')
})
