import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import Obstacle from '../objects/obstacle'
import { GameObject, ObjectType } from '../objects/gameobject'
import type Player from '../objects/player'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { archetypeById } from '../utils/archetypes'
import { unpackFrame } from '../../../../plunder-land-client/src/net/framedparser'
import { decodeRecord } from '../../../../plunder-land-client/src/net/records'
import { RunMap, resetForRun } from '../../../../plunder-land-client/src/net/runmap'
import { Handoff } from '../../../../plunder-land-client/src/net/handoff'
import { Session } from '../../../../plunder-land-client/src/net/session'
import { Fog, SEEN } from '../../../../plunder-land-client/src/objects/fog'

/**
 * A client plays a run in world A, dies, plays again and lands in world B
 * (worlds-per-process, decision #39; Nick: "all data caches clear on play
 * again"). Nothing of A may remain: no object, blocked cell, void, portal or
 * fog cell.
 *
 * The client here is the real client's pixi-free half, fed exactly what the
 * server sends: `unpackFrame` splits the frames, `decodeRecord` decodes the
 * records (with the server's field table, which fieldtable.spec.ts holds
 * identical to the client's), `Session.onHello` and `RunMap` take the map,
 * `Fog` the fog, and `resetForRun` is what `Game.start` runs before every run.
 * What it can't run is `Game` itself (pixi): `LOOKUP` and the object lists are
 * modelled by `held`, cleared where `Game.start` clears them.
 */

afterEach(() => {
  World.strict = false
})

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1, keys: async () => [], hgetall: async () => ({}) } as unknown as Redis
}

type Data = Record<string, any>

class HeadlessClient {
  readonly map = new RunMap()
  readonly fog = new Fog()
  /** `Game.LOOKUP`: what this client holds, by id, as last decoded. */
  readonly held = new Map<number, Data>()
  ownId: number | undefined
  private readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly socket: Socket

  constructor (id: string) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' } },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data: unknown) => {
        if (event === 'hello') this.onHello(data as Data)
        if (event === 'handoff') this.onHandoff()
        return true
      },
      conn: {
        write: (frame: Buffer) => {
          const events = unpackFrame(new Uint8Array(frame))
          assert.ok(events !== undefined)
          for (const [event, buffer] of events) this.onEvent(event, new Uint8Array(buffer))
        }
      }
    } as unknown as Socket
  }

  /** `Game.start`, then `start_requested`, then the wait for the account (decision #48). */
  async play (name: string, extra: Record<string, unknown> = {}): Promise<void> {
    Handoff.reset()
    resetForRun(this.map, this.fog)
    this.held.clear()
    this.ownId = undefined
    this.handlers.start_requested({ id: 'abcdef', name, ...extra })
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
  }

  /** Own creates that continued a run across a handoff (`Handoff.takeOwnCreate`). */
  continued = 0

  /** `Game.onHandoff`: the run's world goes (`resetRun` empties `LOOKUP`), then `Handoff.begin`. */
  private onHandoff (): void {
    this.held.clear()
    this.ownId = undefined
    Handoff.begin(this.map, this.fog)
  }

  private onHello (data: Data): void {
    Session.onHello(data)
    this.map.setVoids(Session.layers, Session.voids)
  }

  private onEvent (event: string, bytes: Uint8Array): void {
    if (event === 'standings' || event === 'effect') return
    for (const record of records(bytes, event === 'update' ? 8 : 0)) {
      const data = decodeRecord(record, GameObject.fieldOrder) as Data
      if (event === 'create' || event === 'create_own') {
        this.held.set(data.id, data)
        this.map.created(data)
        if (event === 'create_own') {
          // `Game.onObjectCreated` for the own create.
          this.ownId = data.id
          if (Handoff.takeOwnCreate()) this.continued++
          this.fog.reset(archetypeById(data.archetype)?.vision ?? null)
          this.see(data)
        }
      } else if (event === 'update') {
        const known = this.held.get(data.id)
        if (known === undefined) continue
        Object.assign(known, data)
        if (data.id === this.ownId) this.see(known)
      } else if (event === 'destroy') {
        const known = this.held.get(data.id)
        if (known === undefined) continue
        // `Game.onObjectDestroyed`.
        const cell = Hex.toCell(new Vector(known.position.x, known.position.y))
        if (known.type === ObjectType.Portal) this.map.removePortal(cell.x, cell.y, known.tag)
        if (known.type === ObjectType.Obstacle) this.map.unblock(cell.x, cell.y, known.tag)
        this.held.delete(data.id)
      }
    }
  }

  private see (own: Data): void {
    const cell = Hex.toCell(new Vector(own.position.x, own.position.y))
    this.fog.update(cell.x, cell.y, own.tag)
  }
}

