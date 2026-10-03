import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Player from './player'
import Consumable from './consumable'
import ItemPickup from './itempickup'
import { GameObject } from './gameobject'
import { ITEMS } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { decodeRecord } from '../../../../plunder-land-client/src/net/records'

/**
 * pickup-reach (#42): a robot takes loot and items within one ring, and a
 * pickup taken that way is destroyed with field `collector` (24), the taker's
 * id, so every client holding it can fly it to them. Decoded here with the
 * client's own `decodeRecord` over `fieldOrder`.
 */

const COLLECTOR_INDEX = 24

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

function unpack (buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let at = 0
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
  // The world tops its layers up with loot and mobs every tick, at random
  // cells; a crystal landing within a ring would be taken too. This spec
  // places its own pickups.
  ;(world as unknown as { refillLayer: () => void }).refillLayer = () => {}
  return { multiplayer, world }
}

function join (multiplayer: Multiplayer, id: string): { player: Player, sent: Recorded[] } {
  const s = fakeSocket(id)
  multiplayer.onConnect(s.socket)
  s.fire('start_requested', { id, name: 'PICK' })
  return { player: World.PLAYERS[World.PLAYERS.length - 1], sent: s.sent }
}

/** Every destroy record this connection was sent, decoded as the client does. */
function destroys (sent: Recorded[]): any[] {
  return sent.filter((s) => s.event === 'destroy')
    .flatMap((s) => unpack(s.data as Buffer))
    .map((r) => decodeRecord(new Uint8Array(r), GameObject.fieldOrder))
}

/**
 * The client must hold the pickup before it is taken, as it does in play:
 * put it two rings inward, tick and flush (sent, out of reach), then step the
 * player one cell inward, which brings it within a ring.
 */
function stepToward (player: Player): void {
  player.position = inward(player, 1)
}

/**
 * A cell centre `rings` from the player's cell along the row, east or west,
 * whichever is towards the middle of the map.
 *
 * It was always east. A join on the last column (centre x 3982.5 on the
 * 4000 map) then stepped to x 4027.5, off the map; `Unit.update` clamped
 * that to 4000, back inside the join cell, and the pickup stayed two rings
 * away. In 4000 instrumented runs all 24 joins there failed, and they were
 * the only failures (0.6%); the 20 joins at x 3960, whose clamped step stays
 * in the next cell, passed.
 */
function inward (player: Player, rings: number): Vector {
  const cell = Hex.toCell(player.position)
  const way = player.position.x < World.mapSize / 2 ? 1 : -1
  return Hex.toPosition(new Vector(cell.x + way * rings, cell.y))
}

test('collector is appended at 24, after finish', () => {
  assert.equal(GameObject.fieldOrder.indexOf('collector'), COLLECTOR_INDEX)
  assert.equal(GameObject.fieldOrder.indexOf('finish'), COLLECTOR_INDEX - 1)
})

test('loot one ring away is taken, and its destroy names the collector to everyone holding it', () => {
  const { multiplayer, world } = setup()
  const { player, sent } = join(multiplayer, 'a1b2c3')
  const at = inward(player, 2)
  const crystal = new Consumable(at.x, at.y, player.tag, 20 as never, 30)
  World.PICKUPS.push(World.CONSUMABLES, crystal)
  world.update(0.25)
  multiplayer.flushAll(1, 250)
  assert.ok(!crystal.destroyed)
  sent.length = 0

  stepToward(player)
  world.update(0.25)
  multiplayer.flushAll(2, 250)
  assert.ok(crystal.destroyed, 'a crystal one ring away was not taken')
  assert.equal(player.loot, 30)
  const record = destroys(sent).find((d) => d.id === crystal.id)
  assert.ok(record !== undefined, 'no destroy for the crystal')
  assert.equal(record.collector, player.id)
})

test('an item one ring away is taken the same way', () => {
  const { multiplayer, world } = setup()
  const { player, sent } = join(multiplayer, 'a1b2c4')
  const at = inward(player, 2)
  const medkit = new ItemPickup(at.x, at.y, player.tag, ITEMS.medkit)
  World.PICKUPS.push(World.ITEMS, medkit)
  world.update(0.25)
  multiplayer.flushAll(1, 250)
  assert.ok(!medkit.destroyed)
  sent.length = 0

  stepToward(player)
  world.update(0.25)
  multiplayer.flushAll(2, 250)
  assert.ok(medkit.destroyed, 'an item one ring away was not taken')
  assert.equal(destroys(sent).find((d) => d.id === medkit.id)?.collector, player.id)
})

test('loot two rings away stays; a pickup that goes any other way names no collector', () => {
  const { multiplayer, world } = setup()
  const { player, sent } = join(multiplayer, 'a1b2c5')
  const at = inward(player, 2)
  const crystal = new Consumable(at.x, at.y, player.tag, 20 as never, 30)
  World.PICKUPS.push(World.CONSUMABLES, crystal)
  world.update(0.25)
  multiplayer.flushAll(1, 250)
  assert.ok(!crystal.destroyed, 'taken from two rings away')
  sent.length = 0

  crystal.destroy()
  World.PICKUPS.remove(World.CONSUMABLES, crystal)
  multiplayer.flushAll(2, 250)
  const record = destroys(sent).find((d) => d.id === crystal.id)
  assert.ok(record !== undefined)
  assert.equal(record.collector, undefined)
})
