import test, { afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import type Player from '../objects/player'
import { Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import { ARCHETYPES } from '../archetypes/archetypes'
import { Skill } from '../skills/skill'
import { MeleeAttack } from '../skills/meleeattack'
import { RangedAttack } from '../skills/rangedattack'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { FireBreath } from '../skills/firebreath'
import { IceBreath } from '../skills/icebreath'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import BotFill, { LEAVE_GRACE_MS } from './fill'
import { BOT_SKILL } from './brain'

/**
 * The bot handicap by layer (decision #60, Q7, task private-4): a bot joining
 * on layer 01 has half its robot's max HP and max armor and deals half its
 * damage, on 02 three quarters, from 03 full; speed is untouched. And bots
 * follow the humans (Q8): a bot on a layer with no human heads out, so the
 * fill tops up on the human's layer.
 */

afterEach(() => { World.strict = false })

const [TOP, MIDDLE, BOTTOM] = World.TAGS
const DT = 0.25

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null, keys: async () => [], hgetall: async () => ({})
  }) as unknown as Redis
}

/** mulberry32, as botlayers.spec.ts. */
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

/** A world with nothing in it but what a test puts there (botlayers.spec.ts). */
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
  World.PROJECTILES.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
  return world
}

const keyOf = (p: Player): keyof typeof ARCHETYPES => (p.archetype as { key: keyof typeof ARCHETYPES }).key

// --- the table -------------------------------------------------------------------

test('BOT_SKILL handicap: x0.5 on layer 01, x0.75 on 02, x1 on 03, HP (and armor) and damage alike', () => {
  assert.deepEqual(BOT_SKILL.map((r) => [r.hpScale, r.damageScale]), [[0.5, 0.5], [0.75, 0.75], [1, 1]])
})

// --- HP and armor ----------------------------------------------------------------

test('a bot joins with its layer\'s share of its robot\'s max HP and armor, full; speed as the robot; a human as the robot', () => {
  const world = quietWorld()
  for (const [i, tag] of World.TAGS.entries()) {
    const scale = BOT_SKILL[i].hpScale
    const fill = new BotFill(1000, 2000, seeded(31 + i))
    const seen = new Set<string>()
    for (let n = 0; n < 60; n++) {
      const bot = fill.spawn(1_000_000, tag)
      const robot = ARCHETYPES[keyOf(bot)]
      seen.add(keyOf(bot))
      assert.equal(bot.tag, tag)
      assert.equal(bot.maxHp, Math.round(robot.maxHp * scale), `${keyOf(bot)} on ${tag}: max hp`)
      assert.equal(bot.hp, bot.maxHp, 'not full')
      assert.equal(bot.maxArmor, Math.round(robot.armor.max * scale), `${keyOf(bot)} on ${tag}: max armor`)
      assert.equal(bot.armor, bot.maxArmor, 'armor not full')
      assert.equal(bot.maxVelocity, robot.speed, 'the handicap changed the speed')
      assert.equal(bot.botDamage, BOT_SKILL[i].damageScale)
      assert.equal(bot.damageScale, robot.damageScale * BOT_SKILL[i].damageScale)

      const human = World.createPlayer('a0000f', 'h', undefined, keyOf(bot), undefined, tag)
      assert.equal(human.tag, tag)
      assert.deepEqual([human.maxHp, human.hp, human.maxArmor, human.armor, human.maxVelocity, human.damageScale, human.botDamage],
        [robot.maxHp, robot.maxHp, robot.armor.max, robot.armor.max, robot.speed, robot.damageScale, 1], 'a human was handicapped')
      World.PLAYERS.length = 0
    }
    assert.deepEqual([...seen].sort(), [...BOT_SKILL[i].robots].sort(), `layer ${tag}: not every robot was checked`)
  }
  // Written out, not read from the table: Peep on 01 is 50 hp and 25 armor.
  const peep = new BotFill(1, 0, () => 0).spawn(1_000_000, TOP)
  assert.equal(keyOf(peep), 'peep')
  assert.deepEqual([peep.maxHp, peep.maxArmor], [50, 25])
  world.close()
})

test('a bot keeps the handicap of the layer it joined on when it changes layer', () => {
  const world = quietWorld()
  const bot = new BotFill(1, 0, () => 0).spawn(1_000_000, TOP)
  const before = [bot.maxHp, bot.maxArmor, bot.damageScale]
  bot.changeLayer(MIDDLE)
  bot.changeLayer(BOTTOM)
  assert.deepEqual([bot.maxHp, bot.maxArmor, bot.damageScale], before)
  world.close()
})

// --- damage, by path -------------------------------------------------------------

/**
 * Every player skill that deals damage, each through `Skill.dealt`
 * (`robotselect.spec.ts` checks the source of every skill for it). A bot's
 * kit uses melee, ranged and the throws; the breaths are gear skills, which a
 * bot never equips, but are measured anyway. `hit`'s argument is recorded,
 * before the floor and before the target's own multipliers.
 */
const PATHS: ReadonlyArray<{ name: string, make: (owner: Player) => Skill, flies: boolean, area: boolean }> = [
  { name: 'melee', make: (o) => new MeleeAttack(o), flies: false, area: false },
  { name: 'ranged', make: (o) => new RangedAttack(o), flies: false, area: false },
  { name: 'fireball', make: (o) => new ThrowFireball(o), flies: true, area: false },
  { name: 'icicle', make: (o) => new Throwicicle(o), flies: true, area: false },
  { name: 'fire breath', make: (o) => new FireBreath(o), flies: false, area: true },
  { name: 'ice breath', make: (o) => new IceBreath(o), flies: false, area: true }
]

/**
 * In a fresh quiet world: `make` an owner there, a sturdy target two cells
 * East of it, cast the skill at the target, and return what `hit` was given.
 */
function dealtBy (t: TestContext, make: () => Player, path: typeof PATHS[number]): { owner: Player, hits: number[] } {
  const world = quietWorld()
  const owner = make()
  const at = Hex.toCell(new Vector(2000, 2000))
  owner.position = Hex.toPosition(at)
  let cell = at
  for (let i = 0; i < 2; i++) cell = Hex.neighbour(cell, 0)
  const spot = Hex.toPosition(cell)
  const target = new Unit(ObjectType.Mob, spot.x, spot.y, 10, owner.tag)
  target.maxHp = 10000
  target.hp = 10000
  World.addUnit(World.MOBS as unknown as Unit[], target)
  const hits: number[] = []
  const hit = target.hit.bind(target)
  target.hit = (value: number): boolean => { hits.push(value); return hit(value) }

  assert.equal(path.make(owner).execute(cell), true, `${path.name} refused to cast`)
  for (let i = 0; i < 20 && hits.length === 0; i++) {
    t.mock.timers.tick(DT * 1000)
    Timers.run(Date.now())
    if (path.flies) World.updateProjectiles(DT)
    if (path.area) target.update(DT)
  }
  // The breaths' and throws' own expiries, in this world.
  Timers.clear()
  world.close()
  return { owner, hits }
}

test('a bot deals its layer\'s share of the same robot\'s damage as a human, through every damage path', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  for (const [i, tag] of World.TAGS.entries()) {
    for (const path of PATHS) {
      // Magnet is on every layer's list, so the same robot on each, given
      // the handicap `spawn` gives (the next test goes through `spawn`).
      const bot = dealtBy(t, () => {
        const m = World.createPlayer('bot-m', 'b', undefined, 'magnet', undefined, tag)
        BotFill.handicap(m)
        return m
      }, path)
      const human = dealtBy(t, () => World.createPlayer('a0000e', 'h', undefined, 'magnet', undefined, tag), path)
      assert.ok(human.hits.length > 0 && human.hits[0] > 0, `${path.name}: the human's never hit`)
      assert.equal(bot.hits.length, human.hits.length, `${path.name} on ${tag}: a different number of hits`)
      const want = human.hits.map((h) => h * BOT_SKILL[i].damageScale)
      assert.deepEqual(bot.hits, want, `${path.name} on ${tag}: the bot dealt ${bot.hits.join()}, want ${want.join()}`)
    }
  }
})

