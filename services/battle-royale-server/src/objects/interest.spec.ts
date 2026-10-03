import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import Mob from './mob'
import Consumable from './consumable'
import ItemPickup from './itempickup'
import Obstacle from './obstacle'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
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
 * - Units, pickups, projectiles and StoneWall stones go only to connections on
 *   their layer with them in sight (server fog, decision #48): within the
 *   viewpoint robot's `vision` + 1 rings, cell to cell, and are created there
 *   when they come into it, whichever of the two moved, even if they never
 *   change. A connection that holds one is sent a destroy once it is beyond
 *   `vision` + 2 rings, or off the layer. Peep: 7 and 8; Periscope: 13 and 14.
 * - Updates and destroys go to exactly the connections that hold the object.
 * - Effects drawn on their originator (types 0-4) go to exactly the
 *   connections that hold it; blasts and bombs (5-8), drawn on a cell, to the
 *   connections on its layer that see the cell: the 500 box around their
 *   viewpoint, or their leave radius where that reaches further (fog
 *   follow-ups, #48).
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
/** The effect box (effects kept it under #48). */
const R = Multiplayer.INTEREST_RADIUS

/**
 * The view, written out here rather than read from `Multiplayer`, so the spec
 * pins #48's policy: a viewer holds what is within `vision` + 1 rings of its
 * cell (enter) and keeps it to `vision` + 2 (leave). Literals on purpose: a
 * change to `VIEW_MARGIN_RINGS` or `VIEW_EXIT_RINGS` should fail here.
 */
const ENTER_MARGIN = 1
const EXIT_RINGS = 1

function ringsBetween (a: Vector, b: Vector): number {
  return Hex.distance(Hex.toCell(a), Hex.toCell(b))
}

function enterRings (viewer: Player): number {
  const vision = viewer.archetype.vision
  assert.ok(vision !== null, 'every robot has a vision')
  return vision + ENTER_MARGIN
}

function leaveRings (viewer: Player): number {
  return enterRings(viewer) + EXIT_RINGS
}

/** Enter radii read from the archetype table, so a vision change moves the tests with it. */
const PEEP_ENTER = (ARCHETYPES.peep.vision as number) + ENTER_MARGIN
const SCOPE_ENTER = (ARCHETYPES.periscope.vision as number) + ENTER_MARGIN

/** A cell's centre `dq`, `dr` from `from`'s cell. */
function offCell (from: Vector, dq: number, dr: number = 0): Vector {
  const cell = Hex.toCell(from)
  return Hex.toPosition(new Vector(cell.x + dq, cell.y + dr))
}

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
function ids (buffer: Buffer, skip = 0, lengths?: number[]): number[] {
  const out: number[] = []
  let at = skip
  while (at + 2 <= buffer.length) {
    const length = buffer.readUInt16BE(at)
    const record = buffer.subarray(at + 2, at + 2 + length)
    assert.equal(record[0], 0, 'a record that does not open with its id')
    out.push(record.readUInt16BE(1))
    lengths?.push(length)
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
  /** Each effect record's type, in step with `seen.effect` (its originator ids). */
  effectTypes: number[] = []
  /** Each destroy record's length in bytes, by id, since the last `clear`: 3 is `id` alone. */
  destroyBytes = new Map<number, number>()
  /** Destroyed since the last `update` event: an update for one of these is harmless (the client ignores it). */
  private goneThisFlush = new Set<number>()

  receive (event: string, data: unknown): void {
    if (event === 'hello' || event === 'standings') return
    const buffer = data as Buffer
    if (event === 'effect') {
      let at = 0
      while (at + 2 <= buffer.length) {
        const length = buffer.readUInt16BE(at)
        const type = buffer.readInt8(at + 2)
        const id = buffer.readUInt16BE(at + 3)
        this.seen.effect.push(id)
        this.effectTypes.push(type)
        // Types 0-4 are drawn on their originator (`Game.onEffect`): one the
        // client doesn't hold is a wasted record (fog follow-ups, #48).
        if (type <= 4 && !this.held.has(id)) this.problems.push(`effect ${type} for ${id}, not held`)
        at += 2 + length
      }
      return
    }
    const lengths: number[] = []
    const list = ids(buffer, event === 'update' ? 8 : 0, lengths)
    for (const [i, id] of list.entries()) {
      this.seen[event].push(id)
      if (event === 'destroy') this.destroyBytes.set(id, lengths[i])
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
    this.effectTypes = []
    this.destroyBytes.clear()
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

/**
 * Join as `robot` (Peep if not given), on `at`'s cell if given (else wherever
 * `spawnCell` picks), and flush the snapshot.
 */
function join (multiplayer: Multiplayer, id: string, at?: Vector, robot?: string): Client {
  const client = connect(multiplayer, id)
  const saved = World.spawnCell
  if (at !== undefined) World.spawnCell = () => ({ cell: Hex.toCell(at), fallback: false })
  try {
    client.fire('start_requested', { id, name: id, robot })
  } finally {
    World.spawnCell = saved
  }
  const player = World.PLAYERS[World.PLAYERS.length - 1]
  assert.equal(player.playerId, id)
  assert.equal(player.archetype.key, robot ?? 'peep')
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
 * layer's terrain, every live unit, pickup, projectile and stone on its layer
 * within its enter radius, and nothing on another layer or beyond its leave
 * radius. The server's `known` agrees with what the client holds.
 *
 * `from`, for a real world's tick: where the player stood when the tick
 * began. Within a tick an object's update can run before or after its
 * viewer's own move, so it is then judged from either: it must be held if it
 * is within the enter radius of both, and must not be if it is beyond the
 * leave radius of both. `hopped`: the players who came through a portal
 * this tick. A player hops after its own update (`Player.hopPortal`), so its
 * viewers are told at its next: either way is right for them here.
 */
function assertHolds (multiplayer: Multiplayer, client: Client, label: string, from?: Vector, hopped?: Set<number>): void {
  const player = client.player
  if (gone(player)) return
  const tag = player.tag
  const terrain = new Set(World.OBSTACLES.filter((o) => o.tag === tag && !o.destroyed && Multiplayer.isTerrain(o)).map((o) => o.id))
  const live = dynamics().filter((o) => !gone(o) && o.tag === tag && hopped?.has(o.id) !== true)
  const spots = from === undefined ? [player.position] : [player.position, from]
  const enter = enterRings(player)
  const leave = leaveRings(player)
  const inner = live.filter((o) => spots.every((at) => ringsBetween(at, o.position) <= enter)).map((o) => o.id)
  const outer = new Set(live.filter((o) => spots.some((at) => ringsBetween(at, o.position) <= leave)).map((o) => o.id))
  const held = client.mirror.held
  for (const id of terrain) assert.ok(held.has(id), `${label}: ${client.id} lacks terrain ${id}`)
  for (const id of inner) assert.ok(held.has(id), `${label}: ${client.id} lacks ${id}, in range`)
  assert.ok(held.has(player.id), `${label}: ${client.id} lost its own player`)
  for (const id of held) {
    if (terrain.has(id) || outer.has(id) || hopped?.has(id) === true) continue
    const info = dynamics().filter((o) => o.id === id)
      .map((o) => `${o.constructor.name} on ${o.tag} at ${spots.map((s) => ringsBetween(s, o.position)).join('/')} rings`).join('; ')
    assert.fail(`${label}: ${client.id} (${player.archetype.key} on ${tag}) holds ${id}, which it cannot see: ${info}`)
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
  // Peep and Periscope viewers mixed (vision 6 and 12).
  for (let i = 0; i < 10; i++) clients.push(join(multiplayer, `c${i.toString(16).padStart(5, '0')}`, spot(), i % 2 === 0 ? 'peep' : 'periscope'))
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

  // Walk east one cell a tick (the rings to each only ever fall). Neither
  // object ever changes.
  const x = (): number => walker.player.position.x
  const rings = (): number[] => [pickup, mob].map((o) => ringsBetween(walker.player.position, o.position))
  let created = 0
  for (let n = 1; x() < 2300; n++) {
    walker.player.position = new Vector(x() + 45, 2000)
    tick(multiplayer, n)
    const now = rings()
    if (now.some((r) => r === 7)) created++
    assert.deepEqual(held(), now.map((r) => r <= 7), `at ${now.join('/')} rings`)
  }
  assert.ok(created > 0, 'never stood 7 rings from either')
  assert.equal(pickup.dirtyFields.size + mob.dirtyFields.size, 0, 'they changed, so this proved nothing')

  // Walk back west (the rings only ever grow): held through the exit ring,
  // destroyed beyond it.
  for (let n = 100; x() > 1000; n++) {
    walker.player.position = new Vector(x() - 45, 2000)
    tick(multiplayer, n)
    const now = rings()
    assert.deepEqual(held(), now.map((r) => r <= 8), `back at ${now.join('/')} rings`)
  }

  // And in again, to 4 or 5 rings.
  for (let n = 200; x() < 2200; n++) {
    walker.player.position = new Vector(x() + 45, 2000)
    tick(multiplayer, n)
  }
  assert.deepEqual(held(), [true, true], 'not re-created on the way back')
  assert.ok(walker.mirror.held.has(far.id))
  assertClean([walker], 'walk')
})

test('a mob walking into a standing player\'s sight is created, and destroyed once it is past the exit ring', () => {
  for (const robot of ['peep', 'periscope']) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const multiplayer = new Multiplayer(250, okRedis())
    const viewer = join(multiplayer, 'a00002', new Vector(2000, 2000), robot)
    const enter = enterRings(viewer.player)
    const mob = idleMob(1000, 2000, TOP)
    tick(multiplayer, 0)
    assert.equal(viewer.mirror.held.has(mob.id), false)
    const rings = (): number => ringsBetween(viewer.player.position, mob.position)
    for (let n = 1; mob.position.x < 1900; n++) {
      mob.position = new Vector(mob.position.x + 45, 2000)
      tick(multiplayer, n)
      assert.equal(viewer.mirror.held.has(mob.id), rings() <= enter, `${robot} at ${rings()} rings`)
    }
    for (let n = 100; mob.position.x > 1000; n++) {
      mob.position = new Vector(mob.position.x - 45, 2000)
      tick(multiplayer, n)
      assert.equal(viewer.mirror.held.has(mob.id), rings() <= enter + 1, `${robot} back at ${rings()} rings`)
    }
    assertClean([viewer], `${robot} mob walk`)
  }
})

// --- server fog: the radii (#48) ---------------------------------------------------

test('a Peep holds a unit at ring 7 and is not sent one that appears at ring 8', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  const viewer = join(multiplayer, 'b00001', at)
  tick(multiplayer, 0)
  viewer.mirror.clear()
  // Made after the join, so each goes through `Multiplayer.create` first.
  const seven = idleMob(offCell(at, 7).x, offCell(at, 7).y, TOP)
  const eight = idleMob(offCell(at, -8).x, offCell(at, -8).y, TOP)
  const eightSw = idleMob(offCell(at, -4, 8).x, offCell(at, -4, 8).y, TOP)
  assert.equal(ringsBetween(at, eightSw.position), 8)
  tick(multiplayer, 1)
  assert.ok(viewer.mirror.held.has(seven.id), 'ring 7 not held')
  for (const mob of [eight, eightSw]) {
    assert.ok(!viewer.mirror.held.has(mob.id), 'ring 8 held')
    assert.ok(!viewer.mirror.seen.create.includes(mob.id), 'ring 8 was sent a create')
  }
  // Walking in from 9 to 8 creates nothing; at 7 it does.
  const walker = idleMob(offCell(at, 0, 9).x, offCell(at, 0, 9).y, TOP)
  for (const [n, ring] of [[2, 9], [3, 8], [4, 7]]) {
    walker.position = offCell(at, 0, ring)
    tick(multiplayer, n)
    assert.equal(viewer.mirror.held.has(walker.id), ring <= 7, `walker at ring ${ring}`)
  }
  assertClean([viewer], 'peep radii')
})

test('a unit a Peep holds stays held with its changes at ring 8, and is destroyed by id alone at ring 9', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  const viewer = join(multiplayer, 'b00002', at)
  const mob = idleMob(offCell(at, 7).x, offCell(at, 7).y, TOP)
  tick(multiplayer, 0)
  assert.ok(viewer.mirror.held.has(mob.id))

  viewer.mirror.clear()
  mob.position = offCell(at, 8)
  mob.hp = mob.hp - 1
  tick(multiplayer, 1)
  assert.ok(viewer.mirror.held.has(mob.id), 'dropped at ring 8')
  assert.ok(viewer.mirror.seen.update.includes(mob.id), 'no changes at ring 8')
  viewer.mirror.clear()
  mob.hp = mob.hp - 1
  tick(multiplayer, 2)
  assert.ok(viewer.mirror.seen.update.includes(mob.id), 'no changes while standing at ring 8')

  viewer.mirror.clear()
  mob.position = offCell(at, 9)
  tick(multiplayer, 3)
  assert.ok(!viewer.mirror.held.has(mob.id), 'still held at ring 9')
  assert.equal(viewer.mirror.destroyBytes.get(mob.id), 3, 'the destroy carried more than its id')
  assert.ok(!mob.knownBy.has(connectionOf(multiplayer, viewer)))
  assertClean([viewer], 'peep exit ring')
})

test('a Periscope is sent a unit on its enter ring due east, and not one a ring further', () => {
  // At vision 10 (2026-10-03) the enter ring is 11 rings, 495 units: inside
  // the old 500 box, so this pins the rings, and the bucket cover is the
  // random-position spec's job.
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(2, 40))
  const viewer = join(multiplayer, 'b00003', at, 'periscope')
  tick(multiplayer, 0)
  const edge = idleMob(offCell(at, SCOPE_ENTER).x, offCell(at, SCOPE_ENTER).y, TOP)
  const beyond = idleMob(offCell(at, SCOPE_ENTER + 1).x, offCell(at, SCOPE_ENTER + 1).y, TOP)
  assert.equal(edge.position.x - at.x, SCOPE_ENTER * Hex.SIZE)
  tick(multiplayer, 1)
  assert.ok(viewer.mirror.held.has(edge.id), `ring ${SCOPE_ENTER} not sent`)
  assert.ok(!viewer.mirror.held.has(beyond.id), `ring ${SCOPE_ENTER + 1} sent`)
  // And the same from the other side: the viewer walks into range of a standing one.
  const later = idleMob(offCell(at, SCOPE_ENTER + 8).x, offCell(at, SCOPE_ENTER + 8).y, TOP)
  tick(multiplayer, 2)
  assert.ok(!viewer.mirror.held.has(later.id))
  viewer.player.position = offCell(at, 8)
  tick(multiplayer, 3)
  assert.ok(viewer.mirror.held.has(later.id), `walked to ${SCOPE_ENTER} rings: not sent`)
  assertClean([viewer], 'periscope radii')
})

test('a spectator sees by the watched player\'s vision, not its own dead robot\'s', () => {
  for (const [dead, watched] of [['periscope', 'peep'], ['peep', 'periscope']]) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    const multiplayer = new Multiplayer(250, okRedis())
    const at = Hex.toPosition(new Vector(30, 40))
    const a = join(multiplayer, 'b00004', at, dead)
    const b = join(multiplayer, 'b00005', offCell(at, 0, 1), watched)
    const from = b.player.position
    // Rings from the watched player, east (away from the dead one's cell too).
    const mobs = [PEEP_ENTER, PEEP_ENTER + 1, SCOPE_ENTER - 1, SCOPE_ENTER, SCOPE_ENTER + 1].map((ring) => idleMob(offCell(from, ring).x, offCell(from, ring).y, TOP))
    tick(multiplayer, 0)
    a.player.hit(9999)
    // The flush that sends its death re-centres it (`watch`); what that
    // changes goes out with the next.
    tick(multiplayer, 1)
    tick(multiplayer, 2)
    const connection = connectionOf(multiplayer, a)
    assert.equal(connection.spectating, b.player, 'not watching')
    // Held within the watched player's enter radius, never beyond its leave
    // radius; in between it depends on what the dead one held before.
    const check = (label: string): void => {
      const enter = enterRings(b.player)
      for (const mob of mobs) {
        const ring = ringsBetween(b.player.position, mob.position)
        if (ring <= enter) assert.ok(a.mirror.held.has(mob.id), `${dead} watching ${watched} ${label}: ring ${ring} not held`)
        if (ring > enter + 1) assert.ok(!a.mirror.held.has(mob.id), `${dead} watching ${watched} ${label}: ring ${ring} held`)
        assert.equal(a.mirror.held.has(mob.id), mob.knownBy.has(connection), `${label}: known disagrees with the client`)
      }
    }
    check('on death')
    // And it follows as the watched player walks.
    b.player.position = offCell(from, 4)
    tick(multiplayer, 3)
    check('after a walk')
    assertClean([a, b], `${dead} watching ${watched}`)
  }
})

test('a unit that leaves a view and comes back into it within one flush is kept, never destroyed and created together', () => {
  // A dead Periscope re-centred on a Peep (`watch`, at the flush that sends
  // its death) is queued a destroy for what the Peep can't see; if one of
  // those walks back into the Peep's sight before the next flush, a create
  // in the same flush would be applied first, for an id the client still
  // holds (found by the real-world test, about 1 suite run in 10).
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  const a = join(multiplayer, 'b0000a', at, 'periscope')
  const b = join(multiplayer, 'b0000b', offCell(at, 0, 1), 'peep')
  const from = b.player.position
  const mob = idleMob(offCell(from, 10).x, offCell(from, 10).y, TOP)
  tick(multiplayer, 0)
  assert.ok(a.mirror.held.has(mob.id) && !b.mirror.held.has(mob.id))
  a.player.hit(9999)
  tick(multiplayer, 1) // sends the death, then re-centres on b: the mob's destroy waits for the next flush
  a.mirror.clear()
  mob.position = offCell(from, 7)
  tick(multiplayer, 2)
  assertClean([a, b], 'back within one flush')
  assert.ok(a.mirror.held.has(mob.id), 'lost')
  assert.ok(!a.mirror.seen.destroy.includes(mob.id) && !a.mirror.seen.create.includes(mob.id), 'destroyed and re-created')
  assert.ok(a.mirror.seen.update.includes(mob.id), 'not re-sent whole')
  assert.ok(mob.knownBy.has(connectionOf(multiplayer, a)))
})

test('a pickup and a StoneWall stone come into and go out of sight by the same radii through the world\'s own tick', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const multiplayer = new Multiplayer(250, okRedis())
  // A wide map, so this runs far east (x 6480-7020), where a pass keyed on
  // the old 500-unit buckets (pickup at 500-bucket 14) and the moves keyed on
  // the `INTEREST_BUCKET` ones (585 at Periscope's 10: the player in bucket
  // 9, watching 7-11) part company.
  const world = new World(8000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  const start = Hex.toPosition(new Vector(124, 40))
  assert.equal(start.x, 6480)
  const client = join(multiplayer, 'b00006', start)
  // Out of reach of anything the refill brings: it is only walked by hand.
  client.player.hp = 60000
  const pickup = loot(offCell(start, 12).x, offCell(start, 12).y, TOP)
  const stone = new Obstacle(offCell(start, 12, -1).x, offCell(start, 12, -1).y, TOP, 600_000)
  World.addObstacle(stone)
  const objects = [pickup, stone]
  const step = (n: number, cell: Vector): void => {
    client.player.position = Hex.toPosition(cell)
    t.mock.timers.tick(250)
    world.update(0.25)
    multiplayer.flushAll(n, 250)
  }
  const home = Hex.toCell(start)
  // In, one cell a tick: created at 7 rings, not before.
  let n = 1
  for (let dq = 0; dq <= 5; dq++, n++) {
    step(n, new Vector(home.x + dq, home.y))
    for (const obj of objects) {
      const ring = ringsBetween(client.player.position, obj.position)
      assert.equal(client.mirror.held.has(obj.id), ring <= 7, `${obj.constructor.name} in at ring ${ring}`)
    }
  }
  // Out: kept to 8, gone at 9.
  for (let dq = 5; dq >= 0; dq--, n++) {
    step(n, new Vector(home.x + dq, home.y))
    for (const obj of objects) {
      const ring = ringsBetween(client.player.position, obj.position)
      assert.equal(client.mirror.held.has(obj.id), ring <= 8, `${obj.constructor.name} out at ring ${ring}`)
    }
  }
  assert.ok(!client.mirror.held.has(pickup.id) && !client.mirror.held.has(stone.id), 'never left')
  assertClean([client], 'world pickups and stones')
})

test('a layer change keeps exactly what is within the leave radius on the new layer', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  const hopper = join(multiplayer, 'b00007', at)
  const seven = join(multiplayer, 'b00008', offCell(at, 7))
  const eight = join(multiplayer, 'b00009', offCell(at, 7, -1))
  tick(multiplayer, 0)
  assert.ok(hopper.mirror.held.has(seven.player.id) && hopper.mirror.held.has(eight.player.id))
  // One steps out to ring 8: still held.
  eight.player.position = offCell(at, 8, -1)
  assert.equal(ringsBetween(at, eight.player.position), 8)
  tick(multiplayer, 1)
  assert.ok(hopper.mirror.held.has(eight.player.id))
  // On the layer below: one waiting at ring 8 (not held), one at ring 7.
  const below8 = idleMob(offCell(at, -8).x, offCell(at, -8).y, MIDDLE)
  const below7 = idleMob(offCell(at, -7).x, offCell(at, -7).y, MIDDLE)
  tick(multiplayer, 2)
  const clients = [hopper, seven, eight]
  for (const client of clients) client.mirror.clear()

  for (const client of clients) client.player.changeLayer(MIDDLE)
  tick(multiplayer, 3)
  const seen = hopper.mirror.seen
  for (const kept of [seven, eight]) {
    assert.ok(hopper.mirror.held.has(kept.player.id), `ring ${ringsBetween(at, kept.player.position)} not kept`)
    assert.ok(!seen.destroy.includes(kept.player.id) && !seen.create.includes(kept.player.id), 'kept, but destroyed or re-created')
    assert.ok(seen.update.includes(kept.player.id), 'kept, but not re-sent whole')
  }
  assert.ok(hopper.mirror.held.has(below7.id), 'ring 7 below not created')
  assert.ok(!hopper.mirror.held.has(below8.id), 'ring 8 below created on arrival')
  assertClean(clients, 'layer change')
  for (const client of clients) assertHolds(multiplayer, client, 'after the layer change')
})

test('the interest buckets hold every viewer whose sight reaches an object, from random off-centre positions', () => {
  World.mapSize = 8000
  const random = lcg(48)
  const bucket = World.INTEREST_BUCKET
  let maxVision = 0
  for (const archetype of Object.values(ARCHETYPES)) if (archetype.vision !== null) maxVision = Math.max(maxVision, archetype.vision)
  assert.equal(bucket, Math.max(R, (maxVision + 3) * Hex.SIZE), 'the bucket is not derived from the largest vision')
  assert.equal(bucket, ((ARCHETYPES.periscope.vision as number) + 3) * Hex.SIZE, 'Periscope sees furthest: the bucket should be its reach')

  // A point somewhere inside `cell` (rejection-sampled on toCell).
  const inside = (cell: Vector): Vector => {
    const centre = Hex.toPosition(cell)
    for (;;) {
      const p = new Vector(centre.x + (random() - 0.5) * 52, centre.y + (random() - 0.5) * 52)
      const c = Hex.toCell(p)
      if (c.x === cell.x && c.y === cell.y) return p
    }
  }
  new Multiplayer(250, okRedis()) // eslint-disable-line no-new
  // One viewer per robot, moved about (the position setter refiles it).
  const viewers = (['peep', 'periscope', 'magnet', 'hopper', 'waddle'] as const).map((key, i) => {
    const player = new Player(100, 100, TOP, `abcdef0${i}`, ARCHETYPES[key])
    World.addUnit(World.PLAYERS, player)
    return player
  })
  let reachX = 0
  let reachY = 0
  let checked = 0
  for (let i = 0; i < 4000; i++) {
    const player = viewers[i % viewers.length]
    const archetype = player.archetype
    const viewerCell = new Vector(40 + Math.floor(random() * 60), 20 + Math.floor(random() * 120))
    player.position = inside(viewerCell)
    const leave = (archetype.vision as number) + ENTER_MARGIN + EXIT_RINGS
    for (let k = 0; k < 10; k++) {
      // A cell up to a ring past the leave radius, and a point anywhere in it.
      const dq = Math.floor(random() * (2 * leave + 3)) - leave - 1
      const dr = Math.floor(random() * (2 * leave + 3)) - leave - 1
      const obj = inside(new Vector(viewerCell.x + dq, viewerCell.y + dr))
      const ring = ringsBetween(player.position, obj)
      const view = Multiplayer.viewOf(player, obj.x, obj.y, Hex.toCell(obj))
      const want = ring <= leave - EXIT_RINGS ? Multiplayer.VIEW_IN : ring <= leave ? Multiplayer.VIEW_EDGE : Multiplayer.VIEW_OUT
      assert.equal(view, want, `viewOf disagrees at ${ring} rings for ${archetype.key}`)
      if (ring > leave) continue
      checked++
      reachX = Math.max(reachX, Math.abs(obj.x - player.position.x))
      reachY = Math.max(reachY, Math.abs(obj.y - player.position.y))
      assert.ok(World.interestCandidates(obj.x, obj.y, TOP).includes(player),
        `${archetype.key} at (${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}) sees (${obj.x.toFixed(1)}, ${obj.y.toFixed(1)}) at ${ring} rings and is not a candidate`)
    }
  }
  assert.ok(checked > 10000, `only ${checked} pairs in sight`)
  // The longest reach on either axis fits one bucket, and with a tick's
  // longest move (a dash: 140 u/s x 2.5 x 0.25 s, under 100) inside the
  // pickup pass's watch (`World.PICKUP_WATCH_BUCKETS` buckets).
  const longest = Math.max(reachX, reachY)
  assert.ok(longest <= bucket, `a view reaches ${longest} units, past the ${bucket} bucket`)
  assert.ok((maxVision + 3) * Hex.SIZE + 100 < World.PICKUP_WATCH_BUCKETS * bucket, 'the pickup pass watches too few buckets')
  assert.ok(longest > bucket - Hex.SIZE, `only reached ${longest}: Periscope's far cells were never sampled`)
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

test('a player who dies is told, then sees through the nearest live player (spectate, #47)', () => {
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
  assert.equal(connection.spectating, b.player, 'watches the nearest live player')
  assert.equal(connection.player, undefined)
  assert.ok(!connection.known.has(a.player), 'lets go of its own corpse')
  assert.ok(connection.known.has(b.player) && connection.known.has(mob), 'keeps what the new viewpoint sees')

  a.mirror.clear()
  mob.position = new Vector(1060, 1000)
  tick(multiplayer, 2)
  assert.ok(a.mirror.seen.update.includes(mob.id), 'follows changes around whom it watches')
  assertClean([a, b], 'spectate')
})

test('a player who dies with nobody left to watch holds nothing afterwards', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const a = join(multiplayer, 'a00009', new Vector(1000, 1000))
  const mob = idleMob(1050, 1000, TOP)
  tick(multiplayer, 0)
  a.mirror.clear()

  a.player.hit(9999)
  tick(multiplayer, 1)
  assert.ok(a.mirror.seen.destroy.includes(a.player.id), 'not told of its own death')
  const connection = connectionOf(multiplayer, a)
  assert.equal(connection.spectating, undefined)
  assert.equal(connection.known.size, 0)
  assert.equal(connection.layer, undefined)
  assert.equal(mob.knownBy.has(connection), false)

  a.mirror.clear()
  mob.position = new Vector(1060, 1000)
  tick(multiplayer, 2)
  assert.deepEqual(a.mirror.seen, { create: [], create_own: [], destroy: [], update: [], effect: [] }, 'sent something after its death')
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

test('a unit effect (types 0-4) reaches exactly the connections that hold its originator', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const random = lcg(7)
  const clients: Client[] = []
  // Peep and Periscope viewers mixed, over 2000 units: most pairs are inside
  // the old 500 box, many of those beyond a Peep's sight.
  for (let i = 0; i < 16; i++) {
    clients.push(join(multiplayer, `e${i.toString(16).padStart(5, '0')}`, new Vector(random() * 2000, random() * 2000), i % 3 === 0 ? 'periscope' : 'peep'))
  }
  for (const client of clients) if (random() < 0.3) client.player.changeLayer(MIDDLE)
  const mobs: Mob[] = []
  for (let i = 0; i < 10; i++) mobs.push(idleMob(random() * 2000, random() * 2000, random() < 0.3 ? MIDDLE : TOP))
  tick(multiplayer, 0)

  let sent = 0
  let withheld = 0
  const origins: Array<Player | Mob> = [...clients.map((c) => c.player), ...mobs]
  for (const [i, origin] of origins.entries()) {
    const type = i % 5
    for (const client of clients) client.mirror.clear()
    multiplayer.effect(type, origin, 500, i % 2 === 0 ? Hex.toCell(origin.position) : undefined)
    multiplayer.flushAll(1, 250)
    for (const client of clients) {
      const got = client.mirror.seen.effect.filter((id) => id === origin.id).length
      const want = client.mirror.held.has(origin.id) ? 1 : 0
      assert.equal(got, want, `effect ${type} of ${origin.id} to ${client.id}`)
      if (want === 1) sent++
      else if (client.player.tag === origin.tag && client.player.position.withinBounds(origin.position.x, origin.position.y, R)) withheld++
    }
  }
  // Both cases occur, or the test proves nothing.
  assert.ok(sent > 0, 'no effect reached a holder')
  assert.ok(withheld > 0, 'no viewer was inside the old box without holding the originator')
  assertClean(clients, 'unit effects')
})

test('a unit effect skips a viewer in the old box that does not hold it, and reaches a holder and its spectator', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  // A Peep 9 rings west of the originator: 405 units, inside the old box,
  // beyond its 7-ring enter radius.
  const far = join(multiplayer, 'b00010', at, 'peep')
  const origin = idleMob(offCell(at, 9).x, offCell(at, 9).y, TOP)
  const holder = join(multiplayer, 'b00011', offCell(at, 12), 'peep')
  // Next to the holder, so it is the one the dead player watches.
  const watcher = join(multiplayer, 'b00012', offCell(at, 13), 'peep')
  tick(multiplayer, 0)
  watcher.player.hit(9999)
  tick(multiplayer, 1)
  tick(multiplayer, 2)
  assert.equal(connectionOf(multiplayer, watcher).spectating, holder.player, 'not watching the holder')
  assert.ok(!far.mirror.held.has(origin.id) && holder.mirror.held.has(origin.id) && watcher.mirror.held.has(origin.id))
  assert.ok(far.player.position.withinBounds(origin.position.x, origin.position.y, R), 'the far viewer is not inside the old box')

  for (const type of [0, 1, 2, 3, 4]) {
    for (const client of [far, holder, watcher]) client.mirror.clear()
    multiplayer.effect(type, origin, 500)
    multiplayer.flushAll(3, 250)
    assert.deepEqual(far.mirror.seen.effect, [], `effect ${type} sent to a viewer that does not hold its originator`)
    assert.deepEqual(holder.mirror.seen.effect, [origin.id], `effect ${type} not sent to the holder`)
    assert.deepEqual(watcher.mirror.seen.effect, [origin.id], `effect ${type} not sent to the holder's spectator`)
  }
  assertClean([far, holder, watcher], 'unit effect recipients')
})

test('a unit effect in the tick its holder dies is not sent to the dead holder', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  const a = join(multiplayer, 'b00013', at, 'peep')
  const origin = idleMob(offCell(at, 2).x, offCell(at, 2).y, TOP)
  tick(multiplayer, 0)
  assert.ok(a.mirror.held.has(origin.id))
  a.mirror.clear()
  a.player.hit(9999)
  multiplayer.effect(2, origin, 1)
  tick(multiplayer, 1)
  assert.ok(a.mirror.seen.destroy.includes(a.player.id), 'not told of its own death')
  assert.deepEqual(a.mirror.seen.effect, [], 'an effect reached a client whose player has just died')
})

test('a fireball or icicle blast and a bomb reach the viewers of their cell, held thrower or not', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  const thrower = join(multiplayer, 'b00014', at, 'peep')
  const cell = Hex.toCell(offCell(at, 10))
  const centre = Hex.toPosition(cell)
  // 4 rings east of the cell, 14 from the thrower (630 units: neither held
  // nor in the old box around it).
  const near = join(multiplayer, 'b00015', offCell(centre, 4), 'peep')
  // Holds the thrower (6 rings west of it), 16 rings from the cell.
  const behind = join(multiplayer, 'b00016', offCell(at, -6), 'peep')
  // On a Periscope's enter ring due east of the cell.
  const scope = join(multiplayer, 'b00017', offCell(centre, SCOPE_ENTER), 'periscope')
  // Another Peep further east, which neither sees the cell nor has it in
  // the 500 box (13 rings: 562 units east, past Peep's 8-ring leave).
  const blind = join(multiplayer, 'b00018', offCell(centre, 13, -1), 'peep')
  // On the layer below, right on the cell.
  const below = join(multiplayer, 'b00019', centre, 'peep')
  below.player.changeLayer(MIDDLE)
  tick(multiplayer, 0)
  const clients = [thrower, near, behind, scope, blind, below]
  assert.ok(!near.mirror.held.has(thrower.player.id) && behind.mirror.held.has(thrower.player.id))
  assert.ok(!scope.mirror.held.has(thrower.player.id))

  const sends: Array<[string, () => void, number]> = [
    ['fireball blast', () => multiplayer.effectAt(5, thrower.player.id, 500, cell, TOP), 5],
    ['icicle blast', () => multiplayer.effectAt(6, thrower.player.id, 500, cell, TOP), 6],
    ['bomb fuse', () => multiplayer.effectAt(7, thrower.player.id, 2000, cell, TOP), 7],
    ['bomb blast', () => multiplayer.effectAt(8, thrower.player.id, 500, cell, TOP), 8]
  ]
  for (const [label, send, type] of sends) {
    for (const client of clients) client.mirror.clear()
    send()
    multiplayer.flushAll(1, 250)
    assert.deepEqual(near.mirror.effectTypes, [type], `${label}: the cell's viewer that does not hold the thrower`)
    assert.deepEqual(scope.mirror.effectTypes, [type], `${label}: a Periscope ${SCOPE_ENTER} rings east of the cell`)
    assert.deepEqual(blind.mirror.effectTypes, [], `${label}: a Peep that does not see the cell`)
    assert.deepEqual(behind.mirror.effectTypes, [], `${label}: a holder of the thrower far from the cell`)
    assert.deepEqual(below.mirror.effectTypes, [], `${label}: another layer`)
  }
  assertClean(clients, 'cell effects')
})

