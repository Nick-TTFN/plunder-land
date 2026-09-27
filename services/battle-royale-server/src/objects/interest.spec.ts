import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Player from './player'
import Mob from './mob'
import Consumable from './consumable'
import ItemPickup from './itempickup'
import Obstacle from './obstacle'
import { type GameObject } from './gameobject'
import { ARCHETYPES, ITEMS, LAYERS } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { unpackFrame } from '../../../../plunder-land-client/src/net/framedparser'

/**
 * interest-filtered-broadcasts (decision #35): who is sent which create,
 * update, destroy and effect.
 *
 * - Terrain (everything in `World.OBSTACLES`) goes to every connection on its
 *   layer, whatever the distance.
 * - Units, pickups and projectiles go only to connections on their layer with
 *   them strictly inside the interest box (half-width `INTEREST_RADIUS`), and
 *   are created there when they come into it, whichever of the two moved, even
 *   if they never change. A connection that holds one is sent a destroy once it
 *   is beyond `INTEREST_RADIUS + EXIT_MARGIN`, or off the layer.
 * - Updates and destroys go to exactly the connections that hold the object.
 *
 * Each client here is a `Mirror`: it applies every event in the order the
 * server emits them, as the real client does (`create`, `create_own`,
 * `effect`, `destroy`, then `update`), and records a problem for anything the
 * client could not apply cleanly: a create for an id it already holds (the
 * real client draws a second sprite and loses the first), an update or a
 * destroy for an id it does not hold.
 */

/** Set by interest.framed.spec.ts before it loads this file. */
const FRAMED = process.env.INTEREST_SPEC_FRAMED === '1'

const [TOP, MIDDLE, BOTTOM] = LAYERS.map((layer) => layer.tag)
const R = Multiplayer.INTEREST_RADIUS
const OUTER = R + Multiplayer.EXIT_MARGIN

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

