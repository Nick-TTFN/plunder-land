import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Consumable from '../objects/consumable'
import { Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import Slowdown from '../buffs/slowdown'
import { Skill } from '../skills/skill'
import { ARCHETYPES, LAYERS, buildSkillById, rollGear } from '../archetypes/archetypes'
import { SKILL_INFO, SKILL_LIST } from '../utils/skills'
import {
  BRING_LEVEL, DUPLICATE_CUTS_COOLDOWN, GEAR_BAG, GEAR_SLOTS, GEAR_STATS, GEAR_STAT_LIST, GEAR_TIERS,
  type GearInstance, type GearTier, STASH_MAX, STASH_SOFT, cooldownCut, decodeGear, effectiveReach,
  encodeGear, gearEffect, itemCooldownMs, rollCount, rollValue
} from '../utils/gear'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Task 49-1 (decision #49, spec `ideas/skill-items-and-stash.md` section 1):
 * the gear table, the instance bytes, `rollGear`, and gear stats applied
 * through the existing stat paths.
 */

const S = {
  hp: GEAR_STATS.hp.id,
  armor: GEAR_STATS.armor.id,
  speed: GEAR_STATS.speed.id,
  damage: GEAR_STATS.damage.id,
  reach: GEAR_STATS.reach.id,
  cooldown: GEAR_STATS.cooldown.id
}

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

beforeEach(() => {
  // The multiplayer before the world, as robotselect.spec.ts does: a real one,
  // so pickups and creates go through the real paths.
  // eslint-disable-next-line no-new
  new Multiplayer(250, okRedis())
  // eslint-disable-next-line no-new
  new World(4000)
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

afterEach(() => {
  mock.restoreAll()
})

const HOME = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))

function robot (key: 'peep' | 'waddle' | 'magnet', name = 'gear'): Player {
  const player = new Player(HOME.x, HOME.y, 0, name, ARCHETYPES[key])
  World.PLAYERS.push(player)
  return player
}

function item (tier: GearTier, skill: number, ...rolls: Array<[number, number]>): GearInstance {
  return { tier, skill, rolls: rolls.map(([stat, q]) => ({ stat, q })) }
}

const FIREBALL = SKILL_INFO.fireball.id
const ICICLE = SKILL_INFO.icicle.id
const RANGED = SKILL_INFO.ranged.id
const STONEWALL = SKILL_INFO.stoneWall.id

// The table ======

test('the stat table is spec section 1, with append-only ids', () => {
  const table = GEAR_STAT_LIST.map((s) => ({ id: s.id, key: s.key, ranges: s.ranges, cap: s.cap }))
  assert.deepEqual(table, [
    { id: 1, key: 'hp', ranges: [[4, 8], [6, 12], [10, 15]], cap: 20 },
    { id: 2, key: 'armor', ranges: [[8, 15], [12, 25], [20, 30]], cap: 40 },
    { id: 3, key: 'speed', ranges: [[2, 4], [3, 5], [4, 6]], cap: 7 },
    { id: 4, key: 'damage', ranges: [[0.03, 0.05], [0.04, 0.07], [0.06, 0.10]], cap: 0.12 },
    { id: 5, key: 'reach', ranges: [null, null, [1, 1]], cap: 2 },
    { id: 6, key: 'cooldown', ranges: [[5, 10], [8, 15], [12, 20]], cap: null }
  ])
  assert.equal(GEAR_SLOTS, 2)
  assert.equal(GEAR_BAG, 4)
  assert.equal(STASH_SOFT, 12)
  // Nick 2026-10-05 (#49 build plan): a storage ceiling, not a design cap.
  assert.equal(STASH_MAX, 100)
  assert.equal(BRING_LEVEL, 3)
  assert.equal(GEAR_TIERS, 3)
  // Nick 2026-10-05 (#49 build plan answer 1): a duplicate's roll doesn't cut the shared cooldown.
  assert.equal(DUPLICATE_CUTS_COOLDOWN, false)
})

test('rollCount is 1 at T1 and 2 at T2 and T3; rollValue spans the range', () => {
  assert.deepEqual([1, 2, 3].map(rollCount), [1, 2, 2])
  assert.equal(rollValue(S.hp, 1, 0), 4)
  assert.equal(rollValue(S.hp, 1, 500), 6)
  assert.equal(rollValue(S.hp, 1, 1000), 8)
  assert.equal(rollValue(S.damage, 3, 1000), 0.10)
  assert.equal(rollValue(S.reach, 3, 0), 1)
  // Not rollable there, unknown stat, out-of-range tier, q clamped.
  assert.equal(rollValue(S.reach, 2, 1000), 0)
  assert.equal(rollValue(99, 1, 1000), 0)
  assert.equal(rollValue(S.hp, 4, 1000), 0)
  assert.equal(rollValue(S.hp, 1, 5000), 8)
  assert.equal(rollValue(S.hp, 1, -5), 4)
})

test('gearEffect sums both slots and caps each stat; parts and unknown stats add nothing', () => {
  const max = gearEffect([
    item(3, FIREBALL, [S.hp, 1000], [S.armor, 1000]),
    item(3, ICICLE, [S.hp, 1000], [S.armor, 1000])
  ])
  assert.equal(max.hpPct, 20)
  assert.equal(max.armorPct, 40)
  const fast = gearEffect([
    item(3, FIREBALL, [S.speed, 1000], [S.damage, 1000]),
    item(3, ICICLE, [S.speed, 1000], [S.damage, 1000])
  ])
  assert.equal(fast.speedPct, 7)
  assert.equal(fast.damageScale, 0.12)
  const reach = gearEffect([item(3, FIREBALL, [S.reach, 0], [S.hp, 0]), item(3, ICICLE, [S.reach, 0], [S.hp, 0])])
  assert.equal(reach.reach, 2)
  assert.equal(reach.hpPct, 20)
  // Under the cap it is the plain sum.
  assert.equal(gearEffect([item(1, FIREBALL, [S.hp, 0]), item(1, ICICLE, [S.hp, 1000])]).hpPct, 12)
  // A part (even one carrying rolls), an unknown stat and an empty slot add nothing.
  assert.deepEqual(
    { ...gearEffect([{ tier: 1, skill: 0, rolls: [{ stat: S.hp, q: 1000 }] }, item(1, FIREBALL, [77, 1000]), null]) },
    { hpPct: 0, armorPct: 0, speedPct: 0, damageScale: 0, reach: 0 }
  )
})

test('effective reach: base + bonus up to 2, a base of 2 or more untouched', () => {
  assert.equal(effectiveReach(1, 0), 1)
  assert.equal(effectiveReach(1, 1), 2)
  assert.equal(effectiveReach(1, 2), 2)
  assert.equal(effectiveReach(0, 2), 2)
  assert.equal(effectiveReach(3, 2), 3)
  assert.equal(effectiveReach(2, 1), 2)
})

test('the item cooldown: cut by its own roll, a duplicate never', () => {
  const it = item(3, FIREBALL, [S.cooldown, 1000], [S.hp, 0])
  assert.equal(cooldownCut(it), 20)
  assert.equal(itemCooldownMs(4000, it, false), 3200)
  assert.equal(itemCooldownMs(750, it, true), 750)
  assert.equal(cooldownCut({ tier: 1, skill: 0, rolls: [{ stat: S.cooldown, q: 1000 }] }), 0)
})

// rollGear ======

test('rollGear: parts bare; skill items roll rollCount distinct stats, reach only at T3, q in 0..1000', () => {
  let seed = 12345
  const random = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 4294967296
  }
  const skills = new Set<number>()
  const stats = new Map<number, Set<number>>([[1, new Set()], [2, new Set()], [3, new Set()]])
  let qMin = Infinity
  let qMax = -Infinity
  for (let i = 0; i < 4000; i++) {
    for (const tier of [1, 2, 3] as GearTier[]) {
      assert.deepEqual(rollGear(tier, 'part', random), { tier, skill: 0, rolls: [] })
      const g = rollGear(tier, 'skill', random)
      assert.equal(g.tier, tier)
      assert.ok(SKILL_LIST.some((s) => s.id === g.skill), `skill ${g.skill}`)
      skills.add(g.skill)
      assert.equal(g.rolls.length, rollCount(tier))
      assert.equal(new Set(g.rolls.map((r) => r.stat)).size, g.rolls.length, 'a repeated stat')
      for (const r of g.rolls) {
        assert.ok(Number.isInteger(r.q) && r.q >= 0 && r.q <= 1000, `q ${r.q}`)
        qMin = Math.min(qMin, r.q)
        qMax = Math.max(qMax, r.q)
        if (tier < 3) assert.notEqual(r.stat, S.reach, `reach at T${tier}`)
        stats.get(tier)?.add(r.stat)
      }
    }
  }
  assert.equal(skills.size, SKILL_LIST.length, 'every skill can roll')
  assert.deepEqual([...(stats.get(1) ?? [])].sort(), [1, 2, 3, 4, 6])
  assert.deepEqual([...(stats.get(3) ?? [])].sort(), [1, 2, 3, 4, 5, 6])
  assert.ok(qMin <= 5 && qMax >= 995, `q spread ${qMin}..${qMax}`)
  // The extremes of `random` stay in range.
  for (const r of [0, 0.9999999999]) {
    const g = rollGear(3, 'skill', () => r)
    assert.ok(g.rolls.every((x) => x.q >= 0 && x.q <= 1000))
    assert.ok(SKILL_LIST.some((s) => s.id === g.skill))
  }
})

test('every layer has a gear row, verbatim from spec section 3, and each mix sums to 1', () => {
  assert.deepEqual(LAYERS.map((l) => [l.gear.caches, l.gear.cacheRespawnMs]), [[1, 180000], [1, 120000], [2, 90000]])
  assert.deepEqual(LAYERS.map((l) => l.gear.cacheMix), [
    { part: 0.75, t1: 0.22, t2: 0.03 }, { part: 0.65, t1: 0.28, t2: 0.07 }, { part: 0.55, t1: 0.33, t2: 0.12 }
  ])
  assert.deepEqual(LAYERS.map((l) => l.gear.mobChance), [
    { grunt: 0.03, gunner: 0, boss: 0 }, { grunt: 0.04, gunner: 0.08, boss: 0.5 }, { grunt: 0.05, gunner: 0.1, boss: 0.5 }
  ])
  assert.deepEqual(LAYERS.map((l) => l.gear.mobMix), [{ part: 0.8, skill: 0.2 }, { part: 0.75, skill: 0.25 }, { part: 0.7, skill: 0.3 }])
  assert.deepEqual(LAYERS.map((l) => l.gear.bossTiers), [null, { t1: 0.7, t2: 0.3 }, { t1: 0.5, t2: 0.5 }])
  for (const l of LAYERS) {
    const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum({ ...l.gear.cacheMix }) - 1) < 1e-9)
    assert.ok(Math.abs(sum(l.gear.mobMix) - 1) < 1e-9)
    if (l.gear.bossTiers !== null) assert.ok(Math.abs(sum(l.gear.bossTiers) - 1) < 1e-9)
    // No gear chance for a mob the layer doesn't keep.
    for (const m of l.mobs) {
      if (m.count === 0) assert.equal(l.gear.mobChance[m.archetype.key as 'grunt' | 'gunner' | 'boss'], 0, m.archetype.key)
    }
  }
})

