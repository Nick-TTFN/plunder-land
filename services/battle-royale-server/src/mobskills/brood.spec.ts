import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { GameObject } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import { type Archetype, ARCHETYPES, type GuardSpec } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import BroodRelease, { type BroodSpec } from './brood'
import { fuseOf, PRIME_RINGS } from './broodling'
import { RangedAttack } from '../skills/rangedattack'
import { runResultOf } from '../progress/run'
import { PROGRESSION, runXp } from '../progress/xp'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
// The client's ports. They import nothing, so this pulls no pixi into the server.
import { attackCells } from '../../../../plunder-land-client/src/vfx/cells'
import { pickReleased, PICK_REACH, type ReleaseCandidate } from '../../../../plunder-land-client/src/vfx/broodpick'

/**
 * The Brood carrier's stream and the Broodlings' fuse, tell, shot and chain
 * (decision #51, l1-7): to the tick, with the clock driven as `World.update`
 * drives it: the clock moves 250 ms, due timers run, then the mobs update
 * from the last to the first, and the dead are swept. A Broodling released
 * by a timer is appended to MOBS before that loop, so it gets its first
 * update, and moves, in the tick it is released (l1-7 F6).
 */

const DT = 0.25
const TICK_MS = 250

interface Sent { type: number, originator: number, lifetime: number, cell: Vector, tag: number, at: number }
let sent: Sent[] = []
let created: Array<{ id: number, fields: Record<string, unknown> }> = []
let hincrby: string[] = []

