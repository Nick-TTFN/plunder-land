import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import Obstacle from '../objects/obstacle'
import Consumable from '../objects/consumable'
import ItemPickup from '../objects/itempickup'
import { type Unit } from '../objects/unit'
import { ARCHETYPES, ITEMS, LAYERS, type Item } from '../archetypes/archetypes'
import { ITEM_INFO, INVENTORY_SLOTS, itemById, itemInSlot, type ItemKey } from '../utils/items'
import { itemForSlot } from './use'
import { BOMB_BLAST_EFFECT, BOMB_FUSE_EFFECT, bombCell } from './bomb'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
// The client's disc, which the bomb's telegraph draws. Imports nothing.
import { discCells } from '../../../../plunder-land-client/src/vfx/cells'

/**
 * usable-items: the medkit and the bomb (decisions #5, #12, #26; balance pass
 * section 1 "Items").
 */

interface Sent { type: number, originator: number, lifetime: number, cell: Vector, tag: number }
let sent: Sent[] = []

beforeEach(() => {
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
  Timers.clear()
})

const MID = Hex.toCell(new Vector(2000, 2000))
const DT = 0.25

function mockClock (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
}

function advance (t: TestContext, ms: number): void {
  t.mock.timers.tick(ms)
  Timers.run(Date.now())
}

function playerOn (cell: Vector, id = 'p1'): Player {
  const at = Hex.toPosition(cell)
  const player = new Player(at.x, at.y, 0, id)
  World.PLAYERS.push(player)
  return player
}

function gruntOn (cell: Vector): Mob {
  const at = Hex.toPosition(cell)
  const mob = new Mob(at.x, at.y, 0, ARCHETYPES.grunt)
  World.MOBS.push(mob)
  return mob
}

/** hp plus armor: what a hit takes from, whichever it comes off. */
function pool (unit: Unit): number {
  return unit.hp + unit.armor
}

function give (player: Player, item: Item, n: number): void {
  for (let i = 0; i < n; i++) assert.ok(player.addItem(item))
}

// --- the table ----------------------------------------------------------------------

const KEYS = Object.keys(ITEM_INFO) as ItemKey[]

test('the server table has exactly the mirrored keys, and takes the shared fields from the mirror', () => {
  assert.deepEqual(Object.keys(ITEMS).sort(), [...KEYS].sort())
  for (const key of KEYS) {
    for (const field of ['id', 'key', 'slot', 'label', 'aimRange', 'rings'] as const) {
      assert.equal(ITEMS[key][field], ITEM_INFO[key][field], `${key}.${field} is written down twice and disagrees`)
    }
  }
})

test('item ids are unique non-zero bytes, and each kind has its own slot inside the inventory', () => {
  const ids = KEYS.map((k) => ITEM_INFO[k].id)
  const slots = KEYS.map((k) => ITEM_INFO[k].slot)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(new Set(slots).size, slots.length, 'two kinds share a slot')
  for (const key of KEYS) {
    const { id, slot } = ITEM_INFO[key]
    assert.ok(Number.isInteger(id) && id >= 1 && id <= 255, `${key}: id ${id}`)
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < INVENTORY_SLOTS, `${key}: slot ${slot}`)
    assert.equal(itemById(id), ITEM_INFO[key])
    assert.equal(itemInSlot(slot), ITEM_INFO[key])
    assert.equal(itemForSlot(slot), ITEMS[key])
  }
  assert.equal(itemById(0), undefined)
  assert.equal(itemById(200), undefined)
  assert.equal(itemForSlot(4), undefined)
  assert.equal(itemForSlot(-1), undefined)
})

test('ids and slots are the ones on the wire (append-only): medkit 1 in slot 1, bomb 2 in slot 2', () => {
  assert.deepEqual([ITEM_INFO.medkit.id, ITEM_INFO.medkit.slot], [1, 0])
  assert.deepEqual([ITEM_INFO.bomb.id, ITEM_INFO.bomb.slot], [2, 1])
})

test('values are the balance pass section 1 "Items"', () => {
  assert.deepEqual(ITEMS.medkit.use, { kind: 'heal', amount: 40, durationMs: 2000 })
  assert.equal(ITEMS.medkit.maxStack, 3)
  assert.deepEqual(ITEMS.bomb.use, { kind: 'bomb', damage: 60, fuseMs: 1500 })
  assert.equal(ITEMS.bomb.maxStack, 2)
  assert.equal(ITEMS.bomb.aimRange, 6)
  assert.equal(ITEMS.bomb.rings, 2)
  assert.equal(ITEMS.medkit.aimRange, null)
})