// Bytes ======

test('encodeGear / decodeGear round-trip a part, a T1 and a T3; rowId is never written', () => {
  const cases: GearInstance[] = [
    { tier: 1, skill: 0, rolls: [] },
    item(1, RANGED, [S.speed, 0]),
    item(3, FIREBALL, [S.reach, 1000], [S.cooldown, 517])
  ]
  for (const g of cases) assert.deepEqual(decodeGear(encodeGear(g)), g)
  assert.deepEqual([...encodeGear(item(3, FIREBALL, [S.reach, 1000], [S.cooldown, 517]))], [3, 6, 2, 5, 3, 232, 6, 2, 5])
  assert.deepEqual([...encodeGear({ ...item(1, RANGED, [S.hp, 1]), rowId: 'abc' })], [1, 3, 1, 1, 0, 1])
  // From an offset, as inside a counted field.
  const inner = encodeGear(cases[2])
  const outer = new Uint8Array(inner.length + 2)
  outer.set(inner, 2)
  assert.deepEqual(decodeGear(outer, 2), cases[2])
})

test('decodeGear ignores trailing bytes and unknown stat ids, and refuses what it cannot read', () => {
  // A T2 Ranged: an hp roll, a stat 200 this build doesn't know, then 4 trailing bytes.
  const bytes = new Uint8Array([2, RANGED, 2, S.hp, 0x01, 0xf4, 200, 0x03, 0xe8, 9, 9, 9, 9])
  assert.deepEqual(decodeGear(bytes), item(2, RANGED, [S.hp, 500]))
  assert.equal(decodeGear(new Uint8Array([2, RANGED])), undefined, 'short header')
  assert.equal(decodeGear(new Uint8Array([2, RANGED, 2, S.hp, 0, 1])), undefined, 'short rolls')
  assert.equal(decodeGear(new Uint8Array([0, RANGED, 0])), undefined, 'tier 0')
  assert.equal(decodeGear(new Uint8Array([4, RANGED, 0])), undefined, 'tier 4')
  assert.equal(decodeGear(new Uint8Array([1, 250, 0])), undefined, 'unknown skill')
  assert.deepEqual(decodeGear(new Uint8Array([1, RANGED, 1, S.hp, 0xff, 0xff])), item(1, RANGED, [S.hp, 1000]), 'q clamped')
})