/**
 * A thrower on TOP throws `Skill` 10 cells due east, then hops to MIDDLE while
 * it flies (`changeLayer`, as `Player.hopPortal` does), with no update since:
 * its client's switch is pending. `old` stands on TOP 4 rings beyond the end of
 * the line, where the projectile bursts; `fresh` stands on MIDDLE right on
 * that cell. Neither is on the projectile's swath, so it strikes nobody.
 */
function hopMidFlight (skill: typeof ThrowFireball | typeof Throwicicle, prefix: string) {
  const multiplayer = new Multiplayer(250, okRedis())
  const at = Hex.toPosition(new Vector(30, 40))
  const thrower = join(multiplayer, `${prefix}0`, at, 'peep')
  const end = new Vector(40, 40)
  const old = join(multiplayer, `${prefix}1`, offCell(Hex.toPosition(end), 4), 'peep')
  const fresh = join(multiplayer, `${prefix}2`, Hex.toPosition(end), 'peep')
  fresh.player.changeLayer(MIDDLE)
  tick(multiplayer, 0)
  const clients = [thrower, old, fresh]
  for (const client of clients) client.mirror.clear()

  const throwSkill = thrower.player.skills.find((s) => s instanceof skill)
  assert.ok(throwSkill !== undefined, `${skill.name} not equipped`)
  assert.equal(throwSkill.execute(end), true, 'the throw was refused')
  assert.equal(World.PROJECTILES.length, 1)
  const projectile = World.PROJECTILES[0]
  assert.equal(projectile.tag, TOP)
  thrower.player.changeLayer(MIDDLE)
  assert.equal(connectionOf(multiplayer, thrower).layer, TOP, 'the switch is not pending')
  return { multiplayer, thrower, old, fresh, clients, end, projectile }
}