beforeEach(() => {
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

/** A seeded generator, so a failure repeats. */
function lcg (seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** The ids of a packed batch's records, after `skip` header bytes. Every record opens with `[0][uint16 id]`. */
function ids (buffer: Buffer, skip = 0): number[] {
  const out: number[] = []
  let at = skip
  while (at + 2 <= buffer.length) {
    const length = buffer.readUInt16BE(at)
    const record = buffer.subarray(at + 2, at + 2 + length)
    assert.equal(record[0], 0, 'a record that does not open with its id')
    out.push(record.readUInt16BE(1))
    at += 2 + length
  }
  return out
}

/** What one client holds, applied event by event in emission order. */
class Mirror {
  held = new Set<number>()
  ownId: number | undefined
  problems: string[] = []
  /** Every record by event, since the last `clear`. */
  seen: Record<string, number[]> = { create: [], create_own: [], destroy: [], update: [], effect: [] }
  /** Destroyed since the last `update` event: an update for one of these is harmless (the client ignores it). */
  private goneThisFlush = new Set<number>()

  receive (event: string, data: unknown): void {
    if (event === 'hello' || event === 'standings') return
    const buffer = data as Buffer
    if (event === 'effect') {
      let at = 0
      while (at + 2 <= buffer.length) {
        const length = buffer.readUInt16BE(at)
        this.seen.effect.push(buffer.readUInt16BE(at + 3))
        at += 2 + length
      }
      return
    }
    const list = ids(buffer, event === 'update' ? 8 : 0)
    for (const id of list) {
      this.seen[event].push(id)
      if (event === 'create' || event === 'create_own') {
        if (this.held.has(id)) this.problems.push(`${event} for ${id}, already held`)
        this.held.add(id)
        if (event === 'create_own') this.ownId = id
      } else if (event === 'destroy') {
        if (!this.held.has(id)) this.problems.push(`destroy for ${id}, not held`)
        this.held.delete(id)
        this.goneThisFlush.add(id)
      } else if (event === 'update') {
        if (!this.held.has(id) && !this.goneThisFlush.has(id)) this.problems.push(`update for ${id}, not held`)
      }
    }
    if (event === 'update') this.goneThisFlush.clear()
  }

  clear (): void {
    for (const key of Object.keys(this.seen)) this.seen[key] = []
  }
}

interface Client { id: string, mirror: Mirror, player: Player, fire: (event: string, data?: unknown) => void }

function connect (multiplayer: Multiplayer, id: string): Omit<Client, 'player'> {
  const handlers: Record<string, (data: unknown) => void> = {}
  const mirror = new Mirror()
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string, data: unknown) => { mirror.receive(event, data); return true },
    // interest.framed.spec.ts runs every test here again with one frame per
    // tick, split back into events by the client's own decoder.
    handshake: { query: FRAMED ? { frames: '1' } : {} },
    conn: {
      write: (frame: Buffer) => {
        const events = unpackFrame(new Uint8Array(frame))
        assert.ok(events !== undefined, 'a frame the client cannot read')
        for (const [event, data] of events) mirror.receive(event, Buffer.from(data))
      }
    }
  } as unknown as Socket
  multiplayer.onConnect(socket)
  return { id, mirror, fire: (event, data) => { handlers[event](data) } }
}

/** Join, on `at`'s cell if given (else wherever `spawnCell` picks), and flush the snapshot. */
function join (multiplayer: Multiplayer, id: string, at?: Vector): Client {
  const client = connect(multiplayer, id)
  const saved = World.spawnCell
  if (at !== undefined) World.spawnCell = () => ({ cell: Hex.toCell(at), fallback: false })
  try {
    client.fire('start_requested', { id, name: id })
  } finally {
    World.spawnCell = saved
  }
  const player = World.PLAYERS[World.PLAYERS.length - 1]
  assert.equal(player.playerId, id)
  return { ...client, player }
}

function connectionOf (multiplayer: Multiplayer, client: Client): Connection {
  const connection = ((multiplayer as any)._connections as Connection[]).find((c) => c.id === client.id)
  assert.ok(connection !== undefined)
  return connection
}

function gone (obj: GameObject): boolean {
  return obj.destroyed || (obj as { exited?: boolean }).exited === true
}

/** StoneWall stones: sent by range, not layer-wide (bandwidth review, 2026-09-27). */
function stones (): GameObject[] {
  return World.OBSTACLES.filter((o) => !Multiplayer.isTerrain(o))
}

function dynamics (): GameObject[] {
  return [...World.PLAYERS, ...World.MOBS, ...World.CONSUMABLES, ...World.ITEMS, ...World.PROJECTILES, ...stones()]
}

/**
 * A tick with no simulation: every object's `Multiplayer.update`, players
 * first as in `World.update`, then the flush. Whatever moved was moved before.
 */
function tick (multiplayer: Multiplayer, n: number): void {
  for (let i = World.PLAYERS.length - 1; i >= 0; i--) multiplayer.update(World.PLAYERS[i])
  for (const obj of [...World.MOBS, ...World.PROJECTILES, ...World.CONSUMABLES, ...World.ITEMS, ...stones()]) multiplayer.update(obj)
  multiplayer.flushAll(n, 250)
}

/**
 * After a full `tick`, exactly: the client holds its own player, all of its
 * layer's terrain, every live unit, pickup and projectile on its layer inside
 * the interest box, and nothing on another layer or beyond the exit margin.
 * The server's `known` agrees with what the client holds.
 */
function assertHolds (multiplayer: Multiplayer, client: Client, label: string): void {
  const player = client.player
  if (gone(player)) return
  const tag = player.tag
  const terrain = new Set(World.OBSTACLES.filter((o) => o.tag === tag && !o.destroyed && Multiplayer.isTerrain(o)).map((o) => o.id))
  const live = dynamics().filter((o) => !gone(o) && o.tag === tag)
  const inner = live.filter((o) => player.position.withinBounds(o.position.x, o.position.y, R)).map((o) => o.id)
  const outer = new Set(live.filter((o) => player.position.withinBounds(o.position.x, o.position.y, OUTER)).map((o) => o.id))
  const held = client.mirror.held
  for (const id of terrain) assert.ok(held.has(id), `${label}: ${client.id} lacks terrain ${id}`)
  for (const id of inner) assert.ok(held.has(id), `${label}: ${client.id} lacks ${id}, in range`)
  assert.ok(held.has(player.id), `${label}: ${client.id} lost its own player`)
  for (const id of held) {
    assert.ok(terrain.has(id) || outer.has(id), `${label}: ${client.id} holds ${id}, which it cannot see`)
  }
  const connection = connectionOf(multiplayer, client)
  assert.equal(connection.layer, tag, `${label}: ${client.id}'s client is on the wrong layer`)
  const known = [...connection.known].map((o) => o.id).sort((a, b) => a - b)
  const dynamicHeld = [...held].filter((id) => !terrain.has(id)).sort((a, b) => a - b)
  assert.deepEqual(known, dynamicHeld, `${label}: ${client.id}'s known set is not what its client holds`)
  for (const obj of connection.known) assert.ok(obj.knownBy.has(connection), `${label}: known without knownBy`)
}

function assertClean (clients: Client[], label: string): void {
  for (const client of clients) assert.deepEqual(client.mirror.problems, [], `${label}: ${client.id}`)
}

function idleMob (x: number, y: number, tag: number): Mob {
  const mob = new Mob(x, y, tag, ARCHETYPES.grunt)
  mob.routines = []
  World.addUnit(World.MOBS, mob)
  return mob
}

function loot (x: number, y: number, tag: number): Consumable {
  const pickup = new Consumable(x, y, tag, undefined, 5)
  World.PICKUPS.push(World.CONSUMABLES, pickup)
  return pickup
}

function rock (x: number, y: number, tag: number): Obstacle {
  const obstacle = new Obstacle(x, y, tag)
  World.addObstacle(obstacle)
  return obstacle
}

// --- the model: many random ticks, checked exactly after every one ------------

test('over thousands of random changes every client holds exactly what it can see, and never gets a record it cannot apply', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const random = lcg(20260926)
  const tags = [TOP, MIDDLE, BOTTOM]
  const spot = (): Vector => new Vector(200 + random() * 2200, 200 + random() * 2200)
  const layer = (): number => tags[Math.floor(random() * tags.length)]

  for (let i = 0; i < 12; i++) {
    const at = spot()
    rock(at.x, at.y, layer())
  }
  const clients: Client[] = []
  for (let i = 0; i < 10; i++) clients.push(join(multiplayer, `c${i.toString(16).padStart(5, '0')}`, spot()))
  for (let i = 0; i < 20; i++) { const at = spot(); idleMob(at.x, at.y, layer()) }
  for (let i = 0; i < 25; i++) { const at = spot(); loot(at.x, at.y, layer()) }
  for (let i = 0; i < 5; i++) {
    const at = spot()
    World.PICKUPS.push(World.ITEMS, new ItemPickup(at.x, at.y, layer(), ITEMS.medkit))
  }
  tick(multiplayer, 0)

  let entries = 0
  let exits = 0
  let hops = 0
  for (let n = 1; n <= 400; n++) {
    for (const client of clients) client.mirror.clear()

    // The sweep: the dead leave the lists a tick after they died.
    for (let i = World.MOBS.length - 1; i >= 0; i--) if (World.MOBS[i].destroyed) World.removeUnitAt(World.MOBS, i)

    for (const obj of [...World.PLAYERS, ...World.MOBS]) {
      const roll = random()
      if (roll < 0.35) obj.position = obj.position.add(new Vector((random() - 0.5) * 160, (random() - 0.5) * 160))
      else if (roll < 0.40) obj.position = spot() // a jump into or out of someone's range
      else if (roll < 0.45) obj.hp = Math.max(1, obj.hp - 1)
      else if (roll < 0.47 && (obj as Player).playerId !== undefined) {
        (obj as Player).changeLayer(tags[(tags.indexOf(obj.tag) + 1 + Math.floor(random() * 2)) % 3])
        hops++
      }
    }
    if (random() < 0.08 && World.PLAYERS.length > 0) {
      // A group through portals together: everyone near one player, to one layer.
      const lead = World.PLAYERS[Math.floor(random() * World.PLAYERS.length)]
      const to = tags[(tags.indexOf(lead.tag) + 1 + Math.floor(random() * 2)) % 3]
      for (const player of World.PLAYERS) {
        if (player.tag === lead.tag && player.position.withinBounds(lead.position.x, lead.position.y, R)) {
          player.changeLayer(to)
          hops++
        }
      }
    }
    // Keep everyone on the map, as the tick does.
    for (const obj of [...World.PLAYERS, ...World.MOBS]) {
      const x = Math.min(4000, Math.max(0, obj.position.x))
      const y = Math.min(4000, Math.max(0, obj.position.y))
      if (x !== obj.position.x || y !== obj.position.y) obj.position = new Vector(x, y)
    }

    const roll = random()
    if (roll < 0.10) {
      // A mob dies this tick; it stays in MOBS until the next sweep.
      const live = World.MOBS.filter((m) => !m.destroyed)
      if (live.length > 0) live[Math.floor(random() * live.length)].hit(9999)
    } else if (roll < 0.20) {
      const at = spot()
      idleMob(at.x, at.y, layer())
    } else if (roll < 0.30 && World.CONSUMABLES.length > 0) {
      const pickup = World.CONSUMABLES[Math.floor(random() * World.CONSUMABLES.length)]
      pickup.destroy()
      World.PICKUPS.remove(World.CONSUMABLES, pickup)
    } else if (roll < 0.40) {
      const at = spot()
      loot(at.x, at.y, layer())
    } else if (roll < 0.45) {
      const at = spot()
      rock(at.x, at.y, layer())
    } else if (roll < 0.50) {
      const rocks = World.OBSTACLES.filter((o) => o instanceof Obstacle)
      if (rocks.length > 0) {
        const gone = rocks[Math.floor(random() * rocks.length)]
        gone.destroy()
        World.removeObstacle(gone)
      }
    }

    tick(multiplayer, n)

    assertClean(clients, `tick ${n}`)
    for (const client of clients) {
      assertHolds(multiplayer, client, `tick ${n}`)
      entries += client.mirror.seen.create.length
      exits += client.mirror.seen.destroy.length
    }
  }

  // It exercised what it claims to.
  assert.ok(entries > 300, `only ${entries} creates`)
  assert.ok(exits > 300, `only ${exits} destroys`)
  assert.ok(hops > 20, `only ${hops} layer changes`)
})