beforeEach(() => {
  mock.method(Math, 'random', () => 0.5)
  const noop = (): void => {}
  sent = []
  created = []
  hincrby = []
  Multiplayer.Instance = {
    create: (obj: GameObject) => {
      created.push({ id: obj.id, fields: obj.serialise(obj.allFields) as Record<string, unknown> })
      obj.dirtyFields.clear()
    },
    update: noop,
    destroy: noop,
    redis: { hincrby: async (_hash: string, key: string) => { hincrby.push(key); return 1 } },
    effect: (type: number, originator: Unit, lifetime: number, cell: Vector) => {
      sent.push({ type, originator: originator.id, lifetime, cell, tag: originator.tag, at: Date.now() })
    },
    effectAt: (type: number, originator: number, lifetime: number, cell: Vector, tag: number) => {
      sent.push({ type, originator, lifetime, cell, tag, at: Date.now() })
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
const key = (cell: { x: number, y: number }): string => `${cell.x},${cell.y}`

const BLAST_RINGS = (ARCHETYPE_INFO.broodling.attack as { rings: number }).rings
const T0 = 1_000_000

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: T0 })
}

function mobAt (archetype: Archetype, dq = 0, dr = 0): Mob {
  const p = at(dq, dr)
  const mob = new Mob(p.x, p.y, 0, archetype)
  World.addUnit(World.MOBS, mob)
  return mob
}

function playerAt (dq: number, dr = 0, id = 'p1'): Player {
  const p = at(dq, dr)
  const player = new Player(p.x, p.y, 0, id)
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

const health = (unit: Unit): number => unit.hp + unit.armor
const blasts = (): Sent[] => sent.filter((s) => s.type === NPC_EFFECT.broodlingBlast)
const releases = (): Sent[] => sent.filter((s) => s.type === NPC_EFFECT.broodRelease)
const broodlings = (): Mob[] => (World.MOBS as Mob[]).filter((m) => m.archetype.key === 'broodling')

/** One server tick, as `World.update` runs the mobs (see the file comment). */
function tick (t: TestContext): void {
  t.mock.timers.tick(TICK_MS)
  Timers.run(Date.now())
  for (let i = World.MOBS.length - 1; i >= 0; i--) {
    const mob = World.MOBS[i]
    if (mob.destroyed) {
      World.removeUnitAt(World.MOBS, i)
      continue
    }
    mob.update(DT)
  }
}

const releaseSpec = (archetype: Archetype): BroodSpec =>
  archetype.routines.find((r): r is BroodSpec => r.kind === 'brood') as BroodSpec
const releaseOf = (mob: Mob): BroodRelease => mob.routines.find((r) => r instanceof BroodRelease) as BroodRelease

/**
 * A Brood whose children never move or go off: the Broodling row with no
 * routines (no guard, no fuse), so the cadence and the cap can be watched on
 * their own. Everything else is the real Brood row.
 */
const INERT: Archetype = { ...ARCHETYPES.broodling, routines: [] }
const INERT_BROOD: Archetype = {
  ...ARCHETYPES.brood,
  routines: ARCHETYPES.brood.routines.map((r) => r.kind === 'brood' ? { ...r, child: INERT } : r)
}

test('the rows are the l1-0 provisional numbers: Brood band 5-6, every 4000 ms, cap 3, hold 500; Broodling fuse 6000, tell 500, 25 on the mirror\'s 1 ring, emerge 1500', () => {
  const guard = ARCHETYPES.brood.routines[0] as GuardSpec
  assert.equal(guard.kind, 'guard', 'the guard must run first: it picks the target')
  assert.deepEqual(guard.retreat, { min: 5, max: 6 })
  assert.deepEqual([guard.acquire, guard.lose, guard.chaseSpeed], [7, 9, 60])
  const release = releaseSpec(ARCHETYPES.brood)
  assert.deepEqual({ ...release, child: release.child.key }, { kind: 'brood', child: 'broodling', intervalMs: 4000, cap: 3, releaseMs: 1100, holdMs: 500 })
  assert.equal(release.child, ARCHETYPES.broodling)

  const lingGuard = ARCHETYPES.broodling.routines[0] as GuardSpec
  assert.equal(lingGuard.kind, 'guard', 'the guard must run first: it picks whom to chase')
  assert.deepEqual([lingGuard.acquire, lingGuard.lose, lingGuard.chaseSpeed, lingGuard.standoff], [8, 10, 130, 0])
  assert.deepEqual(ARCHETYPES.broodling.routines[1], { kind: 'broodling', fuseMs: 6000, tellMs: 500, damage: 25, emergeMs: 1500, rings: 1 })
  assert.equal(BLAST_RINGS, 1)
  assert.equal(PRIME_RINGS, 1)
  assert.deepEqual([ARCHETYPES.broodling.maxHp, ARCHETYPES.broodling.loot, ARCHETYPES.broodling.gearRolls], [1, 0, null])
})

test('a Brood with a target releases one every 4000 ms onto the free neighbour nearest it, up to 3 alive, and replaces a dead one at the next beat', (t) => {
  mockClock(t)
  const brood = mobAt(INERT_BROOD)
  const player = playerAt(6)
  for (let i = 0; i < 84; i++) {
    tick(t)
    // Kill one child just after the cap has held a beat (16000): replaced at 20000.
    if (Date.now() - T0 === 17000) releaseOf(brood).children[0].hit(1)
  }

  assert.deepEqual(releases().map((s) => s.at - T0), [4250, 8250, 12250, 20250])
  // The first tick (T0 + 250) notices the player and arms the clock.
  assert.equal(releaseOf(brood).live, 3)
  assert.equal(broodlings().filter((m) => !m.destroyed).length, 3)
  for (const s of releases()) {
    assert.deepEqual([s.originator, s.tag, s.lifetime], [brood.id, 0, 1100])
  }
  // Held at 6 rings (the band), so it never moved: the first release goes on
  // the neighbour nearest the player (east, direction 0), the next on the
  // nearest free one, and so on.
  assert.deepEqual([brood.position.x, brood.position.y], [at(0).x, at(0).y])
  const cells = releases().map((s) => s.cell)
  for (const cell of cells) assert.equal(Hex.distance(cell, HOME), 1)
  assert.deepEqual(cells[0], cellAt(1))
  assert.equal(Hex.distance(cells[1], player.cell), 6, 'the second was not on the next-nearest free neighbour')
  // The fourth went where the dead first one stood, now free again.
  assert.deepEqual(cells[3], cellAt(1))
  // Each child stands on its cell and is in the index as a mob, so no spawn shares a cell.
  for (const child of releaseOf(brood).children) {
    assert.ok(World.MOBS.includes(child))
    assert.equal(World.mobCellFree(child.cell.x, child.cell.y, 0), false)
  }
})

test('a Brood releases nothing without a target, stops when its target goes, and starts again on the next', (t) => {
  mockClock(t)
  const brood = mobAt(INERT_BROOD)
  for (let i = 0; i < 40; i++) tick(t)
  assert.equal(releases().length, 0, 'released with nobody to chase')

  // Noticed at its next scan (an empty scan blocks the next for refreshMs),
  // and released exactly intervalMs after that.
  const player = playerAt(6)
  let noticed: number | undefined
  for (let i = 0; i < 40 && releases().length === 0; i++) {
    tick(t)
    if (noticed === undefined && brood.target === player) noticed = Date.now()
  }
  assert.ok(noticed !== undefined && noticed - T0 > 10_000, 'test setup: noticed too early')
  assert.deepEqual(releases().map((s) => s.at), [noticed + 4000])
  // The target extracts: the next beat finds none and does not re-arm.
  player.exited = true
  for (let i = 0; i < 40; i++) tick(t)
  assert.equal(releases().length, 1, 'released after its target left')

  const next = playerAt(-6, 0, 'p2')
  for (let i = 0; i < 40 && releases().length === 1; i++) tick(t)
  assert.equal(releases().length, 2)
  assert.equal(Hex.distance(releases()[1].cell, next.cell), 5, 'released away from the new target')
})

test('a Brood with no free neighbour skips the beat', (t) => {
  mockClock(t)
  const brood = mobAt(INERT_BROOD)
  playerAt(6)
  for (let d = 0; d < 6; d++) World.block(Hex.neighbour(HOME, d).x, Hex.neighbour(HOME, d).y, 0)
  for (let i = 0; i < 20; i++) tick(t)
  assert.equal(releases().length, 0)
  assert.equal(releaseOf(brood).children.length, 0)
})

test('a Brood\'s death stops the stream at once; what it released keeps its fuse and goes off', (t) => {
  mockClock(t)
  const brood = mobAt(ARCHETYPES.brood)
  playerAt(6)
  for (let i = 0; i < 17; i++) tick(t)
  assert.equal(releases().length, 1)
  const child = releaseOf(brood).children[0]
  assert.equal(child.destroyed, false)

  brood.hit(1e6)
  assert.equal(brood.destroyed, true)
  // Its freed id is the only timer it leaves: the release clock went with it.
  for (let i = 0; i < 48; i++) tick(t)
  assert.equal(releases().length, 1, 'released after dying')
  assert.equal(child.destroyed, true)
  assert.deepEqual(blasts().map((s) => s.originator), [child.id], 'the released Broodling never went off')
})

test('fuse: a Broodling with nobody near goes off where it stands on the tick its 6000 ms end', (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling)
  const ticks: number[] = []
  let cellBefore: Vector | undefined
  for (let i = 0; i < 30; i++) {
    if (!ling.destroyed) cellBefore = ling.cell
    tick(t)
    if (ling.destroyed && ticks.length === 0) ticks.push(Date.now() - T0)
  }
  assert.deepEqual(ticks, [6000])
  assert.equal(blasts().length, 1)
  assert.deepEqual([blasts()[0].at - T0, blasts()[0].originator, blasts()[0].lifetime], [6000, ling.id, 500])
  // Where it stood: the timer runs before the mobs move, so the cell of the last tick.
  assert.deepEqual(blasts()[0].cell, cellBefore)
  assert.equal(ling.hp, 0, 'a destroy without hp 0 reads as leaving view, not a death')
})

test('adjacent: it primes once a player is within 1 ring of the cell it stands on or steps into, stops there, and goes off 500 ms later on that cell', (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling)
  const player = playerAt(4)
  let primedAt: number | undefined
  let standingOn: Vector | undefined
  for (let i = 0; i < 20 && primedAt === undefined; i++) {
    const before = ling.cell
    tick(t)
    if (fuseOf(ling)?.primedCell !== undefined) {
      primedAt = Date.now() - T0
      standingOn = before
    }
  }
  assert.ok(primedAt !== undefined, 'never primed')
  const primed = fuseOf(ling)?.primedCell as Vector
  // It stood on the cell before when the tick began, stepping into the
  // adjacent one: the cell it steps into counts, as for the Reactor's plant.
  assert.notDeepEqual(standingOn, primed, 'primed only once it stood on the adjacent cell')
  assert.equal(Hex.distance(primed, player.cell), PRIME_RINGS)
  const tell = sent.filter((s) => s.type === NPC_EFFECT.broodlingPrimed)
  assert.equal(tell.length, 1)
  assert.deepEqual([tell[0].at - T0, tell[0].cell, tell[0].lifetime, tell[0].originator], [primedAt, primed, 500, ling.id])

  tick(t)
  assert.equal(ling.destroyed, false, 'went off before the tell ended')
  assert.ok(ling.stepTo === undefined || key(ling.stepTo) === key(primed), 'took a new step during the tell')
  tick(t)
  assert.equal(ling.destroyed, true)
  assert.deepEqual(blasts().map((s) => [s.at - T0, key(s.cell)]), [[primedAt + 500, key(primed)]])
  assert.equal(health(player), 150 - 25)
  assert.equal(player.kills, 0)
})