for (const [skill, type] of [[ThrowFireball, 5], [Throwicicle, 6]] as const) {
  test(`a ${skill.name} blast after its thrower hops a portal reaches the cell's viewers on the layer it flew on, and nobody on the thrower's new one`, () => {
    const { multiplayer, thrower, old, fresh, clients, end, projectile } = hopMidFlight(skill, `c${type}000`)
    const blasts = (client: Client): number => client.mirror.effectTypes.filter((t) => t === type).length

    for (let n = 1; n <= 10 && World.PROJECTILES.length > 0; n++) {
      World.updateProjectiles(0.25)
      tick(multiplayer, n)
    }
    assert.equal(World.PROJECTILES.length, 0, 'the projectile never burst')
    assert.equal(projectile.struck, undefined, 'it struck someone, so the burst is not where the test put it')
    assert.deepEqual(Hex.toCell(projectile.position), end, 'it burst off the end of its line')
    assert.equal(thrower.player.tag, MIDDLE)
    assert.equal(connectionOf(multiplayer, thrower).layer, MIDDLE, 'the thrower\'s client never switched')

    assert.equal(blasts(old), 1, 'the viewer of the burst cell on the projectile\'s layer did not get the blast')
    assert.equal(blasts(fresh), 0, 'the blast went to the thrower\'s new layer')
    assert.equal(blasts(thrower), 0, 'the blast went to the thrower, now on another layer')
    assertClean(clients, 'blast after a hop')
  })
}

