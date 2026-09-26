import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph at an objects/ file leaves
// GameObject undefined, so go in through multiplayer the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import { Unit } from './unit'
import { type GameObject, ObjectType } from './gameobject'
import Throwable from './throwable'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'

/**
 * Projectiles and the world's tick, driven through the real `World.update`.
 *
 * They used to live in `World.OBSTACLES`, which had two effects nobody wanted:
 * a projectile that exploded spliced itself out of the list the tick was
 * walking, so the entry after it skipped a tick of movement; and every live
 * projectile counted toward the 300-obstacle refill, so rocks went missing
 * while anything was in flight.
 */

const DT = 0.25

const SKILLS = [
  { name: 'fireball', make: (owner: Unit) => new ThrowFireball(owner) },
  { name: 'icicle', make: (owner: Unit) => new Throwicicle(owner) }
]

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop
  } as unknown as Multiplayer

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

function playerAt (x: number, y: number): Player {
  const player = new Player(x, y, 0, `p${x}-${y}`)
  World.PLAYERS.push(player)
  return player
}

function castFrom (make: (owner: Unit) => { execute: () => boolean }, owner: Unit): Throwable {
  const before = new Set(World.PROJECTILES)
  assert.equal(make(owner).execute(), true, 'the skill refused to cast')
  const added = World.PROJECTILES.filter((p) => !before.has(p))
  assert.equal(added.length, 1, 'expected exactly one new projectile')
  return added[0]
}

/**
 * A caster facing East (the default facing) with a mob placed so the
 * projectile strikes it on its first tick of flight. DELIBERATE CHANGE
 * (hex-cells P3, #34): it was 1000 + 56 + 75 + 9, a spot the 50-unit disc
 * overlapped after one 75-unit move from a 56-unit spawn. The front now
 * crosses line cells 1-4 on the first tick, so the mob stands on cell 4.
 */
function hitterAndMob (): { caster: Player, mob: Unit } {
  const home = Hex.toCell(new Vector(1000, 2000))
  const at = Hex.toPosition(home)
  const caster = playerAt(at.x, at.y)
  const cell4 = Hex.toPosition(new Vector(home.x + 4, home.y))
  const mob = new Unit(ObjectType.Mob, cell4.x, cell4.y, 10, 0)
  mob.hp = 1000
  World.MOBS.push(mob)
  return { caster, mob }
}

/**
 * A real World to tick, minus the portals and exits its constructor drops at
 * random cells (30 and 12 since `three-ground-layers`; 20 and 8 when this was
 * written). Since decision #26 a portal no longer moves a mob, so the flake
 * below cannot happen that way any more; a solid portal next to the target
 * could still push it off its spot, so the gates stay out.
 *
 * Those made the explode-order tests below flaky (1 suite run in 46, then 1 in
 * 75, on 2026-09-24; the replay rate below predicts about 1 in 30): a plane-0
 * Portal landing within 60 units (its radius 50 + the mob's 10) of the target
 * mob collided with it in the mob's own update, which runs before projectiles
 * fly, and `Portal.onCollide` moved the mob to plane -1, so the projectile on
 * plane 0 flew through it ("the setup projectile never hit"). Measured over
 * 10,000 replays: 85 misses, all 85 with the mob's tag flipped, no flip that
 * still hit. The refill at the end of `update` runs after the projectiles, so
 * nothing it places can reach them this tick.
 */
function worldWithoutPortals (): World {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  return world
}

for (const skill of SKILLS) {
  for (const hitterFirst of [true, false]) {
    const order = hitterFirst ? 'before' : 'after'
    test(`a ${skill.name} that explodes does not cost the one cast ${order} it a tick of movement`, () => {
      const world = worldWithoutPortals()
      const { caster } = hitterAndMob()
      const flyer = playerAt(3000, 1000)

      let hitter: Throwable
      let other: Throwable
      if (hitterFirst) {
        hitter = castFrom(skill.make, caster)
        other = castFrom(skill.make, flyer)
      } else {
        other = castFrom(skill.make, flyer)
        hitter = castFrom(skill.make, caster)
      }
      const from = other.position

      world.update(DT)

      assert.equal(hitter.destroyed, true, 'the setup projectile never hit')
      assert.equal(other.destroyed, false, 'the free projectile hit something')
      // DELIBERATE CHANGE (hex-cells P3, #34): was 300 * DT. The step is a
      // fixed 5/3 cells a tick, 75 units along an axis at any dt (the same 75
      // at the default 250 ms tick). The flyer never moved, so it flies East.
      const step = Throwable.STEP / 3 * Hex.SIZE
      assert.ok(Math.abs(other.position.x - from.x - step) < 1e-6,
        `the free projectile moved ${(other.position.x - from.x).toFixed(1)} units, not ${step}`)
      assert.deepEqual(World.PROJECTILES, [other], 'the exploded projectile is still listed')
    })
  }

  test(`${skill.name}s in flight do not count toward the rock refill`, () => {
    const world = new World(4000)
    for (let i = 0; i < 3; i++) castFrom(skill.make, playerAt(500 + 1000 * i, 3000))
    assert.equal(World.PROJECTILES.length, 3)

    world.update(DT)

    // DELIBERATE CHANGE (decision #26, `three-ground-layers`): the refill was a
    // world-wide 300 that counted the gates; it is now LAYERS' rocks per layer,
    // counting rocks only.
    for (const layer of World.LAYERS) {
      const rocks = World.OBSTACLES.filter((o) => o.tag === layer.tag && World.isRock(o))
      assert.equal(rocks.length, layer.rocks, `the refill stopped short on layer ${layer.tag}`)
    }
    assert.equal(World.OBSTACLES.some((o) => o.type === ObjectType.Throwable), false,
      'a projectile is in the obstacle list')
  })

  test(`a ${skill.name} exploding without being listed removes nothing else`, () => {
    // A rock that a splice at indexOf === -1 (the last entry) would take.
    const rock = { type: ObjectType.Obstacle } as unknown as GameObject
    World.OBSTACLES.push(rock)
    const caster = playerAt(1000, 2000)
    const cast = skill.make(caster)
    const stray = { position: caster.position, tag: 0 } as unknown as GameObject

    cast.explode(stray)

    assert.deepEqual(World.OBSTACLES, [rock])
    assert.deepEqual(World.PROJECTILES, [])
  })

  test(`a ${skill.name} in flight is in a joining player's snapshot`, async () => {
    const projectile = castFrom(skill.make, playerAt(1000, 2000))
    let sent = 0
    const serialise = projectile.serialiseBinary.bind(projectile)
    projectile.serialiseBinary = (fields) => { sent++; return serialise(fields) }

    const handlers: string[] = []
    const socket = { id: 'joiner', on: (event: string) => { handlers.push(event) }, emit: () => {} }
    const connection = { socket, player: undefined, get id () { return 'joiner' } }
    const fake = Object.assign(Object.create(Multiplayer.prototype), {
      tickLengthMs: 250, _buffer: {}, flush: () => {}
    })

    await Multiplayer.prototype.onStart.call(fake, connection, 'joiner')

    assert.equal(sent, 1, 'the projectile was not sent to the joining player')
  })
}