// --- coming into range and going out of it ---------------------------------------

test('walking up to a pickup and an idle mob that never change creates both; walking away destroys them; coming back creates them again', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const walker = join(multiplayer, 'a00001', new Vector(1000, 2000))
  const pickup = loot(2400, 2000, TOP)
  const mob = idleMob(2400, 2045, TOP)
  const far = rock(3800, 3800, TOP) // terrain: held at any distance
  tick(multiplayer, 0)
  mob.dirtyFields.clear()
  const held = (): boolean[] => [walker.mirror.held.has(pickup.id), walker.mirror.held.has(mob.id)]
  assert.deepEqual(held(), [false, false], 'held before in range')
  assert.ok(walker.mirror.held.has(far.id), 'far terrain not in the join snapshot')

  // Walk east one cell a tick. Neither object ever changes.
  const x = (): number => walker.player.position.x
  let createdAt: number | undefined
  for (let n = 1; x() < 2300; n++) {
    walker.player.position = new Vector(x() + 45, 2000)
    tick(multiplayer, n)
    const gap = 2400 - x()
    if (gap < R && createdAt === undefined) createdAt = gap
    assert.deepEqual(held(), gap < R ? [true, true] : [false, false], `at ${gap} units`)
  }
  assert.ok(createdAt !== undefined)
  assert.equal(pickup.dirtyFields.size + mob.dirtyFields.size, 0, 'they changed, so this proved nothing')

  // Walk back west: held through the margin, destroyed beyond it.
  for (let n = 100; x() > 1000; n++) {
    walker.player.position = new Vector(x() - 45, 2000)
    tick(multiplayer, n)
    const gap = 2400 - x()
    assert.deepEqual(held(), gap < OUTER ? [true, true] : [false, false], `back at ${gap} units`)
  }

  // And in again.
  for (let n = 200; x() < 2000; n++) {
    walker.player.position = new Vector(x() + 45, 2000)
    tick(multiplayer, n)
  }
  assert.deepEqual(held(), [true, true], 'not re-created on the way back')
  assert.ok(walker.mirror.held.has(far.id))
  assertClean([walker], 'walk')
})

