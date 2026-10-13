import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import { type Archetype, ARCHETYPES } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { IceBreath } from '../skills/icebreath'
import FieldSlow from './fieldslow'
import { FREEZE, chill } from './freeze'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Task ice-1 (decision #54): the ice skills' chill and freeze on mobs, weaker
 * metal, what a frozen NPC does not do, and Ice Breath's player slow. The
 * clock is driven as `World.update` drives it: 250 ms, due timers, players,
 * then the mobs from the last to the first, the dead swept.
 */

const DT = 0.25
const TICK_MS = 250
const T0 = 1_000_000

interface Sent { type: number, originator: number, lifetime: number, at: number }
let sent: Sent[] = []

beforeEach(() => {
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  sent = []
  Multiplayer.Instance = {
    create: noop,
    update: noop,
    destroy: noop,
    redis: { hincrby: async () => 1 },
    effect: (type: number, originator: Unit, lifetime: number) => {
      sent.push({ type, originator: originator.id, lifetime, at: Date.now() })
    },
    effectAt: (type: number, originator: number, lifetime: number) => {
      sent.push({ type, originator, lifetime, at: Date.now() })
    }
  } as unknown as Multiplayer
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.GEAR.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  World.STEPS.clear()
  Timers.clear()
})

afterEach(() => { mock.restoreAll() })

const HOME = Hex.toCell(new Vector(2000, 2000))
const cellAt = (dq: number, dr: number = 0): Vector => new Vector(HOME.x + dq, HOME.y + dr)
const at = (dq: number, dr: number = 0): Vector => Hex.toPosition(cellAt(dq, dr))

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: T0 })
}

/** A mob of `archetype` on cell `dq` east of HOME; `inert` drops its routines. */
function mobAt (archetype: Archetype, dq = 0, inert = false): Mob {
  const p = at(dq)
  const mob = new Mob(p.x, p.y, 0, archetype)
  if (inert) mob.routines.length = 0
  World.addUnit(World.MOBS, mob)
  return mob
}

function playerAt (dq: number, dr = 0, id = 'p1'): Player {
  const p = at(dq, dr)
  const player = new Player(p.x, p.y, 0, id)
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

/** Casters for chill stacks: players off to the side, never updated. */
function casters (n: number): Player[] {
  const list: Player[] = []
  for (let i = 0; i < n; i++) list.push(new Player(100 + i * 100, 100, 0, `c${i}`))
  return list
}

function tick (t: TestContext): void {
  t.mock.timers.tick(TICK_MS)
  Timers.run(Date.now())
  for (const player of World.PLAYERS) if (!player.destroyed) player.update(DT)
  for (let i = World.MOBS.length - 1; i >= 0; i--) {
    const mob = World.MOBS[i]
    if (mob.destroyed) {
      World.removeUnitAt(World.MOBS, i)
      continue
    }
    mob.update(DT)
  }
}

const health = (unit: Unit): number => unit.hp + unit.armor
const frozenSent = (): Sent[] => sent.filter((s) => s.type === NPC_EFFECT.frozen)
/** Every claim `World.STEPS` holds for `unit`. */
const claimsOf = (unit: Unit): number => [...(World.STEPS.get(unit.tag)?.values() ?? [])].filter((u) => u === unit).length

/** Freeze `mob` for `ms` from now without the chill rules (the stun specs). */
function freezeFor (mob: Unit, ms: number): void {
  const until = Date.now() + ms
  mob.chill = { stacks: [], frozenUntil: until, lockoutUntil: until }
}

// --- the numbers ----------------------------------------------------------------------

test('FREEZE is Nick\'s accepted ice numbers (2026-10-12, #54)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(FREEZE)), {
    normal: { threshold: 1, windowMs: 4000, freezeMs: { icicle: 1500, breath: 1250 }, lockoutMs: 0 },
    boss: { threshold: 4, windowMs: 4000, freezeMs: { icicle: 750, breath: 750 }, lockoutMs: 20000 },
    damageTaken: 1.5,
    slow: { factor: 0.5, icicleMs: 2000, breathTailMs: 1000 }
  })
  assert.equal(NPC_EFFECT.frozen, 21)
})

// --- chill: normal mobs -----------------------------------------------------------------

