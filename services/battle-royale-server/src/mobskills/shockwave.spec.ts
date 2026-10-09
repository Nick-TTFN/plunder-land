import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Mob from '../objects/mob'
import Exit from '../objects/exit'
import Portal from '../objects/portal'
import Obstacle from '../objects/obstacle'
import { type Unit } from '../objects/unit'
import { ARCHETYPES } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { Shockwave, ShockwaveRoutine } from './shockwave'
// The client's port. It imports nothing, so this pulls no pixi into the server.
import * as Client from '../../../../plunder-land-client/src/vfx/cells'

/**
 * The Compactor's shockwave and knockback (decision #51, task l1-6): the
 * line, the hit, the landing rule, the wind-up hold, and the client's cells.
 * The client's `LocalPlayer.knockback` against `Player.knockback` is in
 * `extract.spec.ts` with the rest of the movement mirror.
 */

const [TOP, MIDDLE] = World.LAYERS.map((layer) => layer.tag)

interface Sent { type: number, originator: Unit, lifetime: number, aim: Vector | undefined }
let effects: Sent[] = []

beforeEach(() => {
  effects = []
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop,
    update: noop,
    destroy: noop,
    effect: (type: number, originator: Unit, lifetime: number, aim?: Vector) => { effects.push({ type, originator, lifetime, aim }) },
    effectAt: noop
  } as unknown as Multiplayer
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.VOIDS.clear()
  World.OBSTACLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.GEAR.length = 0
  World.AREA_EFFECT.length = 0
  World.STEPS.clear()
  Timers.clear()
})

const MID = Hex.toCell(new Vector(2000, 2000))
const cell = (dq: number, dr: number = 0): Vector => new Vector(MID.x + dq, MID.y + dr)
const EAST = 0
const SE = 1

function addPlayer (at: Vector, archetype = ARCHETYPES.peep, tag = TOP): Player {
  const p = Hex.toPosition(at)
  const player = new Player(p.x, p.y, tag, `p${World.PLAYERS.length}`, archetype)
  World.addUnit(World.PLAYERS as unknown as Unit[], player)
  return player
}

function addMob (at: Vector, archetype = ARCHETYPES.compactor, tag = TOP): Mob {
  const p = Hex.toPosition(at)
  const mob = new Mob(p.x, p.y, tag, archetype)
  World.addUnit(World.MOBS, mob)
  return mob
}

function voidAt (at: Vector, tag = TOP): void {
  let voids = World.VOIDS.get(tag)
  if (voids === undefined) {
    voids = new Set()
    World.VOIDS.set(tag, voids)
  }
  voids.add(Hex.key(at.x, at.y))
  World.block(at.x, at.y, tag, null)
}

/** A wall cell (decision #44): blocked, not void. */
function wallAt (at: Vector, tag = TOP): void {
  World.block(at.x, at.y, tag, null)
}

/** A blocking obstacle standing on the cell, as a StoneWall stone does. */
function stoneAt (at: Vector, tag = TOP): void {
  const p = Hex.toPosition(at)
  World.addObstacle(new Obstacle(p.x, p.y, tag))
}

function shockwaveOf (mob: Mob): { skill: Shockwave, routine: ShockwaveRoutine } {
  const routine = mob.routines.find((r): r is ShockwaveRoutine => r instanceof ShockwaveRoutine)
  assert.ok(routine !== undefined, 'the Compactor has no ShockwaveRoutine')
  return { skill: routine.skill, routine }
}

const knocks = (): Sent[] => effects.filter((e) => e.type === NPC_EFFECT.knockback)
const same = (a: Vector, b: Vector): boolean => a.x === b.x && a.y === b.y

// --- the row ---------------------------------------------------------------------

test('the Compactor\'s row: a 3-cell line, 35 damage, 3600 ms, knockback 2, impact 1215 ms, cast within 2 (PROVISIONAL l1-0)', () => {
  const mob = addMob(cell(0))
  const { skill, routine } = shockwaveOf(mob)
  assert.equal(skill.length, 3)
  assert.deepEqual([skill.damage, skill.cooldown, skill.knockback, skill.impactMs, routine.withinCells], [35, 3600, 2, 1215, 2])
  assert.equal(ARCHETYPES.compactor.contact.damage, 0, 'the slam is its whole threat (l1-0: no contact damage)')
})

// --- the landing rule (Player.knockback) ----------------------------------------

