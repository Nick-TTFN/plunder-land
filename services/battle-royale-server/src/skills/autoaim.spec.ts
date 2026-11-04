import test, { beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
import Throwable from '../objects/throwable'
import { ITEMS } from '../archetypes/archetypes'
import { RangedAttack } from './rangedattack'
import { ThrowFireball } from './throwfireball'
import { Throwicicle } from './throwicicle'
import { IceBreath } from './icebreath'
import { Dash } from './dash'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import {
  AIM_RANGE_CELLS, AUTO_AIM, AutoAim, type Cell, type TargetView,
  bombCell, clearLine, noTargetCell, rangeCellsOf, skillCell
} from '../../../../plunder-land-client/src/skills/autoaim'
import { ITEM_INFO } from '../../../../plunder-land-client/src/utils/items'

/**
 * Auto-aim (decision #58, plunder-land-client/src/skills/autoaim.ts): the one
 * shared target every aimed press fires at, and the cell each press sends.
 * The server side is unchanged; the last tests pin that an aimed press still
 * doesn't turn the robot, so Dash and StoneWall keep the movement direction.
 */

const OWN: Cell = { x: 0, y: 0 }
const TAG = 0
const NO_WALLS = (): boolean => false
/** Big enough that nothing near OWN is off the map. */
const MAP = 4000

function dist (a: Cell, b: Cell): number {
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.x + a.y - b.x - b.y)) / 2
}

/** A visible, live mob `rings` cells East of OWN, unless a cell is given. */
function unit (id: number, at: Cell | number, over: Partial<TargetView> = {}): TargetView {
  const cell = typeof at === 'number' ? { x: at, y: 0 } : at
  return { id, kind: 'mob', own: false, alive: true, seen: true, tag: TAG, cell, bodyRings: 0, ...over }
}

function pick (aim: AutoAim, views: TargetView[], isWall: (q: number, r: number) => boolean = NO_WALLS): number | undefined {
  return aim.update(OWN, TAG, views, isWall)?.id
}

test('auto-aim: the nearest enemy wins, mob and player alike', () => {
  assert.equal(pick(new AutoAim(), [unit(1, 5), unit(2, 3), unit(3, 4)]), 2)
  assert.equal(pick(new AutoAim(), [unit(1, 5), unit(2, 3, { kind: 'player' })]), 2, 'a player is a target like a mob')
  assert.equal(pick(new AutoAim(), [unit(1, 2, { kind: 'player' }), unit(2, 4)]), 1)
})

test('auto-aim: never the own robot, a unit outside the VISIBLE fog, a dead one, another layer, or a non-unit', () => {
  for (const [name, over] of [
    ['own robot', { own: true, kind: 'player' }],
    ['margin ring (not VISIBLE)', { seen: false }],
    ['killed or gone', { alive: false }],
    ['other layer', { tag: -1 }],
    ['pickup', { kind: 'pickup' }],
    ['StoneWall stone', { kind: 'obstacle' }],
    ['portal', { kind: 'portal' }],
    ['exit', { kind: 'exit' }],
    ['anything else', { kind: 'other' }]
  ] as Array<[string, Partial<TargetView>]>) {
    const aim = new AutoAim()
    assert.equal(pick(aim, [unit(1, 1, over), unit(2, 5)]), 2, `${name} was picked over a valid target`)
    assert.equal(pick(new AutoAim(), [unit(1, 1, over)]), undefined, `${name} was picked alone`)
  }
})

test('auto-aim: acquired within 6, kept at 7, dropped at 8', () => {
  const aim = new AutoAim()
  assert.equal(pick(aim, [unit(1, AUTO_AIM.ACQUIRE_RINGS + 1)]), undefined, 'acquired at 7')
  assert.equal(pick(aim, [unit(1, AUTO_AIM.ACQUIRE_RINGS)]), 1, 'not acquired at 6')
  assert.equal(AUTO_AIM.ACQUIRE_RINGS, 6)
  assert.equal(AUTO_AIM.KEEP_RINGS, 7)
  assert.equal(pick(aim, [unit(1, 7)]), 1, 'dropped at 7')
  assert.equal(pick(aim, [unit(1, 8)]), undefined, 'kept at 8')
  assert.equal(aim.targetId, undefined)
  assert.equal(pick(aim, [unit(1, 7)]), undefined, 'dropped at 8, then re-acquired at 7')
})

test('auto-aim: sticky against an enemy 1 ring closer, re-picked against one 2 rings closer', () => {
  const aim = new AutoAim()
  assert.equal(pick(aim, [unit(1, 5)]), 1)
  assert.equal(pick(aim, [unit(1, 5), unit(2, 4)]), 1, 'switched for 1 ring')
  assert.equal(pick(aim, [unit(1, 5), unit(2, 4), unit(3, 3)]), 3, 'kept against 2 rings closer')
  assert.equal(AUTO_AIM.REPICK_MARGIN, 2)
  // Sticky as it moves away, up to the keep range.
  assert.equal(pick(aim, [unit(3, 7), unit(2, 6)]), 3, 'switched for 1 ring at the edge')
})