test('primed, it holds its cell while the player runs: the blast lands on the primed cell and misses them', (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling)
  const player = playerAt(1)
  tick(t)
  const primed = fuseOf(ling)?.primedCell
  assert.deepEqual(primed, HOME, 'test setup: not primed at rest on its cell')
  // Gone 3 cells west of it at once: the guard wants to chase, the tell holds it.
  player.position = at(-3)
  tick(t)
  assert.equal(ling.stepTo, undefined, 'stepped during the tell')
  assert.deepEqual(ling.position, at(0))
  tick(t)
  assert.equal(ling.destroyed, true)
  assert.deepEqual(blasts().map((s) => key(s.cell)), [key(HOME)])
  assert.equal(health(player), 150)
})

test('shot: a player\'s hit sets it off in place at once, credits that player one Common kill worth 0 XP, and leaves no fuse behind', async (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling)
  const player = playerAt(-4)
  tick(t)
  const cell = ling.cell
  assert.equal(new RangedAttack(player).execute(cell), true)
  // Only its freed id is left to run: the fuse went with it, because the
  // Broodling owns it (an ownerless fuse would still be pending here).
  assert.equal(Timers.size, 1, 'a timer of the Broodling survived its blast')

  assert.equal(ling.destroyed, true)
  assert.deepEqual(blasts().map((s) => [s.at - T0, key(s.cell)]), [[250, key(cell)]])
  assert.equal(player.kills, 1)
  assert.deepEqual(runResultOf(player, 60, 1).mobKills, { broodling: 1 })
  assert.equal(PROGRESSION.kills.mob.broodling, 0)
  assert.equal(runXp({ ...runResultOf(player, 0, 1), extracted: true, loot: 0 }), runXp({ ...runResultOf(player, 0, 1), extracted: true, loot: 0, mobKills: {} }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(hincrby, ['kills', 'mobKills', 'commonKills'])

  // Its fuse was cancelled with it.
  for (let i = 0; i < 30; i++) tick(t)
  assert.equal(blasts().length, 1)
})

test('shot during its tell, it goes off on the primed cell at once and leaves neither the fuse nor the tell pending', (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling)
  const player = playerAt(1)
  tick(t)
  assert.deepEqual(fuseOf(ling)?.primedCell, HOME, 'test setup: not primed')
  assert.equal(ling.hit(5), true)
  assert.deepEqual(blasts().map((s) => key(s.cell)), [key(HOME)])
  assert.equal(Timers.size, 1, 'a timer of the Broodling survived its blast')
  for (let i = 0; i < 4; i++) tick(t)
  assert.equal(blasts().length, 1)
  assert.equal(health(player), 150 - 25)
})

