import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import type UseSkillOnTarget from '../ai/useskillontarget'
import { ARCHETYPES } from '../archetypes/archetypes'
import { RangedAttack } from './rangedattack'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Task `ranged-hex-line`, decision #25: a ranged shot hits the first unit
 * whose cell is on the hex line from the caster's cell through the aimed cell,
 * out to its range in cells (players 6 since #43, 8 before; gunner 6).
 *
 * The sweeps are the measurement that motivated the change. Against the old
 * segment-and-radius test the gunner sweep missed 2068-2084 of 7020 shots per
 * gunner position (29.5-29.7%, re-run 2026-09-25 on d95c223); it must now miss
 * none.
 */

beforeEach(() => {
  // An idle guard wanders with Math.random; at 0.5 its goal is home itself.
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  Multiplayer.Instance = { create: noop, update: noop, destroy: noop, effect: noop } as unknown as Multiplayer
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

afterEach(() => {
  mock.restoreAll()
})

const HOME_CELL = Hex.toCell(new Vector(1000, 2000))
const HOME = Hex.toPosition(HOME_CELL)

/** Off-centre positions inside the home cell (inradius 22.5), plus the centre. */
const OFFSETS = [
  new Vector(0, 0), new Vector(15, 0), new Vector(-15, 8), new Vector(7, -18),
  new Vector(-10, -14), new Vector(12, 15), new Vector(-20, 0)
]

function playerAt (at: Vector, name = 'shooter'): Player {
  const player = new Player(at.x, at.y, 0, name)
  player.armor = 0
  World.PLAYERS.push(player)
  return player
}

function mobAt (at: Vector): Unit {
  const mob = new Unit(ObjectType.Mob, at.x, at.y, 10, 0)
  mob.hp = 1000
  World.MOBS.push(mob)
  return mob
}

const mobOn = (cell: Vector): Unit => mobAt(Hex.toPosition(cell))

/** A player target on `cell`'s centre, 1000 hp and no armour, so a hit reads as -damage. */
function playerOn (cell: Vector, name = 'target'): Player {
  const player = playerAt(Hex.toPosition(cell), name)
  player.hp = 1000
  return player
}

/** Every 3-unit (or `step`) grid point whose cell is `cell`. */
function pointsIn (cell: Vector, step: number): Vector[] {
  const c = Hex.toPosition(cell)
  const result: Vector[] = []
  for (let dx = -27; dx <= 27; dx += step) {
    for (let dy = -27; dy <= 27; dy += step) {
      const p = new Vector(c.x + dx, c.y + dy)
      const pc = Hex.toCell(p)
      if (pc.x === cell.x && pc.y === cell.y) result.push(p)
    }
  }
  return result
}

function cellsAt (origin: Vector, lo: number, hi: number): Vector[] {
  const result: Vector[] = []
  for (let q = -hi; q <= hi; q++) {
    for (let r = -hi; r <= hi; r++) {
      const cell = new Vector(origin.x + q, origin.y + r)
      const n = Hex.distance(origin, cell)
      if (n >= lo && n <= hi) result.push(cell)
    }
  }
  return result
}

const fire = (shooter: Unit, aim?: Vector): boolean => new RangedAttack(shooter).execute(aim)

// --- the sweeps ------------------------------------------------------------------

test('gunner ring-6 sweep: a lone target anywhere in any cell 6 away is hit, gunner on and off its centre', () => {
  const gunner = new Mob(HOME.x, HOME.y, 0, ARCHETYPES.gunner)
  const target = playerAt(HOME, 'target')
  World.MOBS.push(gunner)
  const use = gunner.routines[1] as UseSkillOnTarget
  assert.equal((use.skill as RangedAttack).range, 6)

  for (const offset of OFFSETS) {
    gunner.position = HOME.add(offset)
    assert.deepEqual([gunner.cell.x, gunner.cell.y], [HOME_CELL.x, HOME_CELL.y], 'offset left the home cell')
    let shots = 0
    let misses = 0
    const ring = cellsAt(HOME_CELL, 6, 6)
    assert.equal(ring.length, 36)
    for (const cell of ring) {
      for (const p of pointsIn(cell, 3)) {
        target.position = p
        target.hp = 1000
        gunner.target = target
        use.skill.executeTime = 0
        use.update(0.25)
        shots++
        if (target.hp === 1000) misses++
      }
    }
    assert.ok(shots > 6000, `only ${shots} shots: the sweep says nothing`)
    assert.equal(misses, 0, `offset ${offset.x},${offset.y}: ${misses}/${shots} missed`)
  }
})

test('player sweep: a lone target anywhere in any cell up to 6 away is hit when its cell is aimed at', () => {
  const target = mobAt(HOME)
  for (const offset of [OFFSETS[0], OFFSETS[3], OFFSETS[6]]) {
    const shooter = playerAt(HOME.add(offset))
    let shots = 0
    let misses = 0
    for (const cell of cellsAt(HOME_CELL, 1, 6)) {
      for (const p of pointsIn(cell, 9)) {
        target.position = p
        target.hp = 1000
        assert.equal(fire(shooter, cell), true)
        shots++
        if (target.hp === 1000) misses++
      }
    }
    // 6 rings since #43: 126 cells x 21 points = 2646 shots (it was 8 rings, over 3000).
    assert.ok(shots >= 2646, `only ${shots} shots`)
    assert.equal(misses, 0, `offset ${offset.x},${offset.y}: ${misses}/${shots} missed`)
    World.PLAYERS.length = 0
  }
})

// --- the line ------------------------------------------------------------------

test('a unit on any cell between the caster and the aimed cell takes the shot instead', () => {
  const shooter = playerAt(HOME)
  let cases = 0
  for (const aim of cellsAt(HOME_CELL, 2, 6)) {
    const line = Hex.line(HOME_CELL, aim, 6)
    const n = Hex.distance(HOME_CELL, aim)
    for (let i = 1; i < n; i++) {
      World.MOBS.length = 0
      const target = mobOn(aim)
      const blocker = mobOn(line[i])
      assert.equal(fire(shooter, aim), true)
      assert.equal(blocker.hp, 1000 - World.config.ranged, `aim ${aim.x},${aim.y}: blocker on line cell ${i} not hit`)
      assert.equal(target.hp, 1000, `aim ${aim.x},${aim.y}: shot went through line cell ${i}`)
      cases++
    }
  }
  // Aims 2-6 rings out since #43 (2-8 before, over 700).
  assert.ok(cases >= 420, `only ${cases} cases`)
})

test('a unit beside the line is not a blocker', () => {
  const shooter = playerAt(HOME)
  const aim = HOME_CELL.add(new Vector(6, 0))
  const target = mobOn(aim)
  // Due east is a straight row: the cells either side of it are off the line.
  const beside = [mobOn(HOME_CELL.add(new Vector(3, -1))), mobOn(HOME_CELL.add(new Vector(2, 1)))]
  assert.equal(fire(shooter, aim), true)
  assert.equal(target.hp, 1000 - World.config.ranged)
  for (const b of beside) assert.equal(b.hp, 1000)
})

test('the shot carries on past the aimed cell to its range, and no further', () => {
  for (const aim of cellsAt(HOME_CELL, 1, 4)) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const shooter = playerAt(HOME)
    // #43: a robot's range is 6 cells (it was 8).
    const line = Hex.line(HOME_CELL, aim, 7)
    const beyond = mobOn(line[7])
    assert.equal(fire(shooter, aim), true)
    assert.equal(beyond.hp, 1000, `aim ${aim.x},${aim.y}: hit a unit 7 cells out`)
    const last = mobOn(line[6])
    assert.equal(fire(shooter, aim), true)
    assert.equal(last.hp, 1000 - World.config.ranged, `aim ${aim.x},${aim.y}: missed a unit on the 6th cell`)
  }
})

test('a gunner\'s line is 6 cells: it does not reach a 7th', () => {
  const gunner = new Mob(HOME.x, HOME.y, 0, ARCHETYPES.gunner)
  World.MOBS.push(gunner)
  const skill = (gunner.routines[1] as UseSkillOnTarget).skill
  const aim = HOME_CELL.add(new Vector(3, 0))
  // Players: a gunner's shot passes through mobs (#51 Q7).
  const seventh = playerOn(HOME_CELL.add(new Vector(7, 0)))
  assert.equal(skill.execute(aim), true)
  assert.equal(seventh.hp, 1000)
  const sixth = playerOn(HOME_CELL.add(new Vector(6, 0)))
  skill.executeTime = 0
  assert.equal(skill.execute(aim), true)
  assert.equal(sixth.hp, 1000 - 10)
})

test('of two units on the same line cell, the one nearer the caster is hit', () => {
  const shooter = playerAt(HOME)
  const cell = HOME_CELL.add(new Vector(4, 0))
  const c = Hex.toPosition(cell)
  // Far one pushed first, so list order would pick it.
  const far = mobAt(c.add(new Vector(15, 0)))
  const near = mobAt(c.add(new Vector(-15, 0)))
  assert.equal(fire(shooter, HOME_CELL.add(new Vector(6, 0))), true)
  assert.equal(near.hp, 1000 - World.config.ranged)
  assert.equal(far.hp, 1000)
})

test('the first unit is by line order, even when a unit on a later cell stands nearer the caster', () => {
  // Along an edge-diagonal the line zigzags: cell 1 is a corner neighbour
  // (centre 45 away) and cell 2 a flat-side one (centre 78 away), so the far
  // side of cell 1 is further out than the near side of cell 2.
  const shooter = playerAt(HOME)
  const aim = HOME_CELL.add(new Vector(2, 2))
  const line = Hex.line(HOME_CELL, aim, 8)
  const dist = (p: Vector): number => p.sub(HOME).getMagnitude()
  const farInFirst = pointsIn(line[1], 3).reduce((a, b) => dist(a) > dist(b) ? a : b)
  const nearInSecond = pointsIn(line[2], 3).reduce((a, b) => dist(a) < dist(b) ? a : b)
  assert.ok(dist(farInFirst) > dist(nearInSecond), 'no such pair: the test says nothing')

  const second = mobAt(nearInSecond)
  const first = mobAt(farInFirst)
  assert.equal(fire(shooter, aim), true)
  assert.equal(first.hp, 1000 - World.config.ranged, 'the unit on the earlier cell was passed over')
  assert.equal(second.hp, 1000)
})

test('no aim, or an aim at the caster\'s own cell, runs the line along FACING_INDEX(facing)', () => {
  // (0.2, 1) is 79 degrees: SE (index 1) by FACING_INDEX, not E and not SW.
  const facing = new Vector(0.2, 1).normalised()
  assert.equal(World.FACING_INDEX(facing), 1)
  for (const aim of [undefined, HOME_CELL]) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const shooter = playerAt(HOME)
    shooter.facing = facing
    const ahead = mobOn(HOME_CELL.add(Hex.DIRECTIONS[1].multiply(5)))
    const others = [0, 2].map((d) => mobOn(HOME_CELL.add(Hex.DIRECTIONS[d].multiply(3))))
    assert.equal(fire(shooter, aim), true)
    assert.equal(ahead.hp, 1000 - World.config.ranged, `aim ${aim === undefined ? 'none' : 'own cell'}: missed along the facing`)
    for (const o of others) assert.equal(o.hp, 1000)
  }
})

test('the caster is never its own target, and a dead unit on the line does not stop the shot', () => {
  const shooter = playerAt(HOME)
  const aim = HOME_CELL.add(new Vector(5, 0))
  const corpse = mobOn(HOME_CELL.add(new Vector(2, 0)))
  corpse.destroyed = true
  const target = mobOn(aim)
  assert.equal(fire(shooter, aim), true)
  assert.equal(shooter.hp, shooter.maxHp)
  assert.equal(target.hp, 1000 - World.config.ranged)
})

test('another unit on the caster\'s own cell is on the line, and is hit first', () => {
  // Deliberate reading of "the first unit whose cell is on the line": the
  // caster's cell is cell 0. Flagged for Dez in the task's handoff.
  const shooter = playerAt(HOME)
  const huddled = mobAt(HOME.add(new Vector(10, 0)))
  const target = mobOn(HOME_CELL.add(new Vector(-4, 0)))
  assert.equal(fire(shooter, HOME_CELL.add(new Vector(-4, 0))), true)
  assert.equal(huddled.hp, 1000 - World.config.ranged)
  assert.equal(target.hp, 1000)
})

test('a unit on the other plane is not on the line', () => {
  const shooter = playerAt(HOME)
  const aim = HOME_CELL.add(new Vector(5, 0))
  const other = mobOn(HOME_CELL.add(new Vector(2, 0)))
  other.tag = -1
  const target = mobOn(aim)
  assert.equal(fire(shooter, aim), true)
  assert.equal(other.hp, 1000)
  assert.equal(target.hp, 1000 - World.config.ranged)
})

// --- who stops a shot (decision #51 Q7) -------------------------------------------

/** A Crawler on `cell`'s centre with 1000 hp, and its ranged skill. */
function crawlerOn (cell: Vector): { mob: Mob, skill: RangedAttack } {
  const at = Hex.toPosition(cell)
  const mob = new Mob(at.x, at.y, 0, ARCHETYPES.crawler)
  mob.hp = 1000
  World.MOBS.push(mob)
  const use = mob.routines.find((r) => (r as Partial<UseSkillOnTarget>).skill instanceof RangedAttack) as UseSkillOnTarget | undefined
  assert.ok(use !== undefined, 'the Crawler has no RangedAttack')
  return { mob, skill: use.skill as RangedAttack }
}

const crawler = (): { mob: Mob, skill: RangedAttack } => crawlerOn(HOME_CELL)

test('a Crawler\'s shot passes its pack mate on the line and hits the player behind', () => {
  const { skill } = crawler()
  const aim = HOME_CELL.add(new Vector(4, 0))
  const mate = crawlerOn(HOME_CELL.add(new Vector(2, 0))).mob
  const player = playerOn(aim)
  assert.equal(skill.execute(aim), true)
  assert.equal(mate.hp, 1000, 'the pack mate took the shot')
  assert.equal(player.hp, 1000 - 8, 'the player behind the mate was not hit for the Crawler\'s 8')
})

test('a mob\'s shot with only mobs on its line hits nothing', () => {
  const { skill } = crawler()
  const aim = HOME_CELL.add(new Vector(4, 0))
  const mates = [1, 2, 4].map((q) => crawlerOn(HOME_CELL.add(new Vector(q, 0))).mob)
  assert.equal(skill.execute(aim), true)
  for (const m of mates) assert.equal(m.hp, 1000)
})

test('a player\'s shot still stops at a mob in front of the aimed mob', () => {
  const shooter = playerAt(HOME)
  const aim = HOME_CELL.add(new Vector(4, 0))
  const front = mobOn(HOME_CELL.add(new Vector(2, 0)))
  const behind = mobOn(aim)
  assert.equal(fire(shooter, aim), true)
  assert.equal(front.hp, 1000 - World.config.ranged)
  assert.equal(behind.hp, 1000)
})

test('a player\'s shot at a player behind a mob hits the mob', () => {
  const shooter = playerAt(HOME)
  const aim = HOME_CELL.add(new Vector(4, 0))
  const front = mobOn(HOME_CELL.add(new Vector(2, 0)))
  const behind = playerOn(aim)
  assert.equal(fire(shooter, aim), true)
  assert.equal(front.hp, 1000 - World.config.ranged)
  assert.equal(behind.hp, 1000)
})