test('a mob walking into a standing player\'s range is created, and destroyed once it is past the margin', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const viewer = join(multiplayer, 'a00002', new Vector(2000, 2000))
  const mob = idleMob(1000, 2000, TOP)
  tick(multiplayer, 0)
  assert.equal(viewer.mirror.held.has(mob.id), false)
  const gap = (): number => viewer.player.position.x - mob.position.x
  for (let n = 1; mob.position.x < 1600; n++) {
    mob.position = new Vector(mob.position.x + 45, 2000)
    tick(multiplayer, n)
    assert.equal(viewer.mirror.held.has(mob.id), gap() < R, `at ${gap()}`)
  }
  for (let n = 100; mob.position.x > 1000; n++) {
    mob.position = new Vector(mob.position.x - 45, 2000)
    tick(multiplayer, n)
    assert.equal(viewer.mirror.held.has(mob.id), gap() < OUTER, `back at ${gap()}`)
  }
  assertClean([viewer], 'mob walk')
})

test('no client is sent an update for an object it does not hold', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const near = join(multiplayer, 'a00003', new Vector(1000, 1000))
  const far = join(multiplayer, 'a00004', new Vector(3000, 3000))
  const mob = idleMob(1100, 1000, TOP)
  tick(multiplayer, 0)
  for (const client of [near, far]) client.mirror.clear()
  mob.hp = mob.hp - 1
  mob.position = new Vector(1110, 1000)
  tick(multiplayer, 1)
  assert.deepEqual(near.mirror.seen.update.filter((id) => id === mob.id), [mob.id])
  assert.deepEqual(far.mirror.seen.update.filter((id) => id === mob.id), [])
  assert.equal(mob.knownBy.size, 1)
  assertClean([near, far], 'updates')
})

