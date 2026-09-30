import test from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Player from './player'
import { GameObject } from './gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'

/**
 * server-cpu-trim: `serialiseBinary` writes into one scratch buffer instead of
 * a Buffer per field. The bytes are a wire contract, so this holds the old
 * encoder, verbatim apart from being a function, and requires the new one to
 * match it on every object a real world makes, for every field set it uses and
 * for random subsets, and to throw the same error where the old one threw.
 */
function legacy (obj: GameObject, fields: Set<string>): Buffer | null {
  const getBuffer = (value: number): Buffer => { const res = Buffer.alloc(1); res.writeInt8(value); return res }
  const getBuffer2 = (value: number): Buffer => { const res = Buffer.alloc(2); res.writeUInt16BE(value); return res }
  const getBufferVec = (value: Vector): Buffer => {
    const res = Buffer.alloc(2); res.writeInt8(Math.floor(value.x)); res.writeInt8(Math.floor(value.y), 1); return res
  }
  const getBufferVec2 = (value: Vector): Buffer => {
    const res = Buffer.alloc(4); res.writeInt16BE(Math.floor(value.x)); res.writeInt16BE(Math.floor(value.y), 2); return res
  }
  const dataObj = obj.serialise(fields)
  if (dataObj == null) return null
  const raw: Buffer[] = []
  for (const key in dataObj) {
    const value = dataObj[key]
    if (value === undefined) continue
    raw.push(getBuffer(GameObject.fieldOrder.indexOf(GameObject.WIRE_NAME[key] ?? key)))
    switch (key) {
      case 'id': raw.push(getBuffer2(value)); break
      case 'type': { const byte = Buffer.alloc(1); byte.writeUInt8(value); raw.push(byte); break }
      case 'position': raw.push(getBufferVec2(value)); break
      case 'direction': raw.push(getBufferVec(value.multiply(127))); break
      case 'hp': raw.push(getBuffer2(value)); break
      case 'level': raw.push(getBuffer(value)); break
      case 'loot': {
        const wide = Buffer.alloc(4)
        wide.writeUInt32BE(Math.max(0, Math.min(0xFFFFFFFF, Math.floor(value))))
        raw.push(wide)
        break
      }
      case 'tag': raw.push(getBuffer(value)); break
      case 'to': raw.push(getBuffer(value)); break
      case 'radius': raw.push(getBuffer(value)); break
      case 'lifetime': raw.push(getBuffer2(Math.min(65535, Math.floor(value / 100)))); break
      case 'maxVelocity': raw.push(getBuffer(Math.floor(value / 10))); break
      case 'maxHp': raw.push(getBuffer2(value)); break
      case 'armor': raw.push(getBuffer2(value)); break
      case 'maxArmor': raw.push(getBuffer2(value)); break
      // run-summary-card: appended after this encoder was retired, in the same style.
      case 'kills': raw.push(getBuffer2(Math.max(0, Math.min(0xFFFF, Math.floor(value))))); break
      case 'archetype': { const byte = Buffer.alloc(1); byte.writeUInt8(value); raw.push(byte); break }
      case 'item': { const byte = Buffer.alloc(1); byte.writeUInt8(value); raw.push(byte); break }
      case 'inventory': {
        const counts = value as readonly number[]
        const bytes = Buffer.alloc(1 + counts.length)
        bytes.writeUInt8(counts.length)
        counts.forEach((count, i) => { bytes.writeUInt8(count, 1 + i) })
        raw.push(bytes)
        break
      }
      case 'extractProgress': { const byte = Buffer.alloc(1); byte.writeUInt8(value); raw.push(byte); break }
      // robot-finishes: appended after this encoder was retired, counted like inventory.
      case 'finish': {
        const ids = value as readonly number[]
        const bytes = Buffer.alloc(1 + ids.length)
        bytes.writeUInt8(ids.length)
        ids.forEach((id, i) => { bytes.writeUInt8(id, 1 + i) })
        raw.push(bytes)
        break
      }
      case 'facing': raw.push(getBuffer(value)); break
      case 'name': raw.push(Buffer.from(value), Buffer.alloc(1)); break
    }
  }
  return Buffer.concat(raw)
}

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    handshake: { query: {} },
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  return { socket, fire: (event, data) => { handlers[event](data) } }
}

/** Same result, or the same error. */
function same (obj: GameObject, fields: Set<string>, label: string): void {
  let want: Buffer | null | Error
  let got: Buffer | null | Error
  try { want = legacy(obj, fields) } catch (e) { want = e as Error }
  try { got = obj.serialiseBinary(fields) } catch (e) { got = e as Error }
  if (want instanceof Error) {
    assert.ok(got instanceof Error, `${label}: the old encoder threw ${want.message}, the new one did not`)
    assert.equal(got.constructor, want.constructor, label)
    assert.equal(got.message, want.message, label)
    return
  }
  assert.deepEqual(got, want, label)
}