test('layers keep #26\'s provisional item counts: medkits 8/10/12, bombs 3/5/7', () => {
  assert.deepEqual(
    LAYERS.map((l) => l.items.map(({ item, count }) => [item.key, count])),
    [
      [['medkit', 8], ['bomb', 3]],
      [['medkit', 10], ['bomb', 5]],
      [['medkit', 12], ['bomb', 7]]
    ]
  )
})

test('the client draws the bomb on the same 19 cells the server damages', () => {
  const cells = discCells(MID, ITEM_INFO.bomb.rings)
  assert.equal(cells.length, 19)
  for (const c of cells) assert.ok(Hex.distance(MID, new Vector(c.x, c.y)) <= ITEMS.bomb.rings)
})

// --- pickups ------------------------------------------------------------------------

test('walking onto an item picks it up into its slot and removes it from the world', () => {
  const player = playerOn(MID)
  const at = Hex.toPosition(MID)
  World.ITEMS.push(new ItemPickup(at.x, at.y, 0, ITEMS.bomb))
  player.dirtyFields.clear()

  player.update(DT)
  assert.equal(World.ITEMS.length, 0)
  assert.equal(player.countOf(ITEMS.bomb), 1)
  assert.deepEqual([...player.inventory], [0, 1, 0, 0, 0])
  assert.ok(player.dirtyFields.has('inventory'), 'the owner is never told')
})

test('a full stack leaves the pickup on the ground', () => {
  const player = playerOn(MID)
  give(player, ITEMS.bomb, 2)
  assert.equal(player.addItem(ITEMS.bomb), false, 'a third bomb went into a stack of 2')
  const at = Hex.toPosition(MID)
  World.ITEMS.push(new ItemPickup(at.x, at.y, 0, ITEMS.bomb))

  player.update(DT)
  assert.equal(World.ITEMS.length, 1)
  assert.equal(player.countOf(ITEMS.bomb), 2)

  // ...but the other kind still goes in.
  World.ITEMS.push(new ItemPickup(at.x, at.y, 0, ITEMS.medkit))
  player.update(DT)
  assert.equal(player.countOf(ITEMS.medkit), 1)
  assert.equal(World.ITEMS.length, 1)
})

test('an item on another layer, or out of reach, is not picked up', () => {
  const player = playerOn(MID)
  const at = Hex.toPosition(MID)
  World.ITEMS.push(new ItemPickup(at.x, at.y, -1, ITEMS.medkit))
  const far = Hex.toPosition(MID.add(new Vector(2, 0)))
  World.ITEMS.push(new ItemPickup(far.x, far.y, 0, ITEMS.medkit))
  player.update(DT)
  assert.equal(World.ITEMS.length, 2)
  assert.equal(player.countOf(ITEMS.medkit), 0)
})

test('a loot pickup banks and no longer heals (decision #5)', () => {
  const player = playerOn(MID)
  player.hp = 30
  const at = Hex.toPosition(MID)
  World.CONSUMABLES.push(new Consumable(at.x, at.y, 0, undefined, 25))

  player.update(DT)
  assert.equal(World.CONSUMABLES.length, 0)
  assert.equal(player.loot, 25)
  assert.equal(player.hp, 30, 'the pickup healed')
})

// --- using: validation --------------------------------------------------------------

test('using needs a whole slot number in range that holds one; a refused use spends nothing', () => {
  const player = playerOn(MID)
  player.hp = 50
  for (const slot of [-1, 5, 1.5, NaN, 4]) assert.equal(player.tryUseItem(slot), false, `slot ${slot}`)
  assert.equal(player.tryUseItem(0), false, 'used a medkit it does not have')

  give(player, ITEMS.medkit, 1)
  player.dirtyFields.clear()
  assert.equal(player.tryUseItem(0), true)
  assert.equal(player.countOf(ITEMS.medkit), 0)
  assert.ok(player.dirtyFields.has('inventory'))
})

test('a dead or departed player cannot use an item', () => {
  const player = playerOn(MID)
  give(player, ITEMS.bomb, 1)
  player.exited = true
  assert.equal(player.tryUseItem(1), false)
  player.exited = false
  player.hit(1000)
  assert.equal(player.tryUseItem(1), false)
  assert.equal(player.countOf(ITEMS.bomb), 1)
})

// --- the medkit ---------------------------------------------------------------------

