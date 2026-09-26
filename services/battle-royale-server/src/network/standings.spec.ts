import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer, { type Connection } from './multiplayer'
import World, { Standing } from '../objects/world'
import Timers from '../objects/timers'
import { GameObject } from '../objects/gameobject'
import type Player from '../objects/player'
// The client's decoder and row picking have no pixi imports, so they load here
// (as wire.spec.ts loads the client's sprite map): these specs read the
// server's bytes the way the client does.
import { decodeStanding, pickShown, type StandingRow } from '../../../../plunder-land-client/src/ui/components/standings'

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

/** The client's reading of a standings buffer: its own decoder, record by record. */
function decode (buf: Buffer): StandingRow[] {
  return unpack(buf).map((r) => {
    const row = decodeStanding(r)
    assert.ok(row !== undefined)
    return row
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
  s.fire('start_requested', { id: Buffer.from(socketId).toString('hex').padStart(6, '0'), name })
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
    // A new board each time: an unchanged one is not resent (see below).
    a.player.loot = tick
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
  for (let tick = 1; tick <= 3; tick++) { a.player.loot = tick; slow.flushAll(tick, 1000) }
  assert.equal(standingsSent(a.sent).length, 3)

  const fast = setup(100).multiplayer
  const b = join(fast, 's2', 'BO')
  for (let tick = 1; tick <= 30; tick++) { b.player.loot = tick; fast.flushAll(tick, 100) }
  assert.equal(standingsSent(b.sent).length, 3)
})

test('a board identical to the last one a connection got is not sent again (server-cpu-trim)', () => {
  const { multiplayer } = setup(250)
  const a = join(multiplayer, 's1', 'ANNA')
  const b = join(multiplayer, 's2', 'BO')
  for (let tick = 1; tick <= 8; tick++) multiplayer.flushAll(tick, 250)
  // Due at 4 and 8; nothing changed between them.
  assert.equal(standingsSent(a.sent).length, 1)
  assert.equal(standingsSent(b.sent).length, 1)

  // A change anywhere on the board goes to everyone.
  b.player.loot = 500
  for (let tick = 9; tick <= 12; tick++) multiplayer.flushAll(tick, 250)
  assert.equal(standingsSent(a.sent).length, 2)
  assert.equal(standingsSent(b.sent).length, 2)
  assert.notDeepEqual(standingsSent(a.sent)[1], standingsSent(a.sent)[0])
})

test('a new run on the same connection gets the board even if it has not changed', () => {
  const { multiplayer } = setup(250)
  const a = join(multiplayer, 's1', 'ANNA')
  for (let tick = 1; tick <= 4; tick++) multiplayer.flushAll(tick, 250)
  assert.equal(standingsSent(a.sent).length, 1)
  const connection = ((multiplayer as any)._connections as Connection[])[0]
  ;(multiplayer as any).attach(connection, a.player)
  for (let tick = 5; tick <= 8; tick++) multiplayer.flushAll(tick, 250)
  assert.equal(standingsSent(a.sent).length, 2)
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

test('byte layout: [uint16 id][uint8 status][uint32 loot][UTF-8 name][0][uint16 rank], length-prefixed', () => {
  setup()
  World.FINISHED.push({ id: 0x1234, name: 'Zoë', loot: 0x01020304, status: Standing.EXTRACTED, at: Date.now() })

  const buf = Multiplayer.buildStandings()
  const name = Buffer.from('Zoë', 'utf8') // 4 bytes: ë is two
  assert.equal(name.length, 4)
  assert.deepEqual(
    [...buf],
    [0x00, 14, 0x12, 0x34, 0x01, 0x01, 0x02, 0x03, 0x04, ...name, 0x00, 0x00, 0x01]
  )
})

test('an old client reads the new records unchanged: it stops at the NUL', () => {
  setup()
  World.FINISHED.push({ id: 7, name: 'ANNA', loot: 40, status: Standing.DEAD, at: Date.now() })
  const record = unpack(Multiplayer.buildStandings())[0]
  // The pre-rank client's decoder, verbatim in effect: fixed part, then the
  // name up to the first NUL, and nothing after it is read.
  let end = 7
  while (end < record.length && record[end] !== 0) end++
  assert.equal(record.subarray(7, end).toString('utf8'), 'ANNA')
  assert.equal(record.length, end + 1 + 2, 'exactly the rank follows the NUL')
})

test('the client ranks an old server\'s records (no rank) by position', () => {
  // An old server's board: the whole list, no bytes after the NUL.
  const old = (id: number, loot: number, name: string): Buffer =>
    Buffer.concat([Buffer.from([id >> 8, id & 0xFF, Standing.ACTIVE, 0, 0, 0, loot]), Buffer.from(name), Buffer.from([0])])
  const rows = [old(1, 90, 'A'), old(2, 80, 'B'), old(3, 70, 'C'), old(4, 60, 'D'), old(5, 50, 'E'), old(6, 40, 'F'), old(7, 30, 'ME')]
    .map((r) => decodeStanding(r) as StandingRow)
  assert.ok(rows.every((r) => r.rank === undefined))
  const { shown, own, ownBelow } = pickShown(rows, 7, 5)
  assert.deepEqual(shown.map((s) => [s.rank, s.row.name]), [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D'], [5, 'E'], [7, 'ME']])
  assert.equal(own?.name, 'ME')
  assert.equal(ownBelow, true)
})

// standings-top-10 (decision #30): the top STANDINGS_TOP rows plus the own row.

/** `count` players named P1..Pcount with loot 1000, 990, ... in join order. */
function crowd (multiplayer: Multiplayer, count: number): Array<{ player: Player, sent: Recorded[] }> {
  const out: Array<{ player: Player, sent: Recorded[] }> = []
  for (let i = 0; i < count; i++) {
    const j = join(multiplayer, `c${i + 1}`, `P${i + 1}`)
    j.player.loot = 1000 - 10 * i
    out.push(j)
  }
  return out
}

function lastBoard (sent: Recorded[]): StandingRow[] {
  const boards = standingsSent(sent)
  assert.ok(boards.length > 0, 'a board was sent')
  return decode(boards[boards.length - 1])
}

test('outside the top 10, the own row is appended with its real rank', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 25)
  for (let tick = 1; tick <= 4; tick++) multiplayer.flushAll(tick, 250)

  const me = players[16] // 17th by loot
  const rows = lastBoard(me.sent)
  assert.equal(rows.length, Multiplayer.STANDINGS_TOP + 1)
  assert.deepEqual(rows.slice(0, 10).map((r) => [r.rank, r.name]), players.slice(0, 10).map((p, i) => [i + 1, `P${i + 1}`]))
  assert.deepEqual([rows[10].rank, rows[10].name, rows[10].id, rows[10].loot], [17, 'P17', me.player.id, 840])

  // What the client draws: the top five and the own row, ranked 17, not 11.
  const { shown, own, ownBelow } = pickShown(rows, me.player.id, 5)
  assert.deepEqual(shown.map((s) => s.rank), [1, 2, 3, 4, 5, 17])
  assert.equal(own?.name, 'P17')
  assert.equal(ownBelow, true)

  // Last place too.
  const last = lastBoard(players[24].sent)
  assert.deepEqual([last.length, last[10].rank, last[10].name], [11, 25, 'P25'])
})

test('inside the top 10, nothing is appended and every such connection shares one buffer', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 25)
  const board = Multiplayer.rankStandings()

  for (let i = 0; i < 10; i++) assert.equal(board.bufferFor(players[i].player), board.top, `P${i + 1}`)
  assert.equal(board.bufferFor(undefined), board.top)
  assert.notEqual(board.bufferFor(players[10].player), board.top)

  const tenth = decode(board.bufferFor(players[9].player))
  assert.equal(tenth.length, 10)
  assert.deepEqual(tenth.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(tenth.filter((r) => r.id === players[9].player.id).length, 1, 'the own row is not repeated')
})

test('11th, the first place outside, is appended as rank 11', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 11)
  const rows = decode(Multiplayer.buildStandings(players[10].player))
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(rows[10].name, 'P11')
})