test('auto-aim: a clear line beats a nearer walled one; the nearest is taken when none is clear', () => {
  // A wall on the cell between OWN and (2, 0).
  const wall = (q: number, r: number): boolean => q === 1 && r === 0
  assert.equal(clearLine(OWN, { x: 2, y: 0 }, wall), false)
  assert.equal(clearLine(OWN, { x: 0, y: 4 }, wall), true)
  assert.equal(clearLine(OWN, { x: 1, y: 0 }, wall), true, 'the target\'s own cell is not in the way')

  assert.equal(pick(new AutoAim(), [unit(1, 2), unit(2, { x: 0, y: 4 })], wall), 2)
  assert.equal(pick(new AutoAim(), [unit(1, 2), unit(2, 3)], wall), 1, 'none clear: the nearest')

  // Not re-picked onto a walled enemy from a clear one, however near.
  const aim = new AutoAim()
  assert.equal(pick(aim, [unit(2, { x: 0, y: 5 })], wall), 2)
  assert.equal(pick(aim, [unit(2, { x: 0, y: 5 }), unit(1, 2)], wall), 2)
})

test('auto-aim: a 7-cell body is measured to its nearest cell', () => {
  const big = unit(1, 7, { bodyRings: 1 })
  assert.equal(pick(new AutoAim(), [big]), 1, 'centre 7 off, nearest body cell 6')
  assert.equal(pick(new AutoAim(), [big, unit(2, 6)]), 1, 'ties at 6 by id')
  assert.equal(pick(new AutoAim(), [unit(1, 6), unit(2, 7, { bodyRings: 1 })]), 1)
})

test('auto-aim: ties go to the lower id, whatever the order', () => {
  assert.equal(pick(new AutoAim(), [unit(9, 3), unit(4, { x: 0, y: 3 }), unit(7, { x: -3, y: 0 })]), 4)
  assert.equal(pick(new AutoAim(), [unit(7, { x: -3, y: 0 }), unit(4, { x: 0, y: 3 }), unit(9, 3)]), 4)
})

test('auto-aim: released on death, on leaving the fog, and when gone from the list', () => {
  for (const over of [{ alive: false }, { seen: false }]) {
    const aim = new AutoAim()
    assert.equal(pick(aim, [unit(1, 3), unit(2, 4)]), 1)
    assert.equal(pick(aim, [unit(1, 3, over), unit(2, 4)]), 2)
    assert.equal(pick(aim, [unit(1, 3), unit(2, 4)]), 2, 'the new target is sticky in turn')
  }
  const aim = new AutoAim()
  assert.equal(pick(aim, [unit(1, 3)]), 1)
  assert.equal(pick(aim, []), undefined)
  assert.equal(aim.targetId, undefined)
})

/** A cell well inside the map, for the tests that send a cell. */
const MID: Cell = { x: 20, y: 40 }
/** The cell (dq, dr) from MID. */
function rel (dq: number, dr: number): Cell {
  return { x: MID.x + dq, y: MID.y + dr }
}

test('auto-aim: a press sends the target\'s cell, whatever the skill\'s own reach', () => {
  assert.ok(Hex.onMap(MID.x, MID.y, MAP))
  assert.deepEqual(skillCell(MID, rel(5, -2), 1, 0, 3, MAP), rel(5, -2))
  assert.deepEqual(skillCell(MID, rel(2, 0), 0, 1, 10, MAP), rel(2, 0))
})

test('auto-aim: no target sends the cell its reach along the movement direction; off the map the bare slot', () => {
  // East is (1, 0) in world space and in axial cells.
  assert.deepEqual(noTargetCell(MID, 1, 0, 6, MAP), rel(6, 0))
  assert.deepEqual(skillCell(MID, undefined, 1, 0, 6, MAP), rel(6, 0))
  // West, at any speed: the direction is all that counts.
  assert.deepEqual(noTargetCell(MID, -0.25, 0, 3, MAP), rel(-3, 0))
  // Along SE (DIRECTIONS[1] = (0, 1)): the world direction of that step.
  const se = Hex.toPosition(new Vector(0, 1))
  assert.deepEqual(noTargetCell(MID, se.x, se.y, 4, MAP), rel(0, 4))
  // Every step is exactly one ring further.
  for (const angle of [0.3, 1.1, 2, 2.9, 4.4, 5.8]) {
    const cell = noTargetCell(MID, Math.cos(angle), Math.sin(angle), 6, MAP)
    assert.ok(cell !== undefined)
    assert.equal(dist(MID, cell), 6, `angle ${angle}`)
  }
  // Standing still with no direction: East, as a fresh `facing`.
  assert.deepEqual(noTargetCell(MID, 0, 0, 2, MAP), rel(2, 0))

  // Clamped to the map: walked back to the last cell on it, and the bare slot
  // (undefined) when not even the first step is.
  const size = 400
  const edge = Hex.mapCells(size).reduce((a, b) => (b.x > a.x || (b.x === a.x && b.y < a.y) ? b : a))
  const e = { x: edge.x, y: edge.y }
  assert.equal(Hex.onMap(e.x + 1, e.y, size), false)
  assert.equal(noTargetCell(e, 1, 0, 6, size), undefined, 'off the map: no cell')
  const back = { x: e.x - 2, y: e.y }
  assert.deepEqual(noTargetCell(back, 1, 0, 6, size), e)
})

