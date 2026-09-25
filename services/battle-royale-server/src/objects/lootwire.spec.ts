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
import { ARCHETYPES, ITEMS } from '../archetypes/archetypes'

/**
 * `loot-wire-overflow`. Carried loot went on the wire as a uint16, so a player
 * holding more than 65,535 threw ERR_OUT_OF_RANGE from `serialiseBinary`. The
 * throw left `loot` dirty, so it came back every tick, and it came from inside
 * `world.update`, so the tick's catch skipped `flushAll`: nobody in the world
 * was sent anything again. Loot now goes out as field `loot32`, a uint32; the
 * old `loot` index stays in the table, decodable and never sent.
 */

// The index `loot32` is appended at, after `extractProgress` (19).
const LOOT32_INDEX = 20

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

interface Recorded { event: string, data: unknown }

function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void, sent: Recorded[] } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const sent: Recorded[] = []
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string, data: unknown) => { sent.push({ event, data }); return true }
  } as unknown as Socket
  return { socket, sent, fire: (event, data) => { handlers[event](data) } }
}

function unpack (buf: Buffer, from = 0): Buffer[] {
  const out: Buffer[] = []
  let at = from
  while (at < buf.length) {
    const length = buf.readUInt16BE(at)
    out.push(buf.subarray(at + 2, at + 2 + length))
    at += 2 + length
  }
  return out
}

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  World.FINISHED.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
})

function setup (): { multiplayer: Multiplayer, world: World } {
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  return { multiplayer, world }
}

function join (multiplayer: Multiplayer, socketId: string): { player: Player, sent: Recorded[] } {
  const s = fakeSocket(socketId)
  multiplayer.onConnect(s.socket)
  s.fire('start_requested', { id: Buffer.from(socketId).toString('hex').padStart(6, '0'), name: socketId })
  const player = World.PLAYERS[World.PLAYERS.length - 1]
  s.sent.length = 0
  return { player, sent: s.sent }
}

/** A loot delta: `[0][uint16 id][loot32 index][uint32 loot]`. */
function lootDelta (player: Player): Buffer {
  const bytes = player.serialiseBinary(new Set(['loot']))
  assert.ok(bytes !== null)
  return bytes
}

// --- the table -----------------------------------------------------------------

test('loot32 is appended at its assigned index, and loot keeps index 5', () => {
  assert.equal(GameObject.fieldOrder.indexOf('loot32'), LOOT32_INDEX)
  assert.equal(GameObject.fieldOrder.indexOf('loot'), 5, 'loot moved: the table is append-only')
})

// --- the value -----------------------------------------------------------------

test('a player carrying 70,000 loot serialises, and the client reads 70,000 back', () => {
  const { player } = join(setup().multiplayer, 'rich01')
  player.loot = 70_000

  const own = player.serialiseBinary(player.allFieldsOwn) // create_own, or a full resend
  assert.ok(own !== null)

  const delta = lootDelta(player)
  assert.deepEqual([...delta.subarray(0, 4)], [0, player.id >> 8, player.id & 0xFF, LOOT32_INDEX])
  assert.equal(delta.length, 8)
  assert.equal(delta.readUInt32BE(4), 70_000)
})

test('the old loot index is never written', () => {
  const { player } = join(setup().multiplayer, 'rich02')
  player.loot = 12
  const delta = lootDelta(player)
  assert.equal(delta[3], LOOT32_INDEX)
  assert.equal(delta.readUInt32BE(4), 12)
})

test('loot saturates at the uint32 range rather than throwing, and is sent whole', () => {
  const { player } = join(setup().multiplayer, 'rich03')
  player.loot = 2 ** 40
  assert.equal(lootDelta(player).readUInt32BE(4), 0xFFFFFFFF)
  player.loot = -5
  assert.equal(lootDelta(player).readUInt32BE(4), 0)
  player.loot = 70_000.9
  assert.equal(lootDelta(player).readUInt32BE(4), 70_000)
})

// --- the world -----------------------------------------------------------------

test('a tick with a 70,000-loot player in it completes and flushes to everyone', () => {
  const { multiplayer, world } = setup()
  const rich = join(multiplayer, 'rich04')
  const other = join(multiplayer, 'other1')

  rich.player.loot = 70_000
  world.update(0.25) // threw ERR_OUT_OF_RANGE here, which skipped the flush below
  multiplayer.flushAll(1, 250)

  const updates = rich.sent.filter((s) => s.event === 'update')
  assert.equal(updates.length, 1)
  const records = unpack(updates[0].data as Buffer, 8)
  const mine = records.find((r) => r.readUInt16BE(1) === rich.player.id && r.includes(LOOT32_INDEX))
  assert.ok(mine !== undefined, 'the rich player was not sent their loot')
  const at = mine.indexOf(LOOT32_INDEX, 3)
  assert.equal(mine.readUInt32BE(at + 1), 70_000)

  assert.equal(other.sent.filter((s) => s.event === 'update').length, 1, 'the other player was sent nothing')
})

// --- the other narrow fields, pinned to the data that feeds them ----------------

test('every archetype fits the narrow wire fields it feeds', () => {
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    // hp and maxHp: uint16. hp is capped at maxHp (heal) and floored at 0 (hit).
    assert.ok(a.maxHp >= 0 && a.maxHp <= 0xFFFF, `${key}.maxHp`)
    // armor, maxArmor: uint16. armor is capped at max (refillArmor).
    assert.ok(a.armor.max >= 0 && a.armor.max <= 0xFFFF, `${key}.armor.max`)
    // radius: written as a signed byte, read unsigned; 127 is the safe top.
    assert.ok(a.body >= 0 && a.body <= 127, `${key}.body`)
    // maxVelocity: a signed byte of speed / 10.
    assert.ok(a.speed >= 0 && Math.floor(a.speed / 10) <= 127, `${key}.speed`)
  }
})

test('every item stack fits its uint8 inventory count', () => {
  for (const [key, item] of Object.entries(ITEMS)) {
    assert.ok(item.maxStack >= 0 && item.maxStack <= 0xFF, `${key}.maxStack`)
  }
})