test('ties rank by id, across the top-10 cut too', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 14)
  // Five players tied at 500, straddling ranks 8-12.
  const tied = players.slice(7, 12)
  for (const t of tied) t.player.loot = 500
  for (const p of players.slice(12)) p.player.loot = 1
  const byId = [...tied].sort((a, b) => a.player.id - b.player.id)

  const board = Multiplayer.rankStandings()
  const top = decode(board.top)
  assert.deepEqual(top.slice(7).map((r) => r.id), byId.slice(0, 3).map((t) => t.player.id))
  assert.deepEqual(top.slice(7).map((r) => r.rank), [8, 9, 10])

  // The two tied players below the cut get distinct ranks, 11 and 12, in id order.
  for (const [k, rank] of [[3, 11], [4, 12]] as const) {
    const rows = decode(board.bufferFor(byId[k].player))
    assert.equal(rows.length, 11)
    assert.deepEqual([rows[10].id, rows[10].rank, rows[10].loot], [byId[k].player.id, rank, 500])
  }
})

test('fewer than 10 players: everyone, ranked, nothing appended', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 4)
  for (let tick = 1; tick <= 4; tick++) multiplayer.flushAll(tick, 250)
  for (const p of players) {
    const rows = lastBoard(p.sent)
    assert.deepEqual(rows.map((r) => [r.rank, r.name]), [[1, 'P1'], [2, 'P2'], [3, 'P3'], [4, 'P4']])
  }
  assert.equal(decode(Multiplayer.buildStandings()).length, 4)
})

