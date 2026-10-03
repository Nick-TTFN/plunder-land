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
import Mob from '../objects/mob'
import type UseSkillOnTarget from '../ai/useskillontarget'
import { ARCHETYPES, buildKit, buildSkills } from '../archetypes/archetypes'
import { SKILL_LIST } from '../utils/skills'
import { ARCHETYPE_INFO, archetypeById } from '../utils/archetypes'
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
    },
    // The blasts (5, 6) go by their cell, on the projectile's layer.
    effectAt: (type: number, originatorId: number, lifetime: number, cell: Vector) => {
      effects.push({ type, id: originatorId, lifetime, aimCell: cell })
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
  assert.equal(Client.RANGED_RANGE_CELLS, new RangedAttack(owner).range)
  assert.equal(Client.RANGED_RANGE_CELLS, RangedAttack.RANGE_CELLS)
})

test('every archetype\'s built ranged range is the one the client draws it at, looked up by its wire id', () => {
  // The client reads the `archetype` field, finds the mirrored row with
  // archetypeById and draws the beam at rangedRangeCells(row.rangedCells).
  // Any archetype whose built RangedAttack has another range must fail here,
  // not draw a beam that ends somewhere the shot did not.
  const owner = playerOn(new Vector(20, 40))
  const covered = new Set<string>()
  for (const archetype of Object.values(ARCHETYPES)) {
    const info = archetypeById(archetype.id)
    assert.ok(info !== undefined, `${archetype.key}: id ${archetype.id} is not in the mirrored table`)
    // A robot carries no skills since loadouts (#48 step 4): its RangedAttack
    // is the one any kit builds, so every equippable skill is built for it.
    const built = archetype.kind === 'robot' ? buildKit(owner, SKILL_LIST.map((s) => s.id)) : buildSkills(owner, archetype)
    const ranged = built.filter((s): s is RangedAttack => s instanceof RangedAttack)
    if (ranged.length === 0) {
      assert.equal(info.rangedCells, null, `${archetype.key} has no RangedAttack but its row gives it a range`)
      continue
    }
    for (const skill of ranged) {
      assert.equal(Client.rangedRangeCells(info.rangedCells, archetype.kind === 'mob'), skill.range, archetype.key)
      covered.add(archetype.kind)
    }
  }
  // Both kinds, so neither branch of the fallback is standing in for a real row.
  assert.deepEqual([...covered].sort(), ['mob', 'robot'], 'no robot or no mob has RangedAttack: this checks less than it says')
})

test('the threat cells the client draws under a mob reach as far as its attack (world-markers)', () => {
  // Boss: the FireBreath cone, drawn as the full disc since it can turn.
  // Gunner: its built RangedAttack. Grunts and robots: none.
  const owner = playerOn(new Vector(20, 40))
  for (const archetype of Object.values(ARCHETYPES)) {
    const info = ARCHETYPE_INFO[archetype.key]
    const drawn = Client.threatRingsOf(info.key, info.kind, info.rangedCells)
    const skills = buildSkills(owner, archetype)
    if (archetype.key === 'boss') {
      assert.ok(skills.some((s) => s instanceof FireBreath), 'the boss no longer breathes: its threat cells are wrong')
      assert.equal(drawn, FireBreath.RINGS, 'boss')
    } else if (archetype.key === 'gunner') {
      const ranged = skills.find((s): s is RangedAttack => s instanceof RangedAttack)
      assert.ok(ranged !== undefined)
      assert.equal(drawn, ranged.range, 'gunner')
    } else {
      assert.equal(drawn, 0, archetype.key)
    }
  }
})

test('the drawn range comes from the row when there is one, whatever the unit type', () => {
  // The two fallbacks equal peep's and gunner's ranges, so the test above
  // cannot tell a lookup from a fallback. A value neither default has can.
  assert.equal(Client.rangedRangeCells(5, true), 5)
  assert.equal(Client.rangedRangeCells(5, false), 5)
  assert.equal(Client.rangedRangeCells(11, true), 11)
})

