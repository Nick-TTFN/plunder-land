import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import type Redis from 'ioredis'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob, { MobPack } from '../objects/mob'
import GuardPosition from '../ai/guardposition'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { ARCHETYPES, LAYERS, type LayerPack, isPackEntry } from './archetypes'
import { PROGRESSION } from '../progress/xp'

/**
 * The NPC roster on the layers (decision #51, task l1-1): what spawns where,
 * packs and their escorts, shared home and aggro, the refill rule for packs,
 * and the spawn hazard. Counts are PROVISIONAL (l1-0); these tests read them
 * from `LAYERS` and pin only the rules.
 */

const DT = 0.25
const [TOP, MIDDLE, BOTTOM] = LAYERS.map((layer) => layer.tag)
const RETIRED = new Set<unknown>([ARCHETYPES.grunt, ARCHETYPES.gunner, ARCHETYPES.boss])

beforeEach(() => {
  const redis = { on: function () { return this }, hincrby: async () => 0 } as unknown as Redis
  // eslint-disable-next-line no-new
  new Multiplayer(250, redis)
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

function live (tag: number): Mob[] {
  return (World.MOBS as Mob[]).filter((m) => m.tag === tag && !m.destroyed)
}

function packsOn (tag: number): MobPack[] {
  return [...new Set(live(tag).map((m) => m.pack).filter((p): p is MobPack => p !== undefined))]
}

/** Live count per entry of the layer: packs for a pack entry, lone mobs for a single one. */
function counts (tag: number): number[] {
  const layer = LAYERS.find((l) => l.tag === tag)
  assert.ok(layer !== undefined)
  return layer.mobs.map((entry) => isPackEntry(entry)
    ? packsOn(tag).filter((p) => p.entry === entry).length
    : live(tag).filter((m) => m.pack === undefined && m.archetype === entry.archetype).length)
}

function wanted (tag: number): number[] {
  return (LAYERS.find((l) => l.tag === tag)?.mobs ?? []).map((entry) => entry.count)
}

test('two simulated minutes: every layer holds its LAYERS population of NPCs, packs 2-4 with at most one Coil', () => {
  const world = new World(4000)
  const TICKS = 480 // two minutes at 250 ms
  const full: Record<number, number> = {}
  let killed = 0
  let packsSeen = 0
  const seen = new Set<MobPack>()
  for (let tick = 0; tick < TICKS; tick++) {
    world.update(DT)
    // Kill something now and then, so the refill is exercised, not just the first fill.
    if (tick > 40 && tick % 7 === 0) {
      const all = (World.MOBS as Mob[]).filter((m) => !m.destroyed)
      all[(tick * 31) % all.length].hit(10_000)
      killed++
    }
    for (const layer of LAYERS) {
      const have = counts(layer.tag)
      const want = wanted(layer.tag)
      have.forEach((n, i) => assert.ok(n <= want[i], `tick ${tick}, layer ${layer.tag}, entry ${i}: ${n} over ${want[i]}`))
      if (have.every((n, i) => n === want[i])) full[layer.tag] = (full[layer.tag] ?? 0) + 1

      for (const mob of live(layer.tag)) {
        assert.ok(!RETIRED.has(mob.archetype), `tick ${tick}: a retired ${mob.archetype.key} spawned on ${layer.tag}`)
        assert.notEqual(mob.archetype, ARCHETYPES.broodling, 'a Broodling spawned from LAYERS')
        if (mob.archetype === ARCHETYPES.brood) assert.equal(layer.tag, BOTTOM, 'a Brood off layer -2')
        if (mob.archetype === ARCHETYPES.kiln || mob.archetype === ARCHETYPES.reactor) assert.notEqual(layer.tag, TOP)
        if (mob.archetype === ARCHETYPES.coil) assert.ok(mob.pack !== undefined, 'a Coil with no pack')
        if (mob.archetype === ARCHETYPES.crawler) assert.ok(mob.pack !== undefined, 'a Crawler with no pack')
      }
      for (const pack of packsOn(layer.tag)) {
        if (seen.has(pack)) continue
        seen.add(pack)
        packsSeen++
        const crawlers = pack.members.filter((m) => m.archetype === ARCHETYPES.crawler).length
        const coils = pack.members.filter((m) => m.archetype === ARCHETYPES.coil).length
        assert.ok(crawlers >= 2 && crawlers <= 4, `a pack of ${crawlers} Crawlers`)
        assert.ok(coils <= 1, `${coils} Coils in one pack`)
        assert.equal(crawlers + coils, pack.members.length, 'a pack member that is neither')
        if (layer.tag === TOP) assert.equal(coils, 0, 'a Coil on layer 0')
        for (const m of pack.members) assert.equal(m.tag, layer.tag)
      }
    }
  }
  // After the first fill (a few ticks), full on nearly every tick: a pack
  // with a survivor still counts, and a dead entry is back the next tick.
  for (const layer of LAYERS) {
    assert.ok((full[layer.tag] ?? 0) >= TICKS - 60, `layer ${layer.tag} full on only ${full[layer.tag] ?? 0} ticks`)
  }
  assert.ok(killed > 50)
  assert.ok(packsSeen > LAYERS.reduce((n, l) => n + l.mobs.filter(isPackEntry).reduce((k, e) => k + e.count, 0), 0), 'no pack was ever replaced')
})

test('pack sizes and escorts follow the entry\'s shares over many spawns', () => {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  // Layer -1: its escort share is neither 0 nor 1, so a share ignored either
  // way shows.
  const entry = LAYERS[1].mobs.find(isPackEntry) as LayerPack
  assert.ok(entry.escortShare > 0.2 && entry.escortShare < 0.8, 'pick a layer whose share is in between')
  const sizes = new Map<number, number>()
  let escorted = 0
  const N = 2000
  for (let i = 0; i < N; i++) {
    World.MOBS.length = 0
    const pack = (world as any).spawnPack(entry, LAYERS[1]) as MobPack
    assert.ok(pack !== undefined)
    const crawlers = pack.members.filter((m) => m.archetype === entry.pack).length
    sizes.set(crawlers, (sizes.get(crawlers) ?? 0) + 1)
    if (pack.members.length > crawlers) escorted++
  }
  for (const { count, share } of entry.sizes) {
    assert.ok(Math.abs((sizes.get(count) ?? 0) / N - share) < 0.05, `size ${count}: ${(sizes.get(count) ?? 0) / N} against ${share}`)
  }
  assert.ok(Math.abs(escorted / N - entry.escortShare) < 0.05)
})

test('a pack spawns on one cell and its neighbours, every member homed on the centre', () => {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  const entry = LAYERS[1].mobs.find(isPackEntry) as LayerPack
  for (let i = 0; i < 50; i++) {
    World.MOBS.length = 0
    const pack = (world as any).spawnPack(entry, LAYERS[1]) as MobPack
    const centre = Hex.toCell(pack.home)
    const cells = new Set<string>()
    for (const m of pack.members) {
      assert.ok(Hex.distance(m.cell, centre) <= 1, 'a member off the centre and its ring')
      cells.add(`${m.cell.x},${m.cell.y}`)
      const guard = m.routines.find((r): r is GuardPosition => r instanceof GuardPosition)
      assert.ok(guard !== undefined)
      assert.equal(guard.homePosition, pack.home)
      assert.equal(m.pack, pack)
    }
    assert.equal(cells.size, pack.members.length, 'two members on one cell')
    assert.ok(cells.has(`${centre.x},${centre.y}`), 'nobody on the centre')
  }
})

test('a pack with no room is not spawned partly: nothing at all, until there is room', () => {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  const entry = LAYERS[0].mobs.find(isPackEntry) as LayerPack
  assert.equal(entry.escortShare, 0)
  // Every candidate is this one free cell; its neighbours are the room.
  const centre = new Vector(40, 40)
  ;(world as any).getUnobstructedPosition = () => Hex.toPosition(centre)
  for (let d = 0; d < 6; d++) {
    const n = Hex.neighbour(centre, d)
    World.block(n.x, n.y, TOP)
  }
  const spawn = (sizeRoll: number): MobPack | undefined => (world as any).spawnPack(entry, LAYERS[0], () => sizeRoll)
  assert.equal(spawn(0), undefined, 'a pack of 2 with no free neighbour')
  assert.equal(World.MOBS.length, 0, 'part of a pack spawned')

  // Two free neighbours: room for a pack of 3, not of 4.
  World.BLOCKED.clear()
  for (let d = 2; d < 6; d++) {
    const n = Hex.neighbour(centre, d)
    World.block(n.x, n.y, TOP)
  }
  assert.equal(spawn(0.99), undefined, 'a pack of 4 in room for 3')
  assert.equal(World.MOBS.length, 0, 'part of a pack spawned')
  const pack = spawn(0.5)
  assert.ok(pack !== undefined)
  assert.equal(pack.members.length, 3)
})

test('a pack is replaced only once every member is dead', () => {
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  for (let i = 0; i < 20; i++) world.update(DT)
  const entry = LAYERS[1].mobs.find(isPackEntry) as LayerPack
  const before = packsOn(MIDDLE).filter((p) => p.entry === entry)
  assert.equal(before.length, entry.count)
  const victim = before[0]
  const [last, ...rest] = victim.members
  for (const m of rest) m.hit(10_000)
  for (let i = 0; i < 8; i++) world.update(DT)
  let now = packsOn(MIDDLE).filter((p) => p.entry === entry)
  assert.equal(now.length, entry.count)
  assert.ok(now.includes(victim), 'a pack with a survivor was dropped')
  assert.equal(now.filter((p) => !before.includes(p)).length, 0, 'replaced while a member lived')

  last.hit(10_000)
  world.update(DT) // sweeps the last member and refills in the same tick
  now = packsOn(MIDDLE).filter((p) => p.entry === entry)
  assert.equal(now.length, entry.count)
  assert.ok(!now.includes(victim))
})

test('provoking one pack member provokes the whole pack (#51 Q8); a lone mob alerts nobody', () => {
  new World(4000) // eslint-disable-line no-new
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  const entry = LAYERS[2].mobs.find(isPackEntry) as LayerPack
  const centre = new Vector(40, 40)
  const pack = new MobPack(entry, Hex.toPosition(centre))
  const cells = [centre, Hex.neighbour(centre, 0), Hex.neighbour(centre, 2), Hex.neighbour(centre, 4)]
  cells.forEach((cell, i) => {
    const at = Hex.toPosition(cell)
    const mob = new Mob(at.x, at.y, BOTTOM, i < 3 ? ARCHETYPES.crawler : ARCHETYPES.coil)
    World.addUnit(World.MOBS, mob)
    pack.join(mob)
  })
  const loneAt = Hex.toPosition(new Vector(40, 44))
  const lone = new Mob(loneAt.x, loneAt.y, BOTTOM, ARCHETYPES.compactor)
  World.addUnit(World.MOBS, lone)
  const farAt = Hex.toPosition(new Vector(52, 40))
  const player = new Player(farAt.x, farAt.y, BOTTOM, 'shooter')
  World.PLAYERS.push(player)

  GuardPosition.provoke(pack.members[1], player)
  for (const m of pack.members) assert.equal(m.target, player, `${m.archetype.key} not alerted`)
  assert.equal(lone.target, undefined, 'a mob outside the pack was alerted')

  // A dead member is not woken.
  const other = new MobPack(entry, Hex.toPosition(centre))
  const a = new Mob(loneAt.x, loneAt.y, BOTTOM, ARCHETYPES.crawler)
  const b = new Mob(farAt.x, farAt.y + 200, BOTTOM, ARCHETYPES.crawler)
  other.join(a)
  other.join(b)
  b.hit(10_000)
  GuardPosition.provoke(a, player)
  assert.equal(a.target, player)
  assert.equal(b.target, undefined)
})

test('epic and legendary NPCs are spawn hazards like the boss; the others are soft', () => {
  assert.equal(World.isSpawnHazard(ARCHETYPES.reactor), true)
  assert.equal(World.isSpawnHazard(ARCHETYPES.brood), true)
  assert.equal(World.isSpawnHazard(ARCHETYPES.boss), true)
  for (const a of [ARCHETYPES.crawler, ARCHETYPES.compactor, ARCHETYPES.kiln, ARCHETYPES.coil, ARCHETYPES.broodling, ARCHETYPES.grunt]) {
    assert.equal(World.isSpawnHazard(a), false, a.key)
  }
})

test('kill XP per NPC is the accepted table; the retired rows keep theirs', () => {
  assert.deepEqual(
    ['crawler', 'broodling', 'compactor', 'kiln', 'coil', 'reactor', 'brood', 'grunt', 'gunner', 'boss'].map((k) => PROGRESSION.kills.mob[k]),
    [1, 0, 2, 3, 3, 10, 12, 2, 2, 10]
  )
  assert.equal(PROGRESSION.kills.mobDefault, 2)
  assert.equal(PROGRESSION.kills.mobCap, 20)
})

test('NPC loot is Nick\'s (#51 L1 calls): Crawler 25, Compactor 50, Coil 75, Kiln 100, Reactor 500, Brood 800, Broodling 0', () => {
  assert.deepEqual(
    [ARCHETYPES.crawler, ARCHETYPES.compactor, ARCHETYPES.coil, ARCHETYPES.kiln, ARCHETYPES.reactor, ARCHETYPES.brood, ARCHETYPES.broodling].map((a) => a.loot),
    [25, 50, 75, 100, 500, 800, 0]
  )
})