// Stats through the existing paths ======

const MAX_HP_ARMOR = [item(3, FIREBALL, [S.hp, 1000], [S.armor, 1000]), item(3, ICICLE, [S.hp, 1000], [S.armor, 1000])]
const MAX_SPEED_DAMAGE = [item(3, FIREBALL, [S.speed, 1000], [S.damage, 1000]), item(3, ICICLE, [S.speed, 1000], [S.damage, 1000])]
const MAX_REACH = [item(3, FIREBALL, [S.reach, 1000], [S.hp, 0]), item(3, ICICLE, [S.reach, 1000], [S.hp, 0])]

function equipAll (player: Player, items: GearInstance[]): void {
  items.forEach((g, slot) => assert.ok(player.equipGear(slot, g), `slot ${slot}`))
}

test('two max T3 items on Peep and Waddle: HP, armor, speed, reach and damage at their caps', () => {
  const expected = {
    peep: { maxHp: 120, maxArmor: 70, speed: 149.8 },
    waddle: { maxHp: 156, maxArmor: 140, speed: 128.4 }
  }
  for (const key of ['peep', 'waddle'] as const) {
    const tough = robot(key)
    equipAll(tough, MAX_HP_ARMOR)
    assert.equal(tough.maxHp, expected[key].maxHp, key)
    assert.equal(tough.maxArmor, expected[key].maxArmor, key)
    assert.equal(tough.hp, expected[key].maxHp, `${key}: hp rose with the max`)
    assert.equal(tough.armor, expected[key].maxArmor, `${key}: armor rose with the max`)

    const fast = robot(key)
    equipAll(fast, MAX_SPEED_DAMAGE)
    assert.equal(fast.maxVelocity, expected[key].speed, key)
    assert.equal(fast.damageScale, 1.12, key)

    const reach = robot(key)
    equipAll(reach, MAX_REACH)
    assert.equal(reach.pickupReach, 2, key)
  }
})

