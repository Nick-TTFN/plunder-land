import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Portal from './portal'
import Exit from './exit'
import Obstacle from './obstacle'
import Consumable from './consumable'
import Mob from './mob'
import Player from './player'
import { type GameObject } from './gameobject'
import { type Archetype, ARCHETYPES, LAYERS } from '../archetypes/archetypes'

/**
 * `three-ground-layers` (decisions #3, #10, #16, #26): three ground layers,
 * portals chained 01 <-> 02 <-> 03 that carry players only, and everything the
 * world keeps topped up counted per layer.
 *
 * Tests that build a real `new World()` assert only what holds wherever its
 * random gates land; the ones about movement build their own portal.
 */

const DT = 0.25
const [TOP, MIDDLE, BOTTOM] = LAYERS.map((layer) => layer.tag)

let multiplayer: Multiplayer

beforeEach(() => {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  multiplayer = new Multiplayer(250, redis)
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

// --- the table ------------------------------------------------------------------

test('LAYERS holds #26\'s numbers, top layer first', () => {
  const row = (i: number): unknown => {
    const l = LAYERS[i]
    return {
      tag: l.tag,
      loot: l.lootMultiplier,
      rocks: l.rocks,
      cap: l.naturalLoot,
      mobs: l.mobs.map((m) => `${m.archetype.key} ${m.count}`)
    }
  }
  assert.equal(LAYERS.length, 3)
  assert.deepEqual(row(0), { tag: 0, loot: 1, rocks: 136, cap: 150, mobs: ['grunt 22', 'gunner 0', 'boss 0'] })
  assert.deepEqual(row(1), { tag: -1, loot: 1.75, rocks: 136, cap: 150, mobs: ['grunt 18', 'gunner 8', 'boss 2'] })
  assert.deepEqual(row(2), { tag: -2, loot: 3, rocks: 136, cap: 150, mobs: ['grunt 14', 'gunner 14', 'boss 3'] })
  assert.deepEqual(World.TAGS, [0, -1, -2])
})

test('gates keep today\'s density: 10 portals and 4 exits a layer, chained in order', () => {
  assert.deepEqual(LAYERS.map((l) => [l.portalsUp, l.portalsDown, l.exits]), [[0, 10, 4], [5, 5, 4], [10, 0, 4]])
})

// --- the map --------------------------------------------------------------------

function gates (): Array<Portal | Exit> {
  return World.OBSTACLES.filter((o): o is Portal | Exit => o instanceof Portal || o instanceof Exit)
}

test('a new world puts each layer\'s portals and exits on it, leading only to the next layer', () => {
  new World(4000) // eslint-disable-line no-new
  const portals = (tag: number, to: number): number =>
    gates().filter((g) => g instanceof Portal && g.tag === tag && g.to === to).length
  const exits = (tag: number): number => gates().filter((g) => g instanceof Exit && g.tag === tag).length

  assert.equal(portals(TOP, MIDDLE), 10)
  assert.equal(portals(MIDDLE, TOP), 5)
  assert.equal(portals(MIDDLE, BOTTOM), 5)
  assert.equal(portals(BOTTOM, MIDDLE), 10)
  for (const tag of World.TAGS) assert.equal(exits(tag), 4, `exits on layer ${tag}`)

  // Nothing else: no portal skips a layer, none leads to its own layer.
  assert.equal(gates().filter((g) => g instanceof Portal).length, 30)
  assert.equal(gates().length, 42)
})

test('no gate lies within GATE_SPACING of another a player could meet on the same layer', () => {
  // Several worlds, because placement is random and the rule has to hold for
  // every placement, not one.
  for (let run = 0; run < 5; run++) {
    World.OBSTACLES.length = 0
    World.BLOCKED.clear()
    new World(4000) // eslint-disable-line no-new
    const reach = (g: GameObject): number[] => g instanceof Portal ? [g.tag, g.to] : [g.tag]
    const all = gates()
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]
        const b = all[j]
        if (!reach(a).some((t) => reach(b).includes(t))) continue
        const d = a.position.sub(b.position).getMagnitude()
        assert.ok(d >= World.GATE_SPACING, `gates on ${reach(a)} and ${reach(b)} only ${d.toFixed(0)} apart`)
      }
    }
  }
})

// --- the refill -----------------------------------------------------------------

function worldWithoutGates (): World {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  return world
}

test('every layer is filled to its own rock count, and a StoneWall stone is not a rock', () => {
  const world = worldWithoutGates()
  // A timed obstacle, as StoneWall places, before the first refill.
  const stone = new Obstacle(2000, 2000, TOP, 5000)
  World.OBSTACLES.push(stone)

  world.update(DT)

  for (const layer of LAYERS) {
    const rocks = World.OBSTACLES.filter((o) => o.tag === layer.tag && World.isRock(o)).length
    assert.equal(rocks, layer.rocks, `rocks on layer ${layer.tag}`)
  }
  assert.equal(World.isRock(stone), false)
  assert.equal(World.OBSTACLES.filter((o) => o.tag === TOP).length, LAYERS[0].rocks + 1)
})

const natural = (tag: number): Consumable[] =>
  World.CONSUMABLES.filter((c) => c.tag === tag && c.expiresAt === 0)

