import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph at an objects/ file leaves
// GameObject undefined, so go in through multiplayer the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Player from './player'
import { Unit } from './unit'
import { ObjectType } from './gameobject'
import type Throwable from './throwable'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'

/**
 * Fireball and icicle used to detonate on their own caster on the first tick:
 * they spawn `radius * 4` ahead, inside the caster's obstacle push-out reach,
 * and a Throwable sat in that push-out as if it were a rock. These drive the
 * real skills through the world's own update order and measure how far the
 * projectile gets.
 */

/** The server tick, TICK_MS's default. */
const DT = 0.25
/** Both skills use a 3000 ms lifetime; tick until just short of it. */
const FLIGHT_TICKS = Math.floor(3 / DT) - 1
const FIVE_CELLS = 5 * Hex.SIZE

const SKILLS = [
  { name: 'fireball', make: (owner: Unit) => new ThrowFireball(owner) },
  { name: 'icicle', make: (owner: Unit) => new Throwicicle(owner) }
]

beforeEach(() => {
  // Nothing here is sent anywhere; the objects only need something to report to.
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop
  } as unknown as Multiplayer

  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
})

/** One tick in `World.update`'s order: players, then mobs, then throwables. */
function tick (): void {
  for (const player of World.PLAYERS) player.update(DT)
  for (const mob of World.MOBS) mob.update(DT)
  for (const obj of World.OBSTACLES) {
    if (obj.type === ObjectType.Throwable) obj.update(DT)
  }
}

function playerAt (x: number, y: number): Player {
  const player = new Player(x, y, 0, 'caster')
  World.PLAYERS.push(player)
  return player
}

/** Cast, and return the projectile the cast put in the world. */
function cast (make: (owner: Unit) => { execute: () => boolean }, owner: Unit): Throwable {
  assert.equal(make(owner).execute(), true, 'the skill refused to cast')
  const thrown = World.OBSTACLES.filter((o) => o.type === ObjectType.Throwable)
  assert.equal(thrown.length, 1, 'expected exactly one projectile')
  return thrown[0] as Throwable
}

/**
 * Fly the projectile until it detonates or its lifetime is nearly up, and
 * return how far it got from where it spawned.
 */
function fly (projectile: Throwable): { travelled: number, detonated: boolean } {
  const from = projectile.position
  for (let i = 0; i < FLIGHT_TICKS && !projectile.destroyed; i++) tick()

  const detonated = projectile.destroyed
  const travelled = projectile.position.sub(from).getMagnitude()
  // Clears the skill's lifetime setTimeout, so the test process can exit.
  if (!detonated) projectile.destroy()
  return { travelled, detonated }
}

for (const skill of SKILLS) {
  test(`${skill.name} from a walking player flies more than five cells`, () => {
    const start = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))
    const player = playerAt(start.x, start.y)
    const cell = player.cell
    player.setDestination(cell.x + 20, cell.y)

    tick() // takes the first step, which is what gives the player a heading
    assert.ok(player.direction.getSquareMagnitude() > 0, 'player is not walking')
    assert.ok(player.path.length > 0, 'player stopped before the cast')

    const { travelled } = fly(cast(skill.make, player))

    assert.ok(travelled > FIVE_CELLS,
      `travelled ${travelled.toFixed(1)}, needed more than ${FIVE_CELLS}`)
    assert.equal(player.hp, player.maxHP(), 'the caster was hurt by their own cast')
  })

  test(`${skill.name} from a standing player flies more than five cells`, () => {
    // A standing player facing east. The server has no facing yet: `stop()`
    // zeroes the heading, and a player with a heading but no path walks. So the
    // heading is set for the cast and the player stops straight after, which
    // is what "last-facing" (fix-direction-on-wire) will give a standing caster.
    // The projectile keeps the vector it was given; `stop()` replaces the
    // player's rather than mutating it.
    const player = playerAt(1000, 2000)
    player.setDirection(1, 0)
    const projectile = cast(skill.make, player)
    player.stop()

    const { travelled } = fly(projectile)

    assert.ok(travelled > FIVE_CELLS,
      `travelled ${travelled.toFixed(1)}, needed more than ${FIVE_CELLS}`)
    assert.equal(player.position.x, 1000, 'the caster was shoved by their own projectile')
    assert.equal(player.hp, player.maxHP(), 'the caster was hurt by their own cast')
  })

  test(`${skill.name} from a stopped player with no heading does not hit its caster`, () => {
    // Direction (0,0): the projectile spawns on the caster's own centre and
    // never moves. Where it should aim belongs to fix-direction-on-wire; this
    // only pins down that it no longer detonates on the unit that threw it.
    const player = playerAt(1000, 2000)
    assert.equal(player.direction.getSquareMagnitude(), 0)

    const projectile = cast(skill.make, player)
    const { travelled, detonated } = fly(projectile)

    assert.equal(detonated, false, 'detonated on its own caster')
    assert.equal(travelled, 0)
    assert.equal(player.hp, player.maxHP(), 'the caster was hurt by their own cast')
  })

  test(`${skill.name} still detonates on a unit in its path, and damages it`, () => {
    // Taking projectiles out of the push-out took away the only thing that
    // used to detect a hit, so check the new hit test actually finds one.
    const player = playerAt(1000, 2000)
    const target = new Unit(ObjectType.Mob, 1000 + 8 * Hex.SIZE, 2000, 10, 0)
    target.hp = 100
    World.MOBS.push(target)

    player.setDirection(1, 0)
    const projectile = cast(skill.make, player)
    player.stop()

    const { detonated } = fly(projectile)

    assert.equal(detonated, true, 'flew through the target')
    const reach = projectile.radius + target.radius
    assert.ok(projectile.position.sub(target.position).getMagnitude() < reach,
      'detonated somewhere other than on the target')
    assert.ok(target.hp < 100, 'target took no damage')
    assert.equal(player.hp, player.maxHP(), 'the caster was hurt by their own cast')
  })
}

test('a projectile is not an obstacle: units walk through it undisplaced', () => {
  // The push-out half of the fix on its own. Hopper wants the same thing.
  const player = playerAt(1000, 2000)
  player.setDirection(1, 0)
  const projectile = cast(SKILLS[0].make, player)
  player.stop()

  // Park it on top of the caster, where a solid one would shove them.
  projectile.direction = new Vector(0, 0)
  projectile.position = new Vector(1010, 2000)

  tick()

  assert.equal(player.position.x, 1000)
  assert.equal(player.position.y, 2000)
  assert.equal(projectile.destroyed, false)
  projectile.destroy()
})