test('a medkit heals 5 a 250 ms tick, 40 in all over 2 s, on the player\'s own update', () => {
  const player = playerOn(MID)
  player.hp = 20
  give(player, ITEMS.medkit, 1)
  assert.equal(player.tryUseItem(0), true)
  assert.equal(player.hp, 20, 'healed at once, not over time')

  const seen: number[] = []
  for (let i = 0; i < 10; i++) {
    player.update(DT)
    seen.push(player.hp)
  }
  assert.deepEqual(seen, [25, 30, 35, 40, 45, 50, 55, 60, 60, 60])
  assert.equal(player.healing, false)
})

test('a medkit\'s heal stops at max hp, and ends on time', () => {
  const player = playerOn(MID)
  player.hp = 90
  give(player, ITEMS.medkit, 1)
  player.tryUseItem(0)
  for (let i = 0; i < 3; i++) player.update(DT)
  assert.equal(player.hp, 100)
  for (let i = 0; i < 5; i++) player.update(DT)
  assert.equal(player.healing, false, 'hp lost to the cap still counts against the heal')
})

test('a medkit keeps its total under a jittering dt', () => {
  const player = playerOn(MID)
  player.hp = 10
  give(player, ITEMS.medkit, 1)
  player.tryUseItem(0)
  for (const dt of [0.249, 0.262, 0.238, 0.251, 0.25, 0.3, 0.2, 0.25, 0.25, 0.25]) player.update(dt)
  assert.equal(player.hp, 50)
})

test('a medkit is refused, and kept, at full hp or while one is already healing', () => {
  const player = playerOn(MID)
  give(player, ITEMS.medkit, 2)
  assert.equal(player.tryUseItem(0), false, 'used at full hp')
  assert.equal(player.countOf(ITEMS.medkit), 2)

  player.hp = 20
  assert.equal(player.tryUseItem(0), true)
  assert.equal(player.tryUseItem(0), false, 'two heals at once')
  assert.equal(player.countOf(ITEMS.medkit), 1)
})

test('death ends a heal: a corpse is never healed', () => {
  const player = playerOn(MID)
  player.hp = 20
  give(player, ITEMS.medkit, 1)
  player.tryUseItem(0)
  player.update(DT)
  player.armor = 0
  player.hit(1000)
  assert.equal(player.destroyed, true)
  player.update(DT)
  assert.equal(player.hp, 0)
})

// --- the bomb -----------------------------------------------------------------------

test('a bomb lands on the aimed cell within 6 cells; further is refused and not spent', () => {
  const player = playerOn(MID)
  give(player, ITEMS.bomb, 2)
  const six = MID.add(new Vector(6, 0))
  const seven = MID.add(new Vector(0, 7))
  assert.equal(bombCell(player, ITEMS.bomb, seven), undefined)
  assert.equal(player.tryUseItem(1, seven), false)
  assert.equal(player.countOf(ITEMS.bomb), 2)
  assert.equal(sent.length, 0)

  assert.equal(player.tryUseItem(1, six), true)
  assert.equal(player.countOf(ITEMS.bomb), 1)
  assert.deepEqual(sent.map((s) => [s.type, s.cell.x, s.cell.y, s.lifetime, s.tag, s.originator]),
    [[BOMB_FUSE_EFFECT, six.x, six.y, 1500, 0, player.id]])
})

test('a bomb aimed off the map is refused', () => {
  const player = playerOn(Hex.toCell(new Vector(20, 2000)))
  give(player, ITEMS.bomb, 1)
  const west = player.cell.add(new Vector(-3, 0))
  assert.equal(Hex.onMap(west.x, west.y, World.mapSize), false)
  assert.equal(player.tryUseItem(1, west), false)
})

test('an unaimed bomb, or one aimed at the thrower\'s own cell, goes 6 cells along facing', () => {
  const player = playerOn(MID)
  player.facing = Hex.toPosition(Hex.DIRECTIONS[1]).normalised()
  const expected = MID.add(Hex.DIRECTIONS[1].multiply(6))
  assert.deepEqual(bombCell(player, ITEMS.bomb, undefined), expected)
  assert.deepEqual(bombCell(player, ITEMS.bomb, MID), expected)
})

test('the fuse runs on the tick: nothing at 1499 ms, the blast at 1500', (t) => {
  mockClock(t)
  const thrower = playerOn(MID)
  const target = MID.add(new Vector(4, 0))
  const victim = playerOn(target, 'p2')
  give(thrower, ITEMS.bomb, 1)
  thrower.tryUseItem(1, target)

  const before = pool(victim)
  advance(t, 1499)
  assert.equal(pool(victim), before, 'went off early')
  assert.equal(sent.length, 1)

  // The clock alone does nothing: it goes off when the tick runs the timers.
  t.mock.timers.tick(1)
  assert.equal(pool(victim), before, 'went off outside Timers.run')
  Timers.run(Date.now())
  assert.equal(pool(victim), before - 60)
  assert.deepEqual(sent.map((s) => s.type), [BOMB_FUSE_EFFECT, BOMB_BLAST_EFFECT])
  assert.deepEqual(sent[1].cell, target)
})

