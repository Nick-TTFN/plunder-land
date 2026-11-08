import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Portal from './portal'
import Exit from './exit'
import HandoffGate from '../firstrun/gate'
import { FrozenSet, PRIVATE_MAP_SEED, PRIVATE_MAP_SIZE, PRIVATE_SIDES, PrivateMap, seeded } from './privatemap'
import { Hex } from '../utils/hex'

/**
 * One private map for every private world (decision #60, task private-5):
 * `WorldOptions.map`. The first world on a map generates it from the map's
 * seed; every later one holds the template's very valley and wall Sets and
 * run arrays, read-only, a `BLOCKED` on the template's shared terrain
 * (`CellOverlay`, private-10; `privateblocked.spec.ts`), and its own gate
 * objects at the template's sites.
 */

const [TOP, MIDDLE, BOTTOM] = World.TAGS
/** The private worlds' map size and layers (Dez's 3a, private-3; private-6 builds them). */
const SIZE = PRIVATE_MAP_SIZE
const HELD = [TOP, MIDDLE]

/**
 * The digest of the private map at `PRIVATE_MAP_SEED` (hello's voids and
 * walls plus every gate site). A fresh process every test run, so this is
 * the "same map in every process and across deploys" check. **If it fails,
 * the private map changed**: a seed, generator (`valleys.ts`, `walls.ts`,
 * `World.placeGate`) or `LAYERS` row change. That is a new map for every
 * player and so a release; update the digest only if that was the intent.
 * Last changed 2026-11-08 (Nick): map 1400 (was 2000), 01 on the square
 * 0..1000 (`PRIVATE_SIDES`), portal sites drawn where both ends can be ground.
 */
const DIGEST = '46a51132e751ec778e3977b4e4f28f06d171b7fc21d8ac4a1a4b824f27d77e8b'

function redisStub (): Redis {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  return redis
}

function build (map: PrivateMap | undefined, layers: readonly number[] | undefined = HELD, size = SIZE): { world: World, mp: Multiplayer } {
  const mp = new Multiplayer(250, redisStub())
  const world = World.build(size, { multiplayer: mp, layers, map })
  return { world, mp }
}

const gatesOf = (world: World): Array<Portal | Exit> =>
  world.OBSTACLES.filter((o): o is Portal | Exit => o instanceof Portal || o instanceof Exit)

/** The gate sites as data: kind, layer, target, cell. */
function sites (world: World): string[] {
  return gatesOf(world).map((g) => {
    const cell = Hex.toCell(g.position)
    const kind = g instanceof Exit ? 'exit' : g instanceof HandoffGate ? 'pad' : 'portal'
    return `${kind}:${g.tag}->${g instanceof Exit ? '' : g.to}@${cell.x},${cell.y}`
  })
}

/** hello's map fields, exactly as `Multiplayer` builds them. */
function helloMap (world: World): { voids: number[][], walls: number[][] } {
  return {
    voids: World.TAGS.map((tag) => world.VOID_RUNS.get(tag) ?? world.unheldRuns(tag)),
    walls: World.TAGS.map((tag) => world.WALL_RUNS.get(tag) ?? [])
  }
}

function digest (world: World): string {
  return createHash('sha256').update(JSON.stringify({ ...helloMap(world), gates: sites(world) })).digest('hex')
}

test('two private worlds on one map hold the same void and wall Sets and run arrays; their BLOCKED and gates are their own', () => {
  const map = new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)
  const a = build(map).world
  const b = build(map).world
  for (const tag of HELD) {
    const voids = a.VOIDS.get(tag)
    const walls = a.WALLS.get(tag)
    assert.ok(voids instanceof FrozenSet && voids.size > 0, `layer ${tag}: no shared valleys`)
    assert.ok(walls instanceof FrozenSet && walls.size > 0, `layer ${tag}: no shared walls`)
    assert.equal(b.VOIDS.get(tag), voids, `layer ${tag}: the valleys are not the same Set`)
    assert.equal(b.WALLS.get(tag), walls, `layer ${tag}: the walls are not the same Set`)
    assert.equal(b.VOID_RUNS.get(tag), a.VOID_RUNS.get(tag))
    assert.equal(b.WALL_RUNS.get(tag), a.WALL_RUNS.get(tag))
    assert.equal(map.template?.voids.get(tag), voids, 'the world that generated the map holds the template too')

    // BLOCKED: one each (the generating world's a plain Map, a later one's an
    // overlay on the shared terrain), the same static cells: every void and wall, nothing else.
    const blockedA = a.BLOCKED.get(tag)
    const blockedB = b.BLOCKED.get(tag)
    assert.ok(blockedA !== undefined && blockedB !== undefined)
    assert.notEqual(blockedA, blockedB, `layer ${tag}: BLOCKED is shared`)
    assert.deepEqual([...blockedB.keys()].sort(), [...blockedA.keys()].sort())
    assert.equal(blockedA.size, voids.size + walls.size)
    for (const key of blockedA.keys()) assert.ok(voids.has(key) || walls.has(key))
  }
  assert.equal(a.VOIDS.get(BOTTOM), undefined)
  assert.equal(b.BLOCKED.get(BOTTOM), undefined)

  // Gates: the same sites, separate objects (per-world ids).
  assert.deepEqual(sites(b), sites(a))
  const objects = new Set(gatesOf(a))
  for (const gate of gatesOf(b)) assert.ok(!objects.has(gate), 'a gate object is shared')

  // A rock (or stone, or body) in one world blocks nothing in the other or the template.
  const free = Hex.mapCells(SIZE).find((c) => !World.run(a, () => World.isBlocked(c.x, c.y, TOP)))
  assert.ok(free !== undefined)
  World.run(a, () => World.block(free.x, free.y, TOP, null))
  assert.equal(World.run(a, () => World.isBlocked(free.x, free.y, TOP)), true)
  assert.equal(World.run(b, () => World.isBlocked(free.x, free.y, TOP)), false, 'a block in one private world reached another')
  assert.equal(map.template?.terrain.get(TOP)?.has(Hex.key(free.x, free.y)), false, 'a block reached the template')
  // The same from a world that took the template (the generating world `a` always
  // keeps its own BLOCKED, so only a later world can share the template's by mistake).
  const c = build(map).world
  World.run(b, () => World.block(free.x, free.y, TOP, null))
  assert.equal(World.run(b, () => World.isBlocked(free.x, free.y, TOP)), true)
  assert.equal(World.run(c, () => World.isBlocked(free.x, free.y, TOP)), false, 'a block in a later private world reached another')
  assert.equal(map.template?.terrain.get(TOP)?.has(Hex.key(free.x, free.y)), false, 'a block in a later private world reached the template')
})

