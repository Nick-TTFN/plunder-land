import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import type Player from '../objects/player'
import Mob from '../objects/mob'
import Consumable from '../objects/consumable'
import { GameObject } from '../objects/gameobject'
import { ARCHETYPES } from './archetypes'
import { ARCHETYPE_INFO, SELECTABLE_ROBOTS } from '../utils/archetypes'
import { MeleeAttack } from '../skills/meleeattack'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { decodeRecord } from '../../../../plunder-land-client/src/net/records'

/**
 * robot-select (#42): a join names the robot picked in the lobby; the stats
 * the lobby shows are the ones the server plays (they are one table, the
 * mirror's `stats`), and `damageScale` scales every skill's damage.
 */

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  return { socket, fire: (event, data) => { handlers[event](data) } }
}

beforeEach(() => {
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.FINISHED.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
})

function setup (): Multiplayer {
  const multiplayer = new Multiplayer(250, okRedis())
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.BLOCKED.clear()
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  ;(world as unknown as { refillLayer: () => void }).refillLayer = () => {}
  return multiplayer
}

let joins = 0
function join (multiplayer: Multiplayer, robot: unknown): Player {
  const s = fakeSocket(`rob${joins}`)
  multiplayer.onConnect(s.socket)
  const start: Record<string, unknown> = { id: (0xb00000 + joins++).toString(16), name: 'ROB' }
  if (robot !== undefined) start.robot = robot
  s.fire('start_requested', start)
  return World.PLAYERS[World.PLAYERS.length - 1]
}

test('magnet is id 3, hopper 4, waddle 5, and every robot is selectable', () => {
  assert.equal(ARCHETYPE_INFO.magnet.id, 3)
  assert.equal(ARCHETYPE_INFO.magnet.kind, 'robot')
  assert.equal(ARCHETYPE_INFO.hopper.id, 4)
  assert.equal(ARCHETYPE_INFO.waddle.id, 5)
  // #43, deliberate: periscope (2) joined. 2026-10-01, deliberate: hopper and waddle joined.
  assert.deepEqual([...SELECTABLE_ROBOTS], ['peep', 'periscope', 'magnet', 'hopper', 'waddle'])
})