for (const [skill, ms] of [['icicle', 1500], ['breath', 1250]] as const) {
  test(`a normal mob freezes on its first ${skill} chill for ${ms} ms, with one effect 21 on it`, (t) => {
    mockClock(t)
    const mob = mobAt(ARCHETYPES.grunt, 0, true)
    const [c] = casters(1)
    assert.equal(mob.frozen, false)
    assert.equal(chill(mob, c, skill), true)
    assert.equal(mob.frozen, true)
    assert.deepEqual(frozenSent().map((s) => [s.originator, s.lifetime]), [[mob.id, ms]])

    t.mock.timers.tick(ms - 1)
    assert.equal(mob.frozen, true)
    t.mock.timers.tick(1)
    assert.equal(mob.frozen, false, 'still frozen after its length')
  })
}

test('a frozen mob takes no chill (nothing extends a freeze); no lockout: it freezes again after the thaw', (t) => {
  mockClock(t)
  const mob = mobAt(ARCHETYPES.grunt, 0, true)
  const [a, b] = casters(2)
  assert.equal(chill(mob, a, 'icicle'), true)
  t.mock.timers.tick(1000)
  assert.equal(chill(mob, b, 'icicle'), false)
  assert.equal(mob.chill?.frozenUntil, T0 + 1500, 'a second chill moved the thaw')
  assert.equal(frozenSent().length, 1)

  t.mock.timers.tick(500)
  assert.equal(mob.frozen, false)
  assert.equal(chill(mob, a, 'breath'), true, 'a normal mob has no lockout')
  assert.equal(mob.chill?.frozenUntil, T0 + 1500 + 1250)
  assert.equal(frozenSent().length, 2)
})

test('a player is never frozen; a dead mob gets nothing', (t) => {
  mockClock(t)
  const player = playerAt(0)
  const [c] = casters(1)
  assert.equal(chill(player, c, 'icicle'), false)
  assert.equal(player.chill, undefined)
  assert.equal(player.frozen, false)

  const mob = mobAt(ARCHETYPES.grunt, 3, true)
  mob.destroy()
  assert.equal(chill(mob, c, 'icicle'), false)
  assert.equal(mob.frozen, false)
  assert.equal(frozenSent().length, 0)
})

// --- chill: bosses -----------------------------------------------------------------------

for (const key of ['reactor', 'brood'] as const) {
  test(`a ${key} freezes only at 4 distinct casters inside 4000 ms, for 750 ms`, (t) => {
    mockClock(t)
    assert.equal(World.isSpawnHazard(ARCHETYPES[key]), true)
    const boss = mobAt(ARCHETYPES[key], 0, true)
    const [a, b, c, d] = casters(4)
    assert.equal(chill(boss, a, 'icicle'), false)
    assert.equal(chill(boss, b, 'breath'), false)
    assert.equal(chill(boss, c, 'icicle'), false)
    // One caster twice is still one stack.
    assert.equal(chill(boss, a, 'breath'), false)
    assert.equal(chill(boss, a, 'icicle'), false)
    assert.equal(boss.chill?.stacks.length, 3)
    assert.equal(boss.frozen, false)

    assert.equal(chill(boss, d, 'icicle'), true)
    assert.equal(boss.frozen, true)
    assert.equal(boss.chill?.frozenUntil, T0 + 750)
    assert.deepEqual(boss.chill?.stacks, [], 'the freeze clears the stacks')
    assert.deepEqual(frozenSent().map((s) => [s.originator, s.lifetime]), [[boss.id, 750]])
  })
}

test('a boss\'s stack older than the window does not count; a caster\'s stack moves to its latest chill', (t) => {
  mockClock(t)
  const boss = mobAt(ARCHETYPES.reactor, 0, true)
  const [a, b, c, d] = casters(4)
  chill(boss, a, 'icicle') // T0
  t.mock.timers.tick(1000)
  chill(boss, b, 'icicle')
  chill(boss, c, 'icicle')
  t.mock.timers.tick(3000) // T0 + 4000: a's stack is exactly 4000 old, out
  assert.equal(chill(boss, d, 'icicle'), false, 'a stack 4000 ms old still counted')
  assert.equal(boss.chill?.stacks.length, 3)
  assert.equal(chill(boss, a, 'icicle'), true, 'a\'s fresh stack is the fourth')

  // Its latest chill, not its first: a at 0 and 3000, the rest at 6000.
  const other = mobAt(ARCHETYPES.brood, 10, true)
  const start = Date.now()
  chill(other, a, 'icicle')
  t.mock.timers.tick(3000)
  chill(other, a, 'breath')
  t.mock.timers.tick(3000)
  chill(other, b, 'icicle')
  chill(other, c, 'icicle')
  assert.equal(chill(other, d, 'icicle'), true, 'a\'s stack kept its first time')
  assert.equal(other.chill?.frozenUntil, start + 6000 + 750)
})