test('the shared map is read-only: writing its Sets or run arrays throws, in every world', () => {
  const map = new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)
  const a = build(map).world
  const b = build(map).world
  for (const world of [a, b]) {
    for (const tag of HELD) {
      for (const set of [world.VOIDS.get(tag), world.WALLS.get(tag)] as Array<Set<number>>) {
        const size = set.size
        const [inside] = set
        assert.throws(() => set.add(-123456), TypeError)
        assert.throws(() => set.delete(inside), TypeError)
        assert.throws(() => { set.clear() }, TypeError)
        assert.equal(set.size, size)
        assert.ok(set.has(inside))
      }
      for (const runs of [world.VOID_RUNS.get(tag), world.WALL_RUNS.get(tag)] as number[][]) {
        const copy = [...runs]
        assert.throws(() => runs.push(1), TypeError)
        assert.throws(() => { runs.length = 0 }, TypeError)
        assert.deepEqual(runs, copy)
      }
    }
  }
  // Reading through World's statics, as the game does, works.
  World.run(b, () => {
    const [key] = b.VOIDS.get(TOP) as Set<number>
    const cell = Hex.mapCells(SIZE).find((c) => Hex.key(c.x, c.y) === key)
    assert.ok(cell !== undefined && World.isVoid(cell.x, cell.y, TOP) && World.isBlocked(cell.x, cell.y, TOP))
  })
})

test('a default world and a partial world without a map are unchanged: their own plain, writable Sets', () => {
  for (const layers of [undefined, HELD]) {
    const { world } = build(undefined, layers, 4000)
    const voids = world.VOIDS.get(TOP) as Set<number>
    assert.ok(!(voids instanceof FrozenSet))
    assert.ok(!(world.WALLS.get(TOP) instanceof FrozenSet))
    assert.ok(!Object.isFrozen(world.VOID_RUNS.get(TOP)))
    const other = build(undefined, layers, 4000).world
    assert.notEqual(other.VOIDS.get(TOP), voids)
    assert.notDeepEqual(helloMap(other), helloMap(world), 'two random maps came out equal')
  }
})

test('the map comes from its seed alone: built twice from clean state, whatever Math.random does, the same hello and gates; pinned', (t: TestContext) => {
  const first = build(new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)).world
  // Another sequence of Math.random for the second build: the map must not draw from it.
  const lcg = seeded(99)
  t.mock.method(Math, 'random', lcg)
  const second = build(new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)).world
  t.mock.restoreAll()
  assert.equal(JSON.stringify(helloMap(second)), JSON.stringify(helloMap(first)), 'hello voids/walls differ')
  assert.deepEqual(sites(second), sites(first))
  // And a later world on the second map (the template path) sends the same.
  const map = new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)
  build(map)
  assert.equal(digest(build(map).world), digest(first))

  // Another seed is another map.
  assert.notEqual(digest(build(new PrivateMap(PRIVATE_MAP_SEED + 1, PRIVATE_SIDES)).world), digest(first))
  assert.equal(digest(first), DIGEST, 'the private map changed: a new map for every player is a release (see DIGEST)')
})

test('building on a map draws nothing from Math.random, generating or not', (t: TestContext) => {
  const map = new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)
  const random = t.mock.method(Math, 'random')
  build(map)
  assert.equal(random.mock.callCount(), 0, 'the generating world drew from Math.random')
  build(map)
  assert.equal(random.mock.callCount(), 0, 'a template world drew from Math.random')
})

