import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob, { MobPack } from '../objects/mob'
import { type GameObject } from '../objects/gameobject'
import GuardPosition from '../ai/guardposition'
import Slowdown from '../buffs/slowdown'
import FieldSlow from '../buffs/fieldslow'
import CoilField from './coilfield'
import { ARCHETYPES, LAYERS, type CoilFieldSpec, type GuardSpec, isPackEntry } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
// The client's pulse timing imports nothing, so it loads here.
import { COIL_PULSE } from '../../../../plunder-land-client/src/vfx/coilfield'

/**
 * Task l1-3 (decision #51): the Coil Tripod's slowing field, the `FieldSlow`
 * buff it applies, and its escort row. Players update before mobs, as in
 * `World.update`, so a slow applied on a tick is walked at from the next.
 */

const DT = 0.25

/** Effects sent: [type, originator id, lifetime, cell?]. */
let effects: Array<{ type: number, id: number, lifetime: number, cell?: Vector }> = []

beforeEach(() => {
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  effects = []
  Multiplayer.Instance = {
    create: noop,
    update: noop,
    destroy: noop,
    effect: (type: number, obj: GameObject, lifetime: number) => { effects.push({ type, id: obj.id, lifetime }) },
    effectAt: (type: number, id: number, lifetime: number, cell: Vector) => { effects.push({ type, id, lifetime, cell }) }
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

afterEach(() => {
  mock.restoreAll()
})

const HOME = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))
const east = (cells: number): Vector => Hex.toPosition(Hex.toCell(HOME).add(new Vector(cells, 0)))

const FIELD = ARCHETYPES.coil.routines.find((r) => r.kind === 'coilField') as CoilFieldSpec
const GUARD = ARCHETYPES.coil.routines.find((r) => r.kind === 'guard') as GuardSpec
const RINGS = 2

function mockDate (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

function addCoil (at: Vector = HOME): Mob {
  const coil = new Mob(at.x, at.y, 0, ARCHETYPES.coil)
  World.MOBS.push(coil)
  return coil
}

function addPlayer (at: Vector, name = 'p1'): Player {
  const player = new Player(at.x, at.y, 0, name)
  World.PLAYERS.push(player)
  return player
}

/** One world tick: the clock, timers, players, then mobs. */
function tick (t: TestContext): void {
  t.mock.timers.tick(250)
  Timers.run(Date.now())
  // A dead player is not updated, as in `World.update`; it stays in the
  // cell index (and so findable) until the sweep, which this never runs.
  for (const p of World.PLAYERS) if (!p.destroyed) p.update(DT)
  for (const m of World.MOBS) if (!m.destroyed) m.update(DT)
}

const fieldOf = (coil: Mob): CoilField => coil.routines.find((r) => r instanceof CoilField) as CoilField
const of = (type: number): typeof effects => effects.filter((e) => e.type === type)

// --- the row ------------------------------------------------------------------------

test('coil: guard then field, standoff = the field\'s rings = the mirrored disc, l1-0 numbers', () => {
  const coil = addCoil()
  assert.deepEqual(coil.routines.map((r) => r.constructor), [GuardPosition, CoilField])
  assert.deepEqual(ARCHETYPE_INFO.coil.attack, { kind: 'disc', rings: RINGS })
  assert.equal(fieldOf(coil).rings, RINGS)
  assert.equal(GUARD.standoff, RINGS)
  assert.deepEqual(
    [GUARD.acquire, GUARD.lose, GUARD.chaseSpeed, FIELD.slow, FIELD.tellMs, FIELD.holdMs, FIELD.coolMs, FIELD.tailMs, FIELD.cooldownMs],
    [5, 6, 90, 0.6, 1500, 1500, 700, 500, 6000])
  assert.equal(ARCHETYPES.coil.contact.damage, 0)
})

test('the client splits the pulse at the same tell the server holds', () => {
  assert.deepEqual({ ...COIL_PULSE }, { tellMs: FIELD.tellMs, holdMs: FIELD.holdMs, rings: RINGS })
})

test('an escort Coil spawned with a pack shares its home and stands off at its field\'s edge', () => {
  const entry = LAYERS[2].mobs.find(isPackEntry)
  assert.ok(entry?.escort === ARCHETYPES.coil, 'layer -2 packs carry a Coil escort')
  const pack = new MobPack(entry, HOME)
  const crawler = new Mob(east(1).x, east(1).y, 0, ARCHETYPES.crawler)
  const coil = new Mob(east(-1).x, east(-1).y, 0, ARCHETYPES.coil)
  pack.join(crawler)
  pack.join(coil)
  const guard = coil.routines[0] as GuardPosition
  assert.equal(guard.homePosition, HOME)
  assert.equal(guard.chaseStop, RINGS)
})

// --- FieldSlow ----------------------------------------------------------------------

test('a field applied 20 ticks running leaves the speed at one factor, one buff', (t) => {
  mockDate(t)
  const player = addPlayer(HOME)
  const cues: boolean[] = []
  for (let i = 0; i < 20; i++) {
    cues.push(FieldSlow.apply(player, 0.6, Date.now() + 500))
    t.mock.timers.tick(250)
    player.update(DT)
  }
  assert.equal(player.maxVelocity, 84)
  assert.equal(player.buffs.filter((b) => b instanceof FieldSlow).length, 1)
  // A cue on onset, then only on a refresh past half of what the last cue
  // announced: a sliding 500 ms slow refreshed every 250 ms is at half on the
  // next tick (no cue) and past it on the one after, so every second tick,
  // not every tick. (A real Coil's hold has one fixed end: one cue.)
  assert.deepEqual(cues, Array.from({ length: 20 }, (_, i) => i % 2 === 0))
})

test('the slowed cue is sent again only when refreshed after more than half its time', (t) => {
  mockDate(t)
  const player = addPlayer(HOME)
  const now = Date.now()
  assert.equal(FieldSlow.apply(player, 0.6, now + 2000, now), true)
  assert.equal(FieldSlow.apply(player, 0.6, now + 2500, now + 1000), false, 'at exactly half')
  assert.equal(FieldSlow.apply(player, 0.6, now + 3000, now + 1001), true, 'past half')
  assert.equal(FieldSlow.apply(player, 0.6, now + 2000, now + 2900), false, 'an earlier end changes nothing')
  assert.equal(FieldSlow.on(player)?.endTime, now + 3000)
})

test('speed restores exactly after the slow ends, gear speed delta included', (t) => {
  mockDate(t)
  const player = addPlayer(HOME)
  const fast = { tier: 3 as const, skill: 6, rolls: [{ stat: 3, q: 1000 }, { stat: 1, q: 0 }] }
  // Geared before the slow.
  assert.ok(player.equipGear(0, fast))
  const geared = player.maxVelocity
  assert.equal(geared, 148.4)
  FieldSlow.apply(player, 0.6, Date.now() + 500)
  assert.equal(player.maxVelocity, 89)
  t.mock.timers.tick(501)
  player.update(DT)
  assert.equal(player.maxVelocity, geared)
  assert.equal(player.buffs.length, 0)

  // Geared during the slow: the delta lands on top and survives the restore.
  const other = addPlayer(HOME, 'p2')
  FieldSlow.apply(other, 0.6, Date.now() + 500)
  assert.equal(other.maxVelocity, 84)
  assert.ok(other.equipGear(0, fast))
  t.mock.timers.tick(501)
  other.update(DT)
  assert.equal(other.maxVelocity, 148.4)
})

test('Icicle and Coil multiply, and restore to base in either end order', (t) => {
  mockDate(t)
  for (const coilEndsFirst of [true, false]) {
    for (const coilFirst of [true, false]) {
      const player = addPlayer(HOME, `p${String(coilEndsFirst)}${String(coilFirst)}`)
      const coilEnd = Date.now() + (coilEndsFirst ? 500 : 1500)
      const icicleMs = coilEndsFirst ? 1500 : 500
      if (coilFirst) FieldSlow.apply(player, 0.6, coilEnd)
      player.addBuff(new Slowdown(player, icicleMs))
      if (!coilFirst) FieldSlow.apply(player, 0.6, coilEnd)
      assert.equal(player.maxVelocity, 42, 'x0.6 x0.5 = x0.3 of 140')
      t.mock.timers.tick(501)
      player.update(DT)
      assert.ok(player.maxVelocity > 42 && player.maxVelocity < 140, 'one of the two ended')
      t.mock.timers.tick(1000)
      player.update(DT)
      assert.equal(player.maxVelocity, 140, `coilEndsFirst ${String(coilEndsFirst)} coilFirst ${String(coilFirst)}`)
      assert.equal(player.buffs.length, 0)
    }
  }
})

test('FieldSlow refuses anything but a player', () => {
  const mob = addCoil(east(4))
  const speed = mob.maxVelocity
  assert.equal(FieldSlow.apply(mob, 0.6, Date.now() + 2000), false)
  assert.equal(mob.maxVelocity, speed)
  assert.equal(mob.buffs.length, 0)
})

// --- the charge ----------------------------------------------------------------------

test('a charge: tell, then a held field that slows players on it until the tail ends, planted throughout', (t) => {
  mockDate(t)
  const coil = addCoil()
  const near = addPlayer(east(2), 'near')
  const far = addPlayer(east(3), 'far')
  const start = Date.now()

  // The guard acquires `near` (nearest) and the field starts at once: within 2 rings.
  coil.update(DT)
  assert.equal(coil.target, near)
  const pulses = of(NPC_EFFECT.coilPulse)
  assert.equal(pulses.length, 1)
  assert.equal(pulses[0].id, coil.id)
  assert.equal(pulses[0].lifetime, FIELD.tellMs + FIELD.holdMs)
  assert.deepEqual(pulses[0].cell, Hex.toCell(HOME))

  // The tell: nothing slowed, and the Coil does not move.
  const speeds: number[] = []
  const at = coil.position
  while (Date.now() - start < FIELD.tellMs - 250) {
    tick(t)
    speeds.push(near.maxVelocity)
    assert.deepEqual(coil.position, at, 'moved during the charge')
  }
  assert.ok(speeds.every((s) => s === 140), 'slowed during the tell')

  // The hold: slowed from its first tick; `far` (3 rings) never.
  tick(t)
  assert.equal(Date.now() - start, FIELD.tellMs)
  assert.equal(near.maxVelocity, 84)
  assert.equal(far.maxVelocity, 140)
  assert.equal(of(NPC_EFFECT.slowed).length, 1)
  assert.equal(of(NPC_EFFECT.slowed)[0].id, near.id)
  assert.equal(of(NPC_EFFECT.slowed)[0].lifetime, FIELD.holdMs + FIELD.tailMs)

  // `far` walks onto the field mid-hold and is caught to the same end.
  far.position = east(-2)
  tick(t)
  assert.equal(far.maxVelocity, 84)

  // Slowed through the hold and the tail, back to 140 the tick after.
  const end = start + FIELD.tellMs + FIELD.holdMs + FIELD.tailMs
  while (Date.now() < end) {
    tick(t)
    assert.equal(near.maxVelocity, 84, `at ${Date.now() - start}`)
    assert.deepEqual(coil.position, at, 'moved during the charge')
  }
  tick(t)
  assert.equal(near.maxVelocity, 140)
  assert.equal(far.maxVelocity, 140)
  // One cue per slowed player for the whole charge.
  assert.equal(of(NPC_EFFECT.slowed).length, 2)

  // Start to start: no second charge before the cooldown, one at it.
  while (Date.now() - start < FIELD.cooldownMs - 250) tick(t)
  assert.equal(of(NPC_EFFECT.coilPulse).length, 1)
  tick(t)
  assert.equal(of(NPC_EFFECT.coilPulse).length, 2)
})

test('a mob on the field is never slowed', (t) => {
  mockDate(t)
  const coil = addCoil()
  addPlayer(east(2))
  const crawler = new Mob(east(1).x, east(1).y, 0, ARCHETYPES.crawler)
  World.MOBS.push(crawler)
  const speeds: number[] = []
  for (let i = 0; i < 12; i++) {
    tick(t)
    // Read after the coil's update: a slow would show until the guard's refresh.
    speeds.push(crawler.maxVelocity)
  }
  assert.ok(of(NPC_EFFECT.slowed).length > 0, 'the field never held')
  assert.equal(crawler.buffs.length, 0)
  assert.equal(coil.buffs.length, 0)
  assert.ok(speeds.every((s) => s === 30 || s === 90), `speeds ${speeds.join(',')}`)
})

test('no charge for a target beyond the field, and none after the Coil dies mid-tell', (t) => {
  mockDate(t)
  const coil = addCoil()
  const player = addPlayer(east(4))
  coil.update(DT)
  assert.equal(coil.target, player)
  assert.equal(of(NPC_EFFECT.coilPulse).length, 0, 'charged at 4 rings')

  player.position = east(2)
  coil.stepGoal = undefined
  // Wait out any step under way so the coil is at a centre, then charge.
  tick(t)
  assert.equal(of(NPC_EFFECT.coilPulse).length, 1)
  coil.hit(1000)
  assert.ok(coil.destroyed)
  for (let i = 0; i < 12; i++) tick(t)
  assert.equal(player.maxVelocity, 140)
  assert.equal(of(NPC_EFFECT.slowed).length, 0)
})

test('dead and extracted players on the field are left alone', (t) => {
  mockDate(t)
  const coil = addCoil()
  const target = addPlayer(east(1), 'target')
  const gone = addPlayer(east(-1), 'gone')
  gone.exited = true
  // Killed this tick: destroyed, but still on its cell in the index until
  // the sweep (CLAUDE.md, "A dead unit stays findable").
  const dead = addPlayer(Hex.toPosition(Hex.toCell(HOME).add(new Vector(0, 1))), 'dead')
  dead.destroy()
  assert.ok(dead.destroyed)
  assert.ok(World.FIND_IN_CELLS(Hex.toCell(HOME), RINGS, 0, dead.type).includes(dead), 'the dead player is not findable, so this proves nothing')
  coil.update(DT)
  assert.equal(coil.target, target)
  for (let i = 0; i < 7; i++) tick(t)
  assert.equal(target.maxVelocity, 84)
  assert.equal(gone.maxVelocity, 140)
  assert.equal(dead.maxVelocity, 140)
  assert.deepEqual(of(NPC_EFFECT.slowed).map((e) => e.id), [target.id])
})

test('a charging Coil stays planted when its target walks off, and its field stays on its cell', (t) => {
  mockDate(t)
  const coil = addCoil()
  const player = addPlayer(east(2))
  coil.update(DT)
  assert.equal(of(NPC_EFFECT.coilPulse).length, 1)
  const at = coil.position
  // Out of the field but still within the guard's lose range (6): an
  // unplanted Coil would close to its standoff.
  player.position = east(5)
  for (let i = 0; i < 14; i++) {
    tick(t)
    assert.deepEqual(coil.position, at, `moved ${i + 1} tick(s) into the charge`)
  }
  assert.equal(player.maxVelocity, 140, 'slowed off the field')
  // After the cool (3.7 s; 3.75 at ticks) it chases again.
  for (let i = 0; i < 4; i++) tick(t)
  assert.notDeepEqual(coil.position, at, 'still planted after the clip')
})
