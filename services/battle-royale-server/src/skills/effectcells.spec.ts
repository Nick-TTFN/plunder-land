import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph anywhere but multiplayer leaves
// GameObject undefined, so go in the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import { Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import SectorArea from '../area/sectorarea'
import { RangedAttack } from './rangedattack'
import { MeleeAttack } from './meleeattack'
import { IceBreath } from './icebreath'
import { FireBreath } from './firebreath'
import { ThrowFireball } from './throwfireball'
import { Throwicicle } from './throwicicle'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
// The client's port. It imports nothing, so this pulls no pixi into the server.
import * as Client from '../../../../plunder-land-client/src/vfx/cells'

/**
 * The client draws each effect over the cells it works out itself, from
 * `plunder-land-client/src/vfx/cells.ts`. These tests hold that port to the
 * server's own definitions, so the cells an effect lights are the cells the
 * skill damages (task `effects-render`, decisions #18, #20, #21).
 */

const DT = 0.25

interface EffectCall { type: number, id: number, lifetime: number, aimCell?: Vector }
let effects: EffectCall[] = []

beforeEach(() => {
  const noop = (): void => {}
  effects = []
  Multiplayer.Instance = {
    create: noop,
    update: noop,
    destroy: noop,
    effect: (type: number, originator: Unit, lifetime: number, aimCell?: Vector) => {
      effects.push({ type, id: originator.id, lifetime, aimCell })
    }
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

function keys (cells: Array<{ x: number, y: number }>): number[] {
  return cells.map((c) => Hex.key(c.x, c.y)).sort((a, b) => a - b)
}

function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function mobOn (cell: Vector): Unit {
  const at = Hex.toPosition(cell)
  const mob = new Unit(ObjectType.Mob, at.x, at.y, 10, 0)
  mob.hp = 1000
  World.MOBS.push(mob)
  return mob
}

function playerOn (cell: Vector): Player {
  const at = Hex.toPosition(cell)
  const player = new Player(at.x, at.y, 0, 'caster')
  World.PLAYERS.push(player)
  return player
}

const ORIGINS = [new Vector(0, 0), new Vector(22, 44), new Vector(-7, 13), new Vector(40, -3)]

// --- the port matches the server ---------------------------------------------

test('the client\'s DIRECTIONS copy equals Hex.DIRECTIONS, in order', () => {
  assert.deepEqual(
    Client.DIRECTIONS.map((d) => [d.x, d.y]),
    Hex.DIRECTIONS.map((d) => [d.x, d.y])
  )
})

test('the client\'s ring counts and ranged range equal the skills\'', () => {
  assert.equal(Client.MELEE_RINGS, MeleeAttack.RINGS)
  assert.equal(Client.BLAST_RINGS, ThrowFireball.BLAST_RINGS)
  assert.equal(Client.BLAST_RINGS, Throwicicle.BLAST_RINGS)
  assert.equal(Client.FIRE_BREATH_RINGS, FireBreath.RINGS)
  assert.equal(Client.ICE_BREATH_RINGS, IceBreath.RINGS)
  const owner = playerOn(new Vector(20, 40))
  assert.equal(Client.RANGED_RANGE, new RangedAttack(owner).range)
})

test('the client\'s facingIndex equals World.FACING_INDEX all the way round, halfway facings included', () => {
  for (let deg = 0; deg < 360; deg += 0.5) {
    const a = deg * Math.PI / 180
    for (const m of [0.001, 1, 37]) {
      const x = Math.cos(a) * m
      const y = Math.sin(a) * m
      assert.equal(Client.facingIndex(x, y), World.FACING_INDEX(new Vector(x, y)), `at ${deg} degrees x${m}`)
    }
  }
  for (const [x, y] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0], [Math.sqrt(3), 1], [-Math.sqrt(3), -1]]) {
    assert.equal(Client.facingIndex(x, y), World.FACING_INDEX(new Vector(x, y)), `(${x}, ${y})`)
  }
})

test('the client\'s coneCells equals World.CONE_CELLS, same cells in the same order', () => {
  for (const origin of ORIGINS) {
    for (let d = 0; d < 6; d++) {
      for (let rings = 0; rings <= 6; rings++) {
        assert.deepEqual(
          Client.coneCells(origin, d, rings).map((c) => [c.x, c.y]),
          World.CONE_CELLS(origin, d, rings).map((c) => [c.x, c.y]),
          `origin ${origin.x},${origin.y} direction ${d} rings ${rings}`
        )
      }
    }
  }
})

test('the client\'s discCells is exactly the cells FIND_IN_CELLS takes', () => {
  for (const origin of ORIGINS) {
    for (let rings = 0; rings <= 4; rings++) {
      const expected: Vector[] = []
      for (let q = origin.x - 6; q <= origin.x + 6; q++) {
        for (let r = origin.y - 6; r <= origin.y + 6; r++) {
          if (Hex.distance(origin, new Vector(q, r)) <= rings) expected.push(new Vector(q, r))
        }
      }
      const got = Client.discCells(origin, rings)
      assert.equal(new Set(keys(got)).size, got.length, 'a cell listed twice')
      assert.deepEqual(keys(got), keys(expected), `origin ${origin.x},${origin.y} rings ${rings}`)
    }
  }
})

test('the client\'s firstOnLine picks the unit RangedAttack hits', () => {
  // Deterministic scatter; the shooter fires along a spread of aims.
  let seed = 7
  const rand = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  let compared = 0
  let hits = 0
  for (let trial = 0; trial < 200; trial++) {
    World.MOBS.length = 0
    World.PLAYERS.length = 0
    const shooter = playerOn(new Vector(20, 40))
    const mobs: Unit[] = []
    for (let i = 0; i < 6; i++) {
      const cell = new Vector(20 + Math.floor(rand() * 17) - 8, 40 + Math.floor(rand() * 17) - 8)
      const mob = mobOn(cell)
      mob.position = mob.position.add(new Vector(rand() * 20 - 10, rand() * 20 - 10))
      mobs.push(mob)
    }
    // Mostly at a mob's cell, so there is something to hit and to hit first.
    const aim = trial % 3 === 0
      ? new Vector(20 + Math.floor(rand() * 17) - 8, 40 + Math.floor(rand() * 17) - 8)
      : mobs[Math.floor(rand() * mobs.length)].cell
    if (aim.x === 20 && aim.y === 40) continue

    const before = mobs.map((m) => m.hp)
    assert.equal(new RangedAttack(shooter).execute(aim), true)
    const struck = mobs.findIndex((m, i) => m.hp !== before[i])

    const dir = Hex.toPosition(aim).sub(shooter.position).normalised()
    const end = shooter.position.add(dir.multiply(Client.RANGED_RANGE))
    const got = Client.firstOnLine(
      shooter.position.x, shooter.position.y, end.x, end.y,
      mobs.map((m) => ({ x: m.position.x, y: m.position.y, radius: m.radius }))
    )
    assert.equal(got, struck, `trial ${trial}`)
    compared++
    if (struck >= 0) hits++
  }
  assert.ok(compared > 150 && hits > 20, `only ${compared} shots, ${hits} hits: the sample says nothing`)
})

// --- the effect record says enough to draw the right cells --------------------

for (const [name, Breath, type] of [
  ['FireBreath', FireBreath, 0],
  ['IceBreath', IceBreath, 1]
] as const) {
  test(`an aimed ${name}'s tip cell gives the client the cone the server damages, even one cell out`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const casterCell = new Vector(20, 40)
    for (let d = 0; d < 6; d++) {
      World.AREA_EFFECT.length = 0
      World.PLAYERS.length = 0
      effects = []
      Timers.clear()
      const caster = playerOn(casterCell)
      const aim = new Vector(casterCell.x + Hex.DIRECTIONS[d].x * 2, casterCell.y + Hex.DIRECTIONS[d].y * 2)
      assert.equal(new Breath(caster).execute(aim), true)

      const effect = effects.find((e) => e.type === type)
      assert.ok(effect?.aimCell !== undefined, 'no aimed effect record')
      const area = World.AREA_EFFECT[0] as SectorArea

      // The client agreeing about the caster's cell draws exactly what hurts.
      const direction = Client.directionToward(casterCell, effect.aimCell)
      const drawn = Client.coneCells(casterCell, direction, Breath.RINGS)
      const damaging: Vector[] = []
      for (let q = casterCell.x - 6; q <= casterCell.x + 6; q++) {
        for (let r = casterCell.y - 6; r <= casterCell.y + 6; r++) {
          if (area.overlaps(Hex.toPosition(new Vector(q, r)))) damaging.push(new Vector(q, r))
        }
      }
      assert.deepEqual(keys(drawn), keys(damaging), `direction ${d}`)

      // A client that places the caster one cell off still snaps the same way.
      for (let n = 0; n < 6; n++) {
        const off = Hex.neighbour(casterCell, n)
        assert.equal(Client.directionToward(off, effect.aimCell), d, `direction ${d}, caster seen one cell ${n} off`)
      }
    }
  })
}

