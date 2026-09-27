import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer from './multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import { GameObject } from '../objects/gameobject'

/**
 * A new run on the same socket. The client re-sends `start_requested` after
 * its game-over screen without reconnecting, and from the 2026-09-02 revival
 * until 2026-09-27 the server latched `Connection.started` on the first start
 * and never cleared it, so every restart without a page reload was ignored
 * (Nick: "no restart after game over"). The latch still refuses a second start
 * while the first run is alive.
 */

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

beforeEach(() => {
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.FINISHED.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
})

function setup (): { multiplayer: Multiplayer, world: World, fire: (event: string, data?: unknown) => void } {
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  World.MOBS.length = 0
  const s = fakeSocket('s1')
  multiplayer.onConnect(s.socket)
  return { multiplayer, world, fire: s.fire }
}

for (const [how, end] of [
  ['death', (p: { destroy: () => void }) => { p.destroy() }],
  ['extraction', (p: { exit: () => void }) => { p.exit() }]
] as const) {
  test(`after a ${how}, the same socket can start a new run`, () => {
    const { multiplayer, world, fire } = setup()
    fire('start_requested', { id: 'abcdef', name: 'ONE' })
    const first = World.PLAYERS[World.PLAYERS.length - 1]
    assert.equal(first.name, 'ONE')

    end(first as any)
    world.update(0.25)
    multiplayer.flushAll(1)

    fire('start_requested', { id: 'abcdef', name: 'TWO' })
    const second = World.PLAYERS[World.PLAYERS.length - 1]
    assert.notEqual(second, first, 'the second start was ignored')
    assert.equal(second.name, 'TWO')
    assert.equal(second.destroyed, false)
  })
}

test('a second start while the first run is alive is still ignored', () => {
  const { fire } = setup()
  fire('start_requested', { id: 'abcdef', name: 'ONE' })
  fire('start_requested', { id: 'abcdef', name: 'TWO' })
  assert.equal(World.PLAYERS.length, 1)
  assert.equal(World.PLAYERS[0].name, 'ONE')
})