// #43: players 6 (it was 8).
test('an unknown archetype, or one with no rangedCells, draws at today\'s range: players 6, mobs 6', () => {
  assert.equal(Client.RANGED_RANGE_CELLS, 6)
  assert.equal(Client.RANGED_RANGE_MOB_CELLS, 6)
  for (const id of [undefined, 0, 4, 200]) {
    // What the effect passes for an id this build doesn't know.
    const rangedCells = archetypeById(id)?.rangedCells
    assert.equal(Client.rangedRangeCells(rangedCells, false), 6, `player, id ${String(id)}`)
    assert.equal(Client.rangedRangeCells(rangedCells, true), 6, `mob, id ${String(id)}`)
  }
  // A known row with no RangedAttack (a newer server gave it one).
  assert.equal(Client.rangedRangeCells(ARCHETYPE_INFO.grunt.rangedCells, true), 6)
  assert.equal(Client.rangedRangeCells(null, false), 6)
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

test('the client\'s firstOnLine, over the client\'s Hex.line, picks the unit RangedAttack hits', () => {
  // Deterministic scatter: players and gunners firing aimed and unaimed shots
  // into a crowd with shared cells, so line order, same-cell nearness, range
  // and the facing fallback all get compared.
  let seed = 7
  const rand = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const offsetCell = (c: Vector, spread: number): Vector =>
    new Vector(c.x + Math.floor(rand() * (2 * spread + 1)) - spread, c.y + Math.floor(rand() * (2 * spread + 1)) - spread)
  const home = new Vector(20, 40)
  let compared = 0
  let hits = 0
  let sameCell = 0
  let unaimed = 0
  for (let trial = 0; trial < 400; trial++) {
    World.MOBS.length = 0
    World.PLAYERS.length = 0
    const gunnerShot = trial % 4 === 3
    const at = Hex.toPosition(home).add(new Vector(rand() * 30 - 15, rand() * 30 - 15))
    let shooter: Unit
    let skill: RangedAttack
    if (gunnerShot) {
      const gunner = new Mob(at.x, at.y, 0, ARCHETYPES.gunner)
      World.MOBS.push(gunner)
      shooter = gunner
      skill = (gunner.routines[1] as UseSkillOnTarget).skill as RangedAttack
    } else {
      const player = new Player(at.x, at.y, 0, 'caster')
      World.PLAYERS.push(player)
      shooter = player
      skill = new RangedAttack(player)
    }
    shooter.facing = new Vector(rand() * 2 - 1, rand() * 2 - 1)

    const mobs: Unit[] = []
    for (let i = 0; i < 8; i++) {
      // Every third one shares the previous one's cell.
      const cell = i % 3 === 2 ? mobs[i - 1].cell : offsetCell(home, 8)
      const mob = mobOn(cell)
      mob.position = mob.position.add(new Vector(rand() * 20 - 10, rand() * 20 - 10))
      mobs.push(mob)
    }
    // Mostly at a mob's cell, sometimes anywhere, sometimes no aim at all.
    const pick = trial % 5
    const aim = pick === 0
      ? undefined
      : pick === 1 ? offsetCell(home, 8) : mobs[Math.floor(rand() * mobs.length)].cell
    const own = shooter.cell

    const before = mobs.map((m) => m.hp)
    assert.equal(skill.execute(aim), true)
    const struck = mobs.findIndex((m, i) => m.hp !== before[i])

    // What the client does: the line from its view of the caster's cell (here
    // the same), through the aim or along the wire facing, at the drawn range.
    const aimed = aim !== undefined && (aim.x !== own.x || aim.y !== own.y)
    const toward = aimed ? aim : Hex.neighbour(own, World.FACING_INDEX(shooter.facing))
    const range = Client.rangedRangeCells(archetypeById(shooter.archetype?.id)?.rangedCells, gunnerShot)
    const got = Client.firstOnLine(
      Hex.line(own, toward, range),
      shooter.position.x, shooter.position.y,
      mobs.map((m) => ({ x: m.position.x, y: m.position.y, cell: m.cell }))
    )
    assert.equal(got, struck, `trial ${trial}`)
    compared++
    if (struck >= 0) hits++
    if (struck >= 0 && mobs.some((m, i) => i !== struck && m.cell.x === mobs[struck].cell.x && m.cell.y === mobs[struck].cell.y)) sameCell++
    if (!aimed) unaimed++
  }
  assert.ok(compared === 400 && hits > 100 && sameCell > 10 && unaimed > 50,
    `${compared} shots, ${hits} hits, ${sameCell} same-cell hits, ${unaimed} unaimed: the sample says too little`)
})

test('the client\'s firstOnLine and World.FIRST_ON_LINE agree on a line with two units in one cell', () => {
  const line = Hex.line(new Vector(20, 40), new Vector(26, 40), 8)
  const c = Hex.toPosition(new Vector(23, 40))
  const far = mobOn(new Vector(23, 40))
  far.position = c.add(new Vector(15, 0))
  const near = mobOn(new Vector(23, 40))
  near.position = c.add(new Vector(-15, 0))
  const from = Hex.toPosition(new Vector(20, 40))
  const server = World.FIRST_ON_LINE(line, from, 0, ObjectType.Mob)
  const client = Client.firstOnLine(line, from.x, from.y, [far, near].map((m) => ({ x: m.position.x, y: m.position.y, cell: m.cell })))
  assert.equal(server, near)
  assert.equal(client, 1)
})

test('the client\'s firstOnLine and World.FIRST_ON_LINE both go by line order, not by distance', () => {
  // An edge-diagonal line zigzags: a point on the far side of cell 1 is
  // further from the caster than one on the near side of cell 2.
  const origin = new Vector(20, 40)
  const line = Hex.line(origin, new Vector(22, 42), 8)
  const from = Hex.toPosition(origin)
  const early = mobOn(line[1])
  early.position = Hex.toPosition(line[1]).add(new Vector(0, 20))
  const late = mobOn(line[2])
  late.position = Hex.toPosition(line[2]).add(new Vector(-12, -16))
  assert.deepEqual([early.cell.x, early.cell.y], [line[1].x, line[1].y])
  assert.deepEqual([late.cell.x, late.cell.y], [line[2].x, line[2].y])
  assert.ok(early.position.sub(from).getMagnitude() > late.position.sub(from).getMagnitude(), 'no such pair: the test says nothing')

  const server = World.FIRST_ON_LINE(line, from, 0, ObjectType.Mob)
  const client = Client.firstOnLine(line, from.x, from.y, [late, early].map((m) => ({ x: m.position.x, y: m.position.y, cell: m.cell })))
  assert.equal(server, early)
  assert.equal(client, 1)
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

  test(`a ${name} that reaches the end of its line sends its blast on its last cell`, (t) => {
    // Hex-cells P3: it ends at the end of its 10-cell line on its 5th tick,
    // not when a 1200 ms timer runs out.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const caster = playerOn(new Vector(20, 40))
    assert.equal(make(caster).execute(new Vector(23, 42)), true)
    const projectile = World.PROJECTILES[0]
    for (let k = 0; k < 5; k++) {
      assert.equal(projectile.destroyed, false, `ended after ${k} ticks`)
      World.updateProjectiles(DT)
    }

    const blast = effects.find((e) => e.type === type)
    assert.ok(projectile.destroyed)
    const last = projectile.line[projectile.line.length - 1]
    assert.equal(Hex.distance(caster.cell, last), 10)
    assert.deepEqual(blast?.aimCell, last)
  })

  test(`a ${name} ended in flight sends its blast on its own cell`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const caster = playerOn(new Vector(20, 40))
    assert.equal(make(caster).execute(), true)
    const projectile = World.PROJECTILES[0]
    const parked = new Vector(30, 10)
    projectile.position = Hex.toPosition(parked)
    projectile.direction = new Vector(0, 0)

    projectile.destroy()

    const blast = effects.find((e) => e.type === type)
    assert.ok(projectile.destroyed)
    assert.deepEqual(blast?.aimCell, parked)
  })
}