test('knockback on open ground moves the player K cells, to the centre, stopped, and tells its holders where', () => {
  const player = addPlayer(cell(0))
  player.setDestination(cell(0, 5).x, cell(0, 5).y)
  assert.ok(player.path.length > 0)
  const landing = player.knockback(EAST, 2)
  assert.ok(landing !== undefined && same(landing, cell(2)))
  assert.deepEqual(player.position, Hex.toPosition(cell(2)))
  assert.deepEqual([player.path, player.waypoints], [[], []], 'the route did not end')
  assert.equal(knocks().length, 1)
  assert.equal(knocks()[0].originator, player)
  assert.ok(knocks()[0].aim !== undefined && same(knocks()[0].aim as Vector, cell(2)))
  assert.ok(World.UNITS_ON(cell(2).x, cell(2).y, TOP).includes(player), 'not refiled on its landing cell')
})

test('knockback stops before a valley: never into the void', () => {
  voidAt(cell(2))
  const player = addPlayer(cell(0))
  assert.ok(same(player.knockback(EAST, 2) as Vector, cell(1)))
})

test('knockback stops before a wall for Peep; Hopper passes it and may land on one', () => {
  wallAt(cell(1))
  const peep = addPlayer(cell(0))
  assert.equal(peep.knockback(EAST, 2), undefined)
  const hopper = addPlayer(cell(0, 2), ARCHETYPES.hopper)
  wallAt(cell(1, 2))
  wallAt(cell(2, 2))
  assert.ok(same(hopper.knockback(EAST, 2) as Vector, cell(2, 2)), 'Hopper stopped at a wall')
})

test('knockback stops before a stone for Peep; Hopper passes it', () => {
  stoneAt(cell(2))
  const peep = addPlayer(cell(0))
  assert.ok(same(peep.knockback(EAST, 2) as Vector, cell(1)))
  stoneAt(cell(1, 2))
  const hopper = addPlayer(cell(0, 2), ARCHETYPES.hopper)
  assert.ok(same(hopper.knockback(EAST, 2) as Vector, cell(2, 2)))
})

test('knockback stops before a portal and before an exit: it never hops a layer or lands on a pad', () => {
  const portal = Hex.toPosition(cell(2))
  World.addObstacle(new Portal(portal.x, portal.y, MIDDLE, TOP))
  const player = addPlayer(cell(0))
  assert.ok(same(player.knockback(EAST, 2) as Vector, cell(1)))
  assert.equal(player.tag, TOP)

  const exit = Hex.toPosition(cell(1, 2))
  World.addObstacle(new Exit(exit.x, exit.y, TOP))
  const other = addPlayer(cell(0, 2))
  assert.equal(other.knockback(EAST, 2), undefined, 'knocked onto an exit')
  assert.equal(knocks().length, 1)
})

test('knockback stops before a portal\'s arrival cell', () => {
  // A portal on the middle layer whose arrival (its east neighbour) is cell(2) on top.
  const portal = Hex.toPosition(cell(1))
  World.addObstacle(new Portal(portal.x, portal.y, TOP, MIDDLE))
  assert.ok(World.isArrival(cell(2).x, cell(2).y, TOP))
  const player = addPlayer(cell(0))
  assert.ok(same(player.knockback(EAST, 2) as Vector, cell(1)))
})

test('knockback stops at the map\'s edge', () => {
  // The last column on the east edge of the middle row.
  let edge = MID
  while (Hex.onMap(edge.x + 1, edge.y, World.mapSize)) edge = new Vector(edge.x + 1, edge.y)
  const player = addPlayer(new Vector(edge.x - 1, edge.y))
  assert.ok(same(player.knockback(EAST, 2) as Vector, edge))
  const onEdge = addPlayer(edge)
  assert.equal(onEdge.knockback(EAST, 2), undefined)
})

test('nothing free ahead: no move, no effect, and the route goes on', () => {
  voidAt(cell(1))
  const player = addPlayer(cell(0))
  player.setDestination(cell(0, 4).x, cell(0, 4).y)
  const path = player.path.slice()
  assert.equal(player.knockback(EAST, 2), undefined)
  assert.deepEqual(player.position, Hex.toPosition(cell(0)))
  assert.deepEqual(player.path, path)
  assert.equal(knocks().length, 0)
})

test('knockback mid-dash ends the dash with the route', () => {
  const player = addPlayer(cell(0))
  player.setDestination(cell(6).x, cell(6).y)
  assert.equal(player.dash(), true)
  player.update(0.1)
  assert.ok(player.dashLeft > 0)
  const landing = player.knockback(SE, 2)
  assert.ok(landing !== undefined)
  assert.equal(player.dashLeft, 0)
  assert.deepEqual(player.path, [])
  player.update(0.25)
  assert.deepEqual(player.position, Hex.toPosition(landing), 'walked on after the knockback')
})

