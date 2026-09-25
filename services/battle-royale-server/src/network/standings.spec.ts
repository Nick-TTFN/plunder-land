import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer from './multiplayer'
import World, { Standing } from '../objects/world'
import Timers from '../objects/timers'
import { GameObject } from '../objects/gameobject'
import type Player from '../objects/player'

/**
 * `live-world-leaderboard`: the `standings` event, about once a second, listing
 * the world's players and the recently finished by loot.
 */

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

interface Row { id: number, status: number, loot: number, name: string }

/** The client's reading of a standings buffer (leaderboard.ts `decodeStandings`). */
function decode (buf: Buffer): Row[] {
  return unpack(buf).map((r) => {
    const end = r.indexOf(0, 7)
    return { id: r.readUInt16BE(0), status: r.readUInt8(2), loot: r.readUInt32BE(3), name: r.subarray(7, end).toString('utf8') }
  })
}

function standingsSent (sent: Recorded[]): Buffer[] {
  return sent.filter((s) => s.event === 'standings').map((s) => s.data as Buffer)
}

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  World.FINISHED.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
})

/** A world with nothing in it: no exits or portals to extract or move a player. */
function setup (tickMs = 250): { multiplayer: Multiplayer, world: World } {
  const multiplayer = new Multiplayer(tickMs, okRedis())
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  return { multiplayer, world }
}

function join (multiplayer: Multiplayer, socketId: string, name: string): { player: Player, sent: Recorded[] } {
  const s = fakeSocket(socketId)
  multiplayer.onConnect(s.socket)
  s.fire('start_requested', { id: `pid-${socketId}`, name })
  const player = World.PLAYERS[World.PLAYERS.length - 1]
  s.sent.length = 0 // drop the join's own traffic
  return { player, sent: s.sent }
}

test('standings go out once every 4 ticks at 250 ms: once a second', () => {
  const { multiplayer } = setup(250)
  const a = join(multiplayer, 's1', 'ANNA')

  const due: number[] = []
  for (let tick = 1; tick <= 12; tick++) {
    const before = standingsSent(a.sent).length
    multiplayer.flushAll(tick, 250)
    if (standingsSent(a.sent).length > before) due.push(tick)
  }
  assert.deepEqual(due, [4, 8, 12])
  // Never more than one per flush, and update still goes every tick.
  assert.equal(a.sent.filter((s) => s.event === 'update').length, 12)
})

test('the cadence follows the tick length, and never exceeds one per tick', () => {
  const slow = setup(1000).multiplayer
  const a = join(slow, 's1', 'ANNA')
  for (let tick = 1; tick <= 3; tick++) slow.flushAll(tick, 1000)
  assert.equal(standingsSent(a.sent).length, 3)

  const fast = setup(100).multiplayer
  const b = join(fast, 's2', 'BO')
  for (let tick = 1; tick <= 30; tick++) fast.flushAll(tick, 100)
  assert.equal(standingsSent(b.sent).length, 3)
})

test('a socket that never started a run is sent no standings', () => {
  const { multiplayer } = setup()
  join(multiplayer, 's1', 'ANNA')
  const idle = fakeSocket('idle')
  multiplayer.onConnect(idle.socket)
  for (let tick = 1; tick <= 8; tick++) multiplayer.flushAll(tick, 250)
  assert.equal(standingsSent(idle.sent).length, 0)
})

test('rows are ranked by loot, most first, ties by id', () => {
  const { multiplayer } = setup()
  const a = join(multiplayer, 's1', 'LOW')
  const b = join(multiplayer, 's2', 'HIGH')
  const c = join(multiplayer, 's3', 'MID')
  const d = join(multiplayer, 's4', 'TIE')
  a.player.loot = 5
  b.player.loot = 500
  c.player.loot = 50
  d.player.loot = 50

  const rows = decode(Multiplayer.buildStandings())
  const tieFirst = c.player.id < d.player.id ? 'MID' : 'TIE'
  const tieSecond = tieFirst === 'MID' ? 'TIE' : 'MID'
  assert.deepEqual(rows.map((r) => r.name), ['HIGH', tieFirst, tieSecond, 'LOW'])
  assert.deepEqual(rows.map((r) => r.loot), [500, 50, 50, 5])
  assert.ok(rows.every((r) => r.status === Standing.ACTIVE))
})

test('byte layout: [uint16 id][uint8 status][uint32 loot][UTF-8 name][0], length-prefixed', () => {
  setup()
  World.FINISHED.push({ id: 0x1234, name: 'Zoë', loot: 0x01020304, status: Standing.EXTRACTED, at: Date.now() })

  const buf = Multiplayer.buildStandings()
  const name = Buffer.from('Zoë', 'utf8') // 4 bytes: ë is two
  assert.equal(name.length, 4)
  assert.deepEqual(
    [...buf],
    [0x00, 12, 0x12, 0x34, 0x01, 0x01, 0x02, 0x03, 0x04, ...name, 0x00]
  )
})

