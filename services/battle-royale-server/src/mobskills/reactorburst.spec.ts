import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { ARCHETYPES } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import ReactorBurst, { type ReactorPhase } from './reactorburst'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
// The client's port. It imports nothing, so this pulls no pixi into the server.
import { attackCells } from '../../../../plunder-land-client/src/vfx/cells'

/**
 * The Reactor Spider's charge, plant and radial burst (decision #51, l1-5):
 * the phases to the tick, the disc against the client's, players only, kill
 * credit, death cancelling everything, and the planted Reactor standing still.
 *
 * Ticks are driven as `World.update` runs them: the clock moves 250 ms, due
 * timers run, then every live mob updates.
 */

const DT = 0.25
const TICK_MS = 250

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
  World.STEPS.clear()
  Timers.clear()
})

afterEach(() => { mock.restoreAll() })

const HOME = Hex.toCell(new Vector(2000, 2000))
const cellAt = (dq: number, dr: number = 0): Vector => new Vector(HOME.x + dq, HOME.y + dr)
const at = (dq: number, dr: number = 0): Vector => Hex.toPosition(cellAt(dq, dr))
const key = (cell: { x: number, y: number }): string => `${cell.x},${cell.y}`

const RINGS = (ARCHETYPE_INFO.reactor.attack as { rings: number }).rings

function reactorAt (dq = 0, dr = 0): Mob {
  const p = at(dq, dr)
  const mob = new Mob(p.x, p.y, 0, ARCHETYPES.reactor)
  World.MOBS.push(mob)
  return mob
}

function playerAt (dq: number, dr = 0, id = 'p1'): Player {
  const p = at(dq, dr)
  const player = new Player(p.x, p.y, 0, id)
  World.PLAYERS.push(player)
  return player
}

const burstOf = (mob: Mob): ReactorBurst => mob.routines.find((r) => r instanceof ReactorBurst) as ReactorBurst
const health = (unit: Player): number => unit.hp + unit.armor

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

/** One server tick: the clock, the timers, then each live mob, as `World.update`. */
function tick (t: TestContext): void {
  t.mock.timers.tick(TICK_MS)
  Timers.run(Date.now())
  for (const mob of World.MOBS) if (!mob.destroyed) mob.update(DT)
}

test('the spec is the l1-0 provisional numbers, the disc is the mirror\'s, timings are the clip\'s', () => {
  const spec = ARCHETYPES.reactor.routines.find((r) => r.kind === 'reactorBurst')
  assert.deepEqual(spec, {
    kind: 'reactorBurst',
    plantRings: 2,
    rings: 2,
    damage: 25,
    pulses: 4,
    activateMs: 1000,
    releaseMs: 1000,
    settleMs: 350,
    cooldownMs: 2000
  })
  assert.equal(ARCHETYPES.reactor.routines[0].kind, 'guard', 'the guard must run first: it picks the target')
  assert.equal(ARCHETYPES.reactor.contact.damage, 15)
})

