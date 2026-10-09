import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { type Unit } from '../objects/unit'
import UseSkillOnTarget from '../ai/useskillontarget'
import { type Archetype, ARCHETYPES, type GuardSpec, type UseSkillOnTargetSpec } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import BroodRelease from './brood'
import { fuseOf } from './broodling'
import { Shockwave, ShockwaveRoutine } from './shockwave'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * NPC wind-up holds (#52 lane 2, Dez's `ideas/npc-windup-holds.md`, accepted
 * 2026-10-09): the Crawler, the Kiln and the Brood come to rest, then cast,
 * then stand still for their hold; the Compactor stands still to 1750 ms; a
 * new Broodling stands still through its 1500 ms emerge.
 *
 * Driven tick by tick as `World.update` drives it (the clock moves 250 ms,
 * due timers run, the mobs update last to first) against a player the spec
 * moves every tick, so the mob is often mid-step when its attack comes due.
 * Each cast is caught at the moment its effect is sent.
 */

const TICK_MS = 250
const DT = TICK_MS / 1000
const T0 = 1_000_000

interface Cast { at: number, x: number, y: number, stepTo: Vector | undefined }
interface Frame {
  at: number
  x: number
  y: number
  /** The step goal after the tick: undefined while a routine holds it still. */
  goal: boolean
  /** `stepTo` at the start of the tick, and whether the attack was then due. */
  stepBefore: Vector | undefined
  dueBefore: boolean
  stepAfter: Vector | undefined
}

let casts: Map<number, Cast[]>
let created: Unit[]

const record = (unit: Unit | undefined, type: number, watched: number[]): void => {
  if (unit === undefined || !watched.includes(type)) return
  const list = casts.get(unit.id) ?? []
  list.push({ at: Date.now(), x: unit.position.x, y: unit.position.y, stepTo: unit.stepTo })
  casts.set(unit.id, list)
}

const WATCHED = [3, NPC_EFFECT.kilnLob, NPC_EFFECT.broodRelease, NPC_EFFECT.compactorShockwave]

