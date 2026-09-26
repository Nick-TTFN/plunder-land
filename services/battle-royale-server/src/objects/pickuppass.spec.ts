import test from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Player from './player'
import { type GameObject } from './gameobject'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * server-cpu-trim: the pickup pass skips a pickup when no player moved within
 * `World.PICKUP_WATCH_BUCKETS` of it (`World.pickupPass`). That is only right
 * if the skipped update would have been a no-op. So this runs a real world of
 * walking players and, for every pickup the pass skips, runs its update anyway
 * and requires that it queued nothing for anyone and left the same clients
 * holding it.
 */

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

function lcg (seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

function join (multiplayer: Multiplayer, id: string): Player {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    handshake: { query: {} },
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  multiplayer.onConnect(socket)
  handlers.start_requested({ id, name: id })
  return World.PLAYERS[World.PLAYERS.length - 1]
}

/** Everything a pickup's update could touch: every queued record count, and who holds it. */
function footprint (connections: Connection[], pickup: GameObject): string {
  const queued = connections.map((c) => {
    const o = c.outbox
    return o === undefined ? '-' : `${o.create.length}/${o.update.length}/${o.destroy.length}`
  }).join(' ')
  const holders = [...pickup.knownBy].map((c) => c.id).sort().join(',')
  return `${queued} | ${holders}`
}

test('every pickup the pass skips would have done nothing', () => {
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  Timers.clear()
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  // Mobs would kill the walkers; the pass is about players and pickups.
  World.MOBS.length = 0
  const rand = lcg(99)
  const players: Player[] = []
  for (let i = 0; i < 24; i++) players.push(join(multiplayer, `abcdef${i.toString(16).padStart(2, '0')}`))
  const connections = (multiplayer as unknown as { _connections: Connection[] })._connections

  let skipped = 0
  let checked = 0
  const real = World.pickupPass
  World.pickupPass = (dt: number) => {
    const near = World.pickupWatch()
    for (const pickup of [...World.CONSUMABLES, ...World.ITEMS]) {
      if (World.pickupDue(pickup, near)) {
        pickup.update(dt)
        checked++
        continue
      }
      skipped++
      const before = footprint(connections, pickup)
      Multiplayer.Instance.update(pickup)
      assert.equal(footprint(connections, pickup), before, `skipping pickup ${pickup.id} lost something`)
    }
  }
  try {
    for (let tick = 0; tick < 240; tick++) {
      for (const player of players) {
        if (player.destroyed || player.exited) continue
        // Long walks, so players cross buckets, boxes and exit margins; a
        // third of them stand still for a while.
        if (rand() < 0.04) {
          if (rand() < 0.33) player.stop()
          else {
            const cell = player.cell
            const target = new Vector(cell.x + Math.floor(rand() * 41) - 20, cell.y + Math.floor(rand() * 41) - 20)
            if (Hex.onMap(target.x, target.y, World.mapSize) && !World.isBlocked(target.x, target.y, player.tag)) player.setWaypoints([target])
          }
        }
      }
      world.update(0.25)
      multiplayer.flushAll(tick)
    }
  } finally {
    World.pickupPass = real
  }
  assert.ok(skipped > 1000, `only ${skipped} skips: the test did not exercise the shortcut`)
  assert.ok(checked > 1000, `only ${checked} checks`)
})