test('the blast hits everyone within 2 rings for 60, the thrower included, and nobody at 3', (t) => {
  mockClock(t)
  const thrower = playerOn(MID)
  const centre = MID.add(new Vector(2, 0))
  const onCentre = playerOn(centre, 'c')
  const ringTwo = gruntOn(centre.add(new Vector(0, 2)))
  const ringThree = gruntOn(centre.add(new Vector(-3, 0)))
  const elsewhere = gruntOn(centre.add(new Vector(0, -1)))
  elsewhere.tag = -1
  give(thrower, ITEMS.bomb, 1)
  thrower.tryUseItem(1, centre)
  advance(t, 1500)

  assert.equal(pool(thrower), 150 - 60, 'N3: the thrower is hurt too')
  assert.equal(pool(onCentre), 150 - 60)
  assert.equal(ringTwo.hp, 0, 'a grunt has 50: 60 kills it')
  assert.equal(ringThree.hp, 50)
  assert.equal(elsewhere.hp, 50, 'another layer was hit')
})

test('a surviving mob is provoked by the thrower (N1); a kill is credited, the thrower\'s own death is not', (t) => {
  mockClock(t)
  const thrower = playerOn(MID)
  const boss = new Mob(Hex.toPosition(MID.add(new Vector(3, 0))).x, Hex.toPosition(MID.add(new Vector(3, 0))).y, 0, ARCHETYPES.boss)
  World.MOBS.push(boss)
  const grunt = gruntOn(MID.add(new Vector(4, 0)))
  const kills: unknown[] = []
  thrower.onKill = (value) => { kills.push(value) }

  give(thrower, ITEMS.bomb, 2)
  thrower.tryUseItem(1, MID.add(new Vector(3, 0)))
  advance(t, 1500)
  assert.equal(boss.hp, 240)
  assert.equal(boss.target, thrower, 'the boss was not provoked')
  assert.deepEqual(kills, [grunt])
})

test('a bomb on the thrower\'s cell kills them without crediting a kill', (t) => {
  mockClock(t)
  const thrower = playerOn(MID)
  const kills: unknown[] = []
  thrower.onKill = (value) => { kills.push(value) }
  give(thrower, ITEMS.bomb, 1)
  // An aim at its own cell is no aim (facing), so aim one cell away: still inside the disc.
  thrower.tryUseItem(1, MID.add(new Vector(1, 0)))
  thrower.armor = 0
  thrower.hp = 10
  advance(t, 1500)
  assert.equal(thrower.destroyed, true)
  assert.deepEqual(kills, [])
})

test('a thrown bomb goes off even if its thrower dies or leaves first', (t) => {
  mockClock(t)
  const thrower = playerOn(MID)
  const target = MID.add(new Vector(5, 0))
  const victim = playerOn(target, 'p2')
  give(thrower, ITEMS.bomb, 2)
  thrower.tryUseItem(1, target)
  thrower.armor = 0
  thrower.hit(1000)
  assert.equal(thrower.destroyed, true)
  advance(t, 1500)
  assert.equal(pool(victim), 90, 'the thrower\'s death cancelled the fuse')

  const leaver = playerOn(MID.add(new Vector(0, 3)), 'p3')
  give(leaver, ITEMS.bomb, 1)
  leaver.tryUseItem(1, target)
  leaver.exit()
  advance(t, 1500)
  assert.equal(pool(victim), 30, 'the thrower\'s exit cancelled the fuse')
})