test('finished rows rank by their loot and can take top-10 places', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 12)
  World.FINISHED.push({ id: 900, name: 'GONE', loot: 995, status: Standing.EXTRACTED, at: Date.now() })
  World.FINISHED.push({ id: 901, name: 'DIED', loot: 5, status: Standing.DEAD, at: Date.now() })

  const board = Multiplayer.rankStandings()
  const top = decode(board.top)
  assert.deepEqual([top[1].name, top[1].rank, top[1].status], ['GONE', 2, Standing.EXTRACTED])
  assert.ok(!top.some((r) => r.name === 'DIED'))
  // P10 was pushed out of the top 10 by the finished row.
  const rows = decode(board.bufferFor(players[9].player))
  assert.deepEqual([rows.length, rows[10].name, rows[10].rank], [11, 'P10', 11])
})

test('own row finished this tick: sent with its status and rank, and the client does not take it as its own', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 15)
  const me = players[12] // 13th

  for (let tick = 1; tick <= 3; tick++) multiplayer.flushAll(tick, 250)
  // Killed during the tick whose flush sends a board: still in PLAYERS until
  // the sweep, and the connection still points at it until this flush ends.
  me.player.destroy()
  multiplayer.flushAll(4, 250)
  const rows = lastBoard(me.sent)
  assert.deepEqual([rows.length, rows[10].name, rows[10].rank, rows[10].status], [11, 'P13', 13, Standing.DEAD])
  // The client's own row is the ACTIVE one with its id: there is none, so no highlight.
  assert.equal(pickShown(rows, me.player.id, 5).own, undefined)

  // After that flush the connection is done: no more boards.
  const before = standingsSent(me.sent).length
  for (let tick = 5; tick <= 12; tick++) multiplayer.flushAll(tick, 250)
  assert.equal(standingsSent(me.sent).length, before)
})

test('a recycled id: the own row is the live player, even when a finished row with its id is in the top 10', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 20)
  const me = players[15] // 16th
  // A finished player who held this id before, ranked 1st.
  World.FINISHED.push({ id: me.player.id, name: 'OLD', loot: 5000, status: Standing.DEAD, at: Date.now() })

  const rows = decode(Multiplayer.buildStandings(me.player))
  assert.equal(rows.length, 11)
  assert.deepEqual([rows[0].name, rows[0].id, rows[0].status], ['OLD', me.player.id, Standing.DEAD])
  assert.deepEqual([rows[10].name, rows[10].id, rows[10].status, rows[10].rank], ['P16', me.player.id, Standing.ACTIVE, 17])

  const { shown, own } = pickShown(rows, me.player.id, 5)
  assert.equal(own?.name, 'P16')
  assert.deepEqual(shown[shown.length - 1].rank, 17)
})

test('a recycled id on a finished row below the cut adds nothing for a live player in the top 10', () => {
  const { multiplayer } = setup()
  const players = crowd(multiplayer, 20)
  const me = players[3] // 4th, in the top 10
  World.FINISHED.push({ id: me.player.id, name: 'OLD', loot: 0, status: Standing.DEAD, at: Date.now() })
  const board = Multiplayer.rankStandings()
  assert.equal(board.bufferFor(me.player), board.top)
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
  s.fire('start_requested', { id: 'abcdef', name: 'SAME' })
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
