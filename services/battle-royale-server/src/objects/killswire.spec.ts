import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Player from './player'
import Mob from './mob'
import { GameObject } from './gameobject'
import { ARCHETYPES } from '../archetypes/archetypes'

/**
 * `run-summary-card` (M2, decision #36): a player's kills this run go on the
 * wire as field `kills`, a uint16 appended at 21, so the end-of-run card can
 * show them. In the owner's create (starting at 0) and a delta on each kill.
 */

const KILLS_INDEX = 21

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

/** True if `record` holds the bytes `[21][uint16 kills]` anywhere after its id. */
function carriesKills (record: Buffer, kills: number): boolean {
  const needle = Buffer.from([KILLS_INDEX, kills >> 8, kills & 0xFF])
  return record.indexOf(needle, 3) >= 0
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
  return { player, sent: s.sent }
}

test('kills is appended at 21, after loot32', () => {
  assert.equal(GameObject.fieldOrder.indexOf('kills'), KILLS_INDEX)
  assert.equal(GameObject.fieldOrder.indexOf('loot32'), KILLS_INDEX - 1)
})

test('the owner\'s create carries kills = 0; everyone else\'s does not carry it', () => {
  const { player } = join(setup().multiplayer, 'kill01')
  const own = player.serialiseBinary(player.allFieldsOwn)
  assert.ok(own !== null)
  assert.ok(carriesKills(own, 0), 'create_own has no kills')
  const theirs = player.serialiseBinary(player.allFields)
  assert.ok(theirs !== null)
  assert.equal(theirs.indexOf(Buffer.from([KILLS_INDEX, 0, 0]), 3), -1, 'kills leaked into the create everyone gets')
})

test('a credited kill counts, marks kills dirty, and reaches the owner in the next flush', () => {
  const { multiplayer, world } = setup()
  const { player, sent } = join(multiplayer, 'kill02')
  world.update(0.25)
  multiplayer.flushAll(1, 250)
  sent.length = 0

  const mob = new Mob(player.position.x + 45, player.position.y, player.tag, ARCHETYPES.grunt)
  World.MOBS.push(mob)
  assert.ok(mob.hit(9999))
  player.onKill(mob)
  assert.equal(player.kills, 1)
  assert.ok(player.dirtyFields.has('kills'))

  world.update(0.25)
  multiplayer.flushAll(2, 250)
  const updates = sent.filter((s) => s.event === 'update')
  assert.equal(updates.length, 1)
  const mine = unpack(updates[0].data as Buffer, 8).find((r) => r.readUInt16BE(1) === player.id && carriesKills(r, 1))
  assert.ok(mine !== undefined, 'the owner was not sent their kill')
})

test('kills saturates at the uint16 range rather than throwing', () => {
  const { player } = join(setup().multiplayer, 'kill03')
  player.kills = 70_000
  const delta = player.serialiseBinary(new Set(['kills']))
  assert.ok(delta !== null)
  assert.deepEqual([...delta.subarray(3)], [KILLS_INDEX, 0xFF, 0xFF])
})