test('a Ranged hit from a damage-capped player deals 12 x 1.12, floored, through Skill.dealt', () => {
  const shooter = robot('peep')
  equipAll(shooter, MAX_SPEED_DAMAGE)
  const target = new Unit(ObjectType.Mob, HOME.x + 2 * Hex.SIZE, HOME.y, 10, 0)
  target.hp = 1000
  World.MOBS.push(target)
  // Kit slot 2 is Ranged (START_KIT); no aim fires along facing, east.
  assert.equal(shooter.skillIds[2], RANGED)
  shooter.tryExecuteSkill(2)
  assert.equal(1000 - target.hp, Math.floor(12 * 1.12))
  assert.equal(1000 - target.hp, 13)
})

test('hp and armor rise by the max\'s rise on equip, never refilled to full', () => {
  const player = robot('peep')
  player.hp = 60
  player.armor = 10
  player.dirtyFields.clear()
  assert.ok(player.equipGear(0, item(3, FIREBALL, [S.hp, 1000], [S.armor, 1000])))
  assert.equal(player.maxHp, 115)
  assert.equal(player.hp, 75)
  assert.equal(player.maxArmor, 65)
  assert.equal(player.armor, 25)
  // Through GameObject's accessors, so all four go out as deltas. A field
  // shadowing `armor` on Player (the TS2610 trap) would leave 'armor' clean.
  for (const field of ['hp', 'maxHp', 'armor', 'maxArmor']) {
    assert.ok(player.dirtyFields.has(field), `${field} not marked dirty`)
  }
})

test('equipGear refuses a bad slot, a full slot, a part and an unknown skill, changing nothing', () => {
  const player = robot('peep')
  const g = item(1, FIREBALL, [S.hp, 1000])
  assert.equal(player.equipGear(2, g), false)
  assert.equal(player.equipGear(-1, g), false)
  assert.equal(player.equipGear(0.5, g), false)
  assert.equal(player.equipGear(0, { tier: 1, skill: 0, rolls: [] }), false)
  assert.equal(player.equipGear(0, item(1, 99, [S.hp, 1000])), false)
  assert.equal(player.maxHp, 100)
  assert.ok(player.equipGear(0, g))
  assert.equal(player.equipGear(0, item(1, ICICLE, [S.hp, 1000])), false)
  assert.equal(player.maxHp, 108)
  assert.equal(player.gear[0], g)
})