// Every property the encoder has a case for, plus one it has none for.
const ALL_KEYS = [
  'id', 'type', 'position', 'direction', 'hp', 'level', 'loot', 'tag', 'to', 'radius', 'lifetime',
  'maxVelocity', 'maxHp', 'armor', 'maxArmor', 'archetype', 'item', 'inventory', 'extractProgress',
  'facing', 'name', 'finish', 'notAField'
]

// A small seeded generator, so a failure reproduces.
function rng (seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

function world (): { players: Player[] } {
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.PROJECTILES.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
  const multiplayer = new Multiplayer(250, okRedis())
  const w = new World(4000)
  const players: Player[] = []
  const names = ['plain', 'Ünïcødé', '名前テスト', '🤖bot', '']
  for (let i = 0; i < names.length; i++) {
    const s = fakeSocket(`sock${i}`)
    multiplayer.onConnect(s.socket)
    s.fire('start_requested', { id: `abcdef${i}`, name: names[i] })
    players.push(World.PLAYERS[World.PLAYERS.length - 1])
  }
  // Fill the world (mobs, loot, items arrive a few a tick), move, and cast
  // every skill, so projectiles, stones and wounded, armored units exist.
  for (let tick = 0; tick < 60; tick++) {
    for (const [i, player] of players.entries()) {
      if (player.destroyed || player.exited) continue
      if (tick % 10 === 0) player.setWaypoints([Hex.neighbour(player.cell, (i + tick) % 6)])
      player.tryExecuteSkill(tick % 8)
    }
    w.update(0.25)
  }
  return { players }
}

test('serialiseBinary matches the old encoder on everything a real world makes', () => {
  world()
  const objects: GameObject[] = [
    ...World.PLAYERS, ...World.MOBS, ...World.OBSTACLES, ...World.CONSUMABLES, ...World.ITEMS, ...World.PROJECTILES
  ]
  const kinds = new Set(objects.map((o) => o.type))
  // Players, mobs, rocks, portals, exits, loot and items at the least.
  assert.ok(kinds.size >= 7, `only object types ${[...kinds].join(', ')}`)

  const rand = rng(1234)
  let checked = 0
  for (const obj of objects) {
    same(obj, obj.allFields, `allFields of ${obj.type}#${obj.id}`)
    same(obj, obj.allFieldsOwn, `allFieldsOwn of ${obj.type}#${obj.id}`)
    same(obj, obj.dirtyFields, `dirtyFields of ${obj.type}#${obj.id}`)
    same(obj, new Set(['id']), `id only of ${obj.type}#${obj.id}`)
    same(obj, new Set(), `nothing of ${obj.type}#${obj.id}`)
    for (let k = 0; k < 20; k++) {
      const fields = new Set(ALL_KEYS.filter(() => rand() < 0.4))
      same(obj, fields, `[${[...fields].join(',')}] of ${obj.type}#${obj.id}`)
      checked++
    }
  }
  assert.ok(checked > 1000)
})

test('every cached terrain record is what encoding the object now gives', () => {
  world()
  let checked = 0
  for (const obj of World.OBSTACLES) {
    if (obj.destroyed) continue
    assert.deepEqual(Multiplayer.terrainRecord(obj), obj.serialiseBinary(obj.allFields), `terrain ${obj.type}#${obj.id}`)
    checked++
  }
  // Portals and exits on three layers, and the stones cast in world(). (No
  // world rocks since the valleys, tile art pass: they were 408 of these.)
  assert.ok(checked > 40, `only ${checked} terrain objects`)
})

test('a value that does not fit its field throws the same error as before', () => {
  const { players } = world()
  const player = players[0]
  const cases: Array<[string, unknown]> = [
    ['radius', 300], ['level', -200], ['hp', 70_000], ['hp', -1], ['maxHp', 1.5e6],
    ['armor', 65_536], ['tag', 128], ['facing', 999], ['maxVelocity', 5000], ['position', new Vector(40_000, 0)]
  ]
  for (const [key, value] of cases) {
    const saved = (player as unknown as Record<string, unknown>)[key]
    ;(player as unknown as Record<string, unknown>)[key] = value
    same(player, new Set(['id', 'type', key]), `${key} = ${String(value)}`)
    ;(player as unknown as Record<string, unknown>)[key] = saved
  }
  // Loot saturates rather than throwing.
  player.loot = 2 ** 40
  same(player, new Set(['loot']), 'loot 2^40')
  player.loot = -5
  same(player, new Set(['loot']), 'loot -5')
})

test('a record bigger than the scratch buffer grows it and still matches', () => {
  const { players } = world()
  const player = players[0]
  // Not a name the sanitiser would let through; the encoder doesn't care.
  player.name = 'x'.repeat(5000) + 'é'.repeat(1000)
  same(player, player.allFields, 'huge name')
  player.name = 'short'
  same(player, player.allFields, 'short name after growing')
})
