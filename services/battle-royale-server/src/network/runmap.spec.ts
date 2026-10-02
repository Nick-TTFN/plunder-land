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
      emit: (event: string, data: unknown) => { if (event === 'hello') this.onHello(data as Data); return true },
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
  async play (name: string): Promise<void> {
    resetForRun(this.map, this.fog)
    this.held.clear()
    this.ownId = undefined
    this.handlers.start_requested({ id: 'abcdef', name })
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
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
  return client
}

type Connected = HeadlessClient & { player: Player | undefined, world: World | undefined }

function kill (worlds: Worlds, client: Connected): void {
  const { world, player } = client
  assert.ok(world !== undefined && player !== undefined)
  World.run(world, () => { player.destroy() })
  worlds.tickAll(250)
}

test('a client that plays in world A, dies and plays again in world B keeps nothing of A', async () => {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 1, idleMs: 300_000, redis: okRedis() })
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
  assert.notEqual(b, a)
  kill(worlds, x)
  await z.play('Z')
  assert.equal(z.world, a)
  kill(worlds, y)

  await x.play('X AGAIN')
  assert.equal(x.world, b, 'the second run did not land in world B')
  for (let i = 0; i < 4; i++) worlds.tickAll(250)
  const xb = x.player as Player

  // Objects: everything held is one of B's, with B's type and, for what does
  // not move, B's position. (Ids alone can't say: both worlds count from 1.)
  const bObjects = new Map<number, GameObject>()
  for (const list of [b.PLAYERS, b.MOBS, b.OBSTACLES, b.PROJECTILES, b.CONSUMABLES, b.ITEMS]) {
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
