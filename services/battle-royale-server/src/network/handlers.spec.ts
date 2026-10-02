import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer, { ThrottledLog } from './multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Mob from '../objects/mob'
import Consumable from '../objects/consumable'
import { GameObject } from '../objects/gameobject'
import type Player from '../objects/player'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * `socket-handlers-in-boundary`: the tick's try/catch in `index.ts` covers what
 * the tick runs, but `start_requested`, `pointer` and `skill` run on their own
 * turn of the event loop, straight from socket.io. A throw in any of them used
 * to reach the process: synchronously from `pointer` and `skill`, and as an
 * unhandled rejection from the `async onStart`. Nothing is persisted, so either
 * ends every run in progress.
 */

/** Redis that accepts every write and counts them. */
function okRedis (): { client: Redis, writes: number } {
  const stub = {
    writes: 0,
    client: {
      on: () => stub.client,
      hincrby: async () => { stub.writes++; return 1 }
    } as unknown as Redis
  }
  return stub
}

interface FakeSocket {
  socket: Socket
  fire: (event: string, data?: unknown) => void
  emitted: string[]
}

/** Enough of a socket.io Socket for Multiplayer, recording what it was sent. */
function fakeSocket (id: string): FakeSocket {
  const handlers: Record<string, (data: unknown) => void> = {}
  const emitted: string[] = []
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string) => { emitted.push(event); return true }
  } as unknown as Socket
  return { socket, emitted, fire: (event, data) => { handlers[event](data) } }
}

/** A `pointer` packet: `[uint8 count][int16 q][int16 r] * count][uint16 seq]`. */
function pointer (seq: number, ...cells: Vector[]): Buffer {
  const buf = Buffer.alloc(1 + cells.length * 4 + 2)
  buf.writeUInt8(cells.length, 0)
  cells.forEach((c, i) => {
    buf.writeInt16BE(c.x, 1 + i * 4)
    buf.writeInt16BE(c.y, 3 + i * 4)
  })
  buf.writeUInt16BE(seq, 1 + cells.length * 4)
  return buf
}

async function settle (): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

let unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
let logged: unknown[][] = []
const savedHandlerLog = Multiplayer.HANDLER_LOG
const savedCreatePlayer = World.createPlayer

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0

  unhandled = []
  process.on('unhandledRejection', onUnhandled)
  logged = []
  // A zero window: every throw is a line, so the tests can count them.
  Multiplayer.HANDLER_LOG = new ThrottledLog('socket handler threw', 0, () => Date.now(), (...args) => { logged.push(args) })
})

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  Multiplayer.HANDLER_LOG = savedHandlerLog
  World.createPlayer = savedCreatePlayer
})

/** A world with nothing in it but what the test adds, and a server over it. */
function setup (): { multiplayer: Multiplayer, world: World, redis: ReturnType<typeof okRedis> } {
  const redis = okRedis()
  const multiplayer = new Multiplayer(250, redis.client)
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.CONSUMABLES.length = 0
  World.MOBS.length = 0
  World.BLOCKED.clear()
  return { multiplayer, world, redis }
}

function join (multiplayer: Multiplayer, id: string): FakeSocket & { player: Player } {
  const fake = fakeSocket(id)
  multiplayer.onConnect(fake.socket)
  fake.fire('start_requested', { id })
  const player = World.PLAYERS[World.PLAYERS.length - 1] as Player
  assert.equal(player.playerId, id)
  // Players spawn at random; a route a few cells east of one near the edge
  // leaves the map. Put each on its own cell in the middle instead.
  const middle = Hex.toCell(new Vector(World.mapSize / 2, World.mapSize / 2))
  player.position = Hex.toPosition(middle.add(new Vector(World.PLAYERS.length * 5, 0)))
  return { ...fake, player }
}

/** Every freed-id push that has fallen due, counted for one id. */
function timesFreed (id: number): number {
  Timers.run(Date.now() + 2000)
  return GameObject.FreedIDs.filter((freed) => freed === id).length
}

test('a skill whose execute throws is contained, and other players\' inputs still apply', () => {
  const { multiplayer, world } = setup()
  const a = join(multiplayer, 'aaaaaa')
  const b = join(multiplayer, 'bbbbbb')

  a.player.skills[1].execute = () => { throw new Error('broken skill') }
  let bCast = 0
  b.player.skills[1].execute = () => { bCast++; return true }

  assert.doesNotThrow(() => { a.fire('skill', 1) })
  assert.equal(logged.length, 1, 'the throw was logged')

  // The next input after the throw, from someone else, is applied as normal.
  b.fire('skill', 1)
  const start = new Vector(b.player.position.x, b.player.position.y)
  const goal = Hex.toCell(start).add(Hex.DIRECTIONS[0].multiply(3))
  b.fire('pointer', pointer(7, goal))
  assert.equal(bCast, 1)

  // And the world goes on ticking, moving b along the route it asked for.
  for (let tick = 1; tick <= 4; tick++) {
    world.update(0.25)
    multiplayer.flushAll(tick, 250)
  }
  assert.ok(b.player.position.sub(start).getSquareMagnitude() > 0, 'b did not move')
  assert.equal(World.PLAYERS.length, 2)
})

test('a pointer that throws is contained too', () => {
  const { multiplayer } = setup()
  const a = join(multiplayer, 'aaaaaa')
  const b = join(multiplayer, 'bbbbbb')

  a.player.setWaypoints = () => { throw new Error('broken route') }
  const goal = Hex.toCell(b.player.position).add(Hex.DIRECTIONS[0].multiply(2))

  assert.doesNotThrow(() => { a.fire('pointer', pointer(1, goal)) })
  assert.equal(logged.length, 1)

  b.fire('pointer', pointer(1, goal))
  assert.deepEqual(b.player.waypoints, [goal])
})

