import test from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from '../network/multiplayer'
import Obstacle from './obstacle'
import GearPickup from './gearpickup'
import World from './world'
import Timers from './timers'
import type Player from './player'
import { type GameObject, ObjectType } from './gameobject'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { buildKit, rollGear } from '../archetypes/archetypes'
import { SKILL_INFO } from '../utils/skills'

/**
 * The pickup pass (`World.pickupPass`, `Multiplayer.pickupViews`) brings
 * pickups and StoneWall stones into and out of view per connection, and only
 * for connections whose viewpoint changed cell. It must leave exactly what
 * the old rule left: every pickup's `Multiplayer.update`, every tick, for
 * everyone. So this runs a real world (walking, dashing, StoneWall, portals,
 * deaths with spectators and their drops, joins, a viewer with no vision)
 * and, after every tick's pass, runs that update for every pickup and stone
 * and requires that it queued nothing for anyone and left the same clients
 * holding it.
 */

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

function lcg (seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

function join (multiplayer: Multiplayer, id: string, robot: string): Player {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    handshake: { query: {} },
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  multiplayer.onConnect(socket)
  handlers.start_requested({ id, name: id, robot })
  return World.PLAYERS[World.PLAYERS.length - 1]
}

/** Everything a pickup's update could touch: every queued record count, and who holds it. */
function footprint (connections: Connection[], pickup: GameObject): string {
  const queued = connections.map((c) => {
    const o = c.outbox
    return o === undefined ? '-' : `${o.create.length}/${o.update.length}/${o.destroy.length}`
  }).join(' ')
  const holders = [...pickup.knownBy].map((c) => c.id).sort().join(',')
  return `${queued} | ${holders}`
}

function skillIndex (player: Player, name: string): number {
  return (player.skills ?? []).findIndex((skill) => skill?.constructor.name === name)
}

/**
 * A kit holding Dash and StoneWall, which this test presses: a join gets the
 * start kit (`START_KIT`, #48 step 4), which has no StoneWall, and an empty
 * slot is null (`skillIndex` reads `skill?.constructor`).
 */
function giveKit (player: Player): void {
  player.skillIds = Object.freeze([SKILL_INFO.dash.id, SKILL_INFO.stoneWall.id, SKILL_INFO.melee.id, SKILL_INFO.ranged.id])
  player.skills = buildKit(player, player.skillIds)
}

test('the pickup pass leaves nothing for an every-pickup update to do', () => {
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.GEAR.length = 0
  Timers.clear()
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  // Mobs would kill the walkers at random; deaths here are the test's own.
  World.MOBS.length = 0
  const rand = lcg(20261003)
  const robots = ['peep', 'periscope', 'magnet', 'hopper', 'waddle']
  const players: Player[] = []
  let joined = 0
  const joinOne = (): void => {
    const player = join(multiplayer, `abcd${(joined++).toString(16).padStart(4, '0')}`, robots[joined % robots.length])
    giveKit(player)
    players.push(player)
  }
  for (let i = 0; i < 30; i++) joinOne()
  // One viewer with no vision: it sees by the 500 box and its exit margin.
  const boxed = players[3]
  boxed.archetype = { ...(boxed.archetype as NonNullable<Player['archetype']>), vision: null }
  const connections = (multiplayer as unknown as { _connections: Connection[] })._connections
  // Long-lived stones scattered on every layer, so they stay put while players walk.
  let placed = 0
  while (placed < 90) {
    const x = rand() * 4000
    const y = rand() * 4000
    const tag = World.TAGS[placed % World.TAGS.length]
    const cell = Hex.toCell(new Vector(x, y))
    if (!Hex.onMap(cell.x, cell.y, World.mapSize) || World.isBlocked(cell.x, cell.y, tag)) continue
    World.addObstacle(new Obstacle(x, y, tag, 600_000))
    placed++
  }
  // Gear on the ground (49-2), ObjectType.Item like items but in World.GEAR:
  // the pass must settle it exactly as it does items. Walkers take some, fill
  // their slots and bags, and drop them again when they die.
  let gearPlaced = 0
  while (gearPlaced < 60) {
    const cell = Hex.toCell(new Vector(rand() * 4000, rand() * 4000))
    const tag = World.TAGS[gearPlaced % World.TAGS.length]
    if (!Hex.onMap(cell.x, cell.y, World.mapSize) || World.isBlocked(cell.x, cell.y, tag)) continue
    const at = Hex.toPosition(cell)
    World.PICKUPS.push(World.GEAR, new GearPickup(at.x, at.y, tag, rollGear(gearPlaced % 3 === 0 ? 1 : 2, gearPlaced % 2 === 0 ? 'part' : 'skill', rand)))
    gearPlaced++
  }
  let gearChecked = 0

  const counts = Multiplayer.pickupViewCounts
  const before = { ...counts }
  let checked = 0
  let deaths = 0
  let dashes = 0
  let walls = 0
  const hops = new Set<number>()
  // StoneWall's own stones (the scattered ones last 600 s): a press counted in
  // `walls` places none when the slot is empty or every cell behind is taken.
  const placedStones = new Set<GameObject>()
  for (let tick = 0; tick < 400; tick++) {
    for (const player of players) {
      if (player.destroyed || player.exited) continue
      const roll = rand()
      if (roll < 0.04) {
        if (rand() < 0.25) player.stop()
        else {
          const cell = player.cell
          const target = new Vector(cell.x + Math.floor(rand() * 41) - 20, cell.y + Math.floor(rand() * 41) - 20)
          if (Hex.onMap(target.x, target.y, World.mapSize) && !World.isBlocked(target.x, target.y, player.tag)) player.setWaypoints([target])
        }
      } else if (roll < 0.05) {
        player.tryExecuteSkill(skillIndex(player, 'Dash'))
        dashes++
      } else if (roll < 0.055) {
        player.tryExecuteSkill(skillIndex(player, 'StoneWall'))
        walls++
      } else if (roll < 0.0565 && player !== boxed) {
        // Dies between ticks: drops its loot, and its connection spectates.
        player.hit(1e6)
        deaths++
      }
    }
    if (tick % 40 === 39) joinOne()
    if (tick % 25 === 12) {
      // Through a portal: stood on one, the player hops at the end of its update.
      const live = players.filter((p) => !p.destroyed && !p.exited)
      const player = live[Math.floor(rand() * live.length)]
      const portal = World.OBSTACLES.find((o) => o.type === ObjectType.Portal && o.tag === player.tag)
      if (portal !== undefined) {
        player.stop()
        player.position = Hex.toPosition(Hex.toCell(portal.position))
      }
    }
    world.update(0.25)
    for (const player of players) if (player.tag !== World.TAGS[0]) hops.add(player.id)
    for (const obj of World.OBSTACLES) if (!Multiplayer.isTerrain(obj) && obj.lifetime !== 600_000) placedStones.add(obj)

    for (const pickup of [...World.CONSUMABLES, ...World.ITEMS, ...World.GEAR, ...World.OBSTACLES.filter((o) => !Multiplayer.isTerrain(o))]) {
      if (Multiplayer.gone(pickup)) continue
      if (World.isGear(pickup)) gearChecked++
      const was = footprint(connections, pickup)
      Multiplayer.Instance.update(pickup)
      assert.equal(footprint(connections, pickup), was, `tick ${tick}: the pass left pickup ${pickup.id} (${pickup.constructor.name}) unsettled`)
      checked++
    }
    multiplayer.flushAll(tick)
  }

  const ran = {
    skipped: counts.skipped - before.skipped,
    rings: counts.rings - before.rings,
    whole: counts.whole - before.whole,
    entered: counts.entered - before.entered,
    left: counts.left - before.left
  }
  // It exercised what it claims to.
  console.log(`pickup pass: ${JSON.stringify(ran)}, ${checked} checked (${gearChecked} gear), ${deaths} deaths, ${dashes} dashes, ${walls} walls, ${placedStones.size} stones placed`)
  assert.ok(checked > 100_000, `only ${checked} pickups checked`)
  assert.ok(gearChecked > 10_000, `only ${gearChecked} gear pickups checked`)
  assert.ok(deaths > 5 && dashes > 50 && walls > 25, `deaths ${deaths}, dashes ${dashes}, walls ${walls}`)
  assert.ok(placedStones.size > 25, `StoneWall placed only ${placedStones.size} stones`)
  assert.ok(hops.size > 0, 'nobody came through a portal')
  assert.ok(connections.some((c) => c.spectating !== undefined), 'nobody spectates')
  // Every join is settled whole once (40 here); dashes, deaths and portals add some.
  const least = { skipped: 1000, rings: 500, whole: 40, entered: 100, left: 100 }
  for (const [branch, n] of Object.entries(ran)) {
    assert.ok(n >= least[branch as keyof typeof least], `${branch} ran only ${n} times: ${JSON.stringify(ran)}`)
  }
})

/**
 * A world with no mobs, pickups, gates or stones, and one Peep at a cell well
 * inside the map. Its passes are `World.pickupPass` alone, so nothing moves
 * but what the test moves (a real tick could walk it onto a random portal).
 */
function quietWorld (): { multiplayer: Multiplayer, player: Player, connection: Connection, home: Vector, enter: number, leave: number, pass: () => void } {
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  Timers.clear()
  const multiplayer = new Multiplayer(250, okRedis())
  new World(4000) // eslint-disable-line no-new
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  const player = join(multiplayer, 'abcdef01', 'peep')
  const home = new Vector(40, 40)
  player.position = Hex.toPosition(home)
  const enter = (player.archetype?.vision as number) + Multiplayer.VIEW_MARGIN_RINGS
  let tick = 0
  const pass = (): void => {
    World.pickupPass(0.25)
    multiplayer.flushAll(tick++)
  }
  pass()
  return { multiplayer, player, connection: player.connection as Connection, home, enter, leave: enter + Multiplayer.VIEW_EXIT_RINGS, pass }
}

function stoneAt (cell: Vector, tag: number): Obstacle {
  const at = Hex.toPosition(cell)
  const stone = new Obstacle(at.x, at.y, tag, 600_000)
  World.addObstacle(stone)
  return stone
}

test('a connection that did not change cell is skipped, and one that did enters and leaves by its own radii', () => {
  const { player, connection, home, enter, leave, pass } = quietWorld()
  // A stone due east, one ring past the enter radius: in sight after one step east.
  const stone = stoneAt(new Vector(home.x + enter + 1, home.y), player.tag)
  pass()
  assert.ok(!stone.knownBy.has(connection), 'held from beyond the enter radius')

  const counts = Multiplayer.pickupViewCounts
  const skipped = counts.skipped
  pass()
  assert.equal(counts.skipped, skipped + 1, 'a viewer standing still was not skipped')

  player.position = Hex.toPosition(new Vector(home.x + 1, home.y))
  const rings = counts.rings
  World.pickupPass(0.25)
  assert.equal(counts.rings, rings + 1, 'a one-cell move did not take the ring path')
  assert.ok(stone.knownBy.has(connection), 'not entered on the enter ring')
  pass()

  // Back west to the leave radius, then a ring past it.
  player.position = Hex.toPosition(new Vector(home.x + enter + 1 - leave, home.y))
  pass()
  assert.ok(stone.knownBy.has(connection), 'dropped within the leave radius')
  player.position = Hex.toPosition(new Vector(home.x + enter - leave, home.y))
  World.pickupPass(0.25)
  assert.ok(!stone.knownBy.has(connection), 'kept beyond the leave radius')
  assert.equal(connection.outbox?.destroy.length, 1, 'no destroy for it')
  pass()
})

test('a connection whose layer change is still pending keeps what it holds on the old layer', () => {
  const { player, connection, home, leave, pass } = quietWorld()
  // On the leave radius due west: held, and out of sight after one step east.
  const stone = stoneAt(new Vector(home.x - leave, home.y), player.tag)
  player.position = Hex.toPosition(new Vector(home.x - leave + 1, home.y))
  pass()
  player.position = Hex.toPosition(home)
  pass()
  assert.ok(stone.knownBy.has(connection), 'not held at the leave radius')
  // A portal hop: a cell east, on another layer, after the player's own
  // update, so its client switches at its next (`switchLayer`). Until then
  // the old rule (`Multiplayer.update`) leaves the connection alone.
  const below = World.TAGS[1]
  player.position = Hex.toPosition(new Vector(home.x + 1, home.y))
  player.tag = below
  World.pickupPass(0.25)
  assert.ok(stone.knownBy.has(connection), 'let go while its switch was pending')
  assert.equal(connection.outbox?.destroy.length ?? 0, 0, 'a destroy while its switch was pending')
})

test('a pickup made while its viewer stood elsewhere is settled at the next pass', () => {
  const { player, connection, home, pass } = quietWorld()
  // Settled at home; then, within one pass, out of sight, a stone is made
  // beside home, and back. The connection is skipped (same cell), so only
  // the stone's own first update can bring it into view.
  player.position = Hex.toPosition(new Vector(home.x + 40, home.y))
  const stone = stoneAt(new Vector(home.x + 1, home.y), player.tag)
  assert.ok(!stone.knownBy.has(connection), 'created into a view it was not in')
  player.position = Hex.toPosition(home)
  pass()
  assert.ok(stone.knownBy.has(connection), 'never brought into view')
})

test('a gear pickup made while its viewer stood elsewhere is settled at the next pass', () => {
  const { player, connection, home, pass } = quietWorld()
  World.GEAR.length = 0
  pass()
  // As the stone test above: settled at home, then within one pass the viewer
  // is away when the gear is made, and back. The connection is skipped (same
  // cell), so only the pickup's own first update, from World.pickupPass's walk
  // of World.GEAR, can bring it into view (49-2).
  player.position = Hex.toPosition(new Vector(home.x + 40, home.y))
  const at = Hex.toPosition(new Vector(home.x + 2, home.y))
  const dropped = new GearPickup(at.x, at.y, player.tag, rollGear(1, 'part', Math.random), World.DROPPED_LOOT_LIFETIME)
  World.PICKUPS.push(World.GEAR, dropped)
  assert.ok(!dropped.knownBy.has(connection), 'created into a view it was not in')
  player.position = Hex.toPosition(home)
  pass()
  assert.ok(dropped.knownBy.has(connection), 'never brought into view')
})

test('forRing visits each cell of a ring once, at that distance', () => {
  const centre = new Vector(7, -3)
  for (let ring = 0; ring <= 12; ring++) {
    const seen = new Set<number>()
    Multiplayer.forRing(centre, ring, (q, r) => {
      assert.equal(Hex.distance(centre, new Vector(q, r)), ring, `(${q}, ${r}) is not on ring ${ring}`)
      seen.add(Hex.key(q, r))
    })
    assert.equal(seen.size, ring === 0 ? 1 : 6 * ring, `ring ${ring}`)
  }
})
