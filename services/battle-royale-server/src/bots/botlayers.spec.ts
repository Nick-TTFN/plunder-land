import test, { afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Portal from '../objects/portal'
import type Player from '../objects/player'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { SKILL_INFO } from '../utils/skills'
import BotFill from './fill'
import BotBrain, { BOT_SKILL, botLayer, kitOf, pickTemperament, robotAllowedOn } from './brain'

/**
 * Bots by layer (#58 addendum 2 Q6, addendum 4; task retest-7): a bot joins
 * on the layer whose humans have the fewest bots per head, as one of that
 * layer's robots and temperaments, with that layer's cargo; it never walks
 * into a layer whose robots leave its own out; layer 0's bots think every
 * 900 ms and miss 60%. Humans still join on the top layer.
 */

afterEach(() => { World.strict = false })

const TOP = 0
const MIDDLE = -1
const BOTTOM = -2

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null, keys: async () => [], hgetall: async () => ({})
  }) as unknown as Redis
}

/** mulberry32, as bots.spec.ts: the same population every run. */
function seeded (seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

/**
 * A world with no rocks, valleys, gates, mobs or pickups: only what a test puts
 * in it. Valleys too: a Hopper routes over rocks but not valleys
 * (`Unit.blocks`), and one on the straight line sent it around the portal.
 */
function quietWorld (): World {
  World.strict = false
  void new Multiplayer(250, redisStub())
  const world = new World(4000)
  World.MOBS.length = 0
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.VOIDS.clear()
  World.ITEMS.length = 0
  World.CONSUMABLES.length = 0
  World.GEAR.length = 0
  return world
}

const keyOf = (p: Player): string => (p.archetype as { key: string }).key

// --- the table -------------------------------------------------------------------

test('BOT_SKILL: Dez\'s table and addendum 4, top layer first', () => {
  assert.equal(BOT_SKILL.length, World.TAGS.length)
  const row = (i: number): unknown => {
    const r = BOT_SKILL[i]
    return [r.reactionMs, r.aimMiss, r.engageRings, r.descend, [...r.robots], [...r.temperaments], { ...r.cargo }]
  }
  assert.deepEqual(row(0), [900, 0.6, 5, 0.25, ['peep', 'magnet', 'periscope'], ['steady', 'looter', 'diver'], { chance: 0.25, tier: 1 }])
  assert.deepEqual(row(1), [450, 0.25, 6, 0.15, ['peep', 'magnet', 'periscope', 'hopper'], ['steady', 'brawler', 'looter', 'diver'], { chance: 0.25, tier: 1 }])
  assert.deepEqual(row(2), [300, 0.12, 6, 0, ['magnet', 'periscope', 'hopper', 'waddle'], ['steady', 'brawler', 'looter', 'diver'], { chance: 0.4, tier: 2 }])
  // Layers 04 and 05 (tags -3, -4): Dez's section 3 (`ideas/private-layers-numbers.md`,
  // accepted 2026-11-06, task private-8).
  assert.deepEqual(row(3), [250, 0.08, 6, 0, ['magnet', 'periscope', 'hopper', 'waddle'], ['steady', 'brawler', 'looter', 'diver'], { chance: 0.5, tier: 2 }])
  assert.deepEqual(row(4), [200, 0.05, 7, 0, ['magnet', 'periscope', 'hopper', 'waddle'], ['steady', 'brawler', 'looter', 'diver'], { chance: 0.4, tier: 3 }])
  assert.equal(robotAllowedOn('waddle', TOP), false)
  assert.equal(robotAllowedOn('hopper', TOP), false)
  assert.equal(robotAllowedOn('peep', BOTTOM), false)
  assert.equal(robotAllowedOn('magnet', BOTTOM), true)
  assert.equal(robotAllowedOn('magnet', 7), false, 'not a layer')
})

test('temperaments: over layer 0\'s three, steady 50%, looter and diver 25% each; over all four, as before', () => {
  const count = (allowed?: typeof BOT_SKILL[number]['temperaments']): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (let i = 0; i < 100; i++) {
      const t = allowed === undefined ? pickTemperament(() => i / 100) : pickTemperament(() => i / 100, allowed)
      counts[t] = (counts[t] ?? 0) + 1
    }
    return counts
  }
  assert.deepEqual(count(BOT_SKILL[0].temperaments), { steady: 50, looter: 25, diver: 25 })
  assert.deepEqual(count(BOT_SKILL[2].temperaments), { steady: 40, brawler: 20, looter: 20, diver: 20 })
  assert.deepEqual(count(), { steady: 40, brawler: 20, looter: 20, diver: 20 })
})