function records (bytes: Uint8Array, skip: number): Uint8Array[] {
  const out: Uint8Array[] = []
  let at = skip
  while (at + 2 <= bytes.length) {
    const length = (bytes[at] << 8) + bytes[at + 1]
    out.push(bytes.subarray(at + 2, at + 2 + length))
    at += 2 + length
  }
  return out
}

function connect (worlds: Worlds, id: string): HeadlessClient {
  const client = new HeadlessClient(id)
  const connection = worlds.onConnection(client.socket)
  Object.defineProperty(client, 'player', { get: () => connection.player })
  Object.defineProperty(client, 'world', { get: () => worlds.worldFor(connection) })
  Object.defineProperty(client, 'connection', { get: () => connection })
  return client
}

type Connected = HeadlessClient & { player: Player | undefined, world: World | undefined, connection: unknown }

function kill (worlds: Worlds, client: Connected): void {
  const { world, player } = client
  assert.ok(world !== undefined && player !== undefined)
  World.run(world, () => { player.destroy() })
  worlds.tickAll(250)
}

test('a client that plays in world A, dies and plays again in world B keeps nothing of A', async () => {
  const worlds = new Worlds({ privateRuns: false, tickLengthMs: 250, cap: 1, idleMs: 300_000, redis: okRedis() })
  const [x, y, z] = ['x', 'y', 'z'].map((id) => connect(worlds, id) as Connected)

  // X plays in A, next to a StoneWall stone, and walks a little.
  await x.play('X')
  const a = x.world as World
  const xa = x.player as Player
  const stoneCell = Hex.toCell(xa.position).add(new Vector(0, 2))
  World.run(a, () => {
    const at = Hex.toPosition(stoneCell)
    World.addObstacle(new Obstacle(at.x, at.y, xa.tag, 60_000))
  })
  for (let i = 0; i < 8; i++) {
    World.run(a, () => { xa.setWaypoints([Hex.toCell(xa.position).add(new Vector(i % 2 === 0 ? 3 : -3, 0))]) })
    worlds.tickAll(250)
  }
  // What the client took from A.
  assert.ok(x.map.blocked.get(xa.tag)?.has(Hex.key(stoneCell.x, stoneCell.y)) === true, 'the stone never reached the client')
  assert.ok((x.map.portals.get(xa.tag)?.size ?? 0) > 0, 'no portals reached the client')
  const aVoids = new Set(x.map.voids.get(0))
  const aExplored: Vector[] = []
  for (const cell of Hex.mapCells(4000)) if (x.fog.state(cell.x, cell.y, 0) !== SEEN.UNKNOWN) aExplored.push(cell)
  assert.ok(aExplored.length > 0)

  // The cap is 1. Y's run opens B while X plays; X dies; Z's run takes A;
  // Y dies. When X plays again A is full and B is empty.
  await y.play('Y')
  const b = y.world as World
  // Worlds by identity only: a failing equal on two Worlds builds a multi-GB diff.
  assert.ok(b !== a, 'Y\'s run did not open world B')
  kill(worlds, x)
  await z.play('Z')
  assert.ok(z.world === a, 'Z\'s run did not take world A')
  kill(worlds, y)

  await x.play('X AGAIN')
  assert.ok(x.world === b, 'the second run did not land in world B')
  for (let i = 0; i < 4; i++) worlds.tickAll(250)
  const xb = x.player as Player

  // Objects: everything held is one of B's, with B's type and, for what does
  // not move, B's position. (Ids alone can't say: both worlds count from 1.)
  const bObjects = new Map<number, GameObject>()
  for (const list of [b.PLAYERS, b.MOBS, b.OBSTACLES, b.PROJECTILES, b.CONSUMABLES, b.ITEMS, b.GEAR]) {
    for (const obj of list as GameObject[]) bObjects.set(obj.id, obj)
  }
  const still = ObjectType.Obstacle | ObjectType.Portal | ObjectType.Exit | ObjectType.Consumable | ObjectType.Item
  for (const [id, data] of x.held) {
    const obj = bObjects.get(id)
    assert.ok(obj !== undefined && obj.type === data.type, `held id ${id} (type ${String(data.type)}) is not world B's`)
    if ((obj.type & still) !== 0) {
      assert.deepEqual([data.position.x, data.position.y], [Math.floor(obj.position.x), Math.floor(obj.position.y)],
        `held id ${id} is where world A had its object, not B`)
    }
  }
  assert.ok(x.held.size > 0)

  // Blocked cells: A's stone is gone, and only B's stones block anything.
  for (const [tag, cells] of x.map.blocked) {
    for (const key of cells) {
      assert.ok(b.BLOCKED.get(tag)?.get(key) instanceof GameObject, `cell ${key} on layer ${tag} is blocked, and not by a stone of B's`)
    }
  }
  assert.equal(b.BLOCKED.get(xa.tag)?.get(Hex.key(stoneCell.x, stoneCell.y)) instanceof GameObject, false)
  assert.notEqual(x.map.blocked.get(xa.tag)?.has(Hex.key(stoneCell.x, stoneCell.y)), true, 'world A\'s stone still blocks')

  // Voids: exactly B's, every layer.
  for (const tag of World.TAGS) {
    assert.deepEqual(x.map.voids.get(tag), b.VOIDS.get(tag), `layer ${tag}'s valleys are not world B's`)
  }
  assert.notDeepEqual(aVoids, x.map.voids.get(0), 'A and B had the same valleys: the check checked nothing')

  // Portals: exactly B's on the client's layer.
  const bPortals = new Map<number, number>()
  for (const obj of b.OBSTACLES) {
    if (obj.type !== ObjectType.Portal || obj.tag !== xb.tag) continue
    const cell = Hex.toCell(obj.position)
    bPortals.set(Hex.key(cell.x, cell.y), obj.to)
  }
  assert.deepEqual(x.map.portals.get(xb.tag), bPortals, 'the portals are not world B\'s')

  // Fog: nothing explored in A is still explored unless B's run has seen it.
  const bCell = Hex.toCell(xb.position)
  const vision = archetypeById(x.held.get(x.ownId as number)?.archetype)?.vision ?? 0
  assert.ok(vision > 0)
  for (const cell of aExplored) {
    if (Hex.distance(cell, bCell) <= vision) continue
    assert.equal(x.fog.state(cell.x, cell.y, 0), SEEN.UNKNOWN, `A's explored cell ${cell.x},${cell.y} is still known`)
  }
})