test('a slowed geared player gets base + gear back when the slow ends', () => {
  const player = robot('peep')
  equipAll(player, MAX_SPEED_DAMAGE)
  const slow = new Slowdown(player, 1000)
  assert.equal(player.maxVelocity, 149.8 / 2)
  slow.stop()
  assert.equal(player.maxVelocity, 149.8)

  // Gear picked up during the slow is added as a delta, so the restore still lands on base + gear.
  const other = robot('peep')
  const slow2 = new Slowdown(other, 1000)
  assert.equal(other.maxVelocity, 70)
  assert.ok(other.equipGear(0, item(3, FIREBALL, [S.speed, 1000], [S.hp, 0])))
  slow2.stop()
  assert.equal(other.maxVelocity, 140 + 8.4)
})

test('a duplicate Ranged item shares the kit Ranged\'s instance and cooldown: two presses inside 750 ms, one hit', () => {
  let now = 1_000_000
  mock.method(Date, 'now', () => now)
  const player = robot('peep')
  player.armor = 0
  // Its cooldown roll is at max, and still doesn't shorten the shared cooldown.
  assert.ok(player.equipGear(0, item(3, RANGED, [S.cooldown, 1000], [S.hp, 0])))
  const kit = player.skills[player.slotOf(RANGED)]
  assert.equal(player.gearSkill(0), kit, 'the same instance')
  assert.equal(kit?.cooldown, 750)

  const target = new Unit(ObjectType.Mob, HOME.x + 2 * Hex.SIZE, HOME.y, 10, 0)
  target.hp = 1000
  World.MOBS.push(target)
  player.tryExecuteSkill(player.slotOf(RANGED))
  now += 500
  player.gearSkill(0)?.execute()
  assert.equal(1000 - target.hp, 12, 'the item press inside the cooldown hit')
  now += 300
  player.gearSkill(0)?.execute()
  assert.equal(1000 - target.hp, 24, 'the item press after 800 ms missed')
  // Its stat rolls still count (hp 0 quality is +10%).
  assert.equal(player.maxHp, 110)
})

test('a non-duplicate item skill runs at its own cooldown, cut by its roll; a second copy shares it', () => {
  let now = 2_000_000
  mock.method(Date, 'now', () => now)
  const player = robot('peep')
  const base = buildSkillById(player, STONEWALL).cooldown
  assert.equal(base, 6000)
  assert.ok(player.equipGear(0, item(2, STONEWALL, [S.cooldown, 1000], [S.hp, 0])))
  const own = player.gearSkill(0)
  assert.ok(own !== null)
  assert.ok(!player.skills.includes(own), 'its own instance, not a kit one')
  assert.equal(own.cooldown, base * 0.85)
  // The gate itself (Skill.execute's cooldown test), without placing stones.
  const press = (): boolean => Skill.prototype.execute.call(own)
  assert.equal(press(), true)
  now += 5099
  assert.equal(press(), false)
  now += 2
  assert.equal(press(), true)

  // A second StoneWall in the other slot is a duplicate of the first item: the same instance, its cooldown untouched.
  assert.ok(player.equipGear(1, item(3, STONEWALL, [S.cooldown, 1000], [S.armor, 0])))
  assert.equal(player.gearSkill(1), own)
  assert.equal(own.cooldown, base * 0.85)
})

test('gear reach takes loot two rings away; a Magnet keeps its 3', () => {
  const player = robot('peep')
  const cell = Hex.toCell(player.position)
  const at = (rings: number): Vector => Hex.toPosition(new Vector(cell.x + rings, cell.y))
  const loot = (rings: number): Consumable => {
    const c = new Consumable(at(rings).x, at(rings).y, player.tag, 20 as never, 10)
    World.PICKUPS.push(World.CONSUMABLES, c)
    return c
  }
  const two = loot(2)
  player.update(0.25)
  assert.ok(!two.destroyed, 'took loot two rings away without gear')
  assert.ok(player.equipGear(0, item(3, FIREBALL, [S.reach, 1000], [S.hp, 0])))
  player.update(0.25)
  assert.ok(two.destroyed, 'missed loot two rings away with a reach roll')

  const magnet = robot('magnet')
  equipAll(magnet, MAX_REACH)
  assert.equal(magnet.pickupReach, 3)
})

test('nothing is computed per tick: the effect is cached at equip', () => {
  const player = robot('peep')
  equipAll(player, MAX_SPEED_DAMAGE)
  const effect = player.gearEffect
  player.update(0.25)
  assert.equal(player.gearEffect, effect)
})