// --- the slam --------------------------------------------------------------------

/** A Compactor at cell(0) aimed east at a player on cell(2), cast and resolved. */
function slam (): { mob: Mob, skill: Shockwave } {
  const mob = addMob(cell(0))
  const { skill } = shockwaveOf(mob)
  assert.equal(skill.execute(cell(2)), true)
  Timers.run(Date.now() + skill.impactMs)
  return { mob, skill }
}

test('the slam hits players on the line and knocks each one back along it; nobody off the line', () => {
  const near = addPlayer(cell(1))
  const far = addPlayer(cell(3))
  const beside = addPlayer(cell(1, 1))
  const behind = addPlayer(cell(-1))
  const before = [near, far, beside, behind].map((p) => p.hp + p.armor)
  slam()
  assert.equal(before[0] - (near.hp + near.armor), 35)
  assert.equal(before[1] - (far.hp + far.armor), 35)
  assert.equal(beside.hp + beside.armor, before[2])
  assert.equal(behind.hp + behind.armor, before[3])
  assert.deepEqual(near.position, Hex.toPosition(cell(3)), 'cell 1 + 2 lands on the line\'s end (l1-0)')
  assert.deepEqual(far.position, Hex.toPosition(cell(5)))
  assert.deepEqual(beside.position, Hex.toPosition(cell(1, 1)))
})

test('a player knocked onto a later line cell is hit once', () => {
  const near = addPlayer(cell(1))
  const before = near.hp + near.armor
  slam()
  assert.equal(before - (near.hp + near.armor), 35)
})

test('the slam lands at impactMs after the cast, not before; the effect is aimed at the line\'s tip', () => {
  const mob = addMob(cell(0))
  const player = addPlayer(cell(2))
  const { skill } = shockwaveOf(mob)
  const castAt = Date.now()
  assert.equal(skill.execute(cell(2)), true)
  const cast = effects.filter((e) => e.type === NPC_EFFECT.compactorShockwave)
  assert.equal(cast.length, 1)
  assert.equal(cast[0].originator, mob)
  assert.equal(cast[0].lifetime, skill.impactMs)
  assert.ok(same(cast[0].aim as Vector, cell(3)))
  Timers.run(castAt + skill.impactMs - 20)
  assert.deepEqual(player.position, Hex.toPosition(cell(2)), 'hit before the impact frame')
  Timers.run(Date.now() + skill.impactMs)
  assert.deepEqual(player.position, Hex.toPosition(cell(4)))
  assert.equal(skill.windingUp, false)
  assert.equal(skill.execute(cell(2)), false, 'recast inside the cooldown')
})

test('mobs are never hurt or moved by the slam', () => {
  const grunt = addMob(cell(1), ARCHETYPES.grunt)
  const hp = grunt.hp
  slam()
  assert.equal(grunt.hp, hp)
  assert.deepEqual(grunt.position, Hex.toPosition(cell(1)))
  assert.equal(knocks().length, 0)
})

test('a player the slam kills is credited to the Compactor and not moved', () => {
  const player = addPlayer(cell(1))
  player.hp = 10
  player.armor = 0
  const { mob } = slam()
  assert.equal(player.destroyed, true)
  assert.equal(player.killer, mob)
  assert.equal(player.killedBy, 'mob')
  assert.equal(knocks().length, 0)
})

test('the slam cancels an extraction channel on the pad it knocks the player off', () => {
  const pad = Hex.toPosition(cell(1))
  World.addObstacle(new Exit(pad.x, pad.y, TOP))
  const player = addPlayer(cell(1))
  player.update(0.25)
  player.update(0.25)
  assert.ok(player.extractElapsed !== undefined && player.extractElapsed > 0)
  slam()
  assert.equal(player.extractElapsed, undefined)
  assert.deepEqual(player.position, Hex.toPosition(cell(3)))
  player.update(0.25)
  assert.equal(player.extractElapsed, undefined, 'channelling off the pad')
})

test('killing the Compactor during the wind-up cancels the slam', () => {
  const mob = addMob(cell(0))
  const player = addPlayer(cell(1))
  const { skill } = shockwaveOf(mob)
  skill.execute(cell(1))
  // Its destroy cancels the timers it owns (GameObject.destroy).
  mob.hit(1000)
  Timers.run(Date.now() + skill.impactMs)
  assert.deepEqual(player.position, Hex.toPosition(cell(1)))
})