test('a cell effect on the new layer is not sent to a client whose switch to it is still pending', () => {
  // `sendAt` takes candidates by the player's tag, which is already MIDDLE,
  // while its client still draws TOP until the player's next update
  // (`switchLayer`). Sent now, a MIDDLE blast would be drawn on TOP's plane.
  const { multiplayer, thrower, old, fresh, clients } = hopMidFlight(ThrowFireball, 'c70000')
  const cell = Hex.toCell(offCell(thrower.player.position, 1))
  for (const client of clients) client.mirror.clear()
  multiplayer.effectAt(8, fresh.player.id, 500, cell, MIDDLE)
  // A flush only, with no update: the switch stays pending through it.
  multiplayer.flushAll(1, 250)
  assert.equal(connectionOf(multiplayer, thrower).layer, TOP, 'the flush switched the client')
  assert.deepEqual(thrower.mirror.effectTypes, [], 'a MIDDLE effect reached a client still on TOP')
  // Nine rings from the cell, inside the box: the effect did go out on MIDDLE.
  assert.deepEqual(fresh.mirror.effectTypes, [8], 'the MIDDLE viewer of the cell did not get it')
  assert.deepEqual(old.mirror.effectTypes, [], 'a TOP viewer got a MIDDLE effect')
  assertClean(clients, 'pending switch')
})

