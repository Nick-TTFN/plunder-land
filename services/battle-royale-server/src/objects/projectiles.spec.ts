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
import type Throwable from './throwable'
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
 * projectile overlaps it after exactly one tick of flight: it spawns 56 units
 * ahead and moves 75, and the mob is 9 units beyond that, well inside 50 + 10.
 */
function hitterAndMob (): { caster: Player, mob: Unit } {
  const caster = playerAt(1000, 2000)
  const mob = new Unit(ObjectType.Mob, 1000 + 56 + 75 + 9, 2000, 10, 0)
  mob.hp = 1000
  World.MOBS.push(mob)
  return { caster, mob }
}

for (const skill of SKILLS) {
  for (const hitterFirst of [true, false]) {
    const order = hitterFirst ? 'before' : 'after'
    test(`a ${skill.name} that explodes does not cost the one cast ${order} it a tick of movement`, () => {
      const world = new World(4000)
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
      assert.ok(Math.abs(other.position.x - from.x - 300 * DT) < 1e-6,
        `the free projectile moved ${(other.position.x - from.x).toFixed(1)} units, not ${300 * DT}`)
      assert.deepEqual(World.PROJECTILES, [other], 'the exploded projectile is still listed')
    })
  }

  test(`${skill.name}s in flight do not count toward the rock refill`, () => {
    const world = new World(4000)
    for (let i = 0; i < 3; i++) castFrom(skill.make, playerAt(500 + 1000 * i, 3000))
    assert.equal(World.PROJECTILES.length, 3)

    world.update(DT)

    const solid = World.OBSTACLES.filter((o) => o.type !== ObjectType.Throwable)
    assert.equal(solid.length, 300, 'the refill stopped short by the projectiles in flight')
    assert.equal(World.OBSTACLES.length, 300, 'a projectile is in the obstacle list')
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
