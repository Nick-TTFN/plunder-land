import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import type Redis from 'ioredis'
import World from './world'
import Timers from './timers'
import { GameObject } from './gameobject'
import Consumable from './consumable'
import Throwable from './throwable'
import Mob from './mob'
import { ARCHETYPES } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { decodeRecord } from '../../../../plunder-land-client/src/net/records'

/**
 * The arena art pass (2026-09-28) needs two things the client was never told:
 * what a loot pickup is worth (it picks one of three crystals by value), and
 * whether a projectile is a fireball or an icicle. A pickup's create now
 * carries `loot` (as `loot32`, index 20, which the client already decodes),
 * and a projectile's create carries `projectile`, a uint8 appended at 22.
 * Decoded here with the client's own `decodeRecord` over `fieldOrder`, which
 * `fieldtable.spec.ts` holds identical to the client's `allFields`.
 */

const PROJECTILE_INDEX = 22
const CLIENT_THROWABLE = join(__dirname, '..', '..', '..', '..', 'plunder-land-client', 'src', 'objects', 'throwable.ts')

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
})

function setup (): void {
  const redis = { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
  // eslint-disable-next-line no-new
  new Multiplayer(250, redis)
  // eslint-disable-next-line no-new
  new World(4000)
}

function decoded (obj: GameObject, fields: Set<string>): any {
  const record = obj.serialiseBinary(fields)
  assert.ok(record !== null)
  return decodeRecord(record, GameObject.fieldOrder)
}

test('projectile is appended at 22, after kills', () => {
  assert.equal(GameObject.fieldOrder.indexOf('projectile'), PROJECTILE_INDEX)
  assert.equal(GameObject.fieldOrder.indexOf('kills'), PROJECTILE_INDEX - 1)
})

test('a loot pickup\'s create, which everyone gets, carries its value', () => {
  setup()
  const natural = new Consumable(100, 100, 0, 20 as unknown as undefined, 35)
  assert.equal(decoded(natural, natural.allFields).loot, 35)
  // Death drops are worth what they carry, not their radius.
  const drop = new Consumable(100, 100, 0, undefined, 70000, 30000)
  assert.equal(decoded(drop, drop.allFields).loot, 70000)
})

test('a projectile\'s create carries its kind, and the client\'s table agrees', () => {
  setup()
  const owner = new Mob(Hex.toPosition(new Vector(5, 5)).x, Hex.toPosition(new Vector(5, 5)).y, 0, ARCHETYPES.grunt)
  const line = Hex.line(new Vector(5, 5), new Vector(8, 5), Throwable.RANGE_CELLS)
  const noop = (): void => {}
  const fireball = new Throwable(line, 1200, 0, owner, noop, Throwable.FIREBALL)
  const icicle = new Throwable(line, 1200, 0, owner, noop, Throwable.ICICLE)
  assert.equal(decoded(fireball, fireball.allFields).projectile, Throwable.FIREBALL)
  assert.equal(decoded(icicle, icicle.allFieldsOwn).projectile, Throwable.ICICLE)
  // Never a delta: nothing marks it dirty, including a step along the line.
  icicle.update(0.25)
  assert.equal(icicle.dirtyFields.has('projectile'), false)

  const source = readFileSync(CLIENT_THROWABLE, 'utf8')
  const match = /export const PROJECTILE = \{ fireball: (\d+), icicle: (\d+) \}/.exec(source)
  assert.ok(match !== null, 'client PROJECTILE table not found')
  assert.deepEqual([Number(match[1]), Number(match[2])], [Throwable.FIREBALL, Throwable.ICICLE])
})