test('after a boss freeze, 20000 ms of lockout from its end: no stacks and no freeze', (t) => {
  mockClock(t)
  const boss = mobAt(ARCHETYPES.reactor, 0, true)
  const four = casters(4)
  for (const c of four) chill(boss, c, 'icicle')
  assert.equal(boss.frozen, true)
  assert.equal(boss.chill?.lockoutUntil, T0 + 750 + 20000)

  t.mock.timers.tick(750 + 20000 - 1)
  for (const c of four) assert.equal(chill(boss, c, 'icicle'), false)
  assert.equal(boss.chill?.stacks.length, 0, 'stacks were gained in the lockout')
  assert.equal(boss.frozen, false)

  t.mock.timers.tick(1)
  for (const c of four.slice(0, 3)) assert.equal(chill(boss, c, 'icicle'), false)
  assert.equal(chill(boss, four[3], 'icicle'), true, 'no freeze after the lockout')
  assert.equal(frozenSent().length, 2)
})

// --- weaker metal ----------------------------------------------------------------------

test('weaker metal: x1.5 only while frozen, none after the thaw; Defend and frozen multiply', (t) => {
  mockClock(t)
  // A bare unit: no player freezes, and Defend is a player's skill.
  const unit = new Unit(ObjectType.Mob, at(0).x, at(0).y, 10, 0)
  unit.hp = 1000
  const [c] = casters(1)
  assert.equal(unit.damageTaken(30), 30)
  assert.equal(chill(unit, c, 'icicle'), true)
  assert.equal(unit.damageTaken(30), 45)
  assert.equal(unit.hit(30), false)
  assert.equal(unit.hp, 955)
  unit.damageReduction = 0.5
  assert.equal(unit.damageTaken(30), 22, 'floor(30 x 0.5 x 1.5)')
  t.mock.timers.tick(1500)
  assert.equal(unit.damageTaken(30), 15, 'boosted after the thaw')
  unit.damageReduction = 0
  unit.hit(30)
  assert.equal(unit.hp, 925)
})

test('a frozen Broodling goes off on a hit that floors to nothing unfrozen (its onHit uses damageTaken)', (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling, 0)
  const [c] = casters(1)
  assert.equal(ling.hit(0.8), false)
  assert.equal(ling.destroyed, false, 'floor(0.8) = 0 set it off')
  chill(ling, c, 'icicle')
  assert.equal(ling.frozen, true)
  assert.equal(ling.hit(0.8), true, 'floor(0.8 x 1.5) = 1 did not set it off')
  assert.equal(ling.destroyed, true)
})

// --- movement ----------------------------------------------------------------------------

test('a frozen mob mid-step does not move, keeps both claims, and lands on its step\'s centre after the thaw', (t) => {
  mockClock(t)
  const mob = mobAt(ARCHETYPES.grunt, 0, true)
  const [c] = casters(1)
  mob.stepGoal = { cell: cellAt(1), within: 0 }
  tick(t)
  const stepTo = mob.stepTo
  assert.ok(stepTo !== undefined, 'no step started')
  assert.notDeepEqual(mob.position, Hex.toPosition(stepTo), 'test setup: it already landed')
  assert.equal(claimsOf(mob), 2)

  chill(mob, c, 'icicle') // 1500 ms
  const where = mob.position
  for (let i = 0; i < 5; i++) {
    tick(t)
    assert.equal(mob.position, where, `moved on frozen tick ${i}`)
    assert.equal(mob.stepTo, stepTo)
    assert.equal(claimsOf(mob), 2, 'a claim went during the freeze')
  }
  for (let i = 0; i < 6 && mob.stepTo !== undefined; i++) tick(t)
  assert.equal(mob.frozen, false)
  assert.deepEqual(mob.position, Hex.toPosition(stepTo))
  assert.equal(mob.stepTo, undefined)
  assert.equal(claimsOf(mob), 0)
})