test('each robot\'s server row plays the stats the lobby shows', () => {
  for (const key of SELECTABLE_ROBOTS) {
    const stats = ARCHETYPE_INFO[key].stats
    assert.ok(stats !== null, `${key} has no stats`)
    const row = ARCHETYPES[key as keyof typeof ARCHETYPES]
    assert.equal(row.maxHp, stats.maxHp, key)
    assert.equal(row.armor.max, stats.armor, key)
    assert.equal(row.speed, stats.speed, key)
    assert.equal(row.pickupReach, stats.pickupReach, key)
    assert.equal(row.damageScale, stats.damageScale, key)
    assert.equal(stats.speed % 10, 0, `${key}: maxVelocity goes out as /10`)
  }
  // Decision #42.
  assert.deepEqual({ ...ARCHETYPE_INFO.peep.stats }, { maxHp: 100, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  assert.deepEqual({ ...ARCHETYPE_INFO.magnet.stats }, { maxHp: 90, armor: 25, speed: 140, pickupReach: 3, damageScale: 1 })
  // Decision #43.
  assert.deepEqual({ ...ARCHETYPE_INFO.periscope.stats }, { maxHp: 80, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  // 10 (Nick, 2026-10-03: "limit it to 10"); 11 from #43, held there by the interest box until #48.
  assert.equal(ARCHETYPE_INFO.periscope.vision, 10)
  assert.equal(ARCHETYPE_INFO.peep.vision, 6)
  // Decision #16's table, standard vision from #43 (2026-10-01).
  assert.deepEqual({ ...ARCHETYPE_INFO.hopper.stats }, { maxHp: 90, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  assert.deepEqual({ ...ARCHETYPE_INFO.waddle.stats }, { maxHp: 130, armor: 100, speed: 120, pickupReach: 1, damageScale: 1 })
  assert.equal(ARCHETYPE_INFO.hopper.vision, 6)
  assert.equal(ARCHETYPE_INFO.waddle.vision, 6)
})

test('a join asking for magnet is a magnet, and its create record says so', () => {
  const player = join(setup(), 'magnet')
  assert.equal(player.archetype, ARCHETYPES.magnet)
  assert.equal(player.maxHp, 90)
  assert.equal(player.maxArmor, 25)
  assert.equal(player.maxVelocity, 140)
  for (const fields of [player.allFields, player.allFieldsOwn]) {
    const record = decodeRecord(new Uint8Array(player.serialiseBinary(fields) as Buffer), GameObject.fieldOrder)
    assert.equal(record.archetype, 3)
    assert.equal(record.maxHp, 90)
  }
})

test('anything but a selectable robot joins as peep, and never refuses the join', () => {
  const multiplayer = setup()
  for (const robot of [undefined, 'peep', 'jumper', 'grunt', 'boss', 'MAGNET', 3, null, {}, ['magnet']]) {
    const before = World.PLAYERS.length
    const player = join(multiplayer, robot)
    assert.equal(World.PLAYERS.length, before + 1, `refused ${JSON.stringify(robot)}`)
    assert.equal(player.archetype, ARCHETYPES.peep, JSON.stringify(robot))
  }
})

test('parseStart passes the robot on raw, and leaves it out when none was sent', () => {
  assert.deepEqual(Multiplayer.parseStart({ id: 'abc123', name: 'N', robot: 'magnet' }), { id: 'abc123', name: 'N', robot: 'magnet' })
  assert.deepEqual(Multiplayer.parseStart({ id: 'abc123', name: 'N' }), { id: 'abc123', name: 'N' })
})

test('a magnet takes loot three rings away, not four', () => {
  const multiplayer = setup()
  const player = join(multiplayer, 'magnet')
  const cell = Hex.toCell(player.position)
  const at = (rings: number): Vector => Hex.toPosition(new Vector(cell.x + rings, cell.y))
  const near = new Consumable(at(3).x, at(3).y, player.tag, 20 as never, 10)
  const far = new Consumable(at(4).x, at(4).y, player.tag, 20 as never, 10)
  World.PICKUPS.push(World.CONSUMABLES, near)
  World.PICKUPS.push(World.CONSUMABLES, far)
  player.update(0.25)
  assert.ok(near.destroyed, 'missed loot three rings away')
  assert.ok(!far.destroyed, 'took loot four rings away')
})

test('damageScale multiplies a skill\'s damage', () => {
  const multiplayer = setup()
  const player = join(multiplayer, 'peep')
  const hitFor = (scale: number): number => {
    const mob = new Mob(player.position.x + 45, player.position.y, player.tag, ARCHETYPES.boss)
    World.MOBS.push(mob)
    player.archetype = { ...ARCHETYPES.peep, damageScale: scale }
    const melee = new MeleeAttack(player)
    const before = mob.hp
    melee.execute()
    World.MOBS.length = 0
    return before - mob.hp
  }
  const base = hitFor(1)
  assert.ok(base > 0)
  assert.equal(hitFor(2), 2 * base)
  assert.equal(hitFor(0.5), Math.floor(0.5 * base))
})

test('every skill that deals damage goes through Skill.dealt', () => {
  const dir = joinPath(__dirname, '..', 'skills')
  const dealing: string[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && f !== 'skill.ts')) {
    const source = readFileSync(joinPath(dir, file), 'utf8')
    const hits = source.match(/\.hit\(|setEffect\(/g)?.length ?? 0
    if (hits === 0) continue
    dealing.push(file)
    const dealt = source.match(/\.hit\(this\.dealt\(|setEffect\(this\.dealt\(/g)?.length ?? 0
    assert.equal(dealt, hits, `${file}: a hit that skips this.dealt`)
  }
  // So the check can't pass by finding nothing.
  assert.ok(dealing.length >= 6, `only ${dealing.join(', ')}`)
})
