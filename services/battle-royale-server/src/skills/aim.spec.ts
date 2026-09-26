import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: entering the module graph anywhere but multiplayer leaves
// GameObject undefined, so go in the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { ARCHETYPES } from '../archetypes/archetypes'
import { Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import type Throwable from '../objects/throwable'
import SectorArea from '../area/sectorarea'
import UseSkillOnTarget from '../ai/useskillontarget'
import { Skill } from './skill'
import { RangedAttack } from './rangedattack'
import { ThrowFireball } from './throwfireball'
import { Throwicicle } from './throwicicle'
import { IceBreath } from './icebreath'
import { FireBreath } from './firebreath'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Skills aim at an absolute cell (decision #21): the `skill` message carries
 * `[uint8 slot][int16 q][int16 r]`, projectiles fly through the aimed cell's
 * centre at any angle, and cones snap the aim to one of six and hold it.
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

/**
 * Mock Date for a test that casts a projectile or a breath. Their lifetimes and
 * cooldowns are `Timers` entries on `Date.now()`, not `setTimeout`s; mocking
 * `setTimeout` (what this used to do) mocked nothing the skills read.
 */
function mockTimers (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
}

/** A player standing on the centre of a cell, who has never moved: facing East. */
function playerOnCell (): Player {
  const at = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))
  const player = new Player(at.x, at.y, 0, 'aimer')
  World.PLAYERS.push(player)
  return player
}

function offsetCell (from: Vector, dq: number, dr: number): Vector {
  return new Vector(from.x + dq, from.y + dr)
}

function mobAt (position: Vector): Unit {
  const mob = new Unit(ObjectType.Mob, position.x, position.y, 10, 0)
  mob.hp = 100
  World.MOBS.push(mob)
  return mob
}

/** Distance from point p to the segment a-b. */
function distanceToSegment (p: Vector, a: Vector, b: Vector): number {
  const ab = b.sub(a)
  const len2 = ab.getSquareMagnitude()
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2))
  return p.sub(a.add(ab.multiply(t))).getMagnitude()
}

function throwables (): Throwable[] {
  return World.PROJECTILES.filter((o) => o.type === ObjectType.Throwable) as Throwable[]
}

// --- the wire ---------------------------------------------------------------

test('parseSkill reads [uint8 slot][int16 q][int16 r] big-endian, negatives included', () => {
  const buf = Buffer.alloc(5)
  buf.writeUInt8(5, 0)
  buf.writeInt16BE(-3, 1)
  buf.writeInt16BE(1234, 3)

  const press = Multiplayer.parseSkill(buf)
  assert.deepEqual(press, { slot: 5, aimCell: new Vector(-3, 1234) })

  // What socket.io hands the server for a browser ArrayBuffer can arrive as a
  // Uint8Array view; read it the same way.
  const view = new Uint8Array(buf)
  assert.deepEqual(Multiplayer.parseSkill(view), { slot: 5, aimCell: new Vector(-3, 1234) })
})

test('parseSkill accepts a bare number as the slot with no aim', () => {
  assert.deepEqual(Multiplayer.parseSkill(2), { slot: 2 })
})

test('parseSkill ignores anything else', () => {
  assert.equal(Multiplayer.parseSkill(Buffer.alloc(4)), undefined, 'a 4-byte buffer is short')
  assert.equal(Multiplayer.parseSkill(Buffer.alloc(0)), undefined)
  assert.equal(Multiplayer.parseSkill('2'), undefined)
  assert.equal(Multiplayer.parseSkill({ slot: 2 }), undefined)
  assert.equal(Multiplayer.parseSkill(null), undefined)
  assert.equal(Multiplayer.parseSkill(undefined), undefined)
})

test('onSkill hands the parsed slot and absolute cell to tryExecuteSkill intact', () => {
  const calls: Array<[number, Vector | undefined]> = []
  const player = { exited: false, destroyed: false, tryExecuteSkill: (i: number, a?: Vector) => calls.push([i, a]) }
  const connection = { player } as any

  const buf = Buffer.alloc(5)
  buf.writeUInt8(6, 0)
  buf.writeInt16BE(40, 1)
  buf.writeInt16BE(-7, 3)
  Multiplayer.prototype.onSkill.call(null, connection, buf)
  Multiplayer.prototype.onSkill.call(null, connection, 3)
  Multiplayer.prototype.onSkill.call(null, connection, 'junk')
  Multiplayer.prototype.onSkill.call(null, connection, Buffer.alloc(2))

  assert.deepEqual(calls, [[6, new Vector(40, -7)], [3, undefined]])
})

