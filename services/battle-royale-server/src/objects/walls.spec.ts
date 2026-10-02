import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import { LAYERS } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'
import { encodeRuns } from './valleys'
import { placeWalls } from './walls'
import { Session } from '../../../../plunder-land-client/src/net/session'

/**
 * Walls (decision #44, walls.ts): short runs inside the islands, about
 * `LAYERS.wallShare` of the ground, never on void or a gate's disc, never
 * touching each other, and never cutting any ground off. Over a few real
 * worlds, since the map is random.
 */

beforeEach(() => {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  // eslint-disable-next-line no-new
  new Multiplayer(250, redis)
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  Timers.clear()
})

/** Connected groups of free cells on `tag`. */
function regionCount (cells: Vector[], tag: number): number {
  const free = new Map<number, Vector>()
  for (const c of cells) if (!World.isBlocked(c.x, c.y, tag)) free.set(Hex.key(c.x, c.y), c)
  const seen = new Set<number>()
  let count = 0
  for (const [key, cell] of free) {
    if (seen.has(key)) continue
    count++
    seen.add(key)
    const queue = [cell]
    for (let i = 0; i < queue.length; i++) {
      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbour(queue[i], d)
        const k = Hex.key(n.x, n.y)
        if (free.has(k) && !seen.has(k)) {
          seen.add(k)
          queue.push(n)
        }
      }
    }
  }
  return count
}

test('every layer has walls, blocked, off the void and the gates, and its ground is still one region', () => {
  const cells = Hex.mapCells(4000)
  for (let run = 0; run < 3; run++) {
    World.BLOCKED.clear()
    // eslint-disable-next-line no-new
    new World(4000)
    for (const layer of LAYERS) {
      const walls = World.WALLS.get(layer.tag) as Set<number>
      const voids = World.VOIDS.get(layer.tag) as Set<number>
      const ground = cells.length - voids.size
      const share = walls.size / ground
      assert.ok(share > layer.wallShare * 0.7 && share < layer.wallShare * 1.1, `layer ${layer.tag} is ${(share * 100).toFixed(1)}% wall`)
      const keepOut = World.gateKeepOut(layer.tag)
      for (const key of walls) {
        assert.equal(World.BLOCKED.get(layer.tag)?.get(key), null, 'a wall cell is not blocked')
        assert.ok(!voids.has(key), 'a wall on void')
        assert.ok(!keepOut.has(key), 'a wall in a gate\'s clear disc')
      }
      assert.equal(regionCount(cells, layer.tag), 1, `layer ${layer.tag}'s ground is cut into pieces`)
    }
  }
})

test('segments are straight runs of 2-5 that never touch another', () => {
  const walls = placeWalls(4000, new Set(), new Set(), 0.06)
  // Group the cells into touching pieces: each is one segment.
  const seen = new Set<number>()
  const byKey = new Map<number, Vector>()
  for (const c of Hex.mapCells(4000)) byKey.set(Hex.key(c.x, c.y), c)
  for (const key of walls) {
    if (seen.has(key)) continue
    const piece = [byKey.get(key) as Vector]
    seen.add(key)
    for (let i = 0; i < piece.length; i++) {
      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbour(piece[i], d)
        const k = Hex.key(n.x, n.y)
        if (walls.has(k) && !seen.has(k)) {
          seen.add(k)
          piece.push(n)
        }
      }
    }
    assert.ok(piece.length >= 2 && piece.length <= 5, `a wall piece of ${piece.length}`)
    // Straight: every cell on one hex line between the two farthest apart.
    let a = piece[0]
    let b = piece[0]
    for (const p of piece) for (const q of piece) if (Hex.distance(p, q) > Hex.distance(a, b)) { a = p; b = q }
    assert.equal(Hex.distance(a, b), piece.length - 1, `a wall piece of ${piece.length} isn't a straight run`)
  }
})

test('the client\'s decodeRuns reads hello.walls back to the same cells', () => {
  const walls = placeWalls(4000, new Set(), new Set(), 0.06)
  const decoded = Session.decodeRuns(encodeRuns(walls, 4000), 4000)
  assert.deepEqual([...decoded].sort(), [...walls].sort())
})