test('the Compactor casts at a target within 2 rings, then stands still until the impact', () => {
  const mob = addMob(cell(0))
  const player = addPlayer(cell(3))
  const { skill } = shockwaveOf(mob)
  mob.target = player
  // 3 rings: no cast; the guard closes in.
  mob.update(0.25)
  assert.equal(skill.windingUp, false)
  // Walk it until it casts.
  for (let i = 0; i < 20 && !skill.windingUp; i++) mob.update(0.25)
  assert.equal(skill.windingUp, true)
  assert.ok(Hex.distance(mob.stepTo ?? mob.cell, player.cell) <= 2)
  // Let any step in progress finish, then it holds still with the player beside it.
  for (let i = 0; i < 2; i++) mob.update(0.25)
  const held = mob.position
  player.position = Hex.toPosition(cell(-6))
  for (let i = 0; i < 2; i++) mob.update(0.25)
  assert.deepEqual(mob.position, held, 'chased during the wind-up')
  Timers.run(Date.now() + skill.impactMs)
  assert.equal(skill.windingUp, false)
  mob.update(0.25)
  assert.ok(mob.stepGoal !== undefined, 'the guard does not steer again after the impact')
})

// --- the client's cells ----------------------------------------------------------

const ORIGINS = [MID, new Vector(MID.x - 7, MID.y + 3)]

test('the client\'s lineFromTip gives the server\'s line cells from the effect\'s tip, even a cell off', () => {
  const length = (ARCHETYPE_INFO.compactor.attack as { length: number }).length
  const onMap = (q: number, r: number): boolean => Hex.onMap(q, r, World.mapSize)
  for (const origin of ORIGINS) {
    for (let d = 0; d < 6; d++) {
      const step = Hex.DIRECTIONS[d]
      const tip = new Vector(origin.x + step.x * length, origin.y + step.y * length)
      const server = Shockwave.lineCells(origin, d, length).map((c) => [c.x, c.y])
      assert.equal(server.length, length)
      for (const seen of [origin, ...Hex.DIRECTIONS.map((_, i) => Hex.neighbour(origin, i))]) {
        const client = Client.lineFromTip(seen, tip, length, onMap).map((c) => [c.x, c.y])
        assert.deepEqual(client, server, `origin ${origin.x},${origin.y} direction ${d}, client sees the caster on ${seen.x},${seen.y}`)
      }
    }
  }
})

test('at the map\'s edge both sides cut the line at the last cell on the map', () => {
  let edge = MID
  while (Hex.onMap(edge.x + 1, edge.y, World.mapSize)) edge = new Vector(edge.x + 1, edge.y)
  const origin = new Vector(edge.x - 1, edge.y)
  const server = Shockwave.lineCells(origin, EAST, 3)
  assert.deepEqual(server.map((c) => [c.x, c.y]), [[edge.x, edge.y]])
  const client = Client.lineFromTip(origin, new Vector(origin.x + 3, origin.y), 3, (q, r) => Hex.onMap(q, r, World.mapSize))
  assert.deepEqual(client.map((c) => [c.x, c.y]), [[edge.x, edge.y]])
})

test('a cast\'s tip, drawn by the client, names exactly the cells the impact hits', () => {
  for (let d = 0; d < 6; d++) {
    World.PLAYERS.length = 0
    World.MOBS.length = 0
    Timers.clear()
    effects = []
    const mob = addMob(cell(0))
    const { skill } = shockwaveOf(mob)
    // Aimed two cells out along d, a little off the axis, as a target would be.
    const aim = Hex.neighbour(Hex.neighbour(cell(0), d), d)
    // Players on every cell within 4 rings; the ones the slam hits are the line.
    const players: Player[] = []
    for (let dq = -4; dq <= 4; dq++) {
      for (let dr = -4; dr <= 4; dr++) {
        const at = cell(dq, dr)
        if (Hex.distance(at, cell(0)) > 4 || (dq === 0 && dr === 0)) continue
        players.push(addPlayer(at))
      }
    }
    const hpBefore = new Map(players.map((p) => [p, p.hp + p.armor]))
    const cellBefore = new Map(players.map((p) => [p, p.cell]))
    skill.execute(aim)
    const tip = effects.find((e) => e.type === NPC_EFFECT.compactorShockwave)?.aim
    assert.ok(tip !== undefined)
    Timers.run(Date.now() + skill.impactMs)
    const hit = players.filter((p) => p.hp + p.armor < (hpBefore.get(p) as number)).map((p) => cellBefore.get(p) as Vector)
    const drawn = Client.lineFromTip(cell(0), tip, skill.length, (q, r) => Hex.onMap(q, r, World.mapSize))
    const key = (c: { x: number, y: number }): string => `${c.x},${c.y}`
    assert.deepEqual(hit.map(key).sort(), drawn.map(key).sort(), `direction ${d}`)
  }
})
