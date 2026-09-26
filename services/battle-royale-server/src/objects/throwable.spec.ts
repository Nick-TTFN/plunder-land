import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph at an objects/ file leaves
// GameObject undefined, so go in through multiplayer the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import Mob from './mob'
import { Unit } from './unit'
import { ObjectType } from './gameobject'
import Throwable from './throwable'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { Dash } from '../skills/dash'
import { RangedAttack } from '../skills/rangedattack'
import { StoneWall } from '../skills/stonewall'
import { IceBreath } from '../skills/icebreath'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'

/**
 * Fireball and icicle, driven through the real skills and the world's own
 * update order.
 *
 * They used to detonate on their own caster on the first tick (a Throwable sat
 * in the caster's push-out as if it were a rock). Since hex-cells P3 (#34) they
 * step along a 10-cell `Hex.line`: the front starts 8/3 cells out and gains
 * 5/3 a tick, so after each tick it is on line index 4, 6, 7, 9, 10; each
 * newly crossed index strikes the first unit (not the owner) on that cell or a
 * neighbour of it, and the 10th bursts. Reach is 11 cells in every direction.
 */

/** The server tick, TICK_MS's default. */
const DT = 0.25
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
  World.PROJECTILES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

/**
 * Move the clock and run what fell due, as `World.update` does first thing.
 * Breath removal, stone lifetimes and mob cooldowns are `Timers` on
 * `Date.now()`, so the test's clock is a mocked Date.
 */
function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

/** One tick in `World.update`'s order: players, then mobs, then throwables. */
function tick (): void {
  for (const player of World.PLAYERS) player.update(DT)
  for (const mob of World.MOBS) mob.update(DT)
  World.updateProjectiles(DT)
}

function playerAt (x: number, y: number): Player {
  const player = new Player(x, y, 0, 'caster')
  World.PLAYERS.push(player)
  return player
}

/** The cell the casters in these tests stand on, well inside the map. */
const HOME = Hex.toCell(new Vector(1000, 2000))

function offset (dq: number, dr: number, from: Vector = HOME): Vector {
  return new Vector(from.x + dq, from.y + dr)
}

function playerOn (cell: Vector): Player {
  const at = Hex.toPosition(cell)
  return playerAt(at.x, at.y)
}

/** A bare mob with a grunt's body on a cell centre, with hp to spare. */
function mobOn (cell: Vector, body = 14): Unit {
  const at = Hex.toPosition(cell)
  const mob = new Unit(ObjectType.Mob, at.x, at.y, body, 0)
  mob.hp = 1000
  World.MOBS.push(mob)
  return mob
}

/**
 * A player on a cell centre who walks `dq` cells along the q axis and comes to
 * rest, through the real `setDestination` and tick. Returns them stopped.
 */
function walkedAndStopped (dq: number): Player {
  const player = playerOn(HOME)
  const cell = player.cell
  player.setDestination(cell.x + dq, cell.y)
  assert.ok(player.path.length > 0, 'no route')

  for (let i = 0; i < 40 && player.path.length > 0; i++) tick()

  assert.equal(player.path.length, 0, 'never arrived')
  assert.equal(player.direction.getSquareMagnitude(), 0, 'not stopped')
  return player
}

/** Cast, and return the projectile the cast put in the world. */
function cast (make: (owner: Unit) => { execute: (aim?: Vector) => boolean }, owner: Unit, aim?: Vector): Throwable {
  const before = new Set(World.PROJECTILES)
  assert.equal(make(owner).execute(aim), true, 'the skill refused to cast')
  const added = World.PROJECTILES.filter((p) => !before.has(p))
  assert.equal(added.length, 1, 'expected exactly one new projectile')
  return added[0]
}

/**
 * Tick until the projectile ends, and return how far it got from where it
 * appeared, whether it struck a unit, and on which tick it ended (1 = the
 * first tick after the cast).
 */
function fly (projectile: Throwable): { travelled: number, struck: Unit | undefined, ticks: number } {
  const from = projectile.position
  let ticks = 0
  while (!projectile.destroyed && ticks < 40) {
    tick()
    ticks++
  }
  assert.ok(projectile.destroyed, 'the projectile never ended')
  return { travelled: projectile.position.sub(from).getMagnitude(), struck: projectile.struck, ticks }
}