// --- destroys ------------------------------------------------------------------------

test('a destroy goes to exactly the clients that hold the object, including for a unit killed this tick', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const a = join(multiplayer, 'a00005', new Vector(1000, 1000))
  const b = join(multiplayer, 'a00006', new Vector(1200, 1000))
  const c = join(multiplayer, 'a00007', new Vector(3000, 3000)) // out of range
  const d = join(multiplayer, 'a00008', new Vector(1100, 1000)) // in range, another layer
  d.player.changeLayer(MIDDLE)
  const mob = idleMob(1100, 1000, TOP)
  tick(multiplayer, 0)
  const clients = [a, b, c, d]
  for (const client of clients) client.mirror.clear()

  // Killed mid-tick: its own update afterwards sends nothing, and it is still
  // in MOBS until the next sweep.
  assert.equal(mob.hit(9999), true)
  tick(multiplayer, 1)

  const destroyed = clients.map((client) => client.mirror.seen.destroy.includes(mob.id))
  assert.deepEqual(destroyed, [true, true, false, false])
  assert.deepEqual(clients.map((client) => client.mirror.seen.create.includes(mob.id)), [false, false, false, false],
    'a dead unit was created again')
  assert.equal(mob.knownBy.size, 0)
  assertClean(clients, 'kill')
})

test('a player who dies is told, and its connection holds nothing afterwards', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const a = join(multiplayer, 'a00009', new Vector(1000, 1000))
  const b = join(multiplayer, 'a0000a', new Vector(1100, 1000))
  const mob = idleMob(1050, 1000, TOP)
  tick(multiplayer, 0)
  for (const client of [a, b]) client.mirror.clear()

  a.player.hit(9999)
  tick(multiplayer, 1)
  assert.ok(a.mirror.seen.destroy.includes(a.player.id), 'not told of its own death')
  assert.ok(b.mirror.seen.destroy.includes(a.player.id))
  const connection = connectionOf(multiplayer, a)
  assert.equal(connection.known.size, 0)
  assert.equal(connection.layer, undefined)
  assert.equal(mob.knownBy.has(connection), false)
  assert.equal(b.player.knownBy.has(connection), false)

  a.mirror.clear()
  mob.position = new Vector(1060, 1000)
  tick(multiplayer, 2)
  assert.deepEqual(a.mirror.seen, { create: [], create_own: [], destroy: [], update: [], effect: [] }, 'sent something after its death')
  assertClean([b], 'death')
})