test('a guard acquisition during the freeze moves nothing; after the thaw it chases', (t) => {
  mockClock(t)
  const mob = mobAt(ARCHETYPES.grunt, 0)
  const player = playerAt(3)
  const [c] = casters(1)
  chill(mob, c, 'icicle')
  const where = mob.position
  for (let i = 0; i < 5; i++) tick(t)
  assert.equal(mob.target, player, 'test setup: the guard never acquired')
  assert.equal(mob.position, where, 'a frozen mob moved')
  for (let i = 0; i < 4; i++) tick(t)
  assert.notDeepEqual(mob.position, where, 'test setup: it never chased after the thaw')
})

// --- frozen NPCs: no new attack, no contact; a started wind-up lands ---------------------

/** The effect each NPC sends when it starts an attack. */
const CAST: Record<string, number> = {
  crawler: 3, // RangedAttack
  gunner: 3,
  kiln: NPC_EFFECT.kilnLob,
  compactor: NPC_EFFECT.compactorSlam,
  reactor: NPC_EFFECT.reactorTell,
  coil: NPC_EFFECT.coilPulse,
  brood: NPC_EFFECT.broodRelease
}

for (const key of Object.keys(CAST) as Array<keyof typeof CAST & keyof typeof ARCHETYPES>) {
  test(`a frozen ${key} starts no attack and stays put; after the thaw it attacks`, (t) => {
    mockClock(t)
    const mob = mobAt(ARCHETYPES[key], 0)
    const player = playerAt(2)
    const hp = health(player)
    freezeFor(mob, 4000)
    const where = mob.position
    for (let i = 0; i < 15; i++) tick(t)
    assert.equal(mob.frozen, true)
    assert.equal(mob.target, player, 'test setup: no target')
    assert.deepEqual(sent, [], `${key} sent something while frozen`)
    assert.equal(health(player), hp)
    assert.equal(mob.position, where)
    for (let i = 0; i < 24 && !sent.some((s) => s.type === CAST[key]); i++) tick(t)
    assert.ok(sent.some((s) => s.type === CAST[key]), `test setup: ${key} never attacked after the thaw`)
  })
}

for (const key of ['grunt', 'reactor'] as const) {
  test(`a frozen ${key} deals no contact damage; after the thaw it does`, (t) => {
    mockClock(t)
    const mob = mobAt(ARCHETYPES[key], 0, true)
    assert.ok(ARCHETYPES[key].contact.damage > 0)
    const player = playerAt(1)
    const hp = health(player)
    freezeFor(mob, 2000)
    for (let i = 0; i < 7; i++) tick(t)
    assert.equal(health(player), hp, 'contact damage while frozen')
    tick(t)
    tick(t)
    assert.ok(health(player) < hp, 'test setup: no contact damage after the thaw')
  })
}

/** NPCs with a wind-up: the effect that ends it, and when, from the cast. */
const LANDS: Array<[string, number, number]> = [
  ['kiln', NPC_EFFECT.kilnBlast, 1250],
  ['compactor', NPC_EFFECT.knockback, 750],
  ['reactor', NPC_EFFECT.reactorRelease, 1000],
  ['coil', NPC_EFFECT.slowed, 1500]
]

for (const [key, lands, afterMs] of LANDS) {
  test(`a ${key} wind-up started before the freeze lands on time, and no new one starts`, (t) => {
    mockClock(t)
    const mob = mobAt(ARCHETYPES[key as 'kiln'], 0)
    // Two cells off: inside every one of the four's reach, and a Compactor's
    // knockback (2 cells) leaves the player standing.
    playerAt(2)
    let castAt: number | undefined
    for (let i = 0; i < 24 && castAt === undefined; i++) {
      tick(t)
      castAt = sent.find((s) => s.type === CAST[key])?.at
    }
    assert.ok(castAt !== undefined, `test setup: ${key} never cast`)
    freezeFor(mob, 5000)
    for (let i = 0; i < 16; i++) tick(t)
    const landed = sent.filter((s) => s.type === lands)
    assert.ok(landed.length > 0, `${key}'s wind-up never landed`)
    assert.equal(landed[0].at - castAt, afterMs)
    assert.equal(sent.filter((s) => s.type === CAST[key]).length, 1, 'a second cast while frozen')
  })
}

