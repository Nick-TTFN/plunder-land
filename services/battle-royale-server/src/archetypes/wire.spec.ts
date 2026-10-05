import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import { GameObject, ObjectType } from '../objects/gameobject'
import { Unit } from '../objects/unit'
import { ARCHETYPES, type Archetype } from './archetypes'
import { ARCHETYPE_INFO, archetypeById, type ArchetypeKey } from '../utils/archetypes'
// The client's sprite map has no pixi imports, so it loads here. The client has
// no test runner of its own, and this is the one piece of its archetype
// handling with a rule worth pinning: an unknown id falls back.
import { lookFor, MOB_DEFAULT, ROBOT_DEFAULT } from '../../../../plunder-land-client/src/objects/archetypesprites'

/**
 * unit-archetypes step 4: the archetype id on the wire (design section 4).
 * Field 16, one unsigned byte, sent in the snapshot sets of every unit built
 * from an archetype and never in a delta. The ids and the client-visible flags
 * live in the mirrored `utils/archetypes.ts` (mirror.spec.ts checks the two
 * copies); this file checks that the server table takes them from there, and
 * what goes on the wire.
 */

const X = 1000
const Y = 2000
const KEYS = Object.keys(ARCHETYPE_INFO) as ArchetypeKey[]

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop
  } as unknown as Multiplayer

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

// --- the ids ----------------------------------------------------------------------

test('archetype ids are the ones already on the wire (append-only)', () => {
  // A changed id redraws every unit of that kind as something else on any
  // client built before the change. Add new ids; never move one.
  assert.deepEqual(
    Object.fromEntries(KEYS.map((key) => [key, ARCHETYPE_INFO[key].id])),
    // robot-select (#42), deliberate: magnet appended at 3.
    // #43, deliberate: periscope at 2. 2026-10-01, deliberate: hopper 4, waddle 5.
    { peep: 1, periscope: 2, magnet: 3, hopper: 4, waddle: 5, grunt: 6, boss: 7, gunner: 8 }
  )
})

test('archetype ids are unique, non-zero bytes; robots 1-5 and mobs from 6', () => {
  const ids = KEYS.map((key) => ARCHETYPE_INFO[key].id)
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(', ')}`)
  for (const key of KEYS) {
    const info = ARCHETYPE_INFO[key]
    assert.equal(info.key, key, `${key}'s entry says it is ${info.key}`)
    assert.ok(Number.isInteger(info.id) && info.id >= 1 && info.id <= 255, `${key}: id ${info.id}`)
    if (info.kind === 'robot') assert.ok(info.id <= 5, `${key}: robot ids are 1-5`)
    else assert.ok(info.id >= 6, `${key}: mob ids start at 6`)
  }
})

test('archetypeById finds every entry, and nothing for 0, undefined or an unknown id', () => {
  for (const key of KEYS) assert.equal(archetypeById(ARCHETYPE_INFO[key].id), ARCHETYPE_INFO[key])
  assert.equal(archetypeById(0), undefined)
  assert.equal(archetypeById(undefined), undefined)
  assert.equal(archetypeById(9), undefined, 'an unused id resolved')
  assert.equal(archetypeById(200), undefined)
})

test('the server table has exactly the mirrored keys, and takes the six shared fields from the mirror', () => {
  assert.deepEqual(Object.keys(ARCHETYPES).sort(), [...KEYS].sort())
  for (const key of KEYS) {
    const row: Archetype = ARCHETYPES[key]
    const info = ARCHETYPE_INFO[key]
    for (const field of ['id', 'key', 'kind', 'passesObstacles', 'vision', 'rangedCells'] as const) {
      assert.equal(row[field], info[field], `${key}.${field} is written down twice and disagrees`)
    }
  }
})

// --- the field ----------------------------------------------------------------------

test('archetype is field index 16, after maxArmor', () => {
  assert.equal(GameObject.fieldOrder.indexOf('maxArmor'), 15)
  assert.equal(GameObject.fieldOrder.indexOf('archetype'), 16)
  // usable-items appended `item` (17) and `inventory` (18) after it, and
  // extract-channel appended `extractProgress` (19), and loot-wire-overflow
  // appended `loot32` (20), and run-summary-card appended `kills` (21), and
  // the arena art pass appended `projectile` (22), robot-finishes appended
  // `finish` (23), and pickup-reach appended `collector` (24), and
  // gear-in-run appended `gear` (25), `carried` (26) and `speed` (27).
  assert.deepEqual(GameObject.fieldOrder.slice(17), ['item', 'inventory', 'extractProgress', 'loot32', 'kills', 'projectile', 'finish', 'collector', 'gear', 'carried', 'speed'], 'a field after speed: update this spec')
})

function units (): Array<[string, Unit, number]> {
  return [
    ['peep', new Player(X, Y, 0, 'p1'), 1],
    ['grunt', new Mob(X, Y, 0, ARCHETYPES.grunt), 6],
    ['boss', new Mob(X, Y, 0, ARCHETYPES.boss), 7],
    ['gunner', new Mob(X, Y, 0, ARCHETYPES.gunner), 8]
  ]
}