// --- joining on a layer ----------------------------------------------------------

test('a bot spawned for each layer is on it, as one of its robots and temperaments; never a Waddle on layer 0', () => {
  const world = quietWorld()
  for (const [i, tag] of World.TAGS.entries()) {
    const fill = new BotFill(1000, 2000, seeded(101 + i))
    const robots = new Set<string>()
    const temperaments = new Set<string>()
    const N = tag === TOP ? 1000 : 300
    for (let n = 0; n < N; n++) {
      const bot = fill.spawn(1_000_000, tag)
      assert.equal(bot.tag, tag, 'joined on another layer')
      assert.ok(bot.bot !== undefined)
      robots.add(keyOf(bot))
      temperaments.add(bot.bot.temperament)
      // Keep the spawn cells free: the world's own players don't matter here.
      World.PLAYERS.length = 0
    }
    assert.deepEqual([...robots].sort(), [...BOT_SKILL[i].robots].sort(), `layer ${tag}: robots`)
    // Written out, not read from the table: the point of the table (#58).
    if (tag === TOP) assert.deepEqual([...robots].sort(), ['magnet', 'peep', 'periscope'], 'a Hopper or Waddle on layer 0')
    if (tag === BOTTOM) assert.equal(robots.has('peep'), false, 'a Peep on layer -2')
    assert.deepEqual([...temperaments].sort(), [...BOT_SKILL[i].temperaments].sort(), `layer ${tag}: temperaments`)
  }
  world.close()
})

test('cargo by layer: a quarter at T1 on 0 and -1, 40% at T2 on -2', () => {
  const world = quietWorld()
  for (const [i, tag] of World.TAGS.entries()) {
    const fill = new BotFill(1000, 2000, seeded(7919 + i))
    let carriers = 0
    const N = 800
    for (let n = 0; n < N; n++) {
      const bot = fill.spawn(1_000_000, tag)
      for (const item of bot.bag) assert.equal(item.tier, BOT_SKILL[i].cargo.tier, `layer ${tag}: tier`)
      if (bot.bag.length > 0) carriers++
      World.PLAYERS.length = 0
    }
    const want = BOT_SKILL[i].cargo.chance
    assert.ok(Math.abs(carriers / N - want) < 0.05, `layer ${tag}: ${carriers} of ${N} carry, want ${want}`)
  }
  assert.deepEqual({ ...BOT_SKILL[2].cargo }, { chance: 0.4, tier: 2 })
  world.close()
})

test('the next bot joins where humans have the fewest bots per head, ties to the top; a layer with no human gets none', () => {
  const world = quietWorld()
  World.PLAYERS.length = 0
  assert.equal(BotFill.layerFor(), undefined, 'no humans: nowhere')

  // Two humans on 0, one on -1, none on -2.
  World.createPlayer('a00001', 'h', undefined, 'peep', undefined, TOP)
  World.createPlayer('a00002', 'h', undefined, 'peep', undefined, TOP)
  World.createPlayer('a00003', 'h', undefined, 'peep', undefined, MIDDLE)
  const fill = new BotFill(1000, 2000, seeded(5))
  assert.equal(BotFill.layerFor(), TOP, '0 per head on both: the top')
  fill.spawn(1_000_000, TOP)
  assert.equal(BotFill.layerFor(), MIDDLE, '0.5 on 0 against 0 on -1')
  const onMiddle = fill.spawn(1_000_000, MIDDLE)
  assert.equal(BotFill.layerFor(), TOP, '0.5 on 0 against 1 on -1')
  // A leaving bot no longer counts.
  assert.ok(onMiddle.bot !== undefined)
  onMiddle.bot.leaving = true
  assert.equal(BotFill.layerFor(), MIDDLE)
  onMiddle.bot.leaving = false
  // A dead or extracted human counts for nothing.
  for (const p of World.PLAYERS) if (p.bot === undefined && p.tag === TOP) p.destroy()
  assert.equal(BotFill.layerFor(), MIDDLE, 'no live human on 0')
  world.close()
})

