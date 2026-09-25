import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// See world.spec.ts: entering the module graph anywhere but multiplayer leaves
// GameObject undefined, so go in the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import { GameObject, ObjectType } from './gameobject'
import { Unit } from './unit'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * The field table is a wire contract: a record is a run of `[field index]
 * [payload]`, indexed into `GameObject.fieldOrder` here and `allFields` in the
 * client's `game.ts`. Nothing enforced that the two agree until this file.
 * A drift doesn't throw anywhere: the client reads the wrong width for a field
 * and every field after it in the record is garbage or dropped.
 */

const CLIENT_GAME = join(__dirname, '..', '..', '..', '..', 'plunder-land-client', 'src', 'game.ts')

function clientAllFields (): string[] {
  const source = readFileSync(CLIENT_GAME, 'utf8')
  const match = /const allFields = \[([\s\S]*?)\]/.exec(source)
  assert.ok(match !== null, 'could not find `const allFields = [...]` in the client game.ts')
  // Comments may sit between entries; only quoted strings are fields.
  const body = match[1].replace(/\/\/.*$/gm, '')
  return Array.from(body.matchAll(/'([^']*)'/g), (m) => m[1])
}

test('the client\'s allFields is identical to GameObject.fieldOrder', () => {
  assert.deepEqual(
    clientAllFields(),
    GameObject.fieldOrder,
    'The field tables have drifted. They are append-only and must be identical: ' +
    'add new fields to the end of both.'
  )
})

test('every field the server can mark dirty or create with is in fieldOrder', () => {
  // A field missing from the table encodes as index 255 (indexOf is -1).
  const unit = new Unit(ObjectType.Mob, 100, 100, 10, 0)
  for (const field of [...unit.allFields, ...unit.allFieldsOwn]) {
    assert.ok(GameObject.fieldOrder.includes(field), `${field} is not in fieldOrder`)
  }
})

// --- facing -------------------------------------------------------------------

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop
  } as unknown as Multiplayer
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
})

function unitOn (cell: Vector): Unit {
  const at = Hex.toPosition(cell)
  const unit = new Unit(ObjectType.Mob, at.x, at.y, 10, 0)
  unit.maxVelocity = 140
  unit.dirtyFields.clear()
  return unit
}

test('facing is marked dirty when its snapped index changes, and not on writes that keep it', () => {
  const unit = unitOn(new Vector(20, 40))
  // East to a few degrees off East: same index.
  unit.facing = new Vector(1, 0.1).normalised()
  unit.facing = new Vector(1, -0.2).normalised()
  assert.equal(unit.dirtyFields.has('facing'), false, 'marked dirty without the index changing')

  unit.facing = new Vector(-1, 0)
  assert.equal(unit.dirtyFields.has('facing'), true)
  assert.equal(unit.facingIndex, 3)
})

test('a unit walking a straight route sends facing once, not every tick', () => {
  const unit = unitOn(new Vector(20, 40))
  unit.setDestination(30, 40) // due East, ten cells, but it starts facing East
  let sent = 0
  for (let i = 0; i < 20; i++) {
    unit.update(0.25)
    // `update` hands the unit to Multiplayer, whose mock does not clear.
    if (unit.dirtyFields.has('facing')) sent++
    unit.dirtyFields.clear()
  }
  assert.equal(sent, 0, 'East is the default; a walk East should not send it')

  unit.setDestination(20, 40) // back West
  for (let i = 0; i < 20; i++) {
    unit.update(0.25)
    if (unit.dirtyFields.has('facing')) sent++
    unit.dirtyFields.clear()
  }
  assert.equal(sent, 1, `turning round sent facing ${sent} times`)
})

test('facing goes on the wire as its index in one byte after field index 13', () => {
  const unit = unitOn(new Vector(20, 40))
  unit.facing = new Vector(-0.5, -0.8) // North-West, index 4
  const index = GameObject.fieldOrder.indexOf('facing')
  // Was "the last field"; the armor pool (step 3) appended two after it.
  assert.equal(index, 13, 'facing moved: the table is append-only')
  const bytes = unit.serialiseBinary(new Set(['facing']))
  assert.ok(bytes !== null)
  // [0 id][uint16 id][13][4]
  assert.deepEqual([...bytes.subarray(3)], [index, 4])
})

test('a remote create carries facing, and a non-unit never does', () => {
  const unit = unitOn(new Vector(20, 40))
  unit.facing = new Vector(0, 1) // due South rounds clockwise, to SW (2)
  const created = unit.serialise(unit.allFields) as Record<string, unknown>
  assert.equal(created.facing, 2)

  const rock = new GameObject(ObjectType.Obstacle, 10, 10, 20, 0)
  const rockCreate = rock.serialise(rock.allFields) as Record<string, unknown>
  assert.equal('facing' in rockCreate, false)
})