test('a client through a first run, its handoff and the private run keeps no id, cell or pad of the first-run world (decision #58, #60 Q15)', async () => {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: okRedis() })
  const x = connect(worlds, 'x') as Connected
  await x.play('X', { firstRun: true })
  const first = x.world as World
  const xf = x.player as Player
  assert.equal(first.firstRun, true)
  for (let i = 0; i < 2; i++) worlds.tickAll(250)
  // What the client took from the first-run world: its pad, its map size.
  assert.equal(Session.mapSize, first.mapSize)
  const firstIds = new Set(x.held.keys())
  assert.ok(firstIds.size > 0)
  const gate = first.OBSTACLES.find((o) => (o as { handoff?: boolean }).handoff === true) as GameObject
  const gateCell = Hex.toCell(gate.position)
  assert.equal(x.map.portals.get(xf.tag)?.get(Hex.key(gateCell.x, gateCell.y)), xf.tag, 'the pad never reached the client as a portal to its own layer')

  // Onto the pad: the handoff, then the private world's hello and join, in order.
  World.run(first, () => { xf.position = Hex.toPosition(gateCell) })
  worlds.tickAll(250)
  const priv = x.world as World
  assert.ok(priv !== undefined && priv !== first && !priv.firstRun, 'the handoff did not leave the first-run world')
  assert.ok(worlds.privates.includes(priv), 'the handoff did not land in a private world')
  for (let i = 0; i < 4; i++) worlds.tickAll(250)
  const xp = x.player as Player
  assert.equal(x.continued, 1, 'the private run\'s own create did not continue the run')
  assert.equal(Session.mapSize, priv.mapSize)
  assert.notEqual(priv.mapSize, first.mapSize, 'both worlds have one map size: the size check checks nothing')

  // Every id held is the private world's object, of its type.
  for (const [id, data] of x.held) {
    const obj = objectsOf(priv).get(id)
    assert.ok(obj !== undefined && obj.type === data.type, `held id ${id} (type ${String(data.type)}) is not the private world's`)
  }
  assert.equal(x.held.get(x.ownId as number)?.id, xp.id)
  // The first-run pad is gone from the map; the portals are exactly the private world's.
  const portals = new Map<number, number>()
  for (const obj of priv.OBSTACLES) {
    if (obj.type !== ObjectType.Portal || obj.tag !== xp.tag) continue
    const cell = Hex.toCell(obj.position)
    portals.set(Hex.key(cell.x, cell.y), obj.to)
  }
  assert.ok(portals.size > 0, 'the private world has no portal on its top layer: the portal check checks nothing')
  assert.deepEqual(x.map.portals.get(xp.tag), portals)
  assert.notEqual(x.map.portals.get(xp.tag)?.get(Hex.key(gateCell.x, gateCell.y)), xf.tag, 'the first-run pad is still on the map')
  // Voids: the private world's (its unheld layers all void).
  for (const tag of World.TAGS) assert.deepEqual(x.map.voids.get(tag), voidsOf(priv, tag), `layer ${tag}'s valleys are not the private world's`)

  // A later run from the lobby starts a fresh record.
  World.run(priv, () => { xp.destroy() })
  worlds.tickAll(250)
  await x.play('X AGAIN')
  assert.equal(x.continued, 1)
})