test('inputs apply in arrival order, across connections, whatever throws between them', () => {
  const { multiplayer } = setup()
  const a = join(multiplayer, 'aaaaaa')
  const b = join(multiplayer, 'bbbbbb')

  const order: string[] = []
  for (const [name, p] of [['a', a.player], ['b', b.player]] as const) {
    p.setWaypoints = () => { order.push(`${name}:pointer`) }
    p.stop = () => { order.push(`${name}:stop`) }
    p.skills[0].execute = () => { order.push(`${name}:skill0`); return true }
    p.skills[2].execute = () => { order.push(`${name}:skill2`); throw new Error('mid-sequence') }
  }
  const cell = Hex.toCell(a.player.position)

  a.fire('pointer', pointer(1, cell))
  b.fire('skill', 0)
  a.fire('skill', 2) // throws
  b.fire('pointer', pointer(1, cell))
  a.fire('pointer', pointer(2)) // count 0: stop
  b.fire('skill', 2) // throws
  a.fire('skill', 0)

  assert.deepEqual(order, [
    'a:pointer', 'b:skill0', 'a:skill2', 'b:pointer', 'a:stop', 'b:skill2', 'a:skill0'
  ])
  assert.equal(logged.length, 2)
})

test('a start that throws while building the snapshot leaves no half-joined player', async () => {
  const { multiplayer, world } = setup()
  const watcher = join(multiplayer, 'eeeeee')
  watcher.emitted.length = 0

  // One object in the world that cannot be serialised, beside the watcher,
  // and the joiner put down there too: a join is sent only what is in range
  // on its layer, and the watcher only a joiner in its range (decision #35).
  const near = watcher.player.position
  // Three cells out: in range, but beyond the 1-ring pickup reach
  // (pickup-reach, #42), or the watcher would take it during the tick.
  const bad = new Consumable(near.x + 3 * 45, near.y, 0)
  bad.serialiseBinary = () => { throw new Error('unserialisable') }
  World.CONSUMABLES.push(bad)
  const savedSpawnCell = World.spawnCell
  World.spawnCell = () => ({ cell: Hex.toCell(near), fallback: false })

  const joiner = fakeSocket('joiner')
  multiplayer.onConnect(joiner.socket)
  try {
    assert.doesNotThrow(() => { joiner.fire('start_requested', { id: 'cccccc' }) })
  } finally {
    World.spawnCell = savedSpawnCell
  }
  await settle()

  assert.deepEqual(unhandled, [], 'the throw escaped as a rejection')
  assert.equal(logged.length, 1)
  assert.deepEqual(World.PLAYERS.map((p) => p.playerId), ['eeeeee'], 'a half-joined player stayed in the world')
  assert.deepEqual(joiner.emitted, [], 'the joiner was sent a hello for a join that failed')

  // Nothing is left pointing at the ghost, so the next ticks run clean and
  // its id comes back exactly once.
  const ghostId = GameObject.id
  world.update(0.25)
  multiplayer.flushAll(1, 250)
  assert.equal(World.PLAYERS.length, 1)
  assert.equal(timesFreed(ghostId), 1)

  // The watcher was sent its create; it must also be sent its destroy.
  assert.ok(watcher.emitted.includes('destroy'), 'other clients kept a ghost')

  // Once the cause is gone, the same connection can join.
  World.CONSUMABLES.length = 0
  joiner.fire('start_requested', { id: 'cccccc' })
  assert.deepEqual(World.PLAYERS.map((p) => p.playerId).sort(), ['cccccc', 'eeeeee'])
  assert.ok(joiner.emitted.includes('hello'))
})

test('a start that throws creating the player is contained', async () => {
  const { multiplayer } = setup()
  World.createPlayer = () => { throw new Error('no room') }

  const joiner = fakeSocket('joiner')
  multiplayer.onConnect(joiner.socket)
  assert.doesNotThrow(() => { joiner.fire('start_requested', { id: 'cccccc' }) })
  await settle()

  assert.deepEqual(unhandled, [])
  assert.equal(logged.length, 1)
  assert.equal(World.PLAYERS.length, 0)
  assert.deepEqual(joiner.emitted, [])
})

test('a unit killed twice in one tick frees its id once, and credits one kill', () => {
  setup()
  const mob = new Mob(1000, 1000, 0)

  assert.equal(mob.hit(1000), true, 'the first hit kills')
  // Dead units stay in World.MOBS until the next tick sweeps them, and
  // FIND_IN_CELLS does not skip them, so a second melee in the same tick
  // reaches the corpse.
  const again = mob.hit(1000)
  assert.equal(timesFreed(mob.id), 1, 'the id was freed twice')
  assert.equal(again, false, 'a corpse was killed again, so its killer is credited twice')
})

test('a player killed between ticks who then disconnects frees its id once', async () => {
  const { multiplayer, redis } = setup()
  const victim = join(multiplayer, 'dddddd')

  // A melee run from a socket handler kills between ticks, so the victim's
  // connection still points at it when the disconnect arrives.
  victim.player.hit(1000)
  assert.equal(victim.player.destroyed, true)
  await settle()
  const writesAfterDeath = redis.writes
  assert.ok(writesAfterDeath >= 1, 'the death was not counted at all')

  multiplayer.onDisconnect(victim.socket)
  await settle()

  assert.equal(timesFreed(victim.player.id), 1)
  assert.equal(redis.writes, writesAfterDeath, 'the run was counted twice in stats')
})