test('any damaging hit sets it off, lethal or not; a hit that would do nothing does nothing', () => {
  const ling = mobAt(ARCHETYPES.broodling)
  ling.hp = 50
  assert.equal(ling.hit(0), false)
  assert.equal(ling.destroyed, false)
  assert.equal(blasts().length, 0)
  assert.equal(ling.hit(1), true)
  assert.equal(ling.destroyed, true)
  assert.equal(blasts().length, 1)
  // A second hit on the corpse is no kill and no blast.
  assert.equal(ling.hit(10), false)
  assert.equal(fuseOf(ling)?.detonate(), false)
  assert.equal(blasts().length, 1)
})

test('a chain of three goes off once each, frees each id once and credits only the shot that started it', (t) => {
  mockClock(t)
  const a = mobAt(ARCHETYPES.broodling, 0)
  const b = mobAt(ARCHETYPES.broodling, 1)
  const c = mobAt(ARCHETYPES.broodling, 2)
  // A Crawler two blasts reach (b's and c's), with 35 hp: the second kills it.
  const crawler = mobAt(ARCHETYPES.crawler, 2, -1)
  const shooter = playerAt(-4)
  const bystander = playerAt(3, 0, 'p2')
  const freedBefore = GameObject.FreedIDs.length

  assert.equal(new RangedAttack(shooter).execute(a.cell), true)
  // Only the four freed ids are left: every fuse in the chain went with its Broodling.
  assert.equal(Timers.size, 4, 'a timer of a Broodling survived the chain')
  assert.deepEqual([a.destroyed, b.destroyed, c.destroyed], [true, true, true])
  assert.deepEqual(blasts().map((s) => s.originator), [a.id, b.id, c.id])
  assert.equal(crawler.destroyed, true)
  assert.equal(shooter.kills, 1, 'the shooter is credited for a only')
  assert.equal(bystander.kills, 0)
  assert.equal(health(bystander), 150 - 25, 'c\'s blast reaches the bystander once')

  // Fuses and tells all cancelled; the freed ids land a second later, once each.
  for (let i = 0; i < 40; i++) tick(t)
  assert.equal(blasts().length, 3)
  const freed = GameObject.FreedIDs.slice(freedBefore)
  for (const unit of [a, b, c, crawler]) {
    assert.equal(freed.filter((id) => id === unit.id).length, 1, `id ${unit.id} freed ${freed.filter((id) => id === unit.id).length} times`)
  }
})