test('tryExecuteSkill ignores a slot that is not a whole number in range', () => {
  const player = playerOnCell()
  for (const bad of [-1, 8, 1.5, NaN]) {
    assert.doesNotThrow(() => { player.tryExecuteSkill(bad) }, `slot ${bad} threw`)
  }
})

// --- projectiles ------------------------------------------------------------

for (const { name, make } of [
  { name: 'fireball', make: (owner: Unit) => new ThrowFireball(owner) },
  { name: 'icicle', make: (owner: Unit) => new Throwicicle(owner) }
]) {
  test(`a thrown ${name} aimed 5 cells out at a non-hex angle flies through that cell's centre and on`, (t) => {
    mockTimers(t)
    const player = playerOnCell()
    // (+3, +2): hex distance 5, about 23 degrees below East - between E and SE,
    // so it is reachable only by aiming, never by a snapped facing.
    const aim = offsetCell(player.cell, 3, 2)
    assert.equal(Hex.distance(player.cell, aim), 5)
    const centre = Hex.toPosition(aim)

    assert.equal(make(player).execute(aim), true)
    const [projectile] = throwables()
    assert.ok(projectile !== undefined, 'nothing was thrown')

    let closest = Infinity
    let prev = projectile.position
    const start = projectile.position
    for (let i = 0; i < 4; i++) {
      for (const obj of throwables()) obj.update(DT)
      closest = Math.min(closest, distanceToSegment(centre, prev, projectile.position))
      prev = projectile.position
    }

    assert.ok(closest < 1e-6, `passed ${closest} units from the aimed cell's centre`)
    // It keeps flying past the cell: 4 ticks at 300 u/s is 300 units, and the
    // cell centre is about 196 units out.
    const travelled = projectile.position.sub(start).getMagnitude()
    const toCentre = centre.sub(start).getMagnitude()
    assert.ok(travelled > toCentre + Hex.SIZE, `stopped at ${travelled}, centre at ${toCentre}`)
  })

  test(`a thrown ${name} aimed at the caster's own cell falls back to facing`, (t) => {
    mockTimers(t)
    const player = playerOnCell()
    player.direction = new Vector(0, -1) // facing North
    player.stop()

    assert.equal(make(player).execute(player.cell), true)
    const [projectile] = throwables()
    // Hex-cells P3: it flies a hex line, so an unaimed cast goes along the hex
    // facing, `FACING_INDEX(facing)`, as RangedAttack does. North is not one
    // of the six; it snaps to a northern neighbour.
    const d = World.FACING_INDEX(player.facing)
    assert.deepEqual(projectile.line[1], Hex.neighbour(player.cell, d), 'did not fly along the hex facing')
    assert.ok(Hex.toPosition(projectile.line[1]).y < Hex.toPosition(player.cell).y, 'the hex facing is not northward')
    assert.equal(projectile.line.length, 11)
  })
}

// --- ranged -----------------------------------------------------------------

test('a ranged shot aimed off the hex axes hits the unit on the aimed cell, not the one along facing', () => {
  const player = playerOnCell()
  const aim = offsetCell(player.cell, 3, 2)
  const aimed = mobAt(Hex.toPosition(aim))
  const ahead = mobAt(player.position.add(new Vector(3 * Hex.SIZE, 0)))

  player.tryExecuteSkill(2, aim)

  assert.equal(aimed.hp, 100 - World.config.ranged, 'missed the aimed cell')
  assert.equal(ahead.hp, 100, 'fired along facing')
  assert.deepEqual(effects.map((e) => [e.type, e.aimCell]), [[3, aim]], 'the effect did not carry the aim')
})

test('a bare-number press still fires the ranged shot along facing, with an unaimed effect', () => {
  const player = playerOnCell()
  const ahead = mobAt(player.position.add(new Vector(3 * Hex.SIZE, 0)))

  const press = Multiplayer.parseSkill(2)
  assert.ok(press !== undefined)
  player.tryExecuteSkill(press.slot, press.aimCell)

  assert.equal(ahead.hp, 100 - World.config.ranged, 'the old message no longer fires')
  assert.deepEqual(effects.map((e) => [e.type, e.aimCell]), [[3, undefined]])
})

// --- cones ------------------------------------------------------------------

test('an aim exactly between two directions snaps clockwise, every time', () => {
  const player = playerOnCell()
  // (+1, +1) sits at exactly 30 degrees below East: halfway between E and SE.
  const halfwaySE = offsetCell(player.cell, 1, 1)
  // (+2, -1) sits at exactly 30 degrees above East: halfway between NE and E.
  const halfwayNE = offsetCell(player.cell, 2, -1)
  for (let i = 0; i < 3; i++) {
    assert.equal(SectorArea.aimIndex(player, halfwaySE), 1, 'E/SE did not round to SE')
    assert.equal(SectorArea.aimIndex(player, halfwayNE), 0, 'NE/E did not round to E')
  }
  // Off-axis but not halfway: (+3, +2) is 23 degrees below East, nearer E.
  assert.equal(SectorArea.aimIndex(player, offsetCell(player.cell, 3, 2)), 0)
  assert.equal(SectorArea.aimIndex(player, player.cell), undefined, 'own cell is not an aim')
  assert.equal(SectorArea.aimIndex(player, undefined), undefined)
})

