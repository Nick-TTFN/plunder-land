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
import { carveValleys, encodeRuns } from './valleys'
import { Session } from '../../../../plunder-land-client/src/net/session'

/**
 * The valleys (tile art pass, 2026-09-27; valleys.ts): about a third of every
 * layer is void, in chasms, and all of the rest is one walkable region. Over a
 * few real worlds, since the map is random.
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

/** Connected groups of free cells on `tag`, by size. */
function regions (cells: Vector[], tag: number): number[] {
  const free = new Map<number, Vector>()
  for (const c of cells) if (!World.isBlocked(c.x, c.y, tag)) free.set(Hex.key(c.x, c.y), c)
  const seen = new Set<number>()
  const sizes: number[] = []
  for (const [key, cell] of free) {
    if (seen.has(key)) continue
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
    sizes.push(queue.length)
  }
  return sizes
}

test('about a third of every layer is void, all blocked, and the rest is one region', () => {
  const cells = Hex.mapCells(4000)
  for (let run = 0; run < 3; run++) {
    World.BLOCKED.clear()
    // eslint-disable-next-line no-new
    new World(4000)
    for (const layer of LAYERS) {
      const voids = World.VOIDS.get(layer.tag) as Set<number>
      const share = voids.size / cells.length
      assert.ok(share > 0.28 && share < 0.4, `layer ${layer.tag} is ${(share * 100).toFixed(1)}% void`)
      for (const key of voids) assert.equal(World.BLOCKED.get(layer.tag)?.get(key), null, 'a void cell is not blocked')
      const sizes = regions(cells, layer.tag)
      assert.equal(sizes.length, 1, `layer ${layer.tag}'s ground is in ${sizes.length} pieces: ${sizes.sort((a, b) => b - a).slice(0, 5).join(', ')}`)
    }
  }
})

test('the void comes in valleys, not specks', () => {
  const cells = Hex.mapCells(4000)
  const voids = carveValleys(4000, 1 / 3)
  // Every void cell has a void neighbour: no lone holes.
  const byKey = new Set(cells.map((c) => Hex.key(c.x, c.y)))
  for (const cell of cells) {
    if (!voids.has(Hex.key(cell.x, cell.y))) continue
    let company = 0
    for (let d = 0; d < 6; d++) {
      const n = Hex.neighbour(cell, d)
      const k = Hex.key(n.x, n.y)
      if (!byKey.has(k) || voids.has(k)) company++
    }
    assert.ok(company > 0, `a lone void cell at (${cell.x}, ${cell.y})`)
  }
})

test('the client\'s decodeRuns reads hello.voids back to the same cells', () => {
  const voids = carveValleys(4000, 1 / 3)
  const decoded = Session.decodeRuns(encodeRuns(voids, 4000), 4000)
  assert.deepEqual([...decoded].sort(), [...voids].sort())
  // Anything malformed reads as no valleys rather than a wrong map.
  assert.equal(Session.decodeRuns([1, 2, 3], 4000).size, 0)
  assert.equal(Session.decodeRuns('x', 4000).size, 0)
  assert.equal(Session.decodeRuns([-1, 9168], 4000).size, 0)
})