// robot-finishes: a player's finish (field 23, counted, the default here) follows its archetype.
const FINISH_MINT = [23, 6, 2, 1, 1, 0, 1, 0]

test('every archetype unit\'s create record ends with [16, id] (then a player\'s finish), and its serialised value is the id', () => {
  for (const [key, unit, id] of units()) {
    let bytes = [...(unit.serialiseBinary(unit.allFields) as Buffer)]
    if (unit instanceof Player) {
      assert.deepEqual(bytes.slice(-FINISH_MINT.length), FINISH_MINT, `${key} create record`)
      bytes = bytes.slice(0, -FINISH_MINT.length)
    }
    assert.deepEqual(bytes.slice(-2), [16, id], `${key} create record`)
    const fields = unit.serialise(unit.allFields) as Record<string, unknown>
    assert.equal(fields.archetype, id, `${key}: the archetype object went to the serialiser`)
  }
})

test('the player\'s create_own carries [16, 1], followed only by its inventory, kills, finish, carried gear and speed', () => {
  const player = new Player(X, Y, 0, 'p1')
  const own = [...(player.serialiseBinary(player.allFieldsOwn) as Buffer)]
  // usable-items: the inventory (field 18, five empty slots) came next;
  // run-summary-card: then kills (field 21, a uint16 0); robot-finishes: then the finish;
  // gear-in-run: then carried gear (26, six empty entries) and the speed (27, 1400 tenths).
  assert.deepEqual(own.slice(-33), [16, 1, 18, 5, 0, 0, 0, 0, 0, 21, 0, 0, ...FINISH_MINT, 26, 0, 7, 6, 0, 0, 0, 0, 0, 0, 27, 5, 120])
})

test('archetype is never dirty, so it never goes in a delta', () => {
  for (const [key, unit] of units()) {
    assert.equal(unit.dirtyFields.has('archetype'), false, `${key} at construction`)
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    if (unit instanceof Player) World.PLAYERS.push(unit)
    else World.MOBS.push(unit)
    unit.update(0.25)
    assert.equal(unit.dirtyFields.has('archetype'), false, `${key} after an update`)
  }
})

test('a unit with no archetype sends no archetype field', () => {
  const bare = new Unit(ObjectType.Mob, X, Y, 10, 0)
  assert.equal(bare.allFields.has('archetype'), false)
  assert.equal(bare.allFieldsOwn.has('archetype'), false)
})

test('the id is written unsigned, so ids past 127 survive', () => {
  const future: Archetype = { ...ARCHETYPES.grunt, id: 200 }
  const unit = new Unit(ObjectType.Mob, X, Y, 0, 0, future)
  const bytes = [...(unit.serialiseBinary(new Set(['archetype'])) as Buffer)]
  // [0][uint16 id][16][200]
  assert.deepEqual(bytes.slice(3), [16, 200])
})

// --- the client's sprite map ------------------------------------------------------

test('client sprites: every archetype has a look of its own kind', () => {
  for (const key of KEYS) {
    const info = ARCHETYPE_INFO[key]
    const look = lookFor(info.kind, info)
    // No art yet (Nick's boundary): robots draw the player, mobs draw mob/mob.
    assert.equal(look.run, info.kind === 'robot' ? 'player/run/run' : 'mob/mob', key)
  }
})

test('client sprites: an unknown id falls back to the type\'s pre-archetype sprite', () => {
  // What an older client does with an id from a newer server.
  assert.equal(lookFor('mob', archetypeById(200)), MOB_DEFAULT)
  assert.equal(lookFor('robot', archetypeById(200)), ROBOT_DEFAULT)
  // A record that never carried the field.
  assert.equal(lookFor('mob', archetypeById(undefined)), MOB_DEFAULT)
  assert.equal(lookFor('robot', archetypeById(0)), ROBOT_DEFAULT)
  // A mob's id on a player record, or the reverse.
  assert.equal(lookFor('robot', ARCHETYPE_INFO.grunt), ROBOT_DEFAULT)
  assert.equal(lookFor('mob', ARCHETYPE_INFO.peep), MOB_DEFAULT)
  // The defaults are what the client drew before this step.
  assert.deepEqual({ ...ROBOT_DEFAULT }, { run: 'player/run/run', idle: 'player/idle/idle' })
  assert.deepEqual({ ...MOB_DEFAULT }, { run: 'mob/mob' })
})

test('client sprites: the gunner can be told from a grunt', () => {
  const grunt = lookFor('mob', ARCHETYPE_INFO.grunt)
  const gunner = lookFor('mob', ARCHETYPE_INFO.gunner)
  assert.equal(grunt.tint, undefined)
  assert.notEqual(gunner.tint, undefined)
  assert.notEqual(gunner.tint, 0xffffff)
})