test('the private map places every gate its layers ask for: down portals and exits on 0, up portals, pads to -2 and exits on -1', () => {
  const world = build(new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)).world
  const [top, middle] = World.LAYERS
  const gates = gatesOf(world)
  const count = (tag: number, kind: string, to?: number): number => gates.filter((g) => g.tag === tag &&
    (kind === 'exit' ? g instanceof Exit : (kind === 'pad') === (g instanceof HandoffGate) && !(g instanceof Exit) && g.to === to)).length
  assert.equal(count(TOP, 'portal', MIDDLE), top.portalsDown)
  assert.equal(count(TOP, 'exit'), top.exits)
  assert.equal(count(MIDDLE, 'portal', TOP), middle.portalsUp)
  assert.equal(count(MIDDLE, 'pad', BOTTOM), middle.portalsDown)
  assert.equal(count(MIDDLE, 'exit'), middle.exits)
  assert.equal(gates.length, top.portalsDown + top.exits + middle.portalsUp + middle.portalsDown + middle.exits)
})

test('layer 01 is played on its side of the map only: void outside it, its spawns and refill inside; 02 on the whole map', () => {
  const { world } = build(new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES))
  const side = PRIVATE_SIDES.get(TOP) as number
  assert.ok(side < SIZE)
  assert.equal(world.sideOf(TOP), side)
  assert.equal(world.sideOf(MIDDLE), SIZE)
  const voids = world.VOIDS.get(TOP) as Set<number>
  let outside = 0
  for (const cell of Hex.mapCells(SIZE)) {
    if (Hex.onMap(cell.x, cell.y, side)) continue
    outside++
    assert.ok(voids.has(Hex.key(cell.x, cell.y)), `layer 01 cell ${cell.x},${cell.y} outside its side is not void`)
  }
  assert.ok(outside > 0)
  // Ground on 02 outside 01's square: 02 really is the bigger layer.
  const middleVoids = world.VOIDS.get(MIDDLE) as Set<number>
  assert.ok(Hex.mapCells(SIZE).some((c) => !Hex.onMap(c.x, c.y, side) && !middleVoids.has(Hex.key(c.x, c.y))))
  World.run(world, () => {
    for (let i = 0; i < 200; i++) {
      const { cell, fallback } = World.spawnCell(TOP)
      assert.ok(Hex.onMap(cell.x, cell.y, side) && !fallback, `spawn ${cell.x},${cell.y} outside 01's side, or a fallback`)
    }
    for (let i = 0; i < 32; i++) world.update(0)
    for (const unit of [...world.MOBS, ...world.CONSUMABLES, ...world.ITEMS, ...world.GEAR, ...world.PLAYERS]) {
      if (unit.tag !== TOP) continue
      const cell = Hex.toCell(unit.position)
      assert.ok(Hex.onMap(cell.x, cell.y, side), `layer 01 object at ${cell.x},${cell.y} is outside its side`)
    }
  })
})

test('one map is one size and one set of layers: another asks throws', () => {
  const map = new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)
  build(map)
  assert.throws(() => build(map, HELD, 4000), /built for/)
  assert.throws(() => build(map, [TOP]), /built for/)
  assert.throws(() => World.build(SIZE, { multiplayer: new Multiplayer(250, redisStub()), layers: HELD, padsUp: true, map }), /built for/)
})

test('hello sends the shared map; mobs and loot still spawn at random per world', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const map = new PrivateMap(PRIVATE_MAP_SEED, PRIVATE_SIDES)
  const worlds = [build(map), build(map)]
  const hellos: Array<Record<string, unknown>> = []
  for (const { world, mp } of worlds) {
    World.run(world, () => {
      const handlers: Record<string, (data?: unknown) => void> = {}
      const socket = {
        id: 's' + hellos.length,
        handshake: { query: { frames: '1' } },
        on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
        emit: (event: string, data: Record<string, unknown>) => { if (event === 'hello') hellos.push(data); return true },
        conn: { write: () => {} }
      } as unknown as Socket
      mp.onConnect(socket)
      handlers.start_requested({ id: 'abc12' + hellos.length, name: 'p' })
      for (let tick = 0; tick < 40; tick++) {
        t.mock.timers.tick(250)
        world.update(0.25)
      }
    })
  }
  assert.equal(hellos.length, 2)
  assert.equal(JSON.stringify(hellos[1].voids), JSON.stringify(hellos[0].voids))
  assert.equal(JSON.stringify(hellos[1].walls), JSON.stringify(hellos[0].walls))
  assert.deepEqual(hellos[0].voids, helloMap(worlds[0].world).voids)
  const spots = (world: World): string => JSON.stringify([...world.CONSUMABLES, ...world.MOBS].map((o) => [o.tag, o.position.x, o.position.y]))
  assert.ok(worlds[0].world.CONSUMABLES.length > 0 && worlds[0].world.MOBS.length > 0, 'nothing spawned')
  assert.notEqual(spots(worlds[1].world), spots(worlds[0].world), 'two private worlds spawned the same loot and mobs')
})