test('the fill puts bots only on layers with a human, spread by head', (t: TestContext) => {
  const world = quietWorld()
  World.PLAYERS.length = 0
  // One human on -1, three on -2, none on 0.
  World.createPlayer('b00001', 'h', undefined, 'peep', undefined, MIDDLE)
  for (let i = 0; i < 3; i++) World.createPlayer(`b0000${i + 2}`, 'h', undefined, 'peep', undefined, BOTTOM)
  const fill = new BotFill(12, 0, seeded(11))
  for (let i = 0; i < 20; i++) fill.update(4, 1_000_000 + i)
  const bots = World.PLAYERS.filter((p) => p.bot !== undefined)
  assert.equal(bots.length, 8, 'humans + bots = 12')
  const on = (tag: number): number => bots.filter((p) => p.tag === tag).length
  assert.deepEqual([on(TOP), on(MIDDLE), on(BOTTOM)], [0, 2, 6], 'two per head on each layer with a human')
  for (const bot of bots) assert.ok(robotAllowedOn(keyOf(bot), bot.tag), `${keyOf(bot)} on ${bot.tag}`)
  world.close()
  void t
})

test('humans still join on the top layer: createPlayer with no tag, or one that is no layer', () => {
  const world = quietWorld()
  assert.equal(World.createPlayer('c00001', 'h').tag, TOP)
  assert.equal(World.createPlayer('c00002', 'h', undefined, 'waddle', undefined, 7).tag, TOP)
  world.close()
})

// --- staying in range ------------------------------------------------------------

/**
 * A bot of `robot` on `tag`, with a brain whose every draw is `r`, and nothing
 * near it. On the map's centre cell, not where `spawnCell` put it: near an
 * edge, a fixed wander direction or a portal two cells out can be off the map.
 */
function botOn (tag: number, robot: string, r = 0): { me: Player, brain: BotBrain } {
  const me = World.createPlayer(`bot-${robot}-${tag}`, 'b', undefined, robot, kitOf('steady', () => 0), tag)
  me.position = Hex.toPosition(Hex.toCell(new Vector(2000, 2000)))
  const brain = new BotBrain(me, Date.now(), () => r, 'steady')
  return { me, brain }
}

function line (from: Vector, direction: number, n: number): Vector {
  let at = from
  for (let i = 0; i < n; i++) at = Hex.neighbour(at, direction)
  return at
}

test('a bot never takes a portal down into a layer that leaves its robot out; one it may enter, it takes, if a human is there', () => {
  // A bot follows the humans (#60 Q8): with no human on -2, a Magnet stays too.
  for (const [robot, human, takes] of [['peep', true, false], ['magnet', true, true], ['magnet', false, false]] as const) {
    const world = quietWorld()
    World.PLAYERS.length = 0
    if (human) World.createPlayer('d00001', 'h', undefined, 'peep', undefined, BOTTOM)
    // random 0: descend always rolls (0 < 0.15), and a wander goes 4 cells in direction 0.
    const { me, brain } = botOn(MIDDLE, robot)
    const portalCell = line(me.cell, 3, 2)
    const at = Hex.toPosition(portalCell)
    World.addObstacle(new Portal(at.x, at.y, BOTTOM, MIDDLE))
    // Every route it asks for. A Peep must not even ask for the portal: the
    // route guard in `go` would refuse it too, but only after a search.
    const asked: Vector[] = []
    const setWaypoints = me.setWaypoints.bind(me)
    me.setWaypoints = (cells) => { asked.push(...cells); setWaypoints(cells) }
    brain.update()
    const end = me.path[me.path.length - 1]
    assert.ok(end !== undefined, `${robot}: stood still`)
    const onPortal = end.x === portalCell.x && end.y === portalCell.y
    assert.equal(onPortal, takes, `${robot} on -1 (human on -2: ${human}): ${takes ? 'did not head' : 'headed'} for the portal down to -2`)
    const askedPortal = asked.some((c) => c.x === portalCell.x && c.y === portalCell.y)
    assert.equal(askedPortal, takes, `${robot} (human on -2: ${human}): asked for a route to the portal`)
    world.close()
  }
})