// --- the join snapshot -------------------------------------------------------------

test('the join snapshot is the whole of the layer\'s terrain and only what is in range on it', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = new Vector(2000, 2000)
  const nearRock = rock(2090, 2000, TOP)
  const farRock = rock(3800, 200, TOP)
  const belowRock = rock(2090, 2000, MIDDLE)
  const nearMob = idleMob(2200, 2000, TOP)
  const farMob = idleMob(2600, 2000, TOP)
  const belowMob = idleMob(2200, 2000, MIDDLE)
  const nearLoot = loot(1800, 2100, TOP)
  const farLoot = loot(2000, 1400, TOP)
  const other = join(multiplayer, 'a0000b', new Vector(2300, 2000))
  const distant = join(multiplayer, 'a0000c', new Vector(200, 200))
  other.mirror.clear()

  const joiner = join(multiplayer, 'a0000d', at)
  const created = new Set(joiner.mirror.seen.create)
  for (const obj of [nearRock, farRock, nearMob, nearLoot, other.player]) assert.ok(created.has(obj.id), `missing ${obj.constructor.name} ${obj.id}`)
  for (const obj of [belowRock, farMob, belowMob, farLoot, distant.player]) assert.ok(!created.has(obj.id), `sent ${obj.constructor.name} ${obj.id}`)
  assert.deepEqual(joiner.mirror.seen.create_own, [joiner.player.id])
  assert.ok(!created.has(joiner.player.id), 'its own player went out as a plain create too')
  // The one already there was sent the newcomer, the distant one was not.
  // Their buffers go out with the next tick's flush; the joiner's own went
  // out with the join.
  multiplayer.flushAll(1, 250)
  assert.ok(other.mirror.seen.create.includes(joiner.player.id))
  assert.ok(!distant.mirror.seen.create.includes(joiner.player.id))
  assertClean([joiner, other, distant], 'join')
})

// --- layer changes ---------------------------------------------------------------------

test('a layer change swaps the client over in the flush that carries its new tag, and never touches its own object', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = new Vector(2000, 2000)
  const hopper = join(multiplayer, 'a0000e', at)
  const topRock = rock(3000, 3000, TOP)
  const middleRock = rock(500, 500, MIDDLE)
  const topMob = idleMob(2100, 2000, TOP)
  const middleMob = idleMob(2100, 2045, MIDDLE)
  const middleFar = idleMob(3000, 2000, MIDDLE)
  const neighbour = join(multiplayer, 'a0000f', new Vector(2200, 2000)) // stays on 01
  const below = join(multiplayer, 'a00010', new Vector(1900, 2000))
  below.player.changeLayer(MIDDLE)
  tick(multiplayer, 0)
  const clients = [hopper, neighbour, below]
  assert.ok(hopper.mirror.held.has(topMob.id) && hopper.mirror.held.has(topRock.id))
  for (const client of clients) client.mirror.clear()

  hopper.player.changeLayer(MIDDLE)
  tick(multiplayer, 1)

  const seen = hopper.mirror.seen
  for (const obj of [topRock, topMob, neighbour.player]) assert.ok(seen.destroy.includes(obj.id), `01's ${obj.id} not destroyed`)
  for (const obj of [middleRock, middleMob, below.player]) assert.ok(seen.create.includes(obj.id), `02's ${obj.id} not created`)
  assert.ok(!seen.create.includes(middleFar.id), 'an out-of-range mob on 02 was created')
  assert.ok(!seen.destroy.includes(hopper.player.id) && !seen.create.includes(hopper.player.id), 'its own object was touched')
  assert.ok(seen.update.includes(hopper.player.id), 'the new tag did not go out in the same flush')
  // Those left behind drop it, those it arrived among get it.
  assert.ok(neighbour.mirror.seen.destroy.includes(hopper.player.id))
  assert.ok(below.mirror.seen.create.includes(hopper.player.id))
  assertClean(clients, 'hop')
  for (const client of clients) assertHolds(multiplayer, client, 'after the hop')
})