test('natural loot is capped per layer, and death drops do not count toward the cap', () => {
  const world = worldWithoutGates()
  // A full layer 01, and layer 02 buried in death drops.
  for (let i = 0; i < LAYERS[0].naturalLoot; i++) World.CONSUMABLES.push(new Consumable(100, 100, TOP))
  for (let i = 0; i < 400; i++) World.CONSUMABLES.push(new Consumable(100, 100, MIDDLE, undefined, 10, 60_000))

  world.update(DT)

  assert.equal(natural(TOP).length, LAYERS[0].naturalLoot, 'a full layer spawned more')
  assert.equal(natural(MIDDLE).length, 1, 'death drops held back the natural spawn')
  assert.equal(natural(BOTTOM).length, 1)
})

test('natural pickups, mobs and bosses carry their layer\'s loot multiplier', () => {
  const world = worldWithoutGates()
  world.update(DT)
  // Mob loot is server-side only: never marked for the wire, where the client
  // would float it over the mob as a loot gain. Checked straight after the
  // spawn, because a mob's own update sends and clears whatever is dirty.
  assert.ok(World.MOBS.length > 0)
  for (const mob of World.MOBS) assert.equal(mob.dirtyFields.has('loot'), false)

  for (let i = 0; i < 40; i++) world.update(DT)

  for (const layer of LAYERS) {
    const pickups = natural(layer.tag)
    assert.ok(pickups.length > 0)
    for (const c of pickups) assert.equal(c.loot, Math.round(c.radius * layer.lootMultiplier))
  }

  const lootOf = (a: Archetype, tag: number): number[] =>
    [...new Set(World.MOBS.filter((m) => m.archetype === a && m.tag === tag).map((m) => m.loot))]
  assert.deepEqual(lootOf(ARCHETYPES.grunt, TOP), [50])
  assert.deepEqual(lootOf(ARCHETYPES.grunt, MIDDLE), [88])
  assert.deepEqual(lootOf(ARCHETYPES.grunt, BOTTOM), [150])
  assert.deepEqual(lootOf(ARCHETYPES.gunner, MIDDLE), [131])
  assert.deepEqual(lootOf(ARCHETYPES.gunner, BOTTOM), [225])
  assert.deepEqual(lootOf(ARCHETYPES.boss, MIDDLE), [875])
  assert.deepEqual(lootOf(ARCHETYPES.boss, BOTTOM), [1500])
})

test('a mob\'s death drops carry its multiplied loot', () => {
  const world = worldWithoutGates()
  for (let i = 0; i < 5; i++) world.update(DT)
  const boss = World.MOBS.find((m) => m.archetype === ARCHETYPES.boss && m.tag === BOTTOM) as Mob
  boss.hit(10_000)
  const before = World.CONSUMABLES.filter((c) => c.expiresAt > 0).length
  assert.equal(before, 0)

  world.update(DT)

  const drops = World.CONSUMABLES.filter((c) => c.expiresAt > 0)
  assert.equal(drops.reduce((sum, c) => sum + c.loot, 0), 1500)
  for (const d of drops) assert.equal(d.tag, BOTTOM)
})

// --- joining --------------------------------------------------------------------

test('a new player joins on layer 01', () => {
  new World(4000) // eslint-disable-line no-new
  for (let i = 0; i < 50; i++) assert.equal(World.createPlayer(`p${i}`).tag, TOP)
})

test('hello carries the layer tags, top first', () => {
  new World(4000) // eslint-disable-line no-new
  const sent: Array<[string, unknown]> = []
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id: 'joiner',
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string, data: unknown) => { sent.push([event, data]); return true }
  } as unknown as Socket
  multiplayer.onConnect(socket)
  handlers.start_requested('joiner')

  const hello = sent.find(([event]) => event === 'hello')?.[1] as { layers: number[] }
  assert.deepEqual(hello.layers, [0, -1, -2])
})

// --- portals --------------------------------------------------------------------

/** A portal at (2000, 2000) on layer 02, down to 03, and nothing else solid. */
function portalAhead (): Portal {
  const portal = new Portal(2000, 2000, BOTTOM, MIDDLE)
  World.OBSTACLES.push(portal)
  return portal
}

test('a player walking into a portal is moved to the layer it leads to', () => {
  portalAhead()
  const player = new Player(1900, 2000, MIDDLE, 'walker')
  World.PLAYERS.push(player)
  player.setDirection(1, 0)

  for (let i = 0; i < 8 && player.tag === MIDDLE; i++) player.update(DT)

  assert.equal(player.tag, BOTTOM)
})

for (const archetype of [ARCHETYPES.grunt, ARCHETYPES.gunner, ARCHETYPES.boss]) {
  test(`a ${archetype.key} walking into a portal is pushed out and stays on its layer`, () => {
    const portal = portalAhead()
    const mob = new Mob(1850, 2000, MIDDLE, archetype)
    // No AI: it walks straight at the portal and keeps pressing into it.
    mob.routines = []
    mob.maxVelocity = 100
    mob.setDirection(1, 0)
    World.MOBS.push(mob)

    let touched = false
    for (let i = 0; i < 12; i++) {
      mob.update(DT)
      const gap = mob.position.sub(portal.position).getMagnitude()
      if (gap <= portal.radius + mob.radius + 1e-6) touched = true
      assert.ok(gap >= portal.radius + mob.radius - 1e-6, `inside the portal at tick ${i}: ${gap.toFixed(1)}`)
    }

    assert.ok(touched, 'never reached the portal, so this proved nothing')
    assert.equal(mob.tag, MIDDLE)
  })
}