test('a route that would end on a portal into a layer that leaves the robot out is not walked', () => {
  for (const [robot, walks] of [['waddle', false], ['magnet', true]] as const) {
    const world = quietWorld()
    World.PLAYERS.length = 0
    const { me, brain } = botOn(BOTTOM, robot)
    // A portal up to -1 two cells along the way to a cell four out.
    const portalCell = line(me.cell, 0, 2)
    const at = Hex.toPosition(portalCell)
    World.addObstacle(new Portal(at.x, at.y, MIDDLE, BOTTOM))
    const go = (brain as unknown as { go: (cell: Vector) => boolean }).go.bind(brain)
    assert.equal(go(line(me.cell, 0, 4)), walks, robot)
    if (walks) {
      const end = me.path[me.path.length - 1]
      assert.deepEqual([end.x, end.y], [portalCell.x, portalCell.y], 'the route ends on the portal')
    } else {
      assert.deepEqual(me.path, [], 'a Waddle set off towards -1')
    }
    world.close()
  }
})

test('a brawler whose route to a player was refused does not Dash: a standing dash could hop the portal', () => {
  // A Hopper brawler on -1, a player 5 rings east, a portal up to 0 (barred
  // to a Hopper) on the straight line between them: the only 5-cell route
  // ends on it, so `go` refuses. A Magnet (allowed on 0) walks it and dashes.
  for (const [robot, dashes] of [['hopper', false], ['magnet', true]] as const) {
    const world = quietWorld()
    World.PLAYERS.length = 0
    const me = World.createPlayer(`bot-${robot}`, 'b', undefined, robot, kitOf('brawler', () => 0), MIDDLE)
    me.position = Hex.toPosition(Hex.toCell(new Vector(2000, 2000)))
    // random 0: the 50% dash always rolls.
    const brain = new BotBrain(me, Date.now(), () => 0, 'brawler')
    const portalCell = line(me.cell, 0, 2)
    const at = Hex.toPosition(portalCell)
    World.addObstacle(new Portal(at.x, at.y, TOP, MIDDLE))
    const pressed: number[] = []
    me.skills.forEach((skill, slot) => { if (skill !== null) skill.execute = () => { pressed.push(me.skillIds[slot]); return true } })
    const fight = (brain as unknown as { fight: (enemy: unknown, distance: number, skill: unknown, health: number, fleeing: boolean) => void }).fight.bind(brain)
    fight({ cell: line(me.cell, 0, 5), type: me.type }, 5, botLayer(MIDDLE), 1, false)
    assert.equal(pressed.includes(SKILL_INFO.dash.id), dashes, `${robot}: pressed ${pressed.join()}`)
    if (!dashes) assert.deepEqual(me.path, [], 'a Hopper set off towards 0')
    world.close()
  }
})

// --- layer 0 is slower and less accurate (addendum 4) -----------------------------

test('a bot on layer 0 thinks every 900 ms (before jitter), on -1 every 450 ms', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  for (const [tag, ms] of [[TOP, 900], [MIDDLE, 450], [BOTTOM, 300]] as const) {
    const world = quietWorld()
    World.PLAYERS.length = 0
    // random 0.5: the jitter is x1.0.
    const { brain } = botOn(tag, 'magnet', 0.5)
    brain.update()
    assert.equal((brain as unknown as { nextThinkAt: number }).nextThinkAt - Date.now(), ms, `layer ${tag}`)
    world.close()
  }
})

test('a bot on layer 0 aims off its target 60% of the time', () => {
  const world = quietWorld()
  World.PLAYERS.length = 0
  const me = World.createPlayer('bot-aim', 'b', undefined, 'peep', kitOf('steady', () => 0), TOP)
  me.position = Hex.toPosition(Hex.toCell(new Vector(2000, 2000)))
  const brain = new BotBrain(me, Date.now(), seeded(42), 'steady')
  const aims: Array<Vector | undefined> = []
  me.tryExecuteSkill = (slot, aim) => { if (me.skillIds[slot] === SKILL_INFO.ranged.id) aims.push(aim) }
  const fight = (brain as unknown as { fight: (enemy: unknown, distance: number, skill: unknown, health: number, fleeing: boolean) => void }).fight.bind(brain)
  const target = line(me.cell, 0, 3)
  const N = 2000
  for (let i = 0; i < N; i++) fight({ cell: target, type: me.type }, 3, botLayer(TOP), 1, true)
  assert.equal(aims.length, N)
  const missed = aims.filter((a) => a === undefined || a.x !== target.x || a.y !== target.y).length
  assert.ok(Math.abs(missed / N - 0.6) < 0.04, `missed ${missed} of ${N}`)
  world.close()
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer
