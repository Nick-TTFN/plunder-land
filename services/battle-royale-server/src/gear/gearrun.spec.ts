import test, { afterEach, beforeEach, mock, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import GearPickup from '../objects/gearpickup'
import { type Unit } from '../objects/unit'
import { ARCHETYPES, ITEMS, LAYERS } from '../archetypes/archetypes'
import { SKILL_INFO } from '../utils/skills'
import { GEAR_BAG, GEAR_STATS, type GearInstance, type GearTier } from '../utils/gear'
import type BotBrain from '../bots/brain'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Task 49-2 (decision #49, spec `ideas/skill-items-and-stash.md` sections 1,
 * 3 and 6): gear in the run. Pickup into keys 3-4 and the bag, a bot's bag,
 * casting a gear slot through `use_item`, the death drop, dropped gear's
 * expiry, natural caches and their respawn, and mob drops.
 */

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

let world: World

beforeEach(() => {
  // eslint-disable-next-line no-new
  new Multiplayer(250, okRedis())
  world = new World(4000)
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.GEAR.length = 0
  World.CACHES_PENDING.clear()
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

afterEach(() => {
  mock.restoreAll()
})

/** No refill: the world tops its layers up with loot, mobs and caches every tick; these specs place their own. */
function noRefill (): void {
  (world as unknown as { refillLayer: () => void }).refillLayer = () => {}
}

const HOME_CELL = new Vector(22, 44)
const HOME = Hex.toPosition(HOME_CELL)
const FIREBALL = SKILL_INFO.fireball.id
const ICICLE = SKILL_INFO.icicle.id
const STONEWALL = SKILL_INFO.stoneWall.id
const RANGED = SKILL_INFO.ranged.id

function peep (name = 'gear'): Player {
  const player = new Player(HOME.x, HOME.y, 0, name, ARCHETYPES.peep)
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

function item (tier: GearTier, skill: number, rowId?: string): GearInstance {
  const rolls = skill === 0 ? [] : tier === 1 ? [{ stat: GEAR_STATS.hp.id, q: 500 }] : [{ stat: GEAR_STATS.hp.id, q: 500 }, { stat: GEAR_STATS.speed.id, q: 1000 }]
  return Object.freeze({ tier, skill, rolls: Object.freeze(rolls), ...(rowId !== undefined ? { rowId } : {}) })
}

function dropAt (instance: GearInstance, cell: Vector = HOME_CELL, tag = 0, lifetime = 0): GearPickup {
  const at = Hex.toPosition(cell)
  const pickup = new GearPickup(at.x, at.y, tag, instance, lifetime)
  World.PICKUPS.push(World.GEAR, pickup)
  return pickup
}

function cachesOn (tag: number): GearPickup[] {
  return World.GEAR.filter((g) => g.tag === tag && g.cache && !g.destroyed)
}

// --- pickup -----------------------------------------------------------------

test('skill items fill gear slot 2, then slot 3, then the bag, one a tick, each marking carried', () => {
  noRefill()
  const player = peep()
  const a = item(2, FIREBALL)
  const b = item(1, ICICLE)
  const c = item(1, STONEWALL)
  for (const i of [a, b, c]) dropAt(i)
  const hp = player.maxHp

  player.dirtyFields.clear()
  player.update(0.25)
  assert.equal(player.gear[0], a, 'the first was not equipped in slot 2 (key 3)')
  assert.equal(player.gear[1], null)
  assert.ok(player.dirtyFields.has('carried'))
  assert.ok(player.maxHp > hp, 'equipping applied no stats')
  assert.equal(World.GEAR.length, 2, 'more than one taken in a tick')

  player.update(0.25)
  assert.equal(player.gear[1], b, 'the second was not equipped in slot 3 (key 4)')
  player.update(0.25)
  assert.deepEqual(player.bag, [c], 'the third did not go into the bag')
  assert.equal(World.GEAR.length, 0)
  // The gear slots' skills are the items' own instances.
  assert.equal(player.gearSkill(0)?.constructor.name, 'ThrowFireball')
  assert.equal(player.gearSkill(1)?.constructor.name, 'Throwicicle')
})

test('a part always goes into the bag, even with both gear slots empty', () => {
  noRefill()
  const player = peep()
  const part = item(1, 0)
  dropAt(part)
  player.update(0.25)
  assert.deepEqual(player.gear, [null, null])
  assert.deepEqual(player.bag, [part])
})

test('with no room the pickup stays on the ground; a skill item still takes a free slot when the bag is full', () => {
  noRefill()
  const player = peep()
  for (let i = 0; i < GEAR_BAG; i++) assert.ok(player.addGear(item(1, 0)))
  const part = dropAt(item(1, 0))
  player.update(0.25)
  assert.ok(!part.destroyed, 'a part was taken into a full bag')
  assert.equal(World.GEAR.length, 1)
  assert.equal(player.bag.length, GEAR_BAG)

  const skill = dropAt(item(1, FIREBALL))
  player.update(0.25)
  assert.ok(skill.destroyed, 'a skill item was refused with a gear slot free')
  assert.equal(player.gear[0]?.skill, FIREBALL)
  assert.ok(player.addGear(item(1, ICICLE)))
  // Both slots and the bag are full now.
  assert.equal(player.addGear(item(1, STONEWALL)), false)
  assert.ok(!part.destroyed)
})

test('a bot puts a skill item in the bag and its stats do not change', () => {
  noRefill()
  const player = peep('bot')
  player.bot = {} as unknown as BotBrain
  const before = [player.maxHp, player.maxArmor, player.maxVelocity, player.damageScale, player.pickupReach]
  const found = item(2, FIREBALL)
  dropAt(found)
  player.update(0.25)
  assert.deepEqual(player.bag, [found], 'the bot did not bag it')
  assert.deepEqual(player.gear, [null, null], 'the bot equipped it')
  assert.deepEqual([player.maxHp, player.maxArmor, player.maxVelocity, player.damageScale, player.pickupReach], before)
  assert.equal(player.gearSkill(0), null)
})

test('the carried bytes are 6 entries, slots then bag, each as encodeGear writes it', () => {
  const player = peep()
  const a = item(2, FIREBALL)
  const part = item(1, 0)
  player.addGear(a)
  player.addGear(part)
  const bytes = Array.from(player.carried)
  // [6] then [len][tier][skill][count]{[stat][q hi][q lo]} per entry.
  assert.deepEqual(bytes, [
    6,
    9, 2, FIREBALL, 2, GEAR_STATS.hp.id, 1, 244, GEAR_STATS.speed.id, 3, 232,
    0,
    3, 1, 0, 0,
    0, 0, 0
  ])
})

test('gear is filed in World.PICKUPS, and stays filed through a rebuild of the index', () => {
  noRefill()
  const pickup = dropAt(item(1, 0), new Vector(30, 30))
  const key = Hex.key(30, 30)
  assert.ok(World.PICKUPS.at(0, key).includes(pickup))
  // A list edited outside the index (as specs do) makes the next lookup
  // rebuild from the lists the index was given: World.GEAR must be one of
  // them, or a rebuild forgets every gear pickup. Forget what it last saw, so
  // the next lookup rebuilds.
  ;(World.PICKUPS as unknown as { _seen: undefined })._seen = undefined
  assert.ok(World.PICKUPS.at(0, key).includes(pickup), 'gear lost from the pickup index on a rebuild')
})

// --- use_item on keys 3-4 ------------------------------------------------------

function joined (): { player: Player, fire: (event: string, data?: unknown) => void } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id: 'gearsock',
    handshake: { query: {} },
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  Multiplayer.Instance.onConnect(socket)
  handlers.start_requested({ id: 'abcdef42', name: 'GEAR' })
  return { player: World.PLAYERS[World.PLAYERS.length - 1], fire: (event, data) => { handlers[event](data) } }
}

function press (slot: number, cell: Vector): Buffer {
  const buf = Buffer.alloc(5)
  buf.writeUInt8(slot, 0)
  buf.writeInt16BE(cell.x, 1)
  buf.writeInt16BE(cell.y, 3)
  return buf
}

test('use_item slot 2 casts the gear slot\'s skill with the aim, through Skill.execute', () => {
  const { player, fire } = joined()
  assert.ok(player.addGear(item(1, FIREBALL)))
  const skill = player.gearSkill(0)
  assert.ok(skill !== null)
  const calls: Array<Vector | undefined> = []
  const original = skill.execute.bind(skill)
  skill.execute = (aim?: Vector) => { calls.push(aim); return original(aim) }
  const aim = new Vector(player.cell.x + 4, player.cell.y)
  fire('use_item', press(2, aim))
  assert.equal(calls.length, 1, 'the item skill was not cast')
  assert.deepEqual([calls[0]?.x, calls[0]?.y], [aim.x, aim.y], 'cast without the aim')
  assert.equal(World.PROJECTILES.length, 1, 'no fireball in flight')
  // A bare number is the slot with no aim: along facing. Inside the
  // cooldown, so refused by the skill itself.
  fire('use_item', 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[1], undefined)
  assert.equal(World.PROJECTILES.length, 1, 'cast again inside its cooldown')
})

test('use_item on an empty gear slot does nothing and spends nothing', () => {
  const { player, fire } = joined()
  player.addItem(ITEMS.medkit)
  player.addItem(ITEMS.bomb)
  const inventory = [...player.inventory]
  assert.equal(player.tryUseItem(2, new Vector(1, 1)), false)
  assert.equal(player.tryUseItem(3), false)
  fire('use_item', press(2, new Vector(player.cell.x + 2, player.cell.y)))
  fire('use_item', 3)
  assert.deepEqual([...player.inventory], inventory)
  assert.equal(World.PROJECTILES.length, 0)
  // Slot 4 (key 5) stays empty; slots 0-1 stay the medkit and the bomb.
  assert.equal(player.tryUseItem(4), false)
})

test('a duplicate gear slot fires the kit\'s own instance, sharing its cooldown', () => {
  const { player } = joined()
  assert.ok(player.addGear(item(1, RANGED)))
  const kit = player.skills[player.slotOf(RANGED)]
  assert.equal(player.gearSkill(0), kit)
  assert.equal(player.tryUseItem(2), true)
  const at = kit?.executeTime
  assert.ok(at !== undefined && at > 0, 'the kit instance did not fire')
})

// --- the death drop and expiry --------------------------------------------------

test('a death drops both slots and the bag, each a GearPickup keeping its instance and rowId; drops expire at 30 s', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  noRefill()
  const player = peep()
  const carried = [item(2, FIREBALL, 'row-a'), item(1, ICICLE, 'row-b'), item(1, 0, 'row-c'), item(2, STONEWALL, 'row-d')]
  for (const i of carried) assert.ok(player.addGear(i))
  assert.deepEqual([player.gear[0], player.gear[1], ...player.bag], carried)

  player.hit(1e6)
  world.update(0.25)
  const drops = World.GEAR.filter((g) => !g.destroyed)
  assert.equal(drops.length, 4)
  assert.deepEqual(new Set(drops.map((d) => d.instance)), new Set(carried), 'not the same instances')
  assert.deepEqual(drops.map((d) => d.instance.rowId).sort(), ['row-a', 'row-b', 'row-c', 'row-d'])
  for (const d of drops) {
    assert.equal(d.cache, false)
    assert.equal(d.expiresAt, 1_000_000 + World.DROPPED_LOOT_LIFETIME)
    assert.ok(Hex.distance(Hex.toCell(d.position), HOME_CELL) <= World.DROP_RINGS)
  }
  assert.deepEqual(player.gear, [null, null], 'takeGear left the slots')
  assert.equal(player.bag.length, 0, 'takeGear left the bag')

  t.mock.timers.tick(World.DROPPED_LOOT_LIFETIME)
  world.update(0.25)
  assert.equal(World.GEAR.length, 4, 'gone before its 30 s')
  t.mock.timers.tick(1)
  world.update(0.25)
  assert.equal(World.GEAR.length, 0, 'still on the ground after 30 s')
  for (const d of drops) assert.ok(d.destroyed)
})

// --- natural caches ---------------------------------------------------------------

test('caches stand at the layer\'s count, a taken one respawns after the layer\'s ms, and the count never exceeds the table', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  World.MOBS.length = 0
  const check = (label: string): void => {
    for (const layer of LAYERS) {
      assert.ok(cachesOn(layer.tag).length <= layer.gear.caches, `${label}: layer ${layer.tag} has ${cachesOn(layer.tag).length} caches`)
    }
  }
  for (let n = 0; n < 4; n++) {
    t.mock.timers.tick(250)
    world.update(0.25)
    check(`build tick ${n}`)
  }
  for (const layer of LAYERS) assert.equal(cachesOn(layer.tag).length, layer.gear.caches, `layer ${layer.tag} not filled`)
  for (const cache of World.GEAR) {
    assert.equal(cache.expiresAt, 0, 'a cache expires')
    // Spec section 3: a part, T1 or T2. Never T3.
    assert.ok(cache.instance.tier <= 2)
  }

  // Take the top layer's cache.
  const top = LAYERS[0]
  const taker = peep()
  const cache = cachesOn(top.tag)[0]
  World.gearTaken(cache, taker)
  assert.ok(cache.destroyed)
  assert.equal(cache.collector, taker.id)
  let elapsed = 0
  while (elapsed + 5000 < top.gear.cacheRespawnMs) {
    t.mock.timers.tick(5000)
    elapsed += 5000
    world.update(0.25)
    check(`${elapsed} ms after the take`)
    assert.equal(cachesOn(top.tag).length, 0, `respawned after ${elapsed} ms`)
  }
  t.mock.timers.tick(top.gear.cacheRespawnMs - elapsed)
  world.update(0.25)
  check('at the respawn')
  assert.equal(cachesOn(top.tag).length, 1, 'not respawned after the layer\'s ms')
  assert.notEqual(cachesOn(top.tag)[0], cache)
  for (let n = 0; n < 8; n++) {
    t.mock.timers.tick(250)
    world.update(0.25)
    check(`after the respawn, tick ${n}`)
  }
})

test('a player standing on a cache takes it, and the world starts its respawn', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  noRefill()
  const player = peep()
  const at = Hex.toPosition(HOME_CELL)
  const cache = new GearPickup(at.x, at.y, 0, item(1, FIREBALL), 0, true)
  World.PICKUPS.push(World.GEAR, cache)
  player.update(0.25)
  assert.ok(cache.destroyed)
  assert.equal(World.CACHES_PENDING.get(0), 1)
  t.mock.timers.tick(LAYERS[0].gear.cacheRespawnMs)
  Timers.run(Date.now())
  assert.equal(World.CACHES_PENDING.get(0), 0)
})

// --- mob drops ----------------------------------------------------------------------

function mobOn (key: 'grunt' | 'gunner' | 'boss', tag: number): Mob {
  const mob = new Mob(HOME.x, HOME.y, tag, ARCHETYPES[key])
  mob.routines = []
  World.addUnit(World.MOBS, mob)
  return mob
}

/** A random that returns `values` in turn, then 0.5. */
function seq (...values: number[]): () => number {
  let i = 0
  return () => values[i++] ?? 0.5
}

test('a mob drops gear by its layer\'s chance and mix; a boss always a skill item at T1 or T2; never T3', () => {
  noRefill()
  const grunt = mobOn('grunt', 0)
  // Roll under the chance, then under `part`.
  const part = world.createGearFrom(grunt, seq(0, 0))
  assert.deepEqual(part, { tier: 1, skill: 0, rolls: [] })
  assert.equal(World.GEAR.length, 1)
  assert.equal(World.GEAR[0].expiresAt > 0, true, 'a mob drop never expires')
  // Over the chance: nothing.
  assert.equal(world.createGearFrom(grunt, seq(LAYERS[0].gear.mobChance.grunt)), undefined)
  // No gunners or bosses on 01: never a drop there.
  assert.equal(world.createGearFrom(mobOn('gunner', 0), seq(0, 0)), undefined)
  assert.equal(world.createGearFrom(mobOn('boss', 0), seq(0, 0)), undefined)

  const boss = mobOn('boss', -1)
  const t1 = world.createGearFrom(boss, seq(0, 0))
  assert.equal(t1?.tier, 1)
  assert.ok((t1?.skill ?? 0) > 0)
  const t2 = world.createGearFrom(boss, seq(0, 0.99))
  assert.equal(t2?.tier, 2)

  // Many rolls on every layer and mob: never T3, a boss's never a part.
  let rolled = 0
  let s = 12345
  const random = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
  for (const layer of LAYERS) {
    for (const key of ['grunt', 'gunner', 'boss'] as const) {
      const mob = mobOn(key, layer.tag)
      for (let n = 0; n < 400; n++) {
        const got = world.createGearFrom(mob, random)
        if (got === undefined) continue
        rolled++
        assert.ok(got.tier === 1 || got.tier === 2, `T${got.tier} from a ${key}`)
        if (key === 'boss') assert.ok(got.skill > 0, 'a boss dropped a part')
      }
    }
  }
  assert.ok(rolled > 200, `only ${rolled} drops`)
})

test('a mob killed in the world drops its gear beside its loot on the sweep', () => {
  noRefill()
  const grunt = mobOn('grunt', 0)
  grunt.loot = 50
  mock.method(Math, 'random', () => 0)
  grunt.hit(1e6)
  world.update(0.25)
  const drops = World.GEAR.filter((g) => !g.destroyed)
  assert.equal(drops.length, 1, 'no gear drop from the sweep')
  assert.ok(drops[0].expiresAt > 0)
  assert.ok(World.CONSUMABLES.length > 0, 'no loot either')
})

// --- bots see gear (an ITEMS-like site outside the lists: bots/brain.ts) -----------

test('a bot\'s pickup search treats a gear pickup as gear, not as an item kind: no throw, and only with room', async () => {
  noRefill()
  const { default: BotBrain } = await import('../bots/brain')
  const me = peep('bot')
  const brain = new BotBrain(me, Date.now(), () => 0.5)
  me.bot = brain
  const near = (): Vector | undefined => (brain as unknown as { nearestPickup: (cell: Vector) => Vector | undefined }).nearestPickup(me.cell)
  const cell = new Vector(HOME_CELL.x + 3, HOME_CELL.y)
  dropAt(item(1, FIREBALL), cell)
  assert.deepEqual(near(), cell, 'the bot does not see the gear it has room for')
  assert.doesNotThrow(() => { brain.update() })
  for (let i = 0; i < GEAR_BAG; i++) me.addGear(item(1, 0))
  assert.equal(near(), undefined, 'the bot walks to gear it has no room for')
})
