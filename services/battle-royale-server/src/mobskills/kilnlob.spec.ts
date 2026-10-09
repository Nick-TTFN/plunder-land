import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import Obstacle from '../objects/obstacle'
import { type Unit } from '../objects/unit'
import UseSkillOnTarget from '../ai/useskillontarget'
import GuardPosition from '../ai/guardposition'
import { ARCHETYPES } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { KilnLob } from './kilnlob'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * The Walking Kiln (decision #51, task l1-4): its lob is an effect and an
 * ownerless timer (the bomb's pattern), it hurts players only, and its guard
 * keeps a 5-6 ring band off its target. Numbers PROVISIONAL (l1-0).
 */

interface Sent { type: number, originator: number, lifetime: number, cell: Vector, tag: number }
let sent: Sent[] = []

beforeEach(() => {
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  sent = []
  Multiplayer.Instance = {
    create: noop,
    update: noop,
    destroy: noop,
    effect: noop,
    redis: { hincrby: async () => 1 },
    effectAt: (type: number, originator: number, lifetime: number, cell: Vector, tag: number) => {
      sent.push({ type, originator, lifetime, cell, tag })
    }
  } as unknown as Multiplayer

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
})

afterEach(() => { mock.restoreAll() })

const HOME = Hex.toCell(new Vector(2000, 2000))
const DT = 0.25
const FLIGHT = 1250
const DAMAGE = 30

const cellAt = (dq: number, dr = 0): Vector => new Vector(HOME.x + dq, HOME.y + dr)
const at = (dq: number, dr = 0): Vector => Hex.toPosition(cellAt(dq, dr))

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function kilnAt (dq: number, dr = 0): Mob {
  const p = at(dq, dr)
  const kiln = new Mob(p.x, p.y, 0, ARCHETYPES.kiln)
  World.MOBS.push(kiln)
  return kiln
}

function playerAt (dq: number, dr = 0, id = 'p1'): Player {
  const p = at(dq, dr)
  const player = new Player(p.x, p.y, 0, id)
  World.PLAYERS.push(player)
  return player
}

function lobOf (kiln: Unit): KilnLob {
  const routine = kiln.routines.find((r) => r instanceof UseSkillOnTarget) as UseSkillOnTarget
  assert.ok(routine.skill instanceof KilnLob)
  return routine.skill
}

/** Hp plus armor: a Kiln's 30 lands on the armor first. */
const life = (unit: Unit): number => unit.hp + unit.armor

test('the Kiln row: a 7-cell lob of 30 on a 1-ring blast after 1250 ms, every 3500 ms, cast within 7 (PROVISIONAL l1-0)', () => {
  assert.deepEqual(ARCHETYPE_INFO.kiln.attack, { kind: 'lob', range: 7, rings: 1 })
  const kiln = kilnAt(0)
  const lob = lobOf(kiln)
  assert.deepEqual([lob.range, lob.rings, lob.flightMs, lob.cooldown], [7, 1, FLIGHT, 3500])
  assert.equal(lob.damage, undefined, 'a SkillSpec damage override would hide the row\'s number')
  const use = kiln.routines.find((r) => r instanceof UseSkillOnTarget) as UseSkillOnTarget
  assert.equal(use.withinCells, 7)
  assert.ok(kiln.routines[0] instanceof GuardPosition, 'the guard runs first: it picks the target')
  assert.deepEqual(ARCHETYPES.kiln.routines[0], { ...ARCHETYPES.kiln.routines[0], retreat: { min: 5, max: 6 } })
  assert.deepEqual(ARCHETYPES.kiln.killStats, ['mobKills', 'rareKills'])
})

test('the damage lands only on the marked cells, and only once the flight is over', (t) => {
  mockClock(t)
  const kiln = kilnAt(-6)
  const centre = playerAt(0, 0, 'centre')
  const ring = playerAt(1, -1, 'ring')
  const outside = playerAt(2, 0, 'outside')
  const before = [centre, ring, outside].map(life)

  assert.equal(lobOf(kiln).execute(cellAt(0)), true)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { type: NPC_EFFECT.kilnLob, originator: kiln.id, lifetime: FLIGHT, cell: cellAt(0), tag: 0 })

  advance(t, FLIGHT - 1)
  assert.deepEqual([centre, ring, outside].map(life), before, 'damage before the flight ended')
  assert.equal(sent.length, 1)

  advance(t, 1)
  assert.deepEqual([centre, ring, outside].map(life), [before[0] - DAMAGE, before[1] - DAMAGE, before[2]])
  assert.equal(sent.length, 2)
  assert.deepEqual([sent[1].type, sent[1].originator, sent[1].cell, sent[1].tag], [NPC_EFFECT.kilnBlast, kiln.id, cellAt(0), 0])
})

test('the lob lands after the Kiln died, and its kill is the Kiln\'s, by a mob', (t) => {
  mockClock(t)
  const kiln = kilnAt(-6)
  const victim = playerAt(0)
  victim.armor = 0
  victim.hp = DAMAGE
  assert.equal(lobOf(kiln).execute(cellAt(0)), true)

  assert.equal(kiln.hit(9999), true)
  assert.equal(kiln.destroyed, true)
  advance(t, FLIGHT)

  assert.equal(victim.destroyed, true, 'the landing was cancelled with its Kiln')
  assert.equal(victim.killer, kiln)
  assert.equal(victim.killedBy, 'mob')
  assert.equal(sent.filter((s) => s.type === NPC_EFFECT.kilnBlast).length, 1)
})

test('a player who leaves the marked cells before the landing takes nothing', (t) => {
  mockClock(t)
  const kiln = kilnAt(-6)
  const player = playerAt(0)
  const before = life(player)
  assert.equal(lobOf(kiln).execute(player.cell), true)

  advance(t, FLIGHT / 2)
  player.position = at(2)
  advance(t, FLIGHT / 2)

  assert.equal(life(player), before)
  assert.equal(sent.filter((s) => s.type === NPC_EFFECT.kilnBlast).length, 1, 'the blast is still shown')
})

test('a mob on the marked cells takes nothing (#51 Q6: mob attacks hurt players only)', (t) => {
  mockClock(t)
  const kiln = kilnAt(-6)
  const grunt = new Mob(at(0).x, at(0).y, 0, ARCHETYPES.grunt)
  World.MOBS.push(grunt)
  const near = kilnAt(1)
  const hp = [grunt.hp, near.hp, kiln.hp]
  assert.equal(lobOf(kiln).execute(cellAt(0)), true)
  advance(t, FLIGHT)
  assert.deepEqual([grunt.hp, near.hp, kiln.hp], hp)
  assert.equal(grunt.target, undefined, 'a lob provokes nothing')
})

test('a lob further than 7 cells, or with no aim, is refused and does not spend the cooldown', (t) => {
  mockClock(t)
  const kiln = kilnAt(0)
  const lob = lobOf(kiln)
  assert.equal(lob.execute(cellAt(8)), false)
  assert.equal(lob.execute(undefined), false)
  assert.equal(sent.length, 0)
  assert.equal(lob.execute(cellAt(7)), true)
  advance(t, 3499)
  assert.equal(lob.execute(cellAt(7)), false, 'within the cooldown')
  advance(t, 1)
  assert.equal(lob.execute(cellAt(7)), true)
})

test('a Kiln lobs at its target\'s cell at the cast, within 7 cells, and not beyond', (t) => {
  mockClock(t)
  const kiln = kilnAt(0)
  const player = playerAt(6)
  kiln.update(DT)
  assert.equal(kiln.target, player)
  const lobs = sent.filter((s) => s.type === NPC_EFFECT.kilnLob)
  assert.equal(lobs.length, 1)
  assert.deepEqual(lobs[0].cell, cellAt(6))

  // A target 8 away (kept, since lose is 9): it holds fire, cooldown unspent.
  advance(t, 3500)
  const far = kilnAt(20)
  const use = far.routines.find((r) => r instanceof UseSkillOnTarget) as UseSkillOnTarget
  far.target = playerAt(28, 0, 'far')
  sent.length = 0
  use.update(DT)
  assert.equal(sent.length, 0, 'lobbed at 8 cells')
  far.target = playerAt(27, 0, 'near')
  use.update(DT)
  assert.equal(sent.length, 1, 'held fire at 7 cells')
})

/**
 * The band. The Kiln stands on HOME and the player stands still `rings` east;
 * 12 ticks (3 s) is time for four cells at chase speed 70 (a cell is 45
 * units, 0.64 s). The distance after each tick.
 */
function bandRun (t: TestContext, rings: number): number[] {
  const kiln = kilnAt(0)
  // The guard alone: a lob changes nothing here, but keep the run pure.
  kiln.routines.length = 1
  const player = playerAt(rings)
  const seen: number[] = []
  for (let i = 0; i < 12; i++) {
    kiln.update(DT)
    advance(t, DT * 1000)
    seen.push(Hex.distance(kiln.cell, player.cell))
  }
  return seen
}

test('a Kiln with a player at 3 or 4 rings steps away until 5 off', (t) => {
  mockClock(t)
  for (const rings of [3, 4]) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const seen = bandRun(t, rings)
    assert.equal(seen[seen.length - 1], 5, `from ${rings}: ${seen.join(',')}`)
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `from ${rings}: closed in on the way out (${seen.join(',')})`)
  }
})