test('tell, release, four pulses and settle land on the right ticks, then it cools down and plants again', (t) => {
  mockClock(t)
  const reactor = reactorAt()
  const player = playerAt(2)
  const start = reactor.position

  // Tick 0: noticed and planted at once (2 rings), no step taken.
  tick(t)
  const t0 = Date.now()
  const rows: Array<{ ms: number, phase: ReactorPhase, health: number, types: number[] }> = []
  let seen = 0
  const record = (): void => {
    rows.push({ ms: Date.now() - t0, phase: burstOf(reactor).phase, health: health(player), types: sent.slice(seen).map((s) => s.type) })
    seen = sent.length
  }
  record()
  for (let i = 0; i < 18; i++) {
    tick(t)
    record()
    if (Date.now() - t0 < 2500 && burstOf(reactor).planted) assert.deepEqual([reactor.position.x, reactor.position.y], [start.x, start.y], `moved while planted at ${Date.now() - t0} ms`)
  }

  const tell = NPC_EFFECT.reactorTell
  const release = NPC_EFFECT.reactorRelease
  assert.deepEqual(rows.slice(0, 11), [
    { ms: 0, phase: 'activate', health: 150, types: [tell] },
    { ms: 250, phase: 'activate', health: 150, types: [] },
    { ms: 500, phase: 'activate', health: 150, types: [] },
    { ms: 750, phase: 'activate', health: 150, types: [] },
    { ms: 1000, phase: 'release', health: 125, types: [release] },
    { ms: 1250, phase: 'release', health: 100, types: [] },
    { ms: 1500, phase: 'release', health: 75, types: [] },
    { ms: 1750, phase: 'release', health: 50, types: [] },
    { ms: 2000, phase: 'settle', health: 50, types: [] },
    { ms: 2250, phase: 'settle', health: 50, types: [] },
    // The 350 ms settle ends at 2350, on the next tick. Chasing again, it is
    // past half a step toward the player, so adjacent: contact's 15.
    { ms: 2500, phase: 'cooldown', health: 35, types: [] }
  ])
  // Cooling down it chases again: the guard's step toward the player (2 rings) is no longer cleared.
  assert.notDeepEqual([reactor.position.x, reactor.position.y], [start.x, start.y], 'did not move while cooling down')
  // 2000 ms of cooldown from the settle's end (2500): plants again at 4500, not before.
  const replant = rows.find((row) => row.types.includes(tell) && row.ms > 0)
  assert.equal(replant?.ms, 4500)
  assert.ok(rows.filter((row) => row.ms > 2500 && row.ms < 4500).every((row) => row.phase === 'cooldown'))

  // Both effects on the planted cell, the Reactor's layer and id, for 1 s each.
  for (const effect of sent.slice(0, 2)) {
    assert.deepEqual([effect.cell.x, effect.cell.y, effect.tag, effect.originator, effect.lifetime], [HOME.x, HOME.y, 0, reactor.id, 1000])
  }
})

test('planting mid-step finishes the step onto the planted cell, and the burst is centred there', (t) => {
  mockClock(t)
  const reactor = reactorAt()
  playerAt(5)

  let plantedOn: Vector | undefined
  let stoodOn: Vector | undefined
  for (let i = 0; i < 20 && plantedOn === undefined; i++) {
    stoodOn = reactor.cell
    tick(t)
    plantedOn = burstOf(reactor).plantedCell
  }
  assert.ok(plantedOn !== undefined, 'never planted')
  const tell = sent.find((s) => s.type === NPC_EFFECT.reactorTell)
  assert.deepEqual(tell?.cell, plantedOn)
  // Mid-step at the plant: it stood on another cell and was moving into the planted one.
  assert.notDeepEqual(stoodOn, plantedOn, 'test setup: planted at rest, not mid-step')
  assert.equal(Hex.distance(plantedOn, cellAt(5)), 2)

  // It finishes that step and takes no other through the settle.
  const centre = Hex.toPosition(plantedOn)
  for (let i = 0; i < 9; i++) {
    tick(t)
    assert.ok(burstOf(reactor).planted, `unplanted after ${i + 1} ticks`)
  }
  assert.deepEqual([reactor.position.x, reactor.position.y], [centre.x, centre.y])
  assert.equal(reactor.stepTo, undefined)
  const release = sent.find((s) => s.type === NPC_EFFECT.reactorRelease)
  assert.deepEqual(release?.cell, plantedOn)
})