/** Empty the world between casts inside one test. */
function clearUnits (): void {
  World.PROJECTILES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  Timers.clear()
}

/** Every cell exactly `k` steps from `from`. */
function ring (from: Vector, k: number): Vector[] {
  const cells: Vector[] = []
  for (let dq = -k; dq <= k; dq++) {
    for (let dr = -k; dr <= k; dr++) {
      const cell = offset(dq, dr, from)
      if (Hex.distance(from, cell) === k) cells.push(cell)
    }
  }
  return cells
}

/** Facing a player along hex direction `d` without moving them. */
function face (player: Unit, d: number): void {
  player.direction = Hex.toPosition(Hex.DIRECTIONS[d]).sub(Hex.toPosition(new Vector(0, 0))).normalised()
  player.stop()
  assert.equal(World.FACING_INDEX(player.facing), d)
}

for (const skill of SKILLS) {
  test(`${skill.name} from a walking player flies more than five cells`, () => {
    const player = playerOn(HOME)
    player.setDestination(HOME.x + 20, HOME.y)

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
    const player = playerOn(HOME)
    const start = player.position
    assert.equal(player.direction.getSquareMagnitude(), 0)

    const projectile = cast(skill.make, player)
    const { struck } = fly(projectile)

    assert.equal(struck, undefined, 'struck its own caster')
    assert.ok(projectile.position.x > start.x + FIVE_CELLS, 'did not fly East')
    assert.ok(Math.abs(projectile.position.y - start.y) < 1e-6, 'drifted off the East axis')
    assert.deepEqual(player.position, start, 'the caster was shoved by their own projectile')
    assert.equal(player.hp, player.maxHP(), 'the caster was hurt by their own cast')
  })

  test(`${skill.name} strikes a unit in its path, and damages it`, () => {
    const player = playerOn(HOME)
    const target = mobOn(offset(8, 0))

    const { struck } = fly(cast(skill.make, player))

    assert.equal(struck, target, 'flew through the target')
    assert.ok(target.hp < 1000, 'target took no damage')
    assert.equal(player.hp, player.maxHP(), 'the caster was hurt by their own cast')
  })

  test(`${skill.name}'s front is on line index 4, 6, 7, 9 after each tick and bursts on 10 on the 5th`, () => {
    // #34: 8/3 cells of head start plus 5/3 a tick, in integer thirds.
    const player = playerOn(HOME)
    const projectile = cast(skill.make, player, offset(3, 2))
    assert.equal(projectile.line.length, Throwable.RANGE_CELLS + 1)
    assert.equal(projectile.crossed, 0, 'tested cells before its first tick')

    const fronts: number[] = []
    for (let i = 0; i < 4; i++) {
      tick()
      assert.equal(projectile.destroyed, false, `ended on tick ${i + 1}`)
      fronts.push(projectile.crossed)
    }
    assert.deepEqual(fronts, [4, 6, 7, 9])

    tick()
    assert.equal(projectile.destroyed, true, 'outlived its 5th tick')
    assert.equal(projectile.crossed, 10)
    assert.equal(projectile.struck, undefined)
    const last = projectile.line[10]
    assert.equal(Hex.distance(player.cell, last), 10)
    assert.deepEqual(projectile.position, Hex.toPosition(last), 'did not burst on the last cell\'s centre')
  })

  test(`${skill.name} is drawn 5/3 of a cell further each tick along an axis`, () => {
    // Drawing only (the client snaps its sprite to this): the point the front
    // has reached, on the segment between the first and last cells' centres.
    const player = playerOn(HOME)
    const projectile = cast(skill.make, player)
    const start = Hex.toPosition(HOME)
    const along = (): number => projectile.position.x - start.x
    assert.ok(Math.abs(along() - 8 / 3 * Hex.SIZE) < 1e-9, `appeared ${along()} out`)
    for (let i = 1; i <= 4; i++) {
      tick()
      assert.ok(Math.abs(along() - (8 + 5 * i) / 3 * Hex.SIZE) < 1e-9, `tick ${i}: ${along()} out`)
    }
  })

  test(`${skill.name} reaches 11 cells in every direction: every cell of rings 1-11 and none of 12-13`, () => {
    // The whole ring, so the six axes and every cell between them. Measured
    // before P3 with the real code: 11 along an axis and 11-12 between them,
    // with a grunt on the adjacent cell never hit (task hex-cells-p3).
    const missed: string[] = []
    const reached: string[] = []
    for (let k = 1; k <= 13; k++) {
      for (const cell of ring(HOME, k)) {
        clearUnits()
        const player = playerOn(HOME)
        const mob = mobOn(cell)
        fly(cast(skill.make, player, cell))
        const hit = mob.hp < 1000
        if (k <= 11 && !hit) missed.push(`${cell.x - HOME.x},${cell.y - HOME.y}`)
        if (k > 11 && hit) reached.push(`${cell.x - HOME.x},${cell.y - HOME.y}`)
      }
    }
    assert.deepEqual(missed, [], 'missed a unit within 11 cells')
    assert.deepEqual(reached, [], 'hit a unit beyond 11 cells')
  })

  test(`${skill.name} unaimed reaches 11 cells along each of the six facings, not 12`, () => {
    for (let d = 0; d < 6; d++) {
      for (const k of [1, 11, 12]) {
        clearUnits()
        const player = playerOn(HOME)
        face(player, d)
        const step = Hex.DIRECTIONS[d]
        const mob = mobOn(offset(step.x * k, step.y * k))
        fly(cast(skill.make, player))
        assert.equal(mob.hp < 1000, k <= 11, `direction ${d}, ${k} cells`)
      }
    }
  })

  test(`${skill.name} strikes a grunt and a player on the adjacent cell on the first tick`, () => {
    // Missed before P3: it spawned 56 out and first tested 131 out.
    for (const kind of ['grunt', 'player'] as const) {
      clearUnits()
      const player = playerOn(HOME)
      const next = offset(1, 0)
      let target: Unit
      if (kind === 'grunt') {
        target = new Mob(Hex.toPosition(next).x, Hex.toPosition(next).y, 0)
        target.routines.length = 0
        target.hp = 1000
        World.MOBS.push(target)
      } else {
        target = playerOn(next)
      }
      // A player's armor takes the damage first (Unit.hit), so count both.
      const health = (): number => target.hp + (target.armor ?? 0)
      const before = health()
      const projectile = cast(skill.make, player, next)
      tick()
      assert.equal(projectile.destroyed, true, `${kind}: not struck on the first tick`)
      assert.equal(projectile.struck, target, `${kind}: struck something else`)
      assert.ok(health() < before, `${kind}: no damage`)
    }
  })

  test(`${skill.name} never strikes its owner, but strikes another player on the owner's cell`, () => {
    const owner = playerOn(HOME)
    const other = playerOn(HOME)
    const projectile = cast(skill.make, owner)
    tick()
    assert.equal(projectile.struck, other)
    assert.equal(owner.hp, owner.maxHP(), 'the owner was hurt')
  })

  test(`${skill.name} strikes a unit beside the line (swath 1), and not one two cells off it`, () => {
    // East along the row: a unit one row off (r - 1) is next to a line cell,
    // two rows off (r - 2) is next to none.
    const player = playerOn(HOME)
    const beside = mobOn(offset(6, -1))
    const twoOff = mobOn(offset(3, -2))
    const { struck } = fly(cast(skill.make, player))
    assert.equal(struck, beside)
    assert.equal(twoOff.hp, 1000)
  })

  test(`${skill.name} picks the earliest crossed cell, then the line cell over a neighbour, then the lowest id`, () => {
    // Earliest crossed cell: B beside cell 1 beats A on line cell 4, although
    // both are crossed on the first tick and A was made first.
    let player = playerOn(HOME)
    const onLine4 = mobOn(offset(4, 0))
    const beside1 = mobOn(offset(1, -1))
    assert.ok(onLine4.id < beside1.id)
    assert.equal(fly(cast(skill.make, player)).struck, beside1, 'earliest crossed cell')

    // One patch: cell 7 (crossed alone on the 3rd tick) has both (8, 0), the
    // next line cell, and (8, -1), beside the line, as neighbours; neither is
    // in cell 6's patch. The one on the line wins over a lower id beside it.
    clearUnits()
    player = playerOn(HOME)
    const side = mobOn(offset(8, -1))
    const line = mobOn(offset(8, 0))
    assert.ok(side.id < line.id)
    const onLine = fly(cast(skill.make, player))
    assert.equal(onLine.struck, line, 'on the line before a neighbour')
    assert.equal(onLine.ticks, 3)

    // Two units beside cell 1, neither on the line: the lower id, although
    // the cell walk meets the other first ((1, 1) is at dq 0 from cell 1,
    // (2, -1) at dq +1).
    clearUnits()
    player = playerOn(HOME)
    const low = mobOn(offset(2, -1))
    const high = mobOn(offset(1, 1))
    assert.ok(low.id < high.id)
    World.MOBS.reverse()
    const tie = fly(cast(skill.make, player))
    assert.equal(tie.struck, low, 'the lower id')
    assert.equal(tie.ticks, 1)
  })

  test(`${skill.name} is dodged by a unit that walks out of the swath before the front arrives`, () => {
    // The target stands on line cell 9, first reached when the front crosses
    // cell 8 on the 4th tick. Walking two cells north-east (r - 2) takes it off
    // every line cell and every neighbour of one by then.
    const caster = playerOn(HOME)
    const dodger = playerOn(offset(9, 0))
    dodger.setDestination(HOME.x + 11, HOME.y - 2)
    const { struck } = fly(cast(skill.make, caster))
    assert.equal(struck, undefined, 'struck the dodger')
    assert.equal(dodger.hp, dodger.maxHP(), 'the dodger was hurt')
    assert.equal(dodger.armor, dodger.maxArmor, 'the dodger\'s armor was hurt')

    // Control: standing still on the same cell it is struck, on the 4th tick.
    clearUnits()
    const caster2 = playerOn(HOME)
    const stander = playerOn(offset(9, 0))
    const result = fly(cast(skill.make, caster2))
    assert.equal(result.struck, stander)
    assert.equal(result.ticks, 4)

    // Too late: from line cell 4 the same walk's first cell, (5, -1), is still
    // beside cell 4, which the front crosses on its first tick.
    clearUnits()
    const caster3 = playerOn(HOME)
    const late = playerOn(offset(4, 0))
    late.setDestination(HOME.x + 6, HOME.y - 2)
    const lateResult = fly(cast(skill.make, caster3))
    assert.equal(lateResult.struck, late)
    assert.equal(lateResult.ticks, 1)
  })

  test(`${skill.name} does not strike a unit that steps onto the line behind its front`, () => {
    // Only newly crossed cells are tested: once the front is past a cell,
    // walking onto it is safe.
    const player = playerOn(HOME)
    const projectile = cast(skill.make, player)
    tick()
    assert.equal(projectile.crossed, 4)
    const behind = mobOn(offset(2, 0))
    const { struck } = fly(projectile)
    assert.equal(struck, undefined, 'struck a unit behind the front')
    assert.equal(behind.hp, 1000)
  })

  test(`${skill.name} flies through rocks`, () => {
    // Unchanged by P3: nothing but a unit stops it.
    const player = playerOn(HOME)
    for (const dq of [2, 3, 4]) World.block(HOME.x + dq, HOME.y, 0)
    const target = mobOn(offset(7, 0))
    assert.equal(fly(cast(skill.make, player)).struck, target)
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
  // On a cell centre since hex-cells P2: a standing dash is a route of cell
  // centres (decision #34), so from (1000, 2000), which is not one, its first
  // step went to the centre of the next cell east and moved y.
  const start = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))
  const player = playerAt(start.x, start.y)
  assert.equal(new Dash(player).execute(), true, 'dash refused to cast')
  for (let i = 0; i < 4; i++) tick()

  assert.ok(player.position.x > start.x + Hex.SIZE, `dashed only to x=${player.position.x.toFixed(1)}`)
  assert.equal(player.position.y, start.y)
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
  // StoneWall goes on the side *opposite* the facing: the 3 cells directly
  // behind you (decision #22, `StoneWall.cells`). What is tested here is that a
  // stopped caster gets a wall at all, and on that side of the facing.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
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
  advance(t, StoneWall.LIFETIME)
  assert.equal(World.OBSTACLES.filter((o) => o.type === ObjectType.Obstacle).length, 0,
    'a stone outlived the fixed lifetime')
})

test('IceBreath from a stopped player cones along their last facing, not East', (t) => {
  // SectorArea aimed with `direction`, whose angle at (0,0) is 0: every breath
  // from a standstill went East. Walk West so the old East cone misses.
  // Three cells out, the edge of the cone's 3 rings.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
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
  advance(t, 1000)
  assert.equal(World.AREA_EFFECT.length, 0)
})