test('a spawned bot\'s melee on layer 01 hurts a target half as much as a human\'s', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const melee = PATHS[0]
  // `spawn` itself, not a rebuilt bot: Peep on the first draw.
  const bot = dealtBy(t, () => new BotFill(1, 0, () => 0).spawn(1_000_000, TOP), melee)
  const human = dealtBy(t, () => World.createPlayer('a0000d', 'h', undefined, 'peep', undefined, TOP), melee)
  assert.equal(keyOf(bot.owner), 'peep')
  assert.deepEqual(bot.hits, human.hits.map((h) => h / 2))
})

test('a bot uses no item but the medkit: a bomb\'s damage is not scaled for anyone, so a bot throwing one would skip the handicap', () => {
  const source = readFileSync(joinPath(__dirname, 'brain.ts'), 'utf8')
  const uses = source.match(/tryUseItem\(/g)?.length ?? 0
  assert.ok(uses > 0)
  assert.equal(source.match(/tryUseItem\(MEDKIT\)/g)?.length ?? 0, uses, 'the brain uses another item')
})

// --- bots follow the humans (Q8) -------------------------------------------------

function staying (tag: number): Player[] {
  return World.PLAYERS.filter((p) => p.bot !== undefined && p.tag === tag && !p.destroyed && !p.exited && p.bot.leaving !== true)
}

function present (tag: number): Player[] {
  return World.PLAYERS.filter((p) => p.bot !== undefined && p.tag === tag && !p.destroyed && !p.exited)
}

test('a lone human who goes from layer 01 to 02 has the bots on 02 within the spawn interval, and none left on 01 after the grace', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const world = quietWorld()
  const human = World.createPlayer('a0000c', 'h')
  assert.equal(human.tag, TOP)
  const fill = new BotFill(4, 2000, seeded(17))
  const step = (): void => { fill.update(1, Date.now()); t.mock.timers.tick(250) }
  for (let i = 0; i < 40; i++) step()
  assert.equal(staying(TOP).length, 3, 'the fill did not reach 1 + 3 on 01')

  human.changeLayer(MIDDLE)
  const from = Date.now()
  // Three bots, one per spawn interval, the first at once.
  while (Date.now() - from <= 2 * fill.spawnEveryMs) step()
  assert.equal(staying(MIDDLE).length, 3, 'the bots did not follow the human to 02')
  assert.equal(staying(TOP).length, 0, 'a bot stays on a layer with no human')
  // The old ones head out; one that hasn't made it out exits at the grace.
  while (Date.now() - from <= LEAVE_GRACE_MS + fill.spawnEveryMs) step()
  assert.equal(present(TOP).length, 0, 'a bot is still on 01 after the grace')
  assert.equal(staying(MIDDLE).length, 3)
  // The bots that followed are 02's: three quarters.
  for (const bot of staying(MIDDLE)) assert.equal(bot.botDamage, 0.75)
  world.close()
})

test('with humans on two layers, the bots on both stay', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const world = quietWorld()
  World.createPlayer('a0000b', 'h', undefined, 'peep', undefined, TOP)
  World.createPlayer('a0000a', 'h', undefined, 'peep', undefined, MIDDLE)
  const fill = new BotFill(6, 2000, seeded(23))
  for (let i = 0; i < 400; i++) { fill.update(2, Date.now()); t.mock.timers.tick(250) }
  assert.deepEqual([staying(TOP).length, staying(MIDDLE).length, staying(BOTTOM).length], [2, 2, 0])
  assert.equal(World.PLAYERS.filter((p) => p.bot?.leaving === true).length, 0, 'a bot was sent away')
  world.close()
})