/** Every object of `world` by id, for "is this held id that world's?". */
function objectsOf (world: World): Map<number, GameObject> {
  const objects = new Map<number, GameObject>()
  for (const list of [world.PLAYERS, world.MOBS, world.OBSTACLES, world.PROJECTILES, world.CONSUMABLES, world.ITEMS, world.GEAR]) {
    for (const obj of list as GameObject[]) objects.set(obj.id, obj)
  }
  return objects
}

/** What the client must hold as `world`'s valleys on `tag`: its own, or every cell for a layer it doesn't hold (#60). */
function voidsOf (world: World, tag: number): Set<number> {
  return Session.decodeRuns(world.VOID_RUNS.get(tag) ?? world.unheldRuns(tag), world.mapSize)
}

/** The private layers (decision #60, `LayerSpec.owned`), top first, and the shared world's top layer. */
const PRIVATE_TAGS = World.LAYERS.filter((layer) => layer.owned === true).map((layer) => layer.tag)
const SHARED_TOP = World.TAGS.find((tag) => !PRIVATE_TAGS.includes(tag)) as number

/** Onto a gate on the player's layer that `pick` accepts, and one tick (a portal hops on it; a pad hands off after it). */
function stepOn (worlds: Worlds, world: World, player: Player, pick: (gate: GameObject) => boolean): void {
  const gate = world.OBSTACLES.find((o) => o.type === ObjectType.Portal && o.tag === player.tag && pick(o))
  assert.ok(gate !== undefined, `no such gate on layer ${player.tag}`)
  World.run(world, () => {
    player.stop()
    player.position = Hex.toPosition(Hex.toCell(gate.position))
  })
  worlds.tickAll(250)
}