test('the blast hurts players and mobs on exactly the client\'s cells, credits nobody, and a player it kills was killed by the Broodling, a mob', (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling)
  const drawn = new Set(attackCells(ARCHETYPE_INFO.broodling.attack as never, HOME).map(key))
  assert.equal(drawn.size, 7)
  // A player on every cell of rings 1 and 2 (one already on fumes), a Brood
  // and a Kiln beside it, a Crawler two out.
  const players: Player[] = []
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      const cell = cellAt(q, r)
      const d = Hex.distance(cell, HOME)
      if (d < 1 || d > 2 || (q === 1 && r === 0) || (q === -1 && r === 0)) continue
      players.push(playerAt(q, r, `p${q},${r}`))
    }
  }
  const weak = players.find((p) => Hex.distance(p.cell, HOME) === 1) as Player
  weak.armor = 0
  weak.hp = 10
  const brood = mobAt(ARCHETYPES.brood, 1)
  const kiln = mobAt(ARCHETYPES.kiln, -1)
  const crawler = mobAt(ARCHETYPES.crawler, 2)

  assert.equal(fuseOf(ling)?.detonate(), true)
  for (const p of players) {
    const hit = drawn.has(key(p.cell))
    if (p === weak) {
      assert.equal(hit, true, 'test setup: the weak player is off the blast')
      assert.equal(p.destroyed, true)
      assert.equal(p.killer, ling)
      assert.equal(p.killedBy, 'mob')
      continue
    }
    assert.equal(health(p), hit ? 125 : 150, `player on ${key(p.cell)}`)
  }
  assert.equal(brood.hp, 400 - 25)
  assert.equal(kiln.hp, 80 - 25)
  assert.equal(crawler.hp, 35, 'hit off the blast')
  for (const p of players) assert.equal(p.kills, 0)
})

test('a Broodling drops no loot and no gear when it goes, in a real world\'s sweep', () => {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.PLAYERS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.GEAR.length = 0
  const ling = new Mob(2000, 2000, LAYER_2, ARCHETYPES.broodling)
  World.addUnit(World.MOBS, ling)
  assert.equal(ling.loot, 0)
  assert.deepEqual(world.createGearFrom(ling, () => 0), [], 'a Broodling rolled gear')
  ling.hit(5)
  const before = { loot: World.CONSUMABLES.filter((c) => c.expiresAt > 0).length, gear: World.GEAR.filter((g) => !g.cache).length }
  world.update(DT)
  assert.equal(World.MOBS.includes(ling), false, 'not swept')
  assert.equal(World.CONSUMABLES.filter((c) => c.expiresAt > 0).length, before.loot, 'it dropped loot')
  assert.equal(World.GEAR.filter((g) => !g.cache).length, before.gear, 'it dropped gear')
})