test('two players who change layer together keep each other, with no destroy and create in one flush', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const a = join(multiplayer, 'a00011', new Vector(2000, 2000))
  const b = join(multiplayer, 'a00012', new Vector(2045, 2000))
  tick(multiplayer, 0)
  for (const client of [a, b]) client.mirror.clear()
  a.player.changeLayer(BOTTOM)
  b.player.changeLayer(BOTTOM)
  tick(multiplayer, 1)
  for (const [viewer, other] of [[a, b], [b, a]]) {
    assert.ok(viewer.mirror.held.has(other.player.id))
    assert.ok(!viewer.mirror.seen.destroy.includes(other.player.id), 'destroyed a co-hopper')
    // Whichever switched second missed the other's tag change while its own
    // switch was pending; the switch re-sends what it keeps whole.
    assert.ok(viewer.mirror.seen.update.includes(other.player.id), 'the co-hopper\'s new tag never arrived')
  }
  assertClean([a, b], 'co-hop')
})

test('a layer change and back re-creates the first layer\'s terrain, once each way', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const hopper = join(multiplayer, 'a00013', new Vector(2000, 2000))
  const topRock = rock(3000, 3000, TOP)
  tick(multiplayer, 0)
  hopper.player.changeLayer(MIDDLE)
  tick(multiplayer, 1)
  assert.ok(!hopper.mirror.held.has(topRock.id))
  hopper.player.changeLayer(TOP)
  tick(multiplayer, 2)
  assert.ok(hopper.mirror.held.has(topRock.id))
  assertClean([hopper], 'there and back')
})

test('terrain made or removed while a client is on its layer reaches it wherever it is; on another layer it does not', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const top = join(multiplayer, 'a00014', new Vector(200, 200))
  const middle = join(multiplayer, 'a00015', new Vector(200, 200))
  middle.player.changeLayer(MIDDLE)
  tick(multiplayer, 0)
  for (const client of [top, middle]) client.mirror.clear()
  // An untimed obstacle is terrain (a world rock, before the valleys).
  const far = rock(3800, 3800, TOP)
  tick(multiplayer, 1)
  assert.ok(top.mirror.seen.create.includes(far.id))
  assert.ok(!middle.mirror.seen.create.includes(far.id))
  far.destroy()
  World.removeObstacle(far)
  tick(multiplayer, 2)
  assert.ok(top.mirror.seen.destroy.includes(far.id))
  assert.ok(!middle.mirror.seen.destroy.includes(far.id))
  assertClean([top, middle], 'terrain')
})

test('a StoneWall stone reaches only the clients with it in range, and leaves them when they walk off', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const near = join(multiplayer, 'a00031', new Vector(2000, 2000))
  const far = join(multiplayer, 'a00032', new Vector(200, 200))
  tick(multiplayer, 0)
  for (const client of [near, far]) client.mirror.clear()

  const stone = new Obstacle(2100, 2000, TOP, 4000)
  World.addObstacle(stone)
  tick(multiplayer, 1)
  assert.ok(near.mirror.seen.create.includes(stone.id), 'in range: created')
  assert.ok(!far.mirror.seen.create.includes(stone.id), 'out of range: not sent')
  assert.ok(!Multiplayer.isTerrain(stone))

  // The far player walks up to it: sent when it comes into view.
  far.player.position = new Vector(2050, 2050)
  tick(multiplayer, 2)
  assert.ok(far.mirror.held.has(stone.id), 'walked into range: created')
  // The near one walks away past the exit margin: destroyed on its client only.
  near.player.position = new Vector(200, 200)
  tick(multiplayer, 3)
  assert.ok(!near.mirror.held.has(stone.id), 'walked out of range: destroyed')
  assert.ok(stone.knownBy.size === 1)

  stone.destroy()
  World.removeObstacle(stone)
  tick(multiplayer, 4)
  assert.ok(far.mirror.seen.destroy.includes(stone.id), 'its holder hears it go')
  for (const client of [near, far]) assertHolds(multiplayer, client, 'stone')
  assertClean([near, far], 'stone')
})

