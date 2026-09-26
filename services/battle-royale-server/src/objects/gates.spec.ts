import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Portal from './portal'
import Exit from './exit'
import Obstacle from './obstacle'
import { type GameObject } from './gameobject'
import { LAYERS, type LayerSpec } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * `gate-hygiene`: rocks stay off gates and portal arrival cells, and gates
 * keep `GATE_SPACING` rings apart. (The third part, a portal hop ending the
 * route on both sides, is in extract.spec.ts beside the client mirror it
 * needs.)
 */

beforeEach(() => {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  // eslint-disable-next-line no-new
  new Multiplayer(250, redis)
  reset()
})

function reset (): void {
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
}

// --- GATE_SPACING -----------------------------------------------------------------

test('GATE_SPACING is 4 rings and GATE_ROCK_RINGS 2, as constants (decision #34)', () => {
  // Both were derived from push-out radii (Portal.RADIUS, the largest robot
  // body) until hex-cells P2 deleted push-out. 4 rings is what the old 150
  // units came to on cell centres; the keep-out came to 2 then too.
  assert.equal(World.GATE_SPACING, 4)
  assert.equal(World.GATE_ROCK_RINGS, 2)
})

test('every portal\'s arrival cell is on the map, and no gate is on it or next to it on the layer it leads to, over 20 random worlds', () => {
  let portals = 0
  for (let w = 0; w < 20; w++) {
    reset()
    // eslint-disable-next-line no-new
    new World(4000)
    const gates = World.OBSTACLES.filter(isGate)
    for (const portal of gates.filter((g): g is Portal => g instanceof Portal)) {
      portals++
      const arrival = World.arrivalOf(Hex.toCell(portal.position))
      assert.ok(Hex.onMap(arrival.x, arrival.y, World.mapSize), 'an arrival cell is off the map')
      assert.equal(World.isArrival(arrival.x, arrival.y, portal.to), true)
      for (const gate of gates) {
        if (gate.tag !== portal.to) continue
        const d = Hex.distance(Hex.toCell(gate.position), arrival)
        assert.ok(d >= 2, `a gate ${d} ring(s) from a portal's arrival cell on layer ${portal.to}`)
      }
    }
  }
  assert.ok(portals >= 20 * 25, `only ${portals} portals placed`)
})

// --- rocks off gates --------------------------------------------------------------

type Refill = (layer: LayerSpec) => void

function refillOf (world: World): Refill {
  const refill = (world as unknown as { refillLayer: Refill }).refillLayer
  return (layer) => { refill.call(world, layer) }
}

function isGate (obj: GameObject): obj is Portal | Exit {
  return obj instanceof Portal || obj instanceof Exit
}

/**
 * The cells a rock on `tag` must stay `GATE_ROCK_RINGS` clear of, worked out
 * here from the gates rather than read from `World.gateKeepOut`: each gate on
 * the layer, and each portal elsewhere that puts players down on it.
 */
function guarded (tag: number): Vector[] {
  return World.OBSTACLES
    .filter((g) => isGate(g) && (g.tag === tag || (g instanceof Portal && g.to === tag)))
    .map((g) => Hex.toCell(g.position))
}

function assertClearOfGates (rock: GameObject): void {
  const cell = Hex.toCell(rock.position)
  for (const gate of guarded(rock.tag)) {
    const d = Hex.distance(cell, gate)
    assert.ok(d > World.GATE_ROCK_RINGS,
      `a rock on layer ${rock.tag} at (${cell.x}, ${cell.y}) is ${d} cell(s) from a gate at (${gate.x}, ${gate.y})`)
  }
}

test('no rock lands on a gate, or within GATE_ROCK_RINGS of one, over 10,000 refills across 10 random layouts', () => {
  const WORLDS = 10
  const REFILLS = 1000
  let placed = 0
  let refills = 0

  for (let w = 0; w < WORLDS; w++) {
    reset()
    const world = new World(4000)
    const refill = refillOf(world)
    // The first fill, every layer from empty.
    for (const layer of World.LAYERS) refill(layer)
    // The keep-out must not cost the layer its rocks.
    for (const layer of World.LAYERS) {
      assert.equal(World.OBSTACLES.filter((o) => o.tag === layer.tag && World.isRock(o)).length, layer.rocks,
        `layer ${layer.tag} was not filled`)
    }
    for (const rock of World.OBSTACLES.filter(World.isRock)) { assertClearOfGates(rock); placed++ }

    // Then one rock at a time: take a random one away and let the refill
    // replace it, as it would after anything removed a rock.
    for (let n = 0; n < REFILLS; n++) {
      const rocks = World.OBSTACLES.filter(World.isRock)
      const gone = rocks[Math.floor(Math.random() * rocks.length)] as Obstacle
      gone.destroy()
      World.OBSTACLES.splice(World.OBSTACLES.indexOf(gone), 1)
      const before = new Set(World.OBSTACLES)

      refill(World.LAYERS.find((l) => l.tag === gone.tag) as LayerSpec)
      refills++
      const added = World.OBSTACLES.filter((o) => !before.has(o) && World.isRock(o))
      assert.equal(added.length, 1, 'the refill did not replace the rock')
      assertClearOfGates(added[0])
      placed++
    }
  }

  assert.equal(refills, WORLDS * REFILLS)
  assert.ok(placed >= 10_000 + WORLDS * 3 * 136 - WORLDS, `only ${placed} rocks checked`)
})

test('the keep-out covers a portal\'s landing spot on the layer it leads to', () => {
  const rings = World.GATE_ROCK_RINGS
  const disc = 1 + 3 * rings * (rings + 1)
  // One portal on 01 leading to 02; nothing else.
  const at = Hex.toPosition(new Vector(30, 40))
  World.OBSTACLES.push(new Portal(at.x, at.y, LAYERS[1].tag, LAYERS[0].tag))
  const onTop = World.gateKeepOut(LAYERS[0].tag)
  const onMiddle = World.gateKeepOut(LAYERS[1].tag)
  const onBottom = World.gateKeepOut(LAYERS[2].tag)
  assert.equal(onTop.size, disc, 'the portal\'s cell and every cell within the rings')
  assert.deepEqual([...onMiddle].sort(), [...onTop].sort(), 'where it puts players down on 02')
  assert.equal(onBottom.size, 0)
  // Exits count on their own layer only: `to` defaults to 0 on every object,
  // which is layer 01's tag, and must not read as "leads to 01".
  World.OBSTACLES.length = 0
  World.OBSTACLES.push(new Exit(at.x, at.y, LAYERS[1].tag))
  assert.equal(World.gateKeepOut(LAYERS[0].tag).size, 0)
  assert.equal(World.gateKeepOut(LAYERS[1].tag).size, disc)
})

test('the keep-out covers a portal\'s arrival cell and every neighbour of it, on the layer it leads to', () => {
  // A player put down by a portal must not land in a rock, and must be able
  // to walk off in any direction (#34). Brute force over the cells rather
  // than the ring arithmetic World uses.
  const cell = new Vector(40, 40)
  const at = Hex.toPosition(cell)
  World.OBSTACLES.push(new Portal(at.x, at.y, LAYERS[1].tag, LAYERS[0].tag))
  const keepOut = World.gateKeepOut(LAYERS[1].tag)
  const arrival = World.arrivalOf(cell)
  const around = [arrival, ...Hex.DIRECTIONS.map((_, i) => Hex.neighbour(arrival, i))]
  for (const c of around) {
    assert.ok(keepOut.has(Hex.key(c.x, c.y)), `(${c.x}, ${c.y}) by the arrival cell is not kept clear`)
  }
})