test('the fuse rides lifetime (9): the first create has 6000, a late viewer\'s create the remaining fuse, and no delta ever carries it', (t) => {
  mockClock(t)
  const ling = mobAt(ARCHETYPES.broodling)
  const first = created.find((c) => c.id === ling.id)
  assert.equal(first?.fields.lifetime, 6000)
  assert.equal(ling.dirtyFields.has('lifetime'), false, 'left dirty after the create')

  for (let i = 0; i < 9; i++) {
    tick(t)
    assert.equal(ling.dirtyFields.has('lifetime'), false, 'a fuse delta would go to every holder every tick')
  }
  // 2250 ms in: a create now carries 3750, as the wire's tenths (index 9, uint16 37).
  const fields = ling.serialise(ling.allFields) as Record<string, unknown>
  assert.equal(fields.lifetime, 3750)
  assert.ok(ling.allFields.has('lifetime'))
  assert.equal(GameObject.fieldOrder.indexOf('lifetime'), 9)
  const bytes = [...(ling.serialiseBinary(new Set(['id', 'lifetime'])) as Buffer)]
  assert.deepEqual(bytes, [0, ling.id >> 8, ling.id & 0xff, 9, 0, 37])
})

const LAYER_2 = -2

// l1-7 F6: effect 19 names the release cell. Until #52 lane 2 the Broodling
// had chased off it by the end of its release tick, so the client picks the
// Broodling created in the same frame nearest the cell's centre
// (`vfx/broodpick.ts`). Since the emerge hold it stands on that centre for
// `emergeMs`; the pick is run against the server's real positions after the
// release tick and must still find it.
for (const dtMs of [250, 350]) {
  test(`effect 19 at a ${dtMs} ms tick: the released Broodling stands on the release cell through its emerge, and the client's pick finds it`, (t) => {
    mockClock(t)
    const brood = mobAt(ARCHETYPES.brood)
    playerAt(6)
    let checked = false
    for (let i = 0; i < 40 && !checked; i++) {
      t.mock.timers.tick(dtMs)
      Timers.run(Date.now())
      for (let k = World.MOBS.length - 1; k >= 0; k--) World.MOBS[k].update(dtMs / 1000)
      const release = releases().find((r) => r.at === Date.now())
      if (release === undefined) continue
      checked = true
      const child = releaseOf(brood).children[0]
      const centre = Hex.toPosition(release.cell)
      const off = Math.hypot(child.position.x - centre.x, child.position.y - centre.y)
      // It does not chase in its release tick: the emerge hold.
      assert.equal(off, 0, `${off.toFixed(1)} px off the release cell's centre`)
      assert.ok(off < PICK_REACH, `${off.toFixed(1)} px is beyond the pick's reach`)
      // Its create, built in its constructor, carried the cell's centre.
      const create = created.find((c) => c.id === child.id)
      assert.deepEqual([(create?.fields.position as Vector).x, (create?.fields.position as Vector).y], [centre.x, centre.y])

      const FRAME = 7
      const as = (unit: Unit, frame: number, tag = unit.tag, killed = false): ReleaseCandidate =>
        ({ x: unit.position.x, y: unit.position.y, tag, killed, archetype: { key: unit.archetype?.key ?? '' }, createdInFrame: frame })
      const released = as(child, FRAME)
      const decoy = (dx: number, frame: number, tag = 0, killed = false, key = 'broodling'): ReleaseCandidate =>
        ({ x: centre.x + dx, y: centre.y, tag, killed, archetype: { key }, createdInFrame: frame })
      const candidates: ReleaseCandidate[] = [
        decoy(0, FRAME - 1), // on the centre, but created in an earlier frame (a late viewer's, or an older one)
        decoy(0, FRAME, -1), // this frame, on the centre, another layer
        decoy(0, FRAME, 0, true), // this frame, on the centre, already dead
        decoy(0, FRAME, 0, false, 'crawler'), // this frame, on the centre, not a Broodling
        decoy(PICK_REACH + 1, FRAME), // this frame, beyond reach
        decoy(off + 20, FRAME), // this frame, further than the released one
        released
      ]
      assert.equal(pickReleased(candidates, 0, centre, FRAME), released)
      // Standing on its cell, the exact-cell rule (F2) would now find it too.
      const onCell = candidates.filter((c) => c.createdInFrame === FRAME && c.tag === 0 && !c.killed &&
        c.archetype?.key === 'broodling' && key(Hex.toCell(new Vector(c.x, c.y))) === key(release.cell))
      assert.ok(onCell.includes(released))
      // Nothing created this frame: no pick.
      assert.equal(pickReleased(candidates, 0, centre, FRAME + 1), undefined)
    }
    assert.ok(checked, 'never released')
  })
}