// --- effects -----------------------------------------------------------------------------

test('an effect reaches exactly the players on its originator\'s layer inside the box around it', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const random = lcg(7)
  const clients: Client[] = []
  for (let i = 0; i < 16; i++) clients.push(join(multiplayer, `e${i.toString(16).padStart(5, '0')}`, new Vector(random() * 2000, random() * 2000)))
  for (const client of clients) if (random() < 0.3) client.player.changeLayer(MIDDLE)
  tick(multiplayer, 0)

  for (const origin of clients) {
    for (const client of clients) client.mirror.clear()
    multiplayer.effect(3, origin.player, 500)
    multiplayer.flushAll(1, 250)
    for (const client of clients) {
      const got = client.mirror.seen.effect.filter((id) => id === origin.player.id).length
      const want = client.player.tag === origin.player.tag &&
        client.player.position.withinBounds(origin.player.position.x, origin.player.position.y, R) ? 1 : 0
      assert.equal(got, want, `effect of ${origin.id} to ${client.id}`)
    }
  }
})

// --- a real world ------------------------------------------------------------------------

test('a real world with walking players and portals never sends a client a record it cannot apply', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  const random = lcg(99)
  const clients: Client[] = []
  for (let i = 0; i < 8; i++) clients.push(join(multiplayer, `f${i.toString(16).padStart(5, '0')}`))
  let hops = 0
  for (let n = 1; n <= 400; n++) {
    t.mock.timers.tick(250)
    const tags = clients.map((c) => c.player.tag)
    world.update(0.25)
    multiplayer.flushAll(n, 250)
    clients.forEach((c, i) => { if (c.player.tag !== tags[i]) hops++ })
    for (const client of clients) {
      if (gone(client.player)) continue
      if (n % 6 === 0 || client.player.path.length === 0) {
        // Somewhere up to 8 cells off, often through a portal on a long run.
        const cell = client.player.cell
        client.player.setDestination(cell.x + Math.round((random() - 0.5) * 16), cell.y + Math.round((random() - 0.5) * 16))
      }
    }
    assertClean(clients, `tick ${n}`)
    for (const client of clients) {
      if (client.mirror.seen.destroy.includes(client.player.id)) assert.ok(gone(client.player), `tick ${n}: ${client.id}'s own object destroyed while it lives`)
    }
  }
  assert.ok(clients.some((c) => c.mirror.seen.create.length > 0))
  t.diagnostic(`${hops} layer changes`)
})

test('the world\'s own tick tells a player who comes up to a pickup that it is there', (t: TestContext) => {
  // The pass at the end of `World.update`: a pickup has no update of its own.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  const client = join(multiplayer, 'a00016', new Vector(500, 500))
  // Three cells from where the player will stand, so neither is picked up.
  const target = Hex.toPosition(Hex.toCell(new Vector(3000, 3000)))
  const pickup = loot(target.x + 3 * Hex.SIZE, target.y, TOP)
  const item = new ItemPickup(target.x, target.y + 3 * Hex.SIZE, TOP, ITEMS.bomb)
  World.PICKUPS.push(World.ITEMS, item)
  t.mock.timers.tick(250)
  world.update(0.25)
  multiplayer.flushAll(1, 250)
  assert.ok(!client.mirror.held.has(pickup.id) && !client.mirror.held.has(item.id))

  client.player.position = target
  t.mock.timers.tick(250)
  world.update(0.25)
  multiplayer.flushAll(2, 250)
  assert.ok(client.mirror.held.has(pickup.id), 'loot not created on coming into range')
  assert.ok(client.mirror.held.has(item.id), 'item not created on coming into range')
  assertClean([client], 'world pickups')
})
