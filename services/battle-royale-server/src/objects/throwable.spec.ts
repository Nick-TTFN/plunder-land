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
import { Dash } from '../skills/dash'
import { RangedAttack } from '../skills/rangedattack'
import { StoneWall } from '../skills/stonewall'
import { IceBreath } from '../skills/icebreath'
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

/**
 * A player on a cell centre who walks `dq` cells along the q axis and comes to
 * rest, through the real `setDestination` and tick. Returns them stopped.
 */
function walkedAndStopped (dq: number): Player {
  const start = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))
  const player = playerAt(start.x, start.y)
  const cell = player.cell
  player.setDestination(cell.x + dq, cell.y)
  assert.ok(player.path.length > 0, 'no route')

  for (let i = 0; i < 40 && player.path.length > 0; i++) tick()

  assert.equal(player.path.length, 0, 'never arrived')
  assert.equal(player.direction.getSquareMagnitude(), 0, 'not stopped')
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

  test(`${skill.name} from a player who walked and stopped flies the way they walked`, () => {
    // A real walk-then-stop, no heading set by hand. West, so the result cannot
    // be the East default a never-moved player gets.
    const player = walkedAndStopped(-3)

    const projectile = cast(skill.make, player)
    const { travelled } = fly(projectile)

    assert.ok(travelled > FIVE_CELLS,
      `travelled ${travelled.toFixed(1)}, needed more than ${FIVE_CELLS}`)
    assert.ok(projectile.position.x < player.position.x - FIVE_CELLS,
      'did not fly west, the way the caster last walked')
    assert.equal(player.hp, player.maxHP(), 'the caster was hurt by their own cast')
  })

  test(`${skill.name} from a player who has never moved flies East`, () => {
    // Replaces the old "(0,0) mine" test: with no heading the projectile used
    // to spawn on the caster's centre and sit there for its whole lifetime.
    const player = playerAt(1000, 2000)
    assert.equal(player.direction.getSquareMagnitude(), 0)

    const projectile = cast(skill.make, player)
    const { travelled, detonated } = fly(projectile)

    assert.equal(detonated, false, 'detonated on its own caster')
    assert.ok(travelled > FIVE_CELLS,
      `travelled ${travelled.toFixed(1)}, needed more than ${FIVE_CELLS}`)
    assert.ok(projectile.position.x > 1000 + FIVE_CELLS, 'did not fly East')
    assert.ok(Math.abs(projectile.position.y - 2000) < 1e-6, 'drifted off the East axis')
    assert.equal(player.position.x, 1000, 'the caster was shoved by their own projectile')
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

for (const dq of [-3, 3]) {
  test(`Dash from a standstill moves the player along their last facing (walked ${dq > 0 ? 'East' : 'West'})`, () => {
    // Dash used to set impulse = direction * 1.5, and a stopped player's
    // direction is (0,0). Now it aims along `facing`, and the no-route branch
    // of Unit.update applies an impulse even with no heading.
    const player = walkedAndStopped(dq)
    const from = player.position

    assert.equal(new Dash(player).execute(), true, 'dash refused to cast')
    for (let i = 0; i < 4; i++) tick()

    const moved = player.position.sub(from)
    assert.ok(Math.sign(moved.x) === Math.sign(dq), `dashed the wrong way: dx ${moved.x.toFixed(1)}`)
    assert.ok(Math.abs(moved.x) > Hex.SIZE, `dashed only ${moved.x.toFixed(1)}`)
    assert.ok(Math.abs(moved.y) < 1e-6, 'dashed off the line it last walked')
    assert.equal(player.impulse.getSquareMagnitude(), 0, 'the dash never decayed')
  })
}

test('Dash from a player who has never moved goes East', () => {
  const player = playerAt(1000, 2000)
  assert.equal(new Dash(player).execute(), true, 'dash refused to cast')
  for (let i = 0; i < 4; i++) tick()

  assert.ok(player.position.x > 1000 + Hex.SIZE, `dashed only to x=${player.position.x.toFixed(1)}`)
  assert.equal(player.position.y, 2000)
})

test('RangedAttack from a stopped player hits along their last facing, not behind', () => {
  const player = walkedAndStopped(-3)
  const at = player.position
  const ahead = new Unit(ObjectType.Mob, at.x - 6 * Hex.SIZE, at.y, 10, 0)
  const behind = new Unit(ObjectType.Mob, at.x + 6 * Hex.SIZE, at.y, 10, 0)
  ahead.hp = behind.hp = 100
  World.MOBS.push(ahead, behind)

  assert.equal(new RangedAttack(player).execute(), true, 'ranged refused to cast')

  assert.ok(ahead.hp < 100, 'missed the unit it was facing')
  assert.equal(behind.hp, 100, 'hit the unit behind it')
})

test('StoneWall from a stopped player is placed by their last facing', (t) => {
  // StoneWall has always put its arc on the side *opposite* the heading
  // (`direction * -70`): a wall behind you. That is unchanged; what is tested
  // is that a stopped caster gets a wall at all, and on that side of the facing.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const player = walkedAndStopped(-3)

  assert.equal(new StoneWall(player).execute(), true, 'stonewall refused to cast')
  const stones = World.OBSTACLES.filter((o) => o.type === ObjectType.Obstacle)
  assert.ok(stones.length > 0, 'no stones placed')

  // Measured against the way they walked (West), not against `player.facing`,
  // so a facing that failed to follow the walk cannot pass by agreeing with
  // itself. Behind a West-walker is East.
  let east = 0
  for (const stone of stones) east += stone.position.x - player.position.x
  assert.ok(east / stones.length > Hex.SIZE / 2,
    `the wall's mean offset east of the caster is ${(east / stones.length).toFixed(1)}`)

  // Let the stones expire now rather than holding the test process open.
  t.mock.timers.tick(3000)
})

test('IceBreath from a stopped player cones along their last facing, not East', (t) => {
  // SectorArea aimed with `direction`, whose angle at (0,0) is 0: every breath
  // from a standstill went East. Walk West so the old East cone misses.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const player = walkedAndStopped(-3)
  const at = player.position
  const ahead = new Unit(ObjectType.Mob, at.x - 3 * Hex.SIZE, at.y, 10, 0)
  const behind = new Unit(ObjectType.Mob, at.x + 3 * Hex.SIZE, at.y, 10, 0)
  ahead.hp = behind.hp = 100
  World.MOBS.push(ahead, behind)

  assert.equal(new IceBreath(player).execute(), true, 'icebreath refused to cast')
  tick() // area effects are applied in each unit's own update

  assert.ok(ahead.hp < 100, 'missed the unit it was facing')
  assert.equal(behind.hp, 100, 'hit the unit behind it')

  // Run the breath's 1 s removal timer rather than holding the process open.
  t.mock.timers.tick(1000)
  assert.equal(World.AREA_EFFECT.length, 0)
})