test('loot above uint32 is clamped rather than thrown on', () => {
  setup()
  World.FINISHED.push({ id: 1, name: 'X', loot: 2 ** 40, status: Standing.DEAD, at: Date.now() })
  World.FINISHED.push({ id: 2, name: 'Y', loot: -5, status: Standing.DEAD, at: Date.now() })
  const rows = decode(Multiplayer.buildStandings())
  assert.deepEqual(rows.map((r) => r.loot), [0xFFFFFFFF, 0])
})

test('the own row carries the id the client got in create_own', () => {
  const { multiplayer } = setup()
  const s = fakeSocket('me')
  multiplayer.onConnect(s.socket)
  s.fire('start_requested', { id: 'pid-me', name: 'SAME' })
  join(multiplayer, 'other', 'SAME') // same name: only the id tells them apart

  const own = s.sent.find((e) => e.event === 'create_own')
  assert.ok(own !== undefined)
  const record = unpack(own.data as Buffer)[0]
  assert.equal(record.readUInt8(0), GameObject.fieldOrder.indexOf('id'))
  const ownId = record.readUInt16BE(1)

  for (let tick = 1; tick <= 4; tick++) multiplayer.flushAll(tick, 250)
  const rows = decode(standingsSent(s.sent)[0])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.name), ['SAME', 'SAME'])
  const mine = rows.filter((r) => r.id === ownId && r.status === Standing.ACTIVE)
  assert.equal(mine.length, 1)
})

test('a recycled id never gives two ACTIVE rows', () => {
  const { multiplayer } = setup()
  const a = join(multiplayer, 's1', 'NEW')
  // A finished player whose id has since been handed to the new one.
  World.FINISHED.push({ id: a.player.id, name: 'OLD', loot: 99, status: Standing.DEAD, at: Date.now() })
  const rows = decode(Multiplayer.buildStandings()).filter((r) => r.id === a.player.id)
  assert.equal(rows.length, 2)
  assert.equal(rows.filter((r) => r.status === Standing.ACTIVE).length, 1)
  assert.equal(rows.find((r) => r.status === Standing.ACTIVE)?.name, 'NEW')
})

test('an extracted player shows EXTRACTED, a dead one DEAD, both with their loot', () => {
  const { multiplayer, world } = setup()
  const out = join(multiplayer, 's1', 'OUT')
  const dead = join(multiplayer, 's2', 'DEAD')
  join(multiplayer, 's3', 'STILL')
  out.player.loot = 300
  dead.player.loot = 200

  out.player.exit()
  dead.player.destroy()

  // Before the sweep: still in PLAYERS, status from the flags.
  let rows = decode(Multiplayer.buildStandings())
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.loot]), [
    ['OUT', Standing.EXTRACTED, 300], ['DEAD', Standing.DEAD, 200], ['STILL', Standing.ACTIVE, 0]
  ])

  // After it: out of PLAYERS, into FINISHED, the same rows.
  world.update(0.25)
  assert.equal(World.PLAYERS.length, 1)
  assert.equal(World.FINISHED.length, 2)
  rows = decode(Multiplayer.buildStandings())
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.loot]), [
    ['OUT', Standing.EXTRACTED, 300], ['DEAD', Standing.DEAD, 200], ['STILL', Standing.ACTIVE, 0]
  ])
})

test('finished rows are evicted FINISHED_LINGER_MS after they finish, not before', () => {
  const { multiplayer, world } = setup()
  const out = join(multiplayer, 's1', 'OUT')
  join(multiplayer, 's2', 'STILL')
  out.player.exit()
  world.update(0.25)
  assert.equal(World.FINISHED.length, 1)
  const at = World.FINISHED[0].at

  World.evictFinished(at + World.FINISHED_LINGER_MS - 1)
  assert.equal(World.FINISHED.length, 1, 'still lingering 1 ms before the end')
  World.evictFinished(at + World.FINISHED_LINGER_MS)
  assert.equal(World.FINISHED.length, 0)
  assert.deepEqual(decode(Multiplayer.buildStandings()).map((r) => r.name), ['STILL'])
})

test('the tick itself evicts: a backdated row is gone after world.update', () => {
  const { world } = setup()
  World.FINISHED.push({ id: 7, name: 'STALE', loot: 1, status: Standing.DEAD, at: Date.now() - World.FINISHED_LINGER_MS })
  World.FINISHED.push({ id: 8, name: 'FRESH', loot: 1, status: Standing.DEAD, at: Date.now() })
  world.update(0.25)
  assert.deepEqual(World.FINISHED.map((f) => f.name), ['FRESH'])
})

test('FINISHED never holds more than FINISHED_MAX, oldest dropped first', () => {
  const { multiplayer } = setup()
  const a = join(multiplayer, 's1', 'X')
  const now = Date.now()
  for (let i = 0; i < World.FINISHED_MAX * 3; i++) {
    a.player.loot = i
    World.finish(a.player, Standing.DEAD, now)
  }
  assert.equal(World.FINISHED.length, World.FINISHED_MAX)
  assert.equal(World.FINISHED[0].loot, World.FINISHED_MAX * 2)
  assert.equal(World.FINISHED[World.FINISHED.length - 1].loot, World.FINISHED_MAX * 3 - 1)
})