beforeEach(() => {
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  casts = new Map()
  created = []
  Multiplayer.Instance = {
    create: (obj: Unit) => { created.push(obj); obj.dirtyFields.clear() },
    update: noop,
    destroy: noop,
    redis: { hincrby: async () => 1 },
    effect: (type: number, originator: Unit) => { record(originator, type, WATCHED) },
    effectAt: (type: number, originator: number) => {
      record((World.MOBS as Unit[]).find((m) => m.id === originator), type, WATCHED)
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
const at = (dq: number, dr = 0): Vector => Hex.toPosition(new Vector(HOME.x + dq, HOME.y + dr))

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: T0 })
}

function mobAt (archetype: Archetype, dq = 0, dr = 0): Mob {
  const p = at(dq, dr)
  const mob = new Mob(p.x, p.y, 0, archetype)
  World.addUnit(World.MOBS, mob)
  return mob
}

/** A player that takes no damage, so the target stays for the whole run. */
function playerAt (dq: number, dr = 0): Player {
  const p = at(dq, dr)
  const player = new Player(p.x, p.y, 0, 'p1')
  player.hit = () => false
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

/** Move `player` `speed` u/s along `heading` (a unit vector) for one tick. */
function walk (player: Player, heading: Vector, speed: number): void {
  player.position = new Vector(player.position.x + heading.x * speed * DT, player.position.y + heading.y * speed * DT)
}

/**
 * Run `ticks` ticks. `move` moves the player before each tick; `due` says
 * whether the mob's attack is due at the start of a tick (ready and in range).
 */
function run (t: TestContext, mob: Mob, ticks: number, move: () => void, due: () => boolean): Frame[] {
  const frames: Frame[] = []
  for (let i = 0; i < ticks; i++) {
    move()
    t.mock.timers.tick(TICK_MS)
    Timers.run(Date.now())
    const stepBefore = mob.stepTo
    const dueBefore = due()
    for (let k = World.MOBS.length - 1; k >= 0; k--) {
      const m = World.MOBS[k]
      if (m.destroyed) { World.removeUnitAt(World.MOBS, k); continue }
      m.update(DT)
    }
    frames.push({ at: Date.now(), x: mob.position.x, y: mob.position.y, goal: mob.stepGoal !== undefined, stepBefore, dueBefore, stepAfter: mob.stepTo })
  }
  return frames
}

const onCentre = (x: number, y: number): boolean => {
  const c = Hex.toPosition(Hex.toCell(new Vector(x, y)))
  return c.x === x && c.y === y
}

/**
 * The three rules for a rest-first NPC, over every cast in `frames`:
 * - it casts at rest, on a cell centre;
 * - from the cast to the first tick at or after cast + `holdMs` it does not
 *   move and its step goal stays cleared; on that tick the guard's goal
 *   stands again;
 * - while its attack is due and it is mid-step, it starts no new step.
 * Returns how many casts waited for a step to land, and the longest wait.
 */
function checkRestThenHold (mob: Mob, frames: Frame[], holdMs: number, label: string): { waited: number, longestWaitMs: number, casts: Cast[] } {
  const list = casts.get(mob.id) ?? []
  assert.ok(list.length >= 3, `${label}: only ${list.length} casts`)
  let waited = 0
  let longestWaitMs = 0
  const last = frames[frames.length - 1].at
  for (const cast of list) {
    assert.equal(cast.stepTo, undefined, `${label}: cast at +${cast.at - T0} mid-step`)
    assert.ok(onCentre(cast.x, cast.y), `${label}: cast at +${cast.at - T0} off a centre (${cast.x}, ${cast.y})`)
    if (cast.at + holdMs > last) continue
    const inHold = frames.filter((f) => f.at >= cast.at && f.at < cast.at + holdMs)
    assert.equal(inHold.length, holdMs / TICK_MS, `${label}: hold ticks after the cast at +${cast.at - T0}`)
    for (const f of inHold) {
      assert.deepEqual([f.x, f.y], [cast.x, cast.y], `${label}: moved at +${f.at - T0}, inside the hold from +${cast.at - T0}`)
      assert.equal(f.goal, false, `${label}: a step goal at +${f.at - T0}, inside the hold`)
    }
    // Free again on the first tick past the hold, unless another cast came
    // inside it (a Brood beat soon after a release that waited for a step),
    // whose own hold then runs on.
    const end = frames.find((f) => f.at >= cast.at + holdMs)
    if (end !== undefined && !list.some((c) => c.at > cast.at && c.at <= end.at)) assert.equal(end.goal, true, `${label}: still held at +${end.at - T0}, past the hold from +${cast.at - T0}`)

    // The wait before it: the due ticks just before the cast that began mid-step.
    let i = frames.findIndex((f) => f.at === cast.at) - 1
    let wait = 0
    while (i >= 0 && frames[i].dueBefore && frames[i].stepBefore !== undefined) { wait += TICK_MS; i-- }
    if (wait > 0) waited++
    longestWaitMs = Math.max(longestWaitMs, wait)
  }
  // Mid-step with the attack due: the step lands and no new one starts.
  for (const f of frames) {
    if (!f.dueBefore || f.stepBefore === undefined) continue
    if (f.stepAfter !== undefined) {
      assert.deepEqual(f.stepAfter, f.stepBefore, `${label}: a new step at +${f.at - T0} while the attack was due`)
    }
    assert.equal(f.goal, false, `${label}: a step goal at +${f.at - T0} while coming to rest`)
  }
  return { waited, longestWaitMs, casts: list }
}

/** Ticks to finish one 45 u step at `speed`, rounded up: the longest a cast may wait. */
const stepTicks = (speed: number): number => Math.ceil((Hex.SIZE / speed) * 1000 / TICK_MS)

const useOf = (mob: Mob): UseSkillOnTarget => mob.routines.find((r) => r instanceof UseSkillOnTarget) as UseSkillOnTarget
const inRange = (mob: Mob, cells: number): boolean =>
  mob.target != null && Hex.distance(Hex.toCell(mob.position), Hex.toCell(mob.target.position)) <= cells

test('the hold numbers are the accepted ones, and only the Crawler and the Kiln rest and hold on `useSkillOnTarget`', () => {
  const use = (a: Archetype): UseSkillOnTargetSpec => a.routines.find((r): r is UseSkillOnTargetSpec => r.kind === 'useSkillOnTarget') as UseSkillOnTargetSpec
  assert.equal(use(ARCHETYPES.crawler).holdMs, 500)
  assert.equal(use(ARCHETYPES.kiln).holdMs, 750)
  // The unspawned rows share the routine and keep casting on the move.
  assert.equal(use(ARCHETYPES.boss).holdMs, undefined)
  assert.equal(use(ARCHETYPES.gunner).holdMs, undefined)
  // And as built: the routine itself, not only the row.
  assert.deepEqual([ARCHETYPES.boss, ARCHETYPES.gunner, ARCHETYPES.crawler, ARCHETYPES.kiln].map((a) => useOf(mobAt(a)).holdMs), [undefined, undefined, 500, 750])
  const shock = ARCHETYPES.compactor.routines.find((r) => r.kind === 'shockwave') as { holdMs: number }
  assert.equal(shock.holdMs, 1750)
  const brood = ARCHETYPES.brood.routines.find((r) => r.kind === 'brood') as { holdMs: number }
  assert.equal(brood.holdMs, 500)
  const fuse = ARCHETYPES.broodling.routines.find((r) => r.kind === 'broodling') as { emergeMs: number, tellMs: number }
  assert.equal(fuse.emergeMs, 1500)
  assert.equal(fuse.tellMs, 500, 'the Broodling tell is unchanged')
  // Each hold is whole ticks, so "the first tick at or after" lands exactly on it.
  for (const ms of [500, 750, 1750, 1500]) assert.equal(ms % TICK_MS, 0)
})

test('a Crawler shooting a player who walks away: it comes to rest, shoots on a centre, and stands still 500 ms', (t) => {
  mockClock(t)
  const crawler = mobAt(ARCHETYPES.crawler)
  const player = playerAt(5)
  const use = useOf(crawler)
  const speed = (ARCHETYPES.crawler.routines[0] as GuardSpec).chaseSpeed
  // Away at 60 u/s, slower than its 90: it keeps closing to its standoff 4.
  const frames = run(t, crawler, 100, () => { walk(player, new Vector(1, 0), 60) }, () => use.skill.ready() && inRange(crawler, use.withinCells as number))
  const { waited, longestWaitMs, casts } = checkRestThenHold(crawler, frames, 500, 'crawler')
  assert.ok(waited > 0, 'no shot waited for a step to land: the rest-first path was not exercised')
  assert.ok(longestWaitMs <= stepTicks(speed) * TICK_MS, `waited ${longestWaitMs} ms, over one step`)
  // The cooldown still sets the floor: never two shots within 2000 ms.
  for (let i = 1; i < casts.length; i++) assert.ok(casts[i].at - casts[i - 1].at >= 2000)
})

test('a Kiln lobbing at a player who walks at it: it comes to rest, lobs on a centre, and stands still 750 ms', (t) => {
  mockClock(t)
  const kiln = mobAt(ARCHETYPES.kiln)
  const player = playerAt(6)
  const use = useOf(kiln)
  const speed = (ARCHETYPES.kiln.routines[0] as GuardSpec).chaseSpeed
  // The player walks at the Kiln at 60 u/s; the Kiln backs off at 70.
  const toward = (): void => {
    const d = kiln.position.sub(player.position)
    const n = Math.hypot(d.x, d.y)
    if (n > 0) walk(player, new Vector(d.x / n, d.y / n), 60)
  }
  const frames = run(t, kiln, 100, toward, () => use.skill.ready() && inRange(kiln, use.withinCells as number))
  const { waited, longestWaitMs } = checkRestThenHold(kiln, frames, 750, 'kiln')
  assert.ok(waited > 0, 'no lob waited for a step to land')
  assert.ok(longestWaitMs <= stepTicks(speed) * TICK_MS, `waited ${longestWaitMs} ms, over one step`)
})

/** The Brood row with children that never move or go off, so only the Brood is watched. */
const INERT_BROOD: Archetype = {
  ...ARCHETYPES.brood,
  routines: ARCHETYPES.brood.routines.map((r) => r.kind === 'brood' ? { ...r, child: { ...ARCHETYPES.broodling, routines: [] } } : r)
}

test('a Brood chased by a player: it comes to rest, releases on a centre, stands still 500 ms, and keeps its 1000 ms beat', (t) => {
  mockClock(t)
  const brood = mobAt(INERT_BROOD)
  const player = playerAt(6)
  const release = brood.routines.find((r) => r instanceof BroodRelease) as BroodRelease
  const speed = (ARCHETYPES.brood.routines[0] as GuardSpec).chaseSpeed
  const toward = (): void => {
    const d = brood.position.sub(player.position)
    const n = Math.hypot(d.x, d.y)
    if (n > 0) walk(player, new Vector(d.x / n, d.y / n), 50)
  }
  // Children die at once, so the cap never stops a beat.
  const interval = (ARCHETYPES.brood.routines.find((r) => r.kind === 'brood') as { intervalMs: number }).intervalMs
  const frames = run(t, brood, 90, () => {
    toward()
    for (const child of release.children) if (!child.destroyed) child.destroy()
  }, () => release.pending)
  const { waited, longestWaitMs, casts } = checkRestThenHold(brood, frames, 500, 'brood')
  assert.ok(waited > 0, 'no release waited for a step to land')
  assert.ok(longestWaitMs <= stepTicks(speed) * TICK_MS, `waited ${longestWaitMs} ms, over one step`)
  // The clock re-arms at the beat, not at the release: every release is
  // within one step of its beat, beats `interval` apart. At 1000 ms a
  // release that waited is often followed by the next beat's at once, 250 or
  // 500 ms later: still one per beat.
  const first = casts[0].at
  const beat0 = frames.find((f) => f.dueBefore)?.at ?? first
  casts.forEach((c, i) => {
    const beat = Math.min(first, beat0) + interval * i
    assert.ok(c.at - beat >= 0 && c.at - beat <= stepTicks(speed) * TICK_MS, `release ${i} at +${c.at - T0}, its beat at +${beat - T0}`)
  })
  // Some release came inside the last one's hold, so the hold restarted
  // there (`checkRestThenHold` saw it stand still to the second hold's end):
  // the first hold's timer must not end the second (`BroodRelease.holdTimer`).
  assert.ok(casts.some((c, i) => i > 0 && c.at - casts[i - 1].at < 500), 'no release inside a hold: the restart was not exercised')
})

test('a Brood at rest at its beat releases in that tick, as before, and its pending flag never rises', (t) => {
  mockClock(t)
  const brood = mobAt(INERT_BROOD)
  // 5 rings: inside its band, so it never steps.
  playerAt(5)
  const release = brood.routines.find((r) => r instanceof BroodRelease) as BroodRelease
  const frames = run(t, brood, 20, () => {}, () => release.pending)
  assert.ok(frames.every((f) => !f.dueBefore))
  const list = casts.get(brood.id) ?? []
  const interval = (ARCHETYPES.brood.routines.find((r) => r.kind === 'brood') as { intervalMs: number }).intervalMs
  assert.ok(list.length >= 2, `only ${list.length} releases`)
  // Armed on its first tick (+250), released one interval later, and every interval after.
  assert.deepEqual(list.map((c) => c.at - T0), list.map((_, i) => 250 + interval * (i + 1)))
})

test('a new Broodling stands on its release cell for 1500 ms, then chases', (t) => {
  mockClock(t)
  const brood = mobAt(ARCHETYPES.brood)
  // 5 rings: the Brood holds its band; the Broodling has 4 cells to cover.
  playerAt(5)
  let ling: Mob | undefined
  let born = 0
  const seen: Array<{ at: number, x: number, y: number, goal: boolean, primed: boolean }> = []
  for (let i = 0; i < 40; i++) {
    t.mock.timers.tick(TICK_MS)
    Timers.run(Date.now())
    for (let k = World.MOBS.length - 1; k >= 0; k--) {
      const m = World.MOBS[k]
      if (m.destroyed) { World.removeUnitAt(World.MOBS, k); continue }
      m.update(DT)
    }
    if (ling === undefined) {
      ling = (World.MOBS as Mob[]).find((m) => m.archetype.key === 'broodling')
      if (ling !== undefined) born = Date.now()
    }
    if (ling !== undefined && !ling.destroyed) {
      seen.push({ at: Date.now(), x: ling.position.x, y: ling.position.y, goal: ling.stepGoal !== undefined, primed: fuseOf(ling)?.primedCell !== undefined })
    }
  }
  assert.ok(ling !== undefined, 'never released')
  assert.ok(seen.every((s) => s.at > born + 1500 || !s.primed), 'test setup: it primed during its emerge')
  const start = seen[0]
  const held = seen.filter((s) => s.at < born + 1500)
  assert.equal(held.length, 1500 / TICK_MS)
  for (const s of held) {
    assert.deepEqual([s.x, s.y], [start.x, start.y], `moved at +${s.at - born} ms, inside the emerge`)
    assert.equal(s.goal, false)
  }
  const after = seen.find((s) => s.at >= born + 1500)
  assert.ok(after !== undefined && after.goal, 'no step goal once the emerge is over')
  const moved = seen.find((s) => s.at > born + 1500 && (s.x !== start.x || s.y !== start.y))
  assert.ok(moved !== undefined, 'never chased after its emerge')
})

test('a Compactor chasing a player stands still from the first tick at rest after its cast until 1750 ms, then steers again', (t) => {
  mockClock(t)
  const compactor = mobAt(ARCHETYPES.compactor)
  const player = playerAt(4)
  const routine = compactor.routines.find((r) => r instanceof ShockwaveRoutine) as ShockwaveRoutine
  assert.ok(routine.skill instanceof Shockwave)
  // Away at 60 u/s: it keeps closing in and slams whenever within 2.
  const frames = run(t, compactor, 60, () => { walk(player, new Vector(1, 0), 60) }, () => false)
  const list = (casts.get(compactor.id) ?? []).filter((c) => c.at + 1750 <= frames[frames.length - 1].at)
  assert.ok(list.length >= 2, `only ${list.length} slams`)
  for (const cast of list) {
    const inHold = frames.filter((f) => f.at >= cast.at && f.at < cast.at + 1750)
    assert.equal(inHold.length, 1750 / TICK_MS)
    for (const f of inHold) assert.equal(f.goal, false, `a step goal at +${f.at - cast.at} ms after the slam`)
    // The step in progress at the cast lands (Compactor rule unchanged); then still.
    const rest = inHold.findIndex((f) => f.stepAfter === undefined)
    assert.ok(rest >= 0)
    for (const f of inHold.slice(rest)) {
      assert.deepEqual([f.x, f.y], [inHold[rest].x, inHold[rest].y], `moved at +${f.at - cast.at} ms after the slam`)
    }
    const end = frames.find((f) => f.at >= cast.at + 1750)
    if (end !== undefined) assert.equal(end.goal, true, 'still held past 1750')
  }
})

/**
 * A Brood whose beat found it mid-step (`pending`), then one of three things
 * before the step lands (Archie's lane-2 review): its children reach the cap,
 * it dies, or its target goes. None of them may release, and a live Brood
 * leaves `pending` once at rest.
 */
for (const what of ['cap', 'death', 'target'] as const) {
  test(`a Brood with a pending release does not release when ${what === 'cap' ? 'its children reach the cap' : what === 'death' ? 'it dies' : 'its target goes'} before it comes to rest`, (t) => {
    mockClock(t)
    const brood = mobAt(INERT_BROOD)
    const player = playerAt(6)
    const release = brood.routines.find((r) => r instanceof BroodRelease) as BroodRelease
    const toward = (): void => {
      const d = brood.position.sub(player.position)
      const n = Math.hypot(d.x, d.y)
      if (n > 0) walk(player, new Vector(d.x / n, d.y / n), 50)
    }
    // Children die at once until the first pending beat, so only the cap set below counts.
    // Pending with its step still to land (a step can also land in the beat's own tick).
    for (let i = 0; i < 90 && !(release.pending && brood.stepTo !== undefined); i++) {
      run(t, brood, 1, () => {
        toward()
        for (const child of release.children) if (!child.destroyed) child.destroy()
      }, () => false)
    }
    assert.ok(release.pending, 'test setup: no beat found the Brood mid-step')
    assert.ok(brood.stepTo !== undefined, 'test setup: pending at rest')
    const before = (casts.get(brood.id) ?? []).length
    if (what === 'cap') {
      // Live children up to the cap.
      for (let c = 0; c < release.spec.cap; c++) release.children.push(mobAt({ ...ARCHETYPES.broodling, routines: [] }, 20 + c, 20))
    } else if (what === 'death') {
      brood.destroy()
    } else {
      player.destroy()
    }
    // Long enough for the step to land; the beats in between find the cap, no target or no Brood.
    run(t, brood, 6, () => {}, () => false)
    assert.equal((casts.get(brood.id) ?? []).length, before, `released after ${what}`)
    // At rest at some tick in between (a targetless Brood may wander on after): pending is over.
    if (what !== 'death') assert.equal(release.pending, false, 'pending outlived the rest')
  })
}
