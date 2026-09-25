import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import type Player from './player'
import Mob from './mob'
import { type GameObject } from './gameobject'
import { ARCHETYPES, LAYERS } from '../archetypes/archetypes'
import { Vector } from '../utils/vector'

/**
 * hex-cells P1: `Multiplayer.update` finds its recipients through
 * `World.INTEREST` (coarse buckets) and decides "whole record or delta" by
 * change counters, instead of walking every connection and writing a
 * `pendingObjectIDs` flag on each one out of range.
 *
 * The claim is that nothing a client receives changed. So this runs the old
 * code, copied here as `Reference`, beside the new one over a few thousand
 * random updates (players teleporting in and out of range, changing layer,
 * objects moving or changing hp or not changing at all) and requires every
 * connection's update records to be byte-identical after every call. No object
 * is destroyed, so no id is reused: that is the one case the two differ on
 * (see `Multiplayer.update`), and it is checked on its own below.
 */

const [TOP, MIDDLE] = LAYERS.map((layer) => layer.tag)

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

function join (multiplayer: Multiplayer, id: string): Player {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  multiplayer.onConnect(socket)
  handlers.start_requested({ id, name: id })
  return World.PLAYERS[World.PLAYERS.length - 1]
}

/** `Multiplayer.update` before hex-cells P1, over the same connections, recording instead of buffering. */
class Reference {
  pending = new Map<string, Set<number>>()
  records = new Map<string, Buffer[]>()

  constructor (readonly connections: Array<{ id: string, player: Player }>) {}

  update (obj: GameObject): void {
    // Serialised up front: the real update clears the dirty set.
    const own = obj.serialiseBinary(obj.allFieldsOwn)
    const full = obj.serialiseBinary(obj.allFields)
    const delta = obj.serialiseBinary(obj.dirtyFields)
    const dirty = obj.dirtyFields.size > 0
    for (const { id, player } of this.connections) {
      const pending = this.pending.get(id) ?? new Set()
      this.pending.set(id, pending)
      if (player.tag === obj.tag && player.position.withinBounds(obj.position.x, obj.position.y, 500)) {
        let data
        if (pending.has(obj.id)) {
          data = player === obj ? own : full
          pending.delete(obj.id)
        } else {
          data = delta
        }
        if (data == null) continue
        const list = this.records.get(id) ?? []
        list.push(data)
        this.records.set(id, list)
      } else if (dirty) {
        pending.add(obj.id)
      }
    }
  }
}

test('every connection receives exactly the update records it did before interest buckets', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const random = lcg(20260925)
  const spot = (): Vector => new Vector(random() * 2500, random() * 2500)

  const players: Player[] = []
  for (let i = 0; i < 12; i++) players.push(join(multiplayer, `c${i.toString().padStart(5, '0')}`))
  const mobs: Mob[] = []
  for (let i = 0; i < 20; i++) {
    const at = spot()
    const mob = new Mob(at.x, at.y, TOP, ARCHETYPES.grunt)
    mob.routines = []
    World.addUnit(World.MOBS, mob)
    mobs.push(mob)
  }
  for (const player of players) player.position = spot()
  const objects: GameObject[] = [...players, ...mobs]
  for (const obj of objects) obj.dirtyFields.clear()
  ;(multiplayer as any)._buffer = {}

  const reference = new Reference(players.map((player, i) => ({ id: `c${i.toString().padStart(5, '0')}`, player })))
  let full = 0
  let deltas = 0

  for (let step = 0; step < 3000; step++) {
    const obj = objects[Math.floor(random() * objects.length)]
    const roll = random()
    if (roll < 0.35) obj.position = obj.position.add(new Vector((random() - 0.5) * 300, (random() - 0.5) * 300))
    else if (roll < 0.45) obj.position = spot() // a jump in or out of someone's range
    else if (roll < 0.55) obj.hp = Math.max(1, obj.hp - 1)
    else if (roll < 0.58 && (obj as Player).changeLayer !== undefined) {
      (obj as Player).changeLayer(obj.tag === TOP ? MIDDLE : TOP)
    }
    // else: an update with nothing changed

    reference.update(obj)
    multiplayer.update(obj)

    for (const { id } of reference.connections) {
      const got = ((multiplayer as any)._buffer[id]?.update ?? []) as Buffer[]
      const want = reference.records.get(id) ?? []
      assert.deepEqual(got.map((b) => b.toString('hex')), want.map((b) => b.toString('hex')), `step ${step}, connection ${id}`)
      for (const record of want) {
        if (record.length > 12) full++
        else deltas++
      }
    }
    ;(multiplayer as any)._buffer = {}
    reference.records.clear()
  }

  // It compared something of both kinds.
  assert.ok(full > 20, `only ${full} whole records compared`)
  assert.ok(deltas > 200, `only ${deltas} deltas compared`)
})

test('an effect reaches exactly the players inside the box around its originator, any layer', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const random = lcg(7)
  const players: Player[] = []
  for (let i = 0; i < 16; i++) players.push(join(multiplayer, `e${i.toString().padStart(5, '0')}`))
  for (const player of players) {
    player.position = new Vector(random() * 2000, random() * 2000)
    if (random() < 0.3) player.changeLayer(MIDDLE)
  }
  ;(multiplayer as any)._buffer = {}

  for (const originator of players) {
    multiplayer.effect(3, originator, 500)
    players.forEach((player, i) => {
      const got = ((multiplayer as any)._buffer[`e${i.toString().padStart(5, '0')}`]?.effect ?? []).length
      const want = player.position.withinBounds(originator.position.x, originator.position.y, Multiplayer.INTEREST_RADIUS) ? 1 : 0
      assert.equal(got, want, `effect of ${originator.id} to ${player.id}`)
    })
    ;(multiplayer as any)._buffer = {}
  }
})

test('a new object on a recycled id is not sent whole for its predecessor\'s change', () => {
  const multiplayer = new Multiplayer(250, okRedis())
  const viewer = join(multiplayer, 'a00001')
  viewer.position = new Vector(1000, 1000)
  const old = new Mob(3000, 3000, TOP, ARCHETYPES.grunt)
  old.routines = []
  World.addUnit(World.MOBS, old)
  old.position = new Vector(3010, 3000) // changes out of the viewer's range
  multiplayer.update(old)

  // The old flag outlived its object; the counters are ordered in time.
  const fresh = new Mob(1100, 1000, TOP, ARCHETYPES.grunt)
  fresh.routines = []
  fresh.id = old.id
  World.addUnit(World.MOBS, fresh)
  fresh.dirtyFields.clear()
  fresh.position = new Vector(1110, 1000)
  ;(multiplayer as any)._buffer = {}
  multiplayer.update(fresh)
  const sent = (multiplayer as any)._buffer.a00001.update as Buffer[]
  assert.equal(sent.length, 1)
  assert.deepEqual([...sent[0]], [...(fresh.serialiseBinary(new Set(['position'])) as Buffer)], 'sent whole')
})
