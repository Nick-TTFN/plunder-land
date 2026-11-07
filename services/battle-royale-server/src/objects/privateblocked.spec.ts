import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import Obstacle from './obstacle'
import { CellOverlay, FrozenCells, PRIVATE_MAP_SEED, PrivateMap } from './privatemap'
import { StoneWall } from '../skills/stonewall'
import { ITEMS } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * private-10: a private world's `BLOCKED` is a `CellOverlay` per layer on the
 * private map's terrain, one frozen base per layer shared by every private
 * world (`privatemap.ts`). Shared and default worlds keep plain Maps.
 */

const [TOP, MIDDLE] = World.TAGS
const SIZE = 2000
const HELD = [TOP, MIDDLE]

function redisStub (): Redis {
  const redis = { on: () => redis, hincrby: async () => 1 } as unknown as Redis
  return redis
}

function build (map: PrivateMap | undefined, layers: readonly number[] | undefined = HELD, size = SIZE): World {
  return World.build(size, { multiplayer: new Multiplayer(250, redisStub()), layers, map })
}

/** A base (terrain) cell of `world`'s layer `tag`: a void one. */
function terrainCell (world: World, tag: number): Vector {
  const [key] = world.VOIDS.get(tag) as Set<number>
  const cell = Hex.mapCells(SIZE).find((c) => Hex.key(c.x, c.y) === key)
  assert.ok(cell !== undefined)
  return cell
}

function overlay (world: World, tag: number): CellOverlay<unknown> {
  const cells = world.BLOCKED.get(tag)
  assert.ok(cells instanceof CellOverlay, `layer ${tag} is not an overlay`)
  return cells
}

test('two private worlds share one frozen terrain base per layer; a stone in one blocks nothing in the other, the template or the generating world', () => {
  const map = new PrivateMap(PRIVATE_MAP_SEED)
  const a = build(map) // generates the map, keeps its own plain BLOCKED
  const b = build(map)
  const c = build(map)
  for (const tag of HELD) {
    const base = map.template?.terrain.get(tag)
    assert.ok(base instanceof FrozenCells && base.size > 0, `layer ${tag}: no frozen terrain`)
    assert.ok(overlay(b, tag).base === base, `layer ${tag}: world b holds a copy of the terrain, not the template's`)
    assert.ok(overlay(c, tag).base === base, `layer ${tag}: world c holds a copy of the terrain, not the template's`)
    assert.ok(overlay(b, tag) !== overlay(c, tag), `layer ${tag}: two worlds share one overlay`)
    assert.ok(a.BLOCKED.get(tag) instanceof Map && !(a.BLOCKED.get(tag) instanceof FrozenCells))
    // Same cells, read through the overlay.
    assert.equal(overlay(b, tag).size, base.size)
    assert.deepEqual([...overlay(b, tag).keys()].sort(), [...base.keys()].sort())
  }

  const free = Hex.mapCells(SIZE).find((cell) => !World.run(b, () => World.isBlocked(cell.x, cell.y, TOP)))
  assert.ok(free !== undefined)
  const key = Hex.key(free.x, free.y)
  const size = map.template?.terrain.get(TOP)?.size
  const stone = World.run(b, () => {
    const at = Hex.toPosition(free)
    const obstacle = new Obstacle(at.x, at.y, TOP, 4000)
    World.addObstacle(obstacle)
    return obstacle
  })
  assert.equal(World.run(b, () => World.isBlocked(free.x, free.y, TOP)), true)
  assert.ok(b.BLOCKED.get(TOP)?.get(key) === stone, 'BLOCKED does not name the stone')
  assert.equal(World.run(c, () => World.isBlocked(free.x, free.y, TOP)), false, 'a stone in one private world blocks another')
  assert.equal(World.run(a, () => World.isBlocked(free.x, free.y, TOP)), false, 'a stone in a private world blocks the generating world')
  assert.equal(map.template?.terrain.get(TOP)?.has(key), false, 'a stone reached the template')
  assert.equal(map.template?.terrain.get(TOP)?.size, size)

  World.run(b, () => { stone.destroy(); World.removeObstacle(stone) })
  assert.equal(World.run(b, () => World.isBlocked(free.x, free.y, TOP)), false, 'the stone\'s cell stayed blocked')
})