// --- Ice Breath ----------------------------------------------------------------------------

test('Ice Breath held on a player leaves one ice slow, x0.5, to 1000 ms past its last hitting tick; the cue is throttled', (t) => {
  mockClock(t)
  const caster = playerAt(0, 0, 'caster') // faces East
  const victim = playerAt(1, 0, 'victim')
  const base = victim.maxVelocity
  assert.equal(new IceBreath(caster).execute(), true)
  const ends: number[] = []
  let hits = 0
  for (let i = 0; i < 6; i++) {
    const before = FieldSlow.on(victim, 'ice')?.endTime
    tick(t)
    const slows = victim.buffs.filter((b) => b instanceof FieldSlow)
    if (World.AREA_EFFECT.length > 0) {
      hits++
      assert.equal(slows.length, 1, 'more than one slow')
      assert.equal(victim.maxVelocity, Math.round(base * 5) / 10)
    }
    const after = FieldSlow.on(victim, 'ice')?.endTime
    if (after !== undefined && after !== before) ends.push(after - Date.now())
  }
  assert.ok(hits >= 3, `test setup: the breath hit ${hits} ticks`)
  assert.deepEqual(new Set(ends), new Set([1000]), 'each hitting tick refreshes the end to 1000 ms from it')
  const cues = sent.filter((s) => s.type === NPC_EFFECT.slowed && s.originator === victim.id)
  assert.ok(cues.length >= 1 && cues.length < hits, `${cues.length} cues for ${hits} hitting ticks`)

  for (let i = 0; i < 6; i++) tick(t)
  assert.equal(victim.maxVelocity, base, 'the slow did not give back what it took')
  assert.equal(victim.buffs.length, 0)
  assert.equal(caster.buffs.length, 0, 'the caster slowed itself')
})

test('Ice Breath freezes a normal mob from its first tick for 1250 ms, every tick boosted, effect 21 once', (t) => {
  mockClock(t)
  const caster = playerAt(0, 0, 'caster')
  const mob = mobAt(ARCHETYPES.grunt, 1, true)
  assert.equal(new IceBreath(caster).execute(), true)
  const area = World.AREA_EFFECT[0]
  const perTick = Math.floor(area.damage * DT * FREEZE.damageTaken)
  assert.equal(perTick, 12, '32/s: 8 a tick, 12 frozen')
  let hp = mob.hp
  let first: number | undefined
  let hits = 0
  for (let i = 0; i < 5; i++) {
    tick(t)
    if (mob.hp === hp) continue
    hits++
    first ??= Date.now()
    assert.equal(mob.frozen, true)
    assert.equal(hp - mob.hp, perTick, 'a tick not boosted')
    hp = mob.hp
  }
  assert.ok(first !== undefined && hits >= 3, `test setup: the breath hit ${hits} ticks`)
  assert.equal(mob.chill?.frozenUntil, first + 1250, 'later ticks moved the thaw')
  assert.deepEqual(frozenSent().map((s) => [s.originator, s.lifetime]), [[mob.id, 1250]])
})

test('one Ice Breath chills a mob once: thawed mid-breath, a later tick does not freeze it again', (t) => {
  mockClock(t)
  const caster = playerAt(0, 0, 'caster')
  const mob = mobAt(ARCHETYPES.grunt, 1, true)
  mob.hp = 1000
  const [other] = casters(1)
  // An Icicle 1000 ms ago: frozen until T0 + 500, mid-breath.
  chill(mob, other, 'icicle', T0 - 1000)
  assert.equal(new IceBreath(caster).execute(), true)
  for (let i = 0; i < 3; i++) tick(t) // T0 + 250 (frozen), 500 and 750 (thawed)
  assert.ok(World.AREA_EFFECT.length > 0, 'test setup: the breath ended')
  assert.ok(mob.hp < 1000, 'test setup: the breath missed')
  assert.equal(mob.frozen, false, 'a later tick of the same breath froze it again')
  assert.equal(frozenSent().length, 1)
})