test('auto-aim: a bomb lands at least 3 out and at most aimRange - 1, along the line', () => {
  const range = ITEM_INFO.bomb.aimRange
  assert.ok(range !== null)
  assert.equal(AUTO_AIM.BOMB_MIN_CELLS, 3)
  // A target within 2 rings: the cell 3 along the line through it.
  assert.deepEqual(bombCell(MID, rel(1, 0), 0, 1, range, MAP), rel(3, 0))
  assert.deepEqual(bombCell(MID, rel(0, 2), 1, 0, range, MAP), rel(0, 3))
  assert.deepEqual(bombCell(MID, rel(-1, -1), 1, 0, range, MAP), rel(-2, -1))
  // In between: the target's own cell.
  assert.deepEqual(bombCell(MID, rel(4, 0), 1, 0, range, MAP), rel(4, 0))
  assert.deepEqual(bombCell(MID, rel(3, -1), 1, 0, range, MAP), rel(3, -1))
  // Never past aimRange - 1, however far the target.
  for (const far of [range, range + 1, 9]) {
    assert.deepEqual(bombCell(MID, rel(far, 0), 1, 0, range, MAP), rel(range - 1, 0), `target at ${far}`)
  }
  for (const target of [rel(6, -6), rel(-4, 6), rel(1, 5), rel(-2, -1)]) {
    const cell = bombCell(MID, target, 1, 0, range, MAP)
    assert.ok(cell !== undefined)
    assert.ok(dist(MID, cell) <= range - 1 && dist(MID, cell) >= 3, JSON.stringify([target, cell]))
  }
  // No target: aimRange - 1 along the movement direction.
  assert.deepEqual(bombCell(MID, undefined, -1, 0, range, MAP), rel(-(range - 1), 0))
})

test('auto-aim: the client\'s range table equals the server\'s constants', () => {
  assert.equal(AIM_RANGE_CELLS.fireball, Throwable.RANGE_CELLS)
  assert.equal(AIM_RANGE_CELLS.icicle, Throwable.RANGE_CELLS)
  assert.equal(AIM_RANGE_CELLS.iceBreath, IceBreath.RINGS)
  assert.equal(ITEM_INFO.bomb.aimRange, ITEMS.bomb.aimRange)
  for (const info of Object.values(ARCHETYPE_INFO)) {
    if (info.kind !== 'robot') continue
    assert.equal(rangeCellsOf('ranged', info.rangedCells), RangedAttack.RANGE_CELLS, info.key)
  }
  assert.equal(rangeCellsOf('ranged', undefined), RangedAttack.RANGE_CELLS, 'an unknown robot')
  for (const key of ['dash', 'melee', 'defend', 'stoneWall'] as const) {
    assert.equal(rangeCellsOf(key, 6), undefined, `${key} doesn't aim`)
  }
})

// The server: unchanged, and an aimed press still doesn't turn the robot.

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = { create: noop, update: noop, destroy: noop, effect: noop, effectAt: noop } as unknown as Multiplayer
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

function mockTimers (t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
}

test('server: an aimed press leaves facing unchanged, so Dash still follows movement', (t) => {
  mockTimers(t)
  const at = Hex.toPosition(Hex.toCell(new Vector(1000, 2000)))
  const player = new Player(at.x, at.y, 0, 'aimer')
  World.PLAYERS.push(player)
  const before = { x: player.facing.x, y: player.facing.y }
  assert.equal(World.FACING_INDEX(player.facing), 0, 'a new player faces East')

  // Every aimed skill, aimed West.
  const west = new Vector(player.cell.x - 3, player.cell.y)
  for (const Skill of [RangedAttack, ThrowFireball, Throwicicle, IceBreath]) {
    new Skill(player).execute(west)
    assert.deepEqual({ x: player.facing.x, y: player.facing.y }, before, `${Skill.name} turned the robot`)
  }

  // A standing dash then runs East, along the last movement, not the aim.
  assert.equal(new Dash(player).execute(), true)
  assert.deepEqual(player.path.map((c) => [c.x - player.cell.x, c.y - player.cell.y]), [[1, 0], [2, 0], [3, 0]])
})