test('a Kiln with a player at 5 or 6 rings holds', (t) => {
  mockClock(t)
  for (const rings of [5, 6]) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const kiln = kilnAt(0)
    kiln.routines.length = 1
    playerAt(rings)
    for (let i = 0; i < 8; i++) {
      kiln.update(DT)
      advance(t, DT * 1000)
    }
    assert.deepEqual(kiln.cell, HOME, `moved from ${rings}`)
  }
})

test('a Kiln whose target backs off to 8 rings closes to 6', (t) => {
  mockClock(t)
  const kiln = kilnAt(0)
  kiln.routines.length = 1
  // Noticed at 6 (acquire is 7), then it steps back to 8 (kept: lose is 9).
  const player = playerAt(6)
  kiln.update(DT)
  assert.equal(kiln.target, player)
  player.position = at(8)
  const seen: number[] = []
  for (let i = 0; i < 12; i++) {
    kiln.update(DT)
    advance(t, DT * 1000)
    seen.push(Hex.distance(kiln.cell, player.cell))
  }
  assert.equal(kiln.target, player)
  assert.equal(seen[seen.length - 1], 6, seen.join(','))
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] <= seen[i - 1], `backed off on the way in (${seen.join(',')})`)
})

test('backing away is greedy: walled in behind, it stays put rather than closing', (t) => {
  mockClock(t)
  const kiln = kilnAt(0)
  kiln.routines.length = 1
  playerAt(3)
  // Every neighbour that is not nearer the player: blocked.
  for (let i = 0; i < 6; i++) {
    const n = Hex.neighbour(HOME, i)
    if (Hex.distance(n, cellAt(3)) >= 3) new Obstacle(Hex.toPosition(n).x, Hex.toPosition(n).y, 0) // eslint-disable-line no-new
  }
  for (let i = 0; i < 6; i++) {
    kiln.update(DT)
    advance(t, DT * 1000)
  }
  assert.deepEqual(kiln.cell, HOME)
  assert.equal(kiln.stepBlocked, true)
})