const isPad = (gate: GameObject): boolean => (gate as { handoff?: boolean }).handoff === true

test('a client through two handoffs, first run to a private world to a shared one, keeps nothing of either and one run record (#60)', async () => {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: okRedis() })
  const x = connect(worlds, 'x') as Connected
  await x.play('X', { firstRun: true })
  const first = x.world as World
  assert.equal(first.firstRun, true)
  for (let i = 0; i < 2; i++) worlds.tickAll(250)
  const xf = x.player as Player
  xf.loot = 3

  // Handoff 1: the first run's pad, into a private world of its own (Q15).
  stepOn(worlds, first, xf, isPad)
  const priv = x.world as World
  assert.ok(priv !== undefined && worlds.privates.includes(priv), 'the first handoff did not land in a private world')
  const xp = x.player as Player
  // Read before any tick: the new world's loot under its feet would add to it.
  assert.equal(xp.loot, xf.loot, 'the first run\'s loot did not reach the private world')
  assert.ok(xf.loot >= 3)
  for (let i = 0; i < 4; i++) worlds.tickAll(250)
  assert.equal(x.continued, 1)
  assert.equal(xp.tag, World.TAGS[0])
  for (const [id, data] of x.held) {
    const obj = objectsOf(priv).get(id)
    assert.ok(obj !== undefined && obj.type === data.type, `held id ${id} is not the private world's`)
  }
  for (const tag of World.TAGS) assert.deepEqual(x.map.voids.get(tag), voidsOf(priv, tag), `layer ${tag}'s valleys are not the private world's`)
  assert.equal(x.map.voids.get(SHARED_TOP)?.size, Hex.mapCells(priv.mapSize).length, 'the private world\'s shared layer is not all void')
  // Walk a little on the top layer, then down a real portal and a little on
  // the next, to leave explored fog, portals and pads behind on both.
  const walk = (): void => {
    for (let i = 0; i < 6; i++) {
      World.run(priv, () => { xp.setWaypoints([Hex.toCell(xp.position).add(new Vector(i % 2 === 0 ? 3 : -3, 0))]) })
      worlds.tickAll(250)
    }
  }
  // What the client holds of each private layer, read while it is on it.
  const privExplored: Array<[Vector, number]> = []
  const takeStock = (): void => {
    const tag = xp.tag
    const before = privExplored.length
    for (const cell of Hex.mapCells(priv.mapSize)) if (x.fog.state(cell.x, cell.y, tag) !== SEEN.UNKNOWN) privExplored.push([cell, tag])
    assert.ok(privExplored.length > before, `nothing explored on layer ${tag}`)
    assert.ok((x.map.portals.get(tag)?.size ?? 0) > 0, `no portal or pad of the private world's layer ${tag} reached the client`)
  }
  walk()
  takeStock()
  const deepest = PRIVATE_TAGS[PRIVATE_TAGS.length - 1]
  while (xp.tag !== deepest) {
    const from = xp.tag
    stepOn(worlds, priv, xp, (gate) => !isPad(gate) && gate.to < from)
    assert.ok(xp.tag < from, 'the portal hopped nobody')
    for (let i = 0; i < 2; i++) worlds.tickAll(250)
    walk()
    takeStock()
  }
  const privHeld = new Map([...x.held].map(([id, data]) => [id, { type: data.type as number, x: data.position.x as number, y: data.position.y as number }]))
  xp.loot = 5

  // Handoff 2: a pad on the private world's deepest layer, into a shared
  // world's top layer (`Worlds.padHandoff`): `handoff`, then the shared
  // world's hello, join and own create, in order.
  stepOn(worlds, priv, xp, isPad)
  const shared = x.world as World
  assert.ok(shared !== undefined && worlds.worlds.includes(shared), 'the second handoff did not land in a shared world')
  assert.equal(priv.closed, true)
  assert.equal(worlds.privates.length, 0)
  const xs = x.player as Player
  assert.ok(xs !== xp)
  // As it stood on the pad, read before any tick.
  assert.equal(xs.loot, xp.loot, 'the private world\'s loot did not reach the shared world')
  assert.ok(xp.loot >= 5)
  for (let i = 0; i < 4; i++) worlds.tickAll(250)
  assert.equal(xs.tag, SHARED_TOP, 'the shared run did not start on the shared world\'s top layer')

  // One run record across both handoffs (#58 addendum 5).
  assert.equal(x.continued, 2, 'an own create after a handoff restarted the run')

  // Ids: every one held is the shared world's (both worlds count from 1, so
  // many private ids are reused; the type and the list say whose it is).
  const objects = objectsOf(shared)
  for (const [id, data] of x.held) {
    const obj = objects.get(id)
    assert.ok(obj !== undefined && obj.type === data.type, `held id ${id} (type ${String(data.type)}) is not the shared world's`)
  }
  assert.equal(x.held.get(x.ownId as number)?.id, xs.id)
  // Teeth: some id the client held in the private world names another object
  // (or none) in the shared one, so a record kept across the handoff is wrong.
  assert.ok([...privHeld].some(([id, was]) => {
    const obj = objects.get(id)
    return obj === undefined || obj.type !== was.type || Math.floor(obj.position.x) !== was.x || Math.floor(obj.position.y) !== was.y
  }), 'every private id names the same object in the shared world: the id check checked nothing')

  // Map: the shared world's valleys on every layer (the private ones all void
  // now). `RunMap.setVoids` replaces every tag on each hello, so this holds
  // with or without the handoff's reset; the portal, stone and fog checks
  // below are the ones that catch a missing reset.
  for (const tag of World.TAGS) assert.deepEqual(x.map.voids.get(tag), voidsOf(shared, tag), `layer ${tag}'s valleys are not the shared world's`)
  assert.notDeepEqual(voidsOf(priv, World.TAGS[0]), voidsOf(shared, World.TAGS[0]))
  // No portal, pad or stone of the private world is left on the map (each
  // private layer had some above).
  for (const tag of PRIVATE_TAGS) {
    assert.equal(x.map.portals.get(tag)?.size ?? 0, 0, `a private world's portal or pad is still on layer ${tag}`)
    assert.equal(x.map.blocked.get(tag)?.size ?? 0, 0, `a private world's stone is still on layer ${tag}`)
  }
  // The shared world's top layer has no pads back up (#60 Q3, `padsUp` off),
  // and it is the deepest layer, so it has no gate to another layer at all:
  // this compares empty with empty and is kept only for when layers are added.
  const portals = new Map<number, number>()
  for (const obj of shared.OBSTACLES) {
    if (obj.type !== ObjectType.Portal || obj.tag !== xs.tag) continue
    const cell = Hex.toCell(obj.position)
    portals.set(Hex.key(cell.x, cell.y), obj.to)
  }
  assert.deepEqual(x.map.portals.get(xs.tag) ?? new Map(), portals)

  // Fog: nothing of the private layers is known any more (the shared run is deeper).
  for (const [cell, tag] of privExplored) assert.equal(x.fog.state(cell.x, cell.y, tag), SEEN.UNKNOWN, `the private world's explored cell ${cell.x},${cell.y} on layer ${tag} is still known`)

  // A later run from the lobby starts a fresh record, in a private world again.
  World.run(shared, () => { xs.destroy() })
  worlds.tickAll(250)
  await x.play('X AGAIN')
  assert.ok(x.world !== undefined && worlds.privates.includes(x.world), 'the next run did not start private')
  assert.equal(x.continued, 2)
})