test('it plants on a target 2 rings away, not 3', (t) => {
  mockClock(t)
  for (const [rings, plants] of [[2, true], [3, false]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    Timers.clear()
    const reactor = reactorAt()
    reactor.routines.splice(0, 1) // the burst alone: hold it still, target set by hand
    reactor.target = playerAt(rings)
    tick(t)
    assert.equal(burstOf(reactor).planted, plants, `at ${rings} rings`)
  }
})

test('it does not plant on a dead or extracted target', (t) => {
  mockClock(t)
  for (const end of ['dead', 'extracted'] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const reactor = reactorAt()
    reactor.routines.splice(0, 1)
    const player = playerAt(1)
    if (end === 'dead') player.hit(9999)
    else player.exit()
    reactor.target = player
    tick(t)
    assert.equal(burstOf(reactor).phase, 'ready', end)
  }
})

test('a pulse hits players on exactly the client\'s disc cells, never mobs, the dead or the extracted', (t) => {
  mockClock(t)
  const reactor = reactorAt()
  const players: Player[] = []
  for (let dq = -(RINGS + 2); dq <= RINGS + 2; dq++) {
    for (let dr = -(RINGS + 2); dr <= RINGS + 2; dr++) {
      if (Hex.distance(new Vector(0, 0), new Vector(dq, dr)) > RINGS + 2) continue
      if (dq === 0 && dr === 0) continue
      players.push(playerAt(dq, dr, `p${dq}_${dr}`))
    }
  }
  // A mob on the disc, standing still: the burst is players only (Q6).
  const compactorAt = at(1, -1)
  const bystander = new Mob(compactorAt.x, compactorAt.y, 0, ARCHETYPES.compactor)
  bystander.routines.length = 0
  World.MOBS.push(bystander)
  // Remove the contact hits from the count: only the burst is measured.
  reactor.canAttack = false
  // Stand in a dead and an extracted player on the disc: neither is hit again.
  const dead = players.find((p) => Hex.distance(p.cell, HOME) === 1) as Player
  dead.hit(9999)
  const gone = players.find((p) => Hex.distance(p.cell, HOME) === 2) as Player
  gone.exit()

  tick(t)
  assert.ok(burstOf(reactor).planted)
  for (let i = 0; i < 4; i++) tick(t)
  assert.equal(burstOf(reactor).phase, 'release')

  const hit = players.filter((p) => p !== dead && health(p) < 150).map((p) => key(p.cell)).sort()
  const client = attackCells(ARCHETYPE_INFO.reactor.attack as never, { x: HOME.x, y: HOME.y })
    .filter((c) => !(c.x === HOME.x && c.y === HOME.y))
    .filter((c) => key(c) !== key(dead.cell) && key(c) !== key(gone.cell))
    .map(key).sort()
  assert.equal(client.length, 19 - 3)
  assert.deepEqual(hit, client)
  for (const p of players) if (health(p) < 150 && p !== dead) assert.equal(health(p), 125, `${key(p.cell)} took one pulse`)
  assert.equal(gone.hp + gone.armor, 150, 'an extracted player was hit')
  assert.equal(bystander.hp, ARCHETYPES.compactor.maxHp, 'a mob was hit')
})

test('a pulse that kills credits the Reactor', (t) => {
  mockClock(t)
  const reactor = reactorAt()
  const player = playerAt(2)
  player.armor = 0
  player.hp = 20
  for (let i = 0; i < 5; i++) tick(t)
  assert.equal(player.destroyed, true)
  assert.equal(player.killer, reactor)
  assert.equal(player.killedBy, 'mob')
})

test('a Reactor killed during the tell or the release stops at once and leaves no timer', (t) => {
  mockClock(t)
  for (const [phase, ticksBefore, expected] of [['activate', 2, 150], ['release', 5, 125]] as const) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    Timers.clear()
    sent = []
    const reactor = reactorAt()
    const player = playerAt(2)
    const before = Timers.size

    for (let i = 0; i < ticksBefore; i++) tick(t)
    assert.equal(burstOf(reactor).phase, phase, 'test setup')
    assert.ok(Timers.size > before, 'test setup: nothing scheduled')
    reactor.hit(99999)
    assert.equal(reactor.destroyed, true)
    // `GameObject.destroy` schedules its freed id, with no owner; nothing else may be left.
    assert.equal(Timers.size, before + 1, `timers left after dying in ${phase}, besides the freed id`)

    const types = sent.length
    for (let i = 0; i < 12; i++) tick(t)
    assert.equal(health(player), expected, `posthumous damage after dying in ${phase}`)
    assert.equal(sent.length, types, `posthumous effect after dying in ${phase}`)
  }
})

test('a target that walks off mid-tell does not move the burst: it lands on the planted disc', (t) => {
  mockClock(t)
  const reactor = reactorAt()
  const player = playerAt(2)
  tick(t)
  assert.ok(burstOf(reactor).planted)
  player.position = at(RINGS + 1)
  for (let i = 0; i < 8; i++) tick(t)
  assert.equal(health(player), 150)
  assert.deepEqual([reactor.position.x, reactor.position.y], [at(0).x, at(0).y])
})
