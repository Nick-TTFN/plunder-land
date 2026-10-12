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
 * The Compactor's slam and knockback (decision #51, task l1-6; radial since
 * pve-2): the disc, the hit, the knockback's direction and landing rule, the
 * wind-up hold, and the client's cells.
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

test('the Compactor\'s row: a 2-ring disc, 20 damage, 2500 ms, knockback 2, impact 750 ms, hold 1250, cast within 2, chase 130 (pve-2, Nick 2026-10-12)', () => {
  const mob = addMob(cell(0))
  const { skill, routine } = shockwaveOf(mob)
  assert.deepEqual(ARCHETYPE_INFO.compactor.attack, { kind: 'disc', rings: 2 })
  assert.equal(skill.rings, 2)
  assert.deepEqual([skill.damage, skill.cooldown, skill.knockback, skill.impactMs, routine.withinCells, routine.holdMs], [20, 2500, 2, 750, 2, 1250])
  const guard = ARCHETYPES.compactor.routines.find((r) => r.kind === 'guard') as { acquire: number, lose: number, chaseSpeed: number }
  assert.deepEqual([guard.acquire, guard.lose, guard.chaseSpeed], [4, 5, 130])
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

// --- the knockback direction -----------------------------------------------------

const key = (c: { x: number, y: number }): string => `${c.x},${c.y}`
/** Every cell within `rings` of `centre`, centre included. */
const disc = (centre: Vector, rings: number): Vector[] => Client.discCells(centre, rings).map((c) => new Vector(c.x, c.y))
/** A tie cell: exactly between DIRECTIONS[d] and DIRECTIONS[d + 1], `k` steps along each. */
const between = (centre: Vector, d: number, k: number): Vector => {
  const a = Hex.DIRECTIONS[d]
  const b = Hex.DIRECTIONS[(d + 1) % 6]
  return new Vector(centre.x + k * (a.x + b.x), centre.y + k * (a.y + b.y))
}
const flat = (): number => 2

test('every cell of rings 1-3 is knocked outward: away from the centre, and on the nearer axis', () => {
  const centre = MID
  let ties = 0
  for (const c of disc(centre, 3)) {
    const ring = Hex.distance(c, centre)
    if (ring === 0) continue
    const d = Shockwave.outwardDirection(centre, c, 4, flat)
    assert.ok(d >= 0 && d < 6)
    // One step that way is one ring further out: never sideways, never in.
    assert.equal(Hex.distance(Hex.neighbour(c, d), centre), ring + 1, `cell ${key(c)} direction ${d}`)
    const isTie = [0, 1, 2, 3, 4, 5].some((t) => same(between(centre, t, ring / 2), c))
    if (isTie) {
      ties++
      continue
    }
    // Off the ties the nearer axis is the snapped angle, which can't round wrong there.
    assert.equal(d, World.FACING_INDEX(Hex.toPosition(c).sub(Hex.toPosition(centre))), `cell ${key(c)}`)
  }
  assert.equal(ties, 6, 'ties are ring 2\'s six edge cells only')
})

test('ring 1 and the axes are exact: the direction from the centre to the cell', () => {
  for (let d = 0; d < 6; d++) {
    for (let k = 1; k <= 3; k++) {
      const step = Hex.DIRECTIONS[d]
      const c = new Vector(MID.x + k * step.x, MID.y + k * step.y)
      assert.equal(Shockwave.outwardDirection(MID, c, (d + 3) % 6, flat), d)
    }
  }
})

test('a tie on ring 2 goes the way whose walk lands further, and on equal reach the lower index', () => {
  for (let d = 0; d < 6; d++) {
    const next = (d + 1) % 6
    const low = Math.min(d, next)
    const high = Math.max(d, next)
    const c = between(MID, d, 1)
    assert.equal(Hex.distance(c, MID), 2)
    assert.equal(Shockwave.outwardDirection(MID, c, 0, flat), low, `equal reach ${d}/${next}`)
    assert.equal(Shockwave.outwardDirection(MID, c, 0, (x) => x === high ? 2 : 1), high, `${high} lands further`)
    assert.equal(Shockwave.outwardDirection(MID, c, 0, (x) => x === low ? 1 : 0), low, `${low} lands further`)
    assert.equal(Shockwave.outwardDirection(MID, c, 0, (x) => x === high ? 1 : 0), high, `${high} lands further, by one`)
  }
})

test('on the centre cell, the direction given (the Compactor\'s facing at the cast)', () => {
  for (let d = 0; d < 6; d++) assert.equal(Shockwave.outwardDirection(MID, MID, d, flat), d)
})

test('reachOf is Player.knockback\'s walk: the same landing on open ground and at every kind of stop', () => {
  voidAt(cell(2))
  wallAt(cell(-1, 1))
  stoneAt(cell(0, -2))
  const portal = Hex.toPosition(cell(-2))
  World.addObstacle(new Portal(portal.x, portal.y, MIDDLE, TOP))
  const exit = Hex.toPosition(cell(2, -2))
  World.addObstacle(new Exit(exit.x, exit.y, TOP))
  // A portal on the middle layer whose arrival is cell(1, 2) on top.
  const arrivalPortal = Hex.toPosition(cell(0, 2))
  World.addObstacle(new Portal(arrivalPortal.x, arrivalPortal.y, TOP, MIDDLE))
  let stops = 0
  for (const archetype of [ARCHETYPES.peep, ARCHETYPES.hopper]) {
    for (const from of disc(MID, 1)) {
      if (World.isBlocked(from.x, from.y, TOP)) continue
      for (let d = 0; d < 6; d++) {
        for (const cells of [1, 2, 3]) {
          World.PLAYERS.length = 0
          const player = addPlayer(from, archetype)
          const reach = Shockwave.reachOf(player, d, cells)
          const landing = player.knockback(d, cells)
          const moved = landing === undefined ? 0 : Hex.distance(landing, from)
          assert.equal(reach, moved, `${archetype.key} from ${key(from)} direction ${d} cells ${cells}`)
          if (reach < cells) stops++
        }
      }
    }
  }
  assert.ok(stops > 20, `only ${stops} stopped walks`)
})

// --- the slam --------------------------------------------------------------------

/** A Compactor at cell(0) aimed at `aim` (default two cells east), cast and resolved. */
function slam (aim: Vector = cell(2)): { mob: Mob, skill: Shockwave } {
  const mob = addMob(cell(0))
  const { skill } = shockwaveOf(mob)
  assert.equal(skill.execute(aim), true)
  Timers.run(Date.now() + skill.impactMs)
  assert.equal(effects.filter((e) => e.type === NPC_EFFECT.compactorShockwave).length, 0, 'effect 14 is never sent')
  return { mob, skill }
}

const damageOf = (p: Player, before: number): number => before - (p.hp + p.armor)

test('the slam hits every player on the 2-ring disc, the centre included, once each, and nobody off it', () => {
  const players: Player[] = []
  for (const at of disc(cell(0), 4)) players.push(addPlayer(at))
  const before = new Map(players.map((p) => [p, { hp: p.hp + p.armor, cell: p.cell }]))
  slam()
  for (const p of players) {
    const was = before.get(p) as { hp: number, cell: Vector }
    const onDisc = Hex.distance(was.cell, cell(0)) <= 2
    assert.equal(damageOf(p, was.hp), onDisc ? 20 : 0, `player on ${key(was.cell)}`)
  }
  // 19 cells, one player on each, all hit.
  assert.equal(players.filter((p) => damageOf(p, (before.get(p) as { hp: number }).hp) > 0).length, 19)
})

test('each survivor is knocked 2 cells radially away from the centre, the ties the lower index on open ground', () => {
  const players: Player[] = []
  for (const at of disc(cell(0), 2)) {
    if (same(at, cell(0))) continue
    players.push(addPlayer(at))
  }
  const from = new Map(players.map((p) => [p, p.cell]))
  slam()
  for (const p of players) {
    const was = from.get(p) as Vector
    const d = Shockwave.outwardDirection(cell(0), was, 0, flat)
    const want = Hex.neighbour(Hex.neighbour(was, d), d)
    assert.deepEqual(p.position, Hex.toPosition(want), `from ${key(was)}`)
    assert.equal(Hex.distance(want, cell(0)), Hex.distance(was, cell(0)) + 2, `from ${key(was)}: not outward`)
  }
  assert.equal(knocks().length, 18)
})

test('a player on the Compactor\'s own cell is hit once and knocked along its facing at the cast, toward its target', () => {
  const under = addPlayer(cell(0))
  const before = under.hp + under.armor
  // Aimed south-east: the Compactor turns that way at the cast.
  slam(cell(0, 2))
  assert.equal(damageOf(under, before), 20, 'hit twice when knocked onto another disc cell, or not at all')
  assert.deepEqual(under.position, Hex.toPosition(cell(0, 2)))
})

test('with its target on its own cell the Compactor keeps its facing, and a player there goes that way', () => {
  const under = addPlayer(cell(0))
  const mob = addMob(cell(0))
  mob.facing = Hex.toPosition(cell(-1)).sub(Hex.toPosition(cell(0))).normalised()
  const { skill } = shockwaveOf(mob)
  assert.equal(skill.execute(cell(0)), true)
  Timers.run(Date.now() + skill.impactMs)
  assert.deepEqual(under.position, Hex.toPosition(cell(-2)))
})

test('a ring-2 tie goes the way that lands further when the lower index is walled', () => {
  // Between E and SE: E is index 0, so on open ground it goes east.
  const open = addPlayer(cell(1, 1))
  // Between NE (5) and E (0): 0 is the lower index; a wall right after it on 0's way.
  const walled = addPlayer(cell(2, -1))
  wallAt(cell(3, -1))
  slam()
  assert.deepEqual(open.position, Hex.toPosition(cell(3, 1)))
  assert.deepEqual(walled.position, Hex.toPosition(cell(4, -3)), 'went east into the wall (reach 0) instead of north-east (reach 2)')
})

test('the slam lands at impactMs after the cast, not before; effect 20 on the Compactor, aimed at the disc\'s centre', () => {
  const mob = addMob(cell(0))
  const player = addPlayer(cell(2))
  const { skill } = shockwaveOf(mob)
  const castAt = Date.now()
  assert.equal(skill.execute(cell(2)), true)
  const cast = effects.filter((e) => e.type === NPC_EFFECT.compactorSlam)
  assert.equal(cast.length, 1)
  assert.equal(cast[0].originator, mob)
  assert.equal(cast[0].lifetime, skill.impactMs)
  assert.ok(same(cast[0].aim as Vector, cell(0)))
  assert.equal(effects.filter((e) => e.type === NPC_EFFECT.compactorShockwave).length, 0, 'effect 14 is never sent')
  Timers.run(castAt + skill.impactMs - 20)
  assert.deepEqual(player.position, Hex.toPosition(cell(2)), 'hit before the impact frame')
  Timers.run(Date.now() + skill.impactMs)
  assert.deepEqual(player.position, Hex.toPosition(cell(4)))
  assert.equal(skill.windingUp, false)
  assert.equal(skill.execute(cell(2)), false, 'recast inside the cooldown')
})

test('mobs are never hurt or moved by the slam', () => {
  const grunt = addMob(cell(1), ARCHETYPES.grunt)
  const other = addMob(cell(-1, 2), ARCHETYPES.compactor)
  const hp = [grunt.hp, other.hp]
  slam()
  assert.deepEqual([grunt.hp, other.hp], hp)
  assert.deepEqual(grunt.position, Hex.toPosition(cell(1)))
  assert.deepEqual(other.position, Hex.toPosition(cell(-1, 2)))
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

test('an exited player on the disc is neither hit nor moved', () => {
  const player = addPlayer(cell(1))
  const before = player.hp + player.armor
  player.exited = true
  slam()
  assert.equal(player.hp + player.armor, before)
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
  const before = player.hp + player.armor
  const { skill } = shockwaveOf(mob)
  skill.execute(cell(1))
  // Its destroy cancels the timers it owns (GameObject.destroy).
  mob.hit(1000)
  Timers.run(Date.now() + skill.impactMs)
  assert.deepEqual(player.position, Hex.toPosition(cell(1)))
  assert.equal(player.hp + player.armor, before)
})

test('the Compactor casts at a target within 2 rings, then stands still through the impact until its hold ends at 1250', () => {
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
  mob.update(0.25)
  assert.deepEqual(mob.position, held, 'chased during the wind-up')
  Timers.run(Date.now() + skill.impactMs)
  assert.equal(skill.windingUp, false)
  mob.update(0.25)
  assert.equal(mob.stepGoal, undefined, 'the guard steers again at the impact, before the hold ends')
  assert.deepEqual(mob.position, held, 'moved after the impact, inside the hold')
  const routine = mob.routines.find((r): r is ShockwaveRoutine => r instanceof ShockwaveRoutine) as ShockwaveRoutine
  assert.equal(routine.holdMs, 1250)
  Timers.run(Date.now() + routine.holdMs)
  mob.update(0.25)
  assert.ok(mob.stepGoal !== undefined, 'the guard does not steer again after the hold')
})

// --- the client's cells ----------------------------------------------------------

/**
 * What the client draws from effect 20: the mirror's disc round the cell the
 * record carries (`CompactorSlamEffect`), whatever cell it places the
 * Compactor on.
 */
function drawn (aim: Vector): string[] {
  const attack = ARCHETYPE_INFO.compactor.attack as Client.AttackShape
  return Client.attackCells(attack, { x: aim.x, y: aim.y })
    .filter((c) => Hex.onMap(c.x, c.y, World.mapSize))
    .map(key).sort()
}

test('a Compactor cast mid-step: the disc is round the cell it steps into, and the client draws exactly the cells hit', () => {
  const mob = addMob(cell(0))
  // Mid-step into cell(1, 0): still filed on cell(0), drawn there by a lagging client.
  mob.stepTo = cell(1)
  assert.ok(same(mob.cell, cell(0)))
  const players: Player[] = []
  for (const at of disc(cell(0), 4)) players.push(addPlayer(at))
  const before = new Map(players.map((p) => [p, { hp: p.hp + p.armor, cell: p.cell }]))
  const { skill } = shockwaveOf(mob)
  assert.equal(skill.execute(cell(3)), true)
  const aim = effects.find((e) => e.type === NPC_EFFECT.compactorSlam)?.aim
  assert.ok(aim !== undefined && same(aim, cell(1)), 'effect 20 is not aimed at the cast\'s centre')
  Timers.run(Date.now() + skill.impactMs)
  const hit = players.filter((p) => {
    const was = before.get(p) as { hp: number }
    return p.hp + p.armor < was.hp
  }).map((p) => key((before.get(p) as { cell: Vector }).cell)).sort()
  assert.equal(hit.length, 19)
  assert.deepEqual(hit, drawn(aim), 'the client draws other cells than the server hits')
  assert.deepEqual(hit, disc(cell(1), 2).map(key).sort())
})

test('at the map\'s edge both sides keep only the disc\'s cells on the map', () => {
  let edge = MID
  while (Hex.onMap(edge.x + 1, edge.y, World.mapSize)) edge = new Vector(edge.x + 1, edge.y)
  World.PLAYERS.length = 0
  const mob = addMob(edge)
  const players = disc(edge, 2).filter((c) => Hex.onMap(c.x, c.y, World.mapSize)).map((c) => addPlayer(c))
  const before = new Map(players.map((p) => [p, { hp: p.hp + p.armor, cell: p.cell }]))
  const { skill } = shockwaveOf(mob)
  assert.equal(skill.execute(Hex.neighbour(edge, 3)), true)
  const aim = effects.find((e) => e.type === NPC_EFFECT.compactorSlam)?.aim as Vector
  Timers.run(Date.now() + skill.impactMs)
  const hit = players.filter((p) => p.hp + p.armor < (before.get(p) as { hp: number }).hp).map((p) => key((before.get(p) as { cell: Vector }).cell)).sort()
  assert.ok(hit.length < 19)
  assert.deepEqual(hit, drawn(aim))
})

test('the threat marker reaches the disc\'s rings', () => {
  const info = ARCHETYPE_INFO.compactor
  assert.equal(Client.threatRingsOf(info.key, info.kind, info.rangedCells, info.attack as Client.AttackShape), 2)
})

// The old line (effect 14) is drawn by the client for one release, for a new
// client on an old server; no server sends it now. Its cells are worked back
// from the tip the old server aimed it at.
test('the legacy client lineFromTip still draws the old 3-cell line from an old server\'s tip, even a cell off', () => {
  const onMap = (q: number, r: number): boolean => Hex.onMap(q, r, World.mapSize)
  for (const origin of [MID, new Vector(MID.x - 7, MID.y + 3)]) {
    for (let d = 0; d < 6; d++) {
      const step = Hex.DIRECTIONS[d]
      const tip = new Vector(origin.x + step.x * 3, origin.y + step.y * 3)
      const want = [1, 2, 3].map((i) => [origin.x + step.x * i, origin.y + step.y * i])
      for (const seen of [origin, ...Hex.DIRECTIONS.map((_, i) => Hex.neighbour(origin, i))]) {
        assert.deepEqual(Client.lineFromTip(seen, tip, 3, onMap).map((c) => [c.x, c.y]), want)
      }
    }
  }
})