test('an aimed breath holds its direction when the caster turns mid-breath', (t) => {
  mockTimers(t)
  const player = playerOnCell()
  // Aimed West while facing East.
  const aim = offsetCell(player.cell, -3, 0)
  const west = mobAt(Hex.toPosition(offsetCell(player.cell, -2, 0)))
  const east = mobAt(Hex.toPosition(offsetCell(player.cell, 2, 0)))

  assert.equal(new IceBreath(player).execute(aim), true)
  const [area] = World.AREA_EFFECT as SectorArea[]
  assert.equal(area.fixedDirection, 3)
  assert.equal(area.overlaps(west.position), true, 'the cone is not aimed West')

  // Turn round and stop: an unaimed cone would swing East with the caster.
  player.direction = new Vector(1, 0)
  player.stop()
  assert.equal(World.FACING_INDEX(player.facing), 0)
  assert.equal(area.overlaps(west.position), true, 'the cone followed facing')
  assert.equal(area.overlaps(east.position), false, 'the cone followed facing')

  // The effect carries the tip of the cone, 3 cells straight West.
  assert.deepEqual(effects.map((e) => [e.type, e.aimCell]), [[1, offsetCell(player.cell, -3, 0)]])
})

test('an unaimed breath still follows facing, with an unaimed effect', (t) => {
  mockTimers(t)
  const player = playerOnCell()
  const east = Hex.toPosition(offsetCell(player.cell, 2, 0))
  const west = Hex.toPosition(offsetCell(player.cell, -2, 0))

  assert.equal(new IceBreath(player).execute(), true)
  const [area] = World.AREA_EFFECT as SectorArea[]
  assert.equal(area.overlaps(east), true)
  player.direction = new Vector(-1, 0)
  assert.equal(area.overlaps(west), true, 'the unaimed cone stopped following facing')
  assert.deepEqual(effects.map((e) => e.aimCell), [undefined])
})

test('a boss cones at its target, not along its facing', (t) => {
  mockTimers(t)
  const at = Hex.toPosition(Hex.toCell(new Vector(2000, 2000)))
  const boss = new Mob(at.x, at.y, 0, ARCHETYPES.boss)
  World.MOBS.push(boss)
  // The boss has never moved, so it faces East. Its target is two cells
  // North-West, which no facing-based cone could reach.
  const targetCell = offsetCell(boss.cell, 0, -2)
  const target = new Player(Hex.toPosition(targetCell).x, Hex.toPosition(targetCell).y, 0, 'victim')
  World.PLAYERS.push(target)
  boss.target = target

  const routine = boss.routines.find((r) => r instanceof UseSkillOnTarget) as UseSkillOnTarget
  assert.ok(routine !== undefined && routine.skill instanceof FireBreath)
  routine.update(DT)

  const [area] = World.AREA_EFFECT as SectorArea[]
  assert.ok(area !== undefined, 'the boss did not breathe')
  assert.equal(area.fixedDirection, 4, 'not coned North-West')
  assert.equal(area.overlaps(target.position), true, 'the target is not in the cone')
  assert.equal(area.overlaps(Hex.toPosition(offsetCell(boss.cell, 2, 0))), false, 'coned East along facing')
})

// --- the effect record ------------------------------------------------------

test('the effect record is 4 bytes unaimed and 8 with the aim appended', () => {
  const mp = Object.create(Multiplayer.prototype) as Multiplayer
  const player = playerOnCell()
  const connection = { id: 'c', player }
  ;(mp as any)._connections = [connection]
  // hex-cells P1: effects find their recipients through World.INTEREST and the
  // player's registered connection, not by walking _connections.
  ;(mp as any).attach(connection, player)
  ;(mp as any)._buffer = {}

  mp.effect(3, player, 1)
  mp.effect(0, player, 1000, new Vector(-2, 300))

  const [plain, aimed] = (mp as any)._buffer.c.effect as Buffer[]
  assert.equal(plain.length, 4)
  assert.equal(aimed.length, 8)
  assert.equal(aimed.readInt8(0), 0)
  assert.equal(aimed.readUInt16BE(1), player.id)
  assert.equal(aimed.readInt8(3), 10)
  assert.equal(aimed.readInt16BE(4), -2)
  assert.equal(aimed.readInt16BE(6), 300)
})