test('the blast destroys StoneWall stones on the disc, and leaves rocks and stones outside it', (t) => {
  mockClock(t)
  const thrower = playerOn(MID)
  const centre = MID.add(new Vector(4, 0))
  const stoneIn = new Obstacle(Hex.toPosition(centre.add(new Vector(1, 0))).x, Hex.toPosition(centre.add(new Vector(1, 0))).y, 0, 4000)
  const stoneOut = new Obstacle(Hex.toPosition(centre.add(new Vector(3, 0))).x, Hex.toPosition(centre.add(new Vector(3, 0))).y, 0, 4000)
  const rock = new Obstacle(Hex.toPosition(centre.add(new Vector(0, 1))).x, Hex.toPosition(centre.add(new Vector(0, 1))).y, 0)
  const stoneOtherLayer = new Obstacle(Hex.toPosition(centre).x, Hex.toPosition(centre).y, -1, 4000)
  World.OBSTACLES.push(stoneIn, stoneOut, rock, stoneOtherLayer)
  give(thrower, ITEMS.bomb, 1)
  thrower.tryUseItem(1, centre)
  advance(t, 1500)

  assert.equal(stoneIn.destroyed, true)
  assert.ok(!World.OBSTACLES.includes(stoneIn))
  assert.equal(World.isBlocked(stoneIn.cell.x, stoneIn.cell.y, 0), false, 'its cell stayed blocked')
  assert.equal(stoneOut.destroyed, false)
  assert.equal(rock.destroyed, false)
  assert.equal(stoneOtherLayer.destroyed, false)
  assert.equal(World.OBSTACLES.length, 3)
})

// --- death scatters the inventory ---------------------------------------------------

test('death scatters every carried item as its own pickup near the body, expiring like dropped loot', (t) => {
  mockClock(t)
  const world = Object.create(World.prototype) as World
  const player = playerOn(MID)
  give(player, ITEMS.medkit, 3)
  give(player, ITEMS.bomb, 2)
  // A rock beside the body: nothing may land inside it.
  const rockCell = MID.add(new Vector(1, 0))
  World.OBSTACLES.push(new Obstacle(Hex.toPosition(rockCell).x, Hex.toPosition(rockCell).y, 0))

  player.armor = 0
  player.hit(1000)
  world.update(DT)

  assert.equal(World.PLAYERS.length, 0)
  // The same update tops the layers up with natural ones; only drops expire.
  const drops = World.ITEMS.filter((i) => i.expiresAt > 0)
  assert.equal(drops.length, 5)
  assert.equal(drops.filter((i) => i.kind === ITEMS.medkit).length, 3)
  assert.equal(drops.filter((i) => i.kind === ITEMS.bomb).length, 2)
  for (const drop of drops) {
    const cell = Hex.toCell(drop.position)
    assert.ok(Hex.distance(cell, MID) <= World.DROP_RINGS, 'dropped too far away')
    assert.deepEqual(drop.position, Hex.toPosition(cell), 'not on a cell centre')
    assert.notDeepEqual(cell, rockCell, 'dropped inside a rock')
    assert.equal(drop.tag, 0)
    assert.equal(drop.lifetime, World.DROPPED_LOOT_LIFETIME)
  }
  assert.deepEqual([...player.inventory], [0, 0, 0, 0, 0])

  t.mock.timers.tick(World.DROPPED_LOOT_LIFETIME + 1)
  world.update(DT)
  assert.equal(World.ITEMS.filter((i) => i.expiresAt > 0).length, 0, 'dropped items never expired')
  assert.ok(World.ITEMS.length > 0, 'natural ones expired too')
})

test('a player who exits takes nothing to the ground', () => {
  const world = Object.create(World.prototype) as World
  const player = playerOn(MID)
  give(player, ITEMS.bomb, 1)
  player.exit()
  world.update(DT)
  assert.equal(World.ITEMS.filter((i) => i.expiresAt > 0).length, 0)
})

// --- natural spawns -----------------------------------------------------------------

test('each layer is topped up to its item counts, a kind a tick, and a taken one comes back', () => {
  const world = new World(4000)
  // Gates only get in the way (CLAUDE.md, tests that tick a real world).
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  const refill = (world as unknown as { refillLayer: (l: unknown) => void }).refillLayer.bind(world)

  const count = (tag: number, item: Item): number =>
    World.ITEMS.filter((i) => i.tag === tag && i.kind === item && i.expiresAt === 0).length

  for (let tick = 0; tick < 15; tick++) for (const layer of LAYERS) refill(layer)
  for (const layer of LAYERS) {
    for (const { item, count: want } of layer.items) assert.equal(count(layer.tag, item), want, `${item.key} on ${layer.tag}`)
  }

  // A death drop is on top and does not hold back a respawn.
  const at = Hex.toPosition(MID)
  World.ITEMS.push(new ItemPickup(at.x, at.y, 0, ITEMS.bomb, 30000))
  const natural = World.ITEMS.findIndex((i) => i.tag === 0 && i.kind === ITEMS.bomb && i.expiresAt === 0)
  World.ITEMS.splice(natural, 1)
  refill(LAYERS[0])
  assert.equal(count(0, ITEMS.bomb), 3)
  // And items are not loot: none of this moved the loot cap.
  assert.ok(World.CONSUMABLES.every((c) => !(c instanceof ItemPickup)))
})
