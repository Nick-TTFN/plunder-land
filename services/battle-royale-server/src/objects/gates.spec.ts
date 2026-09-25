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
import { ARCHETYPES, LAYERS, type LayerSpec } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * `gate-hygiene`: rocks stay off gates, and the spacing between gates follows
 * the largest robot. (The third part, a portal hop ending the route on both
 * sides, is in extract.spec.ts beside the client mirror it needs.)
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

const robots = Object.values(ARCHETYPES).filter((a) => a.kind === 'robot')

// --- GATE_SPACING -----------------------------------------------------------------

test('GATE_SPACING is derived from the largest robot body in the table', () => {
  const largest = Math.max(...robots.map((a) => a.body))
  assert.equal(World.MAX_ROBOT_BODY, largest)
  assert.equal(World.GATE_SPACING, 2 * (Portal.RADIUS + largest) + World.GATE_MARGIN)
  // Mobs are bigger (the boss is 40) and must not count: portals move players only.
  assert.ok(Math.max(...Object.values(ARCHETYPES).map((a) => a.body)) > largest, 'the table changed: re-read this test')
})

test('today\'s table keeps today\'s spacing, 150', () => {
  // If a new robot moves this, that is the derivation working: update the
  // number here and in CLAUDE.md's layers paragraph.
  assert.equal(World.GATE_SPACING, 150)
})

for (const robot of robots) {
  test(`GATE_SPACING holds for a ${robot.key} (body ${robot.body})`, () => {
    // Where a portal puts it down, from the portal's centre.
    const arrival = Portal.RADIUS + robot.body
    // Another portal a player could meet there must not catch them on arrival.
    assert.ok(World.GATE_SPACING - arrival >= Portal.RADIUS + robot.body,
      `lands ${World.GATE_SPACING - arrival} from the next portal, which reaches ${Portal.RADIUS + robot.body}`)
    // No exit's cell (no cell reaches past Hex.SIZE from its centre) contains
    // the arrival spot, and nothing standing on an exit's cell touches a portal.
    assert.ok(World.GATE_SPACING - arrival > Hex.SIZE,
      `lands ${World.GATE_SPACING - arrival} from an exit, inside its cell`)
  })
}

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

test('today\'s table keeps rocks two rings from a gate', () => {
  // The derivation (World.GATE_ROCK_RINGS) for a peep: 50 + 14 + 14 + 22.5 =
  // 100.5 is past two steps (78) and inside three (119).
  assert.equal(World.GATE_ROCK_RINGS, 2)
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

for (const robot of robots) {
  test(`a ${robot.key} held against a portal, or put down by one, never overlaps a rock the refill could place`, () => {
    // Brute force rather than the ring arithmetic World uses: walk the circle
    // a player stands on (Portal.RADIUS + body from the portal's centre) and
    // find every cell whose rock collider (Hex.RADIUS) would reach them.
    const gate = new Vector(40, 40)
    const centre = Hex.toPosition(gate)
    const arrival = Portal.RADIUS + robot.body
    const touch = Hex.RADIUS + robot.body
    let furthest = 0
    for (let step = 0; step < 720; step++) {
      const angle = (step / 720) * 2 * Math.PI
      const spot = new Vector(centre.x + arrival * Math.cos(angle), centre.y + arrival * Math.sin(angle))
      const near = Hex.toCell(spot)
      for (let dq = -4; dq <= 4; dq++) {
        for (let dr = -4; dr <= 4; dr++) {
          const cell = new Vector(near.x + dq, near.y + dr)
          if (Hex.toPosition(cell).sub(spot).getMagnitude() >= touch) continue
          furthest = Math.max(furthest, Hex.distance(cell, gate))
        }
      }
    }
    assert.ok(furthest <= World.GATE_ROCK_RINGS,
      `a rock ${furthest} steps from the portal reaches a ${robot.body} body; the keep-out is ${World.GATE_ROCK_RINGS}`)
  })
}