// --- a real world ------------------------------------------------------------------------

test('a real world with walking players and portals never sends a client a record it cannot apply', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  const random = lcg(99)
  const clients: Client[] = []
  // Peep and Periscope viewers mixed (vision 6 and 12).
  for (let i = 0; i < 8; i++) clients.push(join(multiplayer, `f${i.toString(16).padStart(5, '0')}`, undefined, i % 2 === 0 ? 'peep' : 'periscope'))
  let hops = 0
  for (let n = 1; n <= 400; n++) {
    t.mock.timers.tick(250)
    const tags = clients.map((c) => c.player.tag)
    const from = clients.map((c) => c.player.position)
    world.update(0.25)
    multiplayer.flushAll(n, 250)
    clients.forEach((c, i) => { if (c.player.tag !== tags[i]) hops++ })
    // Exactly what each can see, allowing for its own move this tick (see
    // `assertHolds`). Not one that came through a portal this tick: the hop
    // comes after its own update, and its client is switched at the next.
    const hopped = new Set(clients.filter((c, i) => c.player.tag !== tags[i]).map((c) => c.player.id))
    clients.forEach((c, i) => { if (!hopped.has(c.player.id)) assertHolds(multiplayer, c, `tick ${n}`, from[i], hopped) })
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
  // Every one of these was checked against what its client held (`Mirror`).
  const unitEffects = clients.reduce((sum, c) => sum + c.mirror.effectTypes.filter((type) => type <= 4).length, 0)
  t.diagnostic(`${unitEffects} unit effects received`)
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