for (const [name, make, type] of [
  ['fireball', (o: Unit) => new ThrowFireball(o), 5],
  ['icicle', (o: Unit) => new Throwicicle(o), 6]
] as const) {
  test(`a ${name} that strikes a unit sends a blast effect on that unit's cell, and the ring it names is the ring it damaged`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const caster = playerOn(new Vector(20, 40))
    const target = mobOn(new Vector(24, 40))
    // A ring of bystanders around the target, and a second ring that must be spared.
    const ring1 = Client.discCells(target.cell, 1).filter((c) => c.x !== target.cell.x || c.y !== target.cell.y).map((c) => mobOn(new Vector(c.x, c.y)))
    const ring2 = [mobOn(new Vector(26, 40)), mobOn(new Vector(24, 42))]

    assert.equal(make(caster).execute(new Vector(24, 40)), true)
    for (let k = 0; k < 10 && World.PROJECTILES.length > 0; k++) {
      advance(t, DT * 1000)
      World.updateProjectiles(DT)
    }

    const blasts = effects.filter((e) => e.type === type)
    assert.equal(blasts.length, 1, 'expected one blast effect')
    const blast = blasts[0]
    assert.equal(blast.id, caster.id)
    assert.ok(blast.aimCell !== undefined)

    const drawn = new Set(keys(Client.discCells(blast.aimCell, Client.BLAST_RINGS)))
    for (const mob of [...ring1, ...ring2, target]) {
      if (mob.destroyed) continue
      const damaged = mob.hp < 1000
      assert.equal(drawn.has(Hex.key(mob.cell.x, mob.cell.y)), damaged, `mob on ${mob.cell.x},${mob.cell.y}: damaged ${damaged}`)
    }
    assert.ok(target.hp < 1000 || target.destroyed, 'the struck unit was not damaged')
  })

  test(`a ${name} that expires sends its blast on its own cell`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const caster = playerOn(new Vector(20, 40))
    assert.equal(make(caster).execute(), true)
    const projectile = World.PROJECTILES[0]
    const parked = new Vector(30, 10)
    projectile.position = Hex.toPosition(parked)
    projectile.direction = new Vector(0, 0)

    advance(t, 5000)

    const blast = effects.find((e) => e.type === type)
    assert.ok(projectile.destroyed)
    assert.deepEqual(blast?.aimCell, parked)
  })
}
