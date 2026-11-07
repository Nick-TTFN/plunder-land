import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import '../network/multiplayer'
import Worlds from '../network/worlds'
import World from './world'
import Portal from './portal'
import Exit from './exit'
import type Mob from './mob'
import HandoffGate from '../firstrun/gate'
import { isPackEntry } from '../archetypes/archetypes'

/**
 * A shared world under private runs (decision #60; task private-8): it holds
 * every layer that is not private, which since Q19 is layers 03-05 (tags -2,
 * -3, -4). Its portals chain them in `LAYERS` order with Dez's counts, layer
 * 03 has no way back up (Q3), and nothing leads out of it. Over 2000 ticks
 * every held layer fills to its row's mobs, loot and items and never goes
 * over; the private layers stay empty.
 */

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

test('a shared world holds -2, -3 and -4, chained by Dez\'s portals, none up from -2, none out; 2000 ticks fill each to its row', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 3_600_000, redis: redisStub(), bots: 0, now: () => Date.now() })
  const world = worlds.worlds[0]
  assert.ok(world !== undefined, 'no shared world')
  const shared = World.LAYERS.filter((l) => l.owned !== true)
  const sharedTags = shared.map((l) => l.tag)
  assert.deepEqual(sharedTags, [-2, -3, -4])
  assert.deepEqual(World.TAGS, [0, -1, -2, -3, -4], 'every world keeps the global five-tag list')

  World.run(world, () => {
    assert.deepEqual(World.TAGS.filter((tag) => world.holds(tag)), sharedTags)
    assert.equal(world.topLayer, -2)

    const gates = world.OBSTACLES.filter((o): o is Portal | Exit => o instanceof Portal || o instanceof Exit)
    assert.equal(gates.filter((g) => g instanceof HandoffGate).length, 0, 'a pad out of a shared world')
    const portals = (tag: number, to: number): number => gates.filter((g) => g instanceof Portal && g.tag === tag && g.to === to).length
    const exits = (tag: number): number => gates.filter((g) => g instanceof Exit && g.tag === tag).length
    // Written out, not read from LAYERS: Dez's section 2, accepted 2026-11-06.
    assert.deepEqual(
      sharedTags.map((tag) => [portals(tag, tag + 1), portals(tag, tag - 1), exits(tag)]),
      [[0, 10, 4], [5, 5, 4], [5, 0, 3]]
    )
    assert.equal(gates.length, 14 + 14 + 8, 'a gate that skips a layer or leads to its own')
    for (const g of gates) assert.ok(sharedTags.includes(g.tag), `a gate on the unheld layer ${g.tag}`)
  })

  const TICKS = 2000
  const full = new Map<number, number>()
  for (let tick = 0; tick < TICKS; tick++) {
    t.mock.timers.tick(250)
    worlds.tickAll(250)
    World.run(world, () => {
      for (const layer of World.LAYERS) {
        const mobs = (World.MOBS as Mob[]).filter((m) => m.tag === layer.tag && !m.destroyed)
        const loot = World.CONSUMABLES.filter((c) => c.tag === layer.tag && c.expiresAt === 0)
        const items = World.ITEMS.filter((i) => i.tag === layer.tag && i.expiresAt === 0)
        if (!sharedTags.includes(layer.tag)) {
          assert.equal(mobs.length + loot.length + items.length, 0, `tick ${tick}: something on the unheld layer ${layer.tag}`)
          continue
        }
        // Nothing kills here (no players), so every count only rises to its row.
        let atRow = true
        for (const entry of layer.mobs) {
          const have = isPackEntry(entry)
            ? new Set(mobs.filter((m) => m.pack?.entry === entry).map((m) => m.pack)).size
            : mobs.filter((m) => m.archetype === entry.archetype && m.pack === undefined).length
          assert.ok(have <= entry.count, `tick ${tick}, layer ${layer.tag}: ${have} over ${entry.count}`)
          if (have < entry.count) atRow = false
        }
        assert.ok(loot.length <= layer.naturalLoot, `tick ${tick}: loot over on ${layer.tag}`)
        if (loot.length < layer.naturalLoot) atRow = false
        for (const { item, count } of layer.items) {
          const have = items.filter((i) => i.kind === item).length
          assert.ok(have <= count, `tick ${tick}: ${item.key} over on ${layer.tag}`)
          if (have < count) atRow = false
        }
        if (atRow) full.set(layer.tag, (full.get(layer.tag) ?? 0) + 1)
      }
    })
  }
  World.run(world, () => {
    for (const layer of shared) {
      // Filled within the first ticks (one loot pickup a tick: 150), then full to the end.
      assert.ok((full.get(layer.tag) ?? 0) >= TICKS - 200, `layer ${layer.tag} at its row on only ${full.get(layer.tag) ?? 0} ticks`)
      // Every pickup and mob carries the layer's multiplier (x3 / x5 / x7).
      for (const c of World.CONSUMABLES) if (c.tag === layer.tag && c.expiresAt === 0) assert.equal(c.loot, Math.round(c.radius * layer.lootMultiplier))
      for (const m of World.MOBS) if (m.tag === layer.tag && !m.destroyed) assert.equal(m.loot, Math.round((m.archetype?.loot ?? 0) * layer.lootMultiplier))
    }
  })
  for (const w of [...worlds.worlds]) w.close()
})