test('a write to a terrain cell throws, through World.block/unblock and directly, and changes nothing', () => {
  const map = new PrivateMap(PRIVATE_MAP_SEED)
  build(map)
  const b = build(map)
  for (const tag of HELD) {
    const cell = terrainCell(b, tag)
    const key = Hex.key(cell.x, cell.y)
    const cells = overlay(b, tag)
    const base = cells.base as FrozenCells<unknown>
    World.run(b, () => {
      assert.throws(() => { World.block(cell.x, cell.y, tag, null) }, TypeError)
      assert.throws(() => { World.unblock(cell.x, cell.y, tag) }, TypeError)
      assert.equal(World.isBlocked(cell.x, cell.y, tag), true)
    })
    assert.throws(() => cells.set(key, null), TypeError)
    assert.throws(() => cells.delete(key), TypeError)
    assert.throws(() => base.set(key, null), TypeError)
    assert.throws(() => base.set(-123456, null), TypeError)
    assert.throws(() => base.delete(key), TypeError)
    assert.throws(() => { base.clear() }, TypeError)
    assert.ok(base.has(key) && cells.has(key) && cells.get(key) === null)
    assert.equal(base.has(-123456), false)
  }
})

test('in a private world a StoneWall\'s stones block their cells, and a bomb\'s blast frees them (the real bomb.ts path)', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const map = new PrivateMap(PRIVATE_MAP_SEED)
  build(map)
  const b = build(map)
  World.run(b, () => {
    // A caster facing direction 0 whose three cells behind all take a stone.
    const caster = Hex.mapCells(SIZE).map((cell) => {
      if (!World.isClear(cell.x, cell.y, TOP, 4)) return undefined
      const at = Hex.toPosition(cell)
      const player = new Player(at.x, at.y, TOP, 'caster')
      player.facing = Hex.toPosition(Hex.DIRECTIONS[0]).normalised()
      if (!StoneWall.cells(player).every((c) => StoneWall.canPlace(c, TOP))) return undefined
      return player
    }).find((p) => p !== undefined)
    assert.ok(caster !== undefined, 'no free spot for a wall')
    World.addUnit(World.PLAYERS, caster)
    const cells = StoneWall.cells(caster)
    assert.equal(new StoneWall(caster).execute(), true)
    for (const cell of cells) {
      assert.equal(World.isBlocked(cell.x, cell.y, TOP), true, 'a stone does not block its cell')
      assert.ok(World.BLOCKED.get(TOP)?.get(Hex.key(cell.x, cell.y)) instanceof Obstacle)
    }
    assert.equal(map.template?.terrain.get(TOP)?.has(Hex.key(cells[1].x, cells[1].y)), false, 'a stone reached the template')

    // The bomb on the middle stone, thrown by the caster through the real item path.
    assert.ok(caster.addItem(ITEMS.bomb))
    const fuse = ITEMS.bomb.use.kind === 'bomb' ? ITEMS.bomb.use.fuseMs : 0
    assert.equal(caster.tryUseItem(1, cells[1]), true)
    t.mock.timers.tick(fuse + 1)
    Timers.run(Date.now())
    for (const cell of cells) {
      assert.equal(World.isBlocked(cell.x, cell.y, TOP), false, 'the blast left a stone\'s cell blocked')
    }
    assert.equal(World.OBSTACLES.filter((o) => o instanceof Obstacle && !World.isRock(o)).length, 0)
  })
})

test('shared and default worlds, and the world that generates the private map, hold plain Maps', () => {
  const plain = (world: World, what: string): void => {
    assert.ok(world.BLOCKED.size > 0, `${what}: nothing blocked`)
    for (const [tag, cells] of world.BLOCKED) {
      assert.ok(Object.getPrototypeOf(cells) === Map.prototype, `${what}: layer ${tag} is not a plain Map`)
    }
  }
  plain(build(undefined, undefined, 4000), 'a default world')
  plain(build(undefined, HELD, 4000), 'a partial world')
  plain(build(new PrivateMap(PRIVATE_MAP_SEED)), 'the generating world')
})
