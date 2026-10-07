import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
// See world.spec.ts: entering the module graph anywhere but multiplayer leaves
// GameObject undefined, so go in the way index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Player from './player'
import Exit from './exit'
import Portal from './portal'
import Obstacle from './obstacle'
import { Unit } from './unit'
import { GameObject, ObjectType } from './gameobject'
import { ARCHETYPES, ITEMS } from '../archetypes/archetypes'
import { detonate } from '../items/bomb'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Extraction is a channel on the exit's cell (#16): 5 / 7 / 9 s by layer,
 * cancelled by stepping off or by a hit that does damage. The second half of
 * this file holds the client's `LocalPlayer` to the server's `Unit.update`:
 * walking, portal hops onto arrival cells and Dash (hex-cells P2).
 */

// --- the client's LocalPlayer, loaded without pixi ---------------------------
//
// The client's Vector extends pixi's Point, and pixi does not load in node.
// Point is only x and y as far as LocalPlayer, Hex and Path are concerned, so
// a stub stands in for it, for files under plunder-land-client only.
const PIXI_STUB = join(__dirname, '__extract_spec_pixi_stub__.js')
const moduleInternals = Module as unknown as {
  _resolveFilename: (request: string, parent: { filename?: string } | undefined, ...rest: unknown[]) => string
}
const resolve = moduleInternals._resolveFilename
moduleInternals._resolveFilename = function (request, parent, ...rest) {
  if (request === 'pixi.js' && (parent?.filename ?? '').includes('plunder-land-client')) return PIXI_STUB
  return resolve.call(this, request, parent, ...rest)
}
class StubPoint {
  x: number
  y: number
  constructor (x = 0, y = 0) { this.x = x; this.y = y }
}
require.cache[PIXI_STUB] = {
  id: PIXI_STUB, filename: PIXI_STUB, loaded: true, exports: { Point: StubPoint }
} as unknown as NodeJS.Module
// Transpiled, not typechecked: ts-node would check the client's files against
// the server's tsconfig, which they were never written for (it tripped on
// TS2729, a static initialiser, before hex-cells P4). The client has its own
// typecheck.
const extensions = require.extensions as unknown as Record<string, (m: NodeJS.Module & { _compile: (code: string, file: string) => void }, file: string) => void>
const compileTs = extensions['.ts']
extensions['.ts'] = function (m, file) {
  if (!file.includes('plunder-land-client')) { compileTs(m, file); return }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require('typescript')
  const source = readFileSync(file, 'utf8')
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: file
  })
  m._compile(out.outputText, file)
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LocalPlayer } = require('../../../../plunder-land-client/src/net/localplayer')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decodeRecord } = require('../../../../plunder-land-client/src/net/records')

// --- setup ------------------------------------------------------------------

const TICK = 0.25
const [TOP, MIDDLE, BOTTOM] = World.LAYERS.map((layer) => layer.tag)

let destroyed: GameObject[] = []

beforeEach(() => {
  destroyed = []
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop,
    update: noop,
    destroy: (obj: GameObject) => { destroyed.push(obj) },
    effect: noop,
    effectAt: noop
  } as unknown as Multiplayer
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

const EXIT_CELL = new Vector(30, 40)

function exitOn (tag: number, cell: Vector = EXIT_CELL): Exit {
  const at = Hex.toPosition(cell)
  const exit = new Exit(at.x, at.y, tag)
  World.OBSTACLES.push(exit)
  return exit
}

function playerOn (tag: number, cell: Vector = EXIT_CELL): Player {
  const at = Hex.toPosition(cell)
  const player = new Player(at.x, at.y, tag, 'bot')
  World.PLAYERS.push(player)
  return player
}

/** Ticks until the player extracts, or `limit` ticks. */
function ticksToExtract (player: Player, limit = 100): number {
  for (let n = 1; n <= limit; n++) {
    player.update(TICK)
    if (player.exited) return n
  }
  return Infinity
}

// --- the channel --------------------------------------------------------------

test('each layer\'s extraction time comes from LAYERS: 5 / 7 / 9 s', () => {
  assert.deepEqual(World.LAYERS.map((layer) => layer.extractMs), [5000, 7000, 9000])
})

for (const [name, tag, ms] of [['01', TOP, 5000], ['02', MIDDLE, 7000], ['03', BOTTOM, 9000]] as const) {
  test(`a player who stays on a layer ${name} exit extracts after ${ms / 1000} s, and not a tick sooner`, () => {
    exitOn(tag)
    const player = playerOn(tag)
    // The first tick on the pad counts as 0; each later one adds 250 ms.
    assert.equal(ticksToExtract(player), ms / 250 + 1)
    assert.equal(destroyed.includes(player), true, 'the destroy (the banking path) never went out')
    assert.equal(player.extractElapsed, ms)
  })
}

test('the progress byte climbs from 1 in 255ths of the layer\'s time', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  const seen: number[] = []
  for (let n = 0; n < 20; n++) {
    player.dirtyFields.clear()
    player.update(TICK)
    assert.equal(player.dirtyFields.has('extractProgress'), true, `tick ${n + 1} did not send progress`)
    seen.push(player.extractProgress)
  }
  assert.equal(seen[0], 1, 'the first tick must be non-zero: 0 means not extracting')
  assert.equal(seen[10], Math.floor(255 * 2500 / 5000))
  assert.equal(seen[19], Math.floor(255 * 4750 / 5000))
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1])
})

test('a player off every exit sends no progress at all', () => {
  exitOn(TOP)
  const player = playerOn(TOP, new Vector(20, 40))
  for (let n = 0; n < 10; n++) {
    player.dirtyFields.clear()
    player.update(TICK)
    assert.equal(player.dirtyFields.has('extractProgress'), false)
  }
  assert.equal(player.exited, undefined)
})

test('stepping off the pad cancels the countdown, and stepping back starts it over', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  for (let n = 0; n < 15; n++) player.update(TICK)
  assert.ok(player.extractProgress > 0)

  player.position = Hex.toPosition(new Vector(31, 40))
  player.update(TICK)
  assert.equal(player.extractProgress, 0, 'leaving did not tell clients')
  assert.equal(player.extractElapsed, undefined)

  player.position = Hex.toPosition(EXIT_CELL)
  assert.equal(ticksToExtract(player), 21, 'the countdown resumed instead of starting over')
})

test('an exit on another layer, or another cell, does not count', () => {
  exitOn(MIDDLE)
  exitOn(TOP, new Vector(31, 40))
  const player = playerOn(TOP)
  assert.equal(ticksToExtract(player, 60), Infinity)
})

test('a hit that does damage cancels the countdown; it starts over on the next tick', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  for (let n = 0; n < 18; n++) player.update(TICK)

  player.hit(10)
  assert.equal(player.extractProgress, 0)
  assert.equal(player.extractElapsed, undefined)
  assert.equal(ticksToExtract(player), 21)
})

test('a hit the armor pool soaks entirely still cancels it', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  const hp = player.hp
  for (let n = 0; n < 10; n++) player.update(TICK)
  assert.ok(player.armor >= 5, 'peep should start with armor')

  player.hit(5)
  assert.equal(player.hp, hp, 'armor should have taken all of it')
  assert.equal(player.extractElapsed, undefined)
})

test('a hit Defend floors to nothing does not cancel it', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  for (let n = 0; n < 10; n++) player.update(TICK)
  player.damageReduction = 1

  player.hit(10)
  assert.ok(player.extractElapsed !== undefined, 'a zero-damage hit cancelled the channel')
})

test('an area effect landing on the pad cancels it', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  for (let n = 0; n < 10; n++) player.update(TICK)
  World.AREA_EFFECT.push({
    tag: TOP, target: undefined, overlaps: () => true, getEffect: () => 15
  } as never)
  player.update(TICK)
  assert.equal(player.extractElapsed, undefined)
})

test('an extracted player can no longer be hit, so a later mob cannot turn the exit into a death', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  ticksToExtract(player)
  assert.equal(player.exited, true)
  assert.equal(player.hit(100000), false)
  assert.equal(player.destroyed, false)
})

test('progress goes on the wire as one unsigned byte after its field index', () => {
  const player = playerOn(TOP)
  player.extractProgress = 200 // over 127: a signed write would throw
  const bytes = player.serialiseBinary(new Set(['extractProgress']))
  assert.ok(bytes !== null)
  // [0 id][uint16 id][index][200]
  assert.deepEqual([...bytes.subarray(3)], [GameObject.fieldOrder.indexOf('extractProgress'), 200])
})

test('progress is never in a snapshot: a player not extracting costs no bytes', () => {
  const player = playerOn(TOP)
  assert.equal(player.allFields.has('extractProgress'), false)
  assert.equal(player.allFieldsOwn.has('extractProgress'), false)
})

// --- items (usable-items) ------------------------------------------------------

function bombUse (): { kind: 'bomb', damage: number, fuseMs: number } {
  const use = ITEMS.bomb.use
  assert.equal(use.kind, 'bomb')
  return use as { kind: 'bomb', damage: number, fuseMs: number }
}

test('a medkit healing on the pad is not a hit: the countdown carries on', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  player.hp = 40
  const heal = ITEMS.medkit.use
  assert.equal(heal.kind, 'heal')
  if (heal.kind !== 'heal') return
  assert.equal(player.startHeal(heal.amount, heal.durationMs), true)
  const n = ticksToExtract(player, 40)
  // The heal ran, and the channel still finished on its tick.
  assert.ok(player.hp > 40, 'the medkit never healed')
  assert.equal(n, 21, 'the heal cancelled or delayed the countdown')
})

test('a bomb blast on the pad cancels the countdown', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  const thrower = playerOn(TOP, new Vector(20, 40))
  for (let n = 0; n < 10; n++) player.update(TICK)
  detonate(thrower, ITEMS.bomb, bombUse(), EXIT_CELL, TOP)
  assert.equal(player.extractElapsed, undefined)
  assert.equal(player.extractProgress, 0)
})

test('an extracted player is not hurt by their own bomb going off afterwards', () => {
  exitOn(TOP)
  const player = playerOn(TOP)
  ticksToExtract(player)
  assert.equal(player.exited, true)
  const hp = player.hp
  const armor = player.armor
  detonate(player, ITEMS.bomb, bombUse(), EXIT_CELL, TOP)
  assert.equal(player.hp, hp)
  assert.equal(player.armor, armor)
  assert.equal(player.destroyed, false)
})

// --- the pad is a zone to players, and off limits to mobs --------------------

test('a player standing on an exit is not pushed off it', () => {
  const exit = exitOn(TOP)
  const player = playerOn(TOP)
  player.position = exit.position.add(new Vector(5, 0))
  player.update(TICK)
  assert.equal(player.position.sub(exit.position).getMagnitude(), 5)
})

test('a mob never steps onto an exit\'s cell, even with its goal straight through it', () => {
  // It was pushed off; since hex-cells P2 it never enters (World.mobCanEnter).
  exitOn(TOP)
  const at = Hex.toPosition(new Vector(EXIT_CELL.x - 1, EXIT_CELL.y))
  const mob = new Unit(ObjectType.Mob, at.x, at.y, 10, TOP)
  mob.maxVelocity = 100
  World.MOBS.push(mob)
  assert.equal(World.mobCanEnter(EXIT_CELL.x, EXIT_CELL.y, mob), false)

  mob.stepGoal = { cell: new Vector(EXIT_CELL.x + 3, EXIT_CELL.y), within: 0 }
  for (let n = 0; n < 20; n++) {
    mob.update(TICK)
    assert.ok(mob.cell.x !== EXIT_CELL.x || mob.cell.y !== EXIT_CELL.y, `on the exit at tick ${n}`)
  }
})

// --- the client mirror --------------------------------------------------------
//
// The server's player and the client's `LocalPlayer` walk the same routes over
// the same layout, a tick at a time, and must be at identical positions every
// tick. Nothing is solid any more (hex-cells P2): the client knows blocked
// cells (its `isBlocked`) and portal cells (its `portalTo`, `Game.PORTALS` in
// the game), and nothing else.

interface Local {
  x: number
  y: number
  tag: number
  waypoints: Vector[]
  path: Vector[]
  dashLeft: number
  facingIndex: number
  repath: () => void
  reset: (x: number, y: number, tag: number, maxVelocity: number) => void
  predict: (dt: number) => void
  dash: () => boolean
  reconcile: (x: number, y: number) => void
  changeLayer: (tag: number) => void
  setDestination: (x: number, y: number) => void
  awaitingHop: boolean
}

/**
 * A `LocalPlayer` for `player`, reading the server's world as the client's
 * `Game.BLOCKED` and `Game.PORTALS` would hold it: blocked cells and portals
 * on the local player's own layer.
 */
function localFor (player: Player): Local {
  const local: Local = new LocalPlayer(
    (q: number, r: number) => World.isBlocked(q, r, local.tag),
    (q: number, r: number) => World.GATES_ON(q, r, local.tag).find((g) => g.type === ObjectType.Portal)?.to
  )
  local.reset(player.position.x, player.position.y, player.tag, player.maxVelocity)
  return local
}

/** Both sides route to `to`, as a click does: the client plans, the server gets the waypoints. */
function routeBoth (player: Player, local: Local, to: Vector): void {
  player.setWaypoints([to])
  local.waypoints = [new Vector(to.x, to.y)]
  local.repath()
  assert.ok(local.path.length > 0 && player.path.length > 0, 'no route')
}

interface Track {
  server: Vector[]
  client: Vector[]
  serverTag: number[]
  clientTag: number[]
}

/**
 * `ticks` ticks of both sides: `input(n)` first (a press on either side), then
 * the server's update, then the client's prediction for the same time. The
 * server's tag and position reach the client `delay` ticks after the tick
 * that changed the tag, in one record, and are handled as
 * `Game.onObjectUpdated` handles them: `reconcile` the position, then
 * `changeLayer`. (Other positions are not fed back: inside the dead zone
 * `reconcile` ignores them anyway, and this is about the two simulations.)
 */
function run (player: Player, local: Local, ticks: number, delay = 1, input?: (n: number) => void): Track {
  const track: Track = { server: [], client: [], serverTag: [], clientTag: [] }
  for (let n = 0; n < ticks && !player.exited; n++) {
    input?.(n)
    player.update(TICK)
    track.server.push(player.position)
    track.serverTag.push(player.tag)
    const heard = n - delay
    if (heard >= 0 && track.serverTag[heard] !== local.tag) {
      local.reconcile(track.server[heard].x, track.server[heard].y)
      local.changeLayer(track.serverTag[heard])
    }
    local.predict(TICK)
    track.client.push(new Vector(local.x, local.y))
    track.clientTag.push(local.tag)
  }
  return track
}

function same (a: Vector, b: Vector): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
}

function assertSameTrack (track: Track, from = 0, to = track.server.length): void {
  for (let i = from; i < to; i++) {
    const s = track.server[i]
    const c = track.client[i]
    assert.ok(same(s, c), `tick ${i + 1}: server (${s.x}, ${s.y}) vs client (${c.x}, ${c.y})`)
  }
}

/** The mirror as it was: one route, no hop, no dash. */
function walkBoth (from: Vector, to: Vector, ticks: number): Track & { player: Player, local: Local } {
  const player = playerOn(TOP, from)
  const local = localFor(player)
  routeBoth(player, local, to)
  return { ...run(player, local, ticks), player, local }
}

test('mirror: client and server both walk straight across an exit\'s pad', () => {
  const exit = exitOn(TOP)
  // A rock beside the route too, which neither side may be shoved by.
  World.addObstacle(new Obstacle(Hex.toPosition(new Vector(30, 39)).x, Hex.toPosition(new Vector(30, 39)).y, TOP))
  const track = walkBoth(new Vector(27, 40), new Vector(33, 40), 12)
  assertSameTrack(track)
  const closest = Math.min(...track.server.map((p) => p.sub(exit.position).getMagnitude()))
  // Samples are a tick (35 units) apart, so they straddle the centre.
  assert.ok(closest < 20, `the walk never got onto the pad (closest ${closest})`)
})

test('mirror: both end on an exit\'s centre when it is the destination', () => {
  const exit = exitOn(TOP)
  const track = walkBoth(new Vector(26, 40), EXIT_CELL, 8)
  assertSameTrack(track)
  assert.ok(same(track.server[track.server.length - 1], exit.position))
})

test('mirror: a route that bends round rocks, and the facing it ends on, agree', () => {
  // Two rocks across the straight line, so the route turns twice.
  for (const cell of [new Vector(29, 40), new Vector(29, 41)]) {
    const at = Hex.toPosition(cell)
    World.addObstacle(new Obstacle(at.x, at.y, TOP))
  }
  const track = walkBoth(new Vector(26, 41), new Vector(32, 39), 16)
  assertSameTrack(track)
  assert.equal(track.local.path.length, 0, 'the client never arrived')
  assert.equal(track.local.facingIndex, World.FACING_INDEX(track.player.facing), 'the two face different ways')
})

test('mirror: a geared player at a speed that is not a multiple of 10 walks the same track on both sides', () => {
  // Gear (49-1/49-2): a T3 speed roll at max is +6%, so Peep walks at 148.4.
  // The client takes its speed from the wire as it does in play: field 27,
  // tenths. Index 10 carried tens, and would have predicted at 140.
  const player = playerOn(TOP, new Vector(20, 40))
  assert.ok(player.equipGear(0, { tier: 3, skill: 6, rolls: [{ stat: 3, q: 1000 }, { stat: 1, q: 0 }] }))
  assert.ok(player.maxVelocity % 10 !== 0, `speed ${player.maxVelocity} is a multiple of 10`)
  const wire = decodeRecord(player.serialiseBinary(new Set(['id', 'maxVelocity'])), GameObject.fieldOrder)
  assert.equal(wire.maxVelocity, player.maxVelocity, 'the wire did not carry the speed exactly')
  assert.notEqual(Math.floor(player.maxVelocity / 10) * 10, player.maxVelocity)

  const local = localFor(player)
  local.reset(player.position.x, player.position.y, player.tag, wire.maxVelocity)
  routeBoth(player, local, new Vector(36, 40))
  const track = run(player, local, 24)
  assertSameTrack(track)
  assert.ok(same(track.server[track.server.length - 1], Hex.toPosition(new Vector(36, 40))), 'the walk never arrived')
})

// --- a portal hop (hex-cells P2: arrival cells, #31 Q3, #33) ------------------
//
// A player whose tick ends on a portal's cell is put down on its arrival cell
// (the east neighbour) on the layer it leads to, and stops (`Unit.changeLayer`).
// Routes end on a portal's cell on both sides (`endAtPortal`), so the client
// walks to the portal's centre and waits there; when the tag reaches it, it
// jumps to where the server put it (`LocalPlayer.changeLayer`).

function portalOn (tag: number, to: number, cell: Vector = EXIT_CELL): Portal {
  const at = Hex.toPosition(cell)
  const portal = new Portal(at.x, at.y, to, tag)
  World.addObstacle(portal)
  return portal
}

const ARRIVAL = Hex.toPosition(new Vector(EXIT_CELL.x + 1, EXIT_CELL.y))

test('a portal hop mid-route puts the player down on the arrival cell\'s centre, stopped', () => {
  portalOn(TOP, MIDDLE)
  // Through the portal's cell and four cells beyond it.
  const player = playerOn(TOP, new Vector(26, 40))
  player.setWaypoints([new Vector(34, 40)])
  assert.ok(player.path.length > 0)

  let hopped = false
  for (let n = 0; n < 12 && !hopped; n++) {
    player.update(TICK)
    hopped = player.tag === MIDDLE
  }
  assert.ok(hopped, 'the player never went through the portal')
  assert.ok(same(player.position, ARRIVAL), `landed at (${player.position.x}, ${player.position.y})`)
  assert.deepEqual(player.path, [], 'the route planned on layer 01 survived the hop')
  assert.deepEqual(player.waypoints, [], 'the waypoints survived the hop')

  for (let n = 0; n < 8; n++) player.update(TICK)
  assert.equal(player.tag, MIDDLE)
  assert.ok(same(player.position, ARRIVAL), 'the player walked on across layer 02')
})

test('a route through a portal ends on the portal\'s cell, on both sides', () => {
  portalOn(TOP, MIDDLE)
  const player = playerOn(TOP, new Vector(26, 40))
  const local = localFor(player)
  routeBoth(player, local, new Vector(34, 40))
  const last = (path: Vector[]): number[] => [path[path.length - 1].x, path[path.length - 1].y]
  assert.deepEqual(last(player.path), [EXIT_CELL.x, EXIT_CELL.y])
  assert.deepEqual(last(local.path), [EXIT_CELL.x, EXIT_CELL.y])
  assert.deepEqual(local.path.map((c) => [c.x, c.y]), player.path.map((c) => [c.x, c.y]))
})

test('mirror: a portal that comes into view after the route was planned cuts the client\'s route where the server\'s ends', () => {
  // The server knows every portal; the client only those in view
  // (`Game.PORTALS`). A route planned before the portal was sent runs on
  // through it on the client until `portalAppeared` cuts it.
  portalOn(TOP, MIDDLE)
  const player = playerOn(TOP, new Vector(20, 40))
  let seen = false
  const local: Local = new LocalPlayer(
    (q: number, r: number) => World.isBlocked(q, r, local.tag),
    (q: number, r: number) => seen ? World.GATES_ON(q, r, local.tag).find((g) => g.type === ObjectType.Portal)?.to : undefined
  )
  local.reset(player.position.x, player.position.y, TOP, player.maxVelocity)
  routeBoth(player, local, new Vector(34, 40))
  assert.equal(local.path.length, 14, 'the client knew of the portal already')
  const track = run(player, local, 3)
  seen = true
  ;(local as unknown as { portalAppeared: () => void }).portalAppeared()
  assert.deepEqual(local.path.map((c) => [c.x, c.y]), player.path.map((c) => [c.x, c.y]))
  assertSameTrack(track)
})

test('a portal to the player\'s own layer is not a hop and leaves the route alone', () => {
  portalOn(TOP, TOP)
  const player = playerOn(TOP, new Vector(26, 40))
  player.setWaypoints([new Vector(34, 40)])
  for (let n = 0; n < 6; n++) player.update(TICK)
  assert.ok(player.path.length > 0, 'a same-layer portal ended the route')
  assert.equal(player.waypoints.length, 1)
})

test('mirror: an ordinary arrival still keeps the client\'s destination, and a same-layer tag changes nothing', () => {
  // CLAUDE.md, "Arriving does not clear the waypoints, only the path".
  const track = walkBoth(new Vector(26, 40), new Vector(30, 40), 8)
  assertSameTrack(track)
  assert.deepEqual(track.local.path, [])
  assert.deepEqual(track.local.waypoints.map((c) => [c.x, c.y]), [[30, 40]], 'arrival dropped the destination')
  track.local.changeLayer(TOP)
  assert.equal(track.local.waypoints.length, 1, 'a tag equal to the current one stopped the player')
})

const HOP_ROUTES = [
  { name: 'through the portal', to: new Vector(34, 40) },
  { name: 'onto the portal', to: EXIT_CELL }
]

/**
 * The hop, checked tick by tick: identical before the server hops; while the
 * tag is on its way the client is on the portal's cell, walking to or waiting
 * on its centre, still on layer 01; identical again from the tick the tag
 * lands, on layer 02, stopped, on the arrival cell's centre.
 */
function assertHop (track: Track, delay: number, local: Local): void {
  const hop = track.serverTag.findIndex((tag) => tag === MIDDLE)
  assert.ok(hop >= 0, 'the server never hopped')
  assertSameTrack(track, 0, hop)
  for (let i = hop; i < hop + delay; i++) {
    const cell = Hex.toCell(track.client[i])
    assert.deepEqual([cell.x, cell.y], [EXIT_CELL.x, EXIT_CELL.y], `tick ${i + 1}: the client left the portal's cell`)
    assert.equal(track.clientTag[i], TOP)
  }
  assertSameTrack(track, hop + delay)
  assert.ok(same(track.server[track.server.length - 1], ARRIVAL))
  assert.equal(local.tag, MIDDLE)
  assert.deepEqual(local.path, [])
  assert.deepEqual(local.waypoints, [], 'the next input packet would still ask for the old route')
}

for (const delay of [1, 2, 3]) for (const route of HOP_ROUTES) {
  test(`mirror: a portal hop ${route.name} lands both sides on the arrival cell (tag ${delay} tick${delay > 1 ? 's' : ''} late)`, () => {
    portalOn(TOP, MIDDLE)
    // A rock on layer 02 across the old route, so walking on would show.
    const rock = Hex.toPosition(new Vector(32, 40))
    World.addObstacle(new Obstacle(rock.x, rock.y, MIDDLE))
    const player = playerOn(TOP, new Vector(26, 40))
    const local = localFor(player)
    routeBoth(player, local, route.to)
    const track = run(player, local, 16, delay)
    assertHop(track, delay, local)
  })
}

for (const delay of [1, 2, 3]) {
  test(`mirror: a click while the hop's tag is on its way (${delay} tick${delay > 1 ? 's' : ''} late) is routed on the new layer, and both sides walk it alike`, () => {
    portalOn(TOP, MIDDLE)
    const player = playerOn(TOP, new Vector(26, 40))
    const local = localFor(player)
    routeBoth(player, local, EXIT_CELL)
    // On layer 02, east of the arrival cell: a cell the old layer's route would never have aimed at from there.
    const target = new Vector(EXIT_CELL.x + 4, EXIT_CELL.y + 1)
    const at = Hex.toPosition(target)
    let clicked = -1
    let sent: Vector[] | undefined
    let landed = -1
    const track = run(player, local, 30, delay, (n) => {
      // The click: the first tick the client stands waiting on the portal.
      if (clicked < 0 && local.awaitingHop && local.tag === TOP) {
        clicked = n
        local.setDestination(at.x, at.y)
        assert.equal(local.waypoints.length <= 1 && (local.waypoints[0] === undefined || (local.waypoints[0].x === EXIT_CELL.x && local.waypoints[0].y === EXIT_CELL.y)), true, 'a held click changed the route on the old layer')
      }
      // What the next input packet carries once the route changed: the server gets it a tick later.
      if (landed < 0 && local.tag === MIDDLE) {
        landed = n
        sent = local.waypoints.map((c) => new Vector(c.x, c.y))
        player.setWaypoints(sent)
      }
    })
    assert.ok(clicked >= 0, 'the client never waited on the portal')
    assert.ok(landed >= 0, 'the tag never landed')
    assert.deepEqual(sent?.map((c) => [c.x, c.y]), [[target.x, target.y]], 'the held click was not routed after the hop')
    // The client plans as the tag lands; the server gets the route with the next input, one tick behind, as for any click.
    const end = track.server.length - 1
    assert.ok(same(track.server[end], at), `server ended at (${track.server[end].x}, ${track.server[end].y})`)
    assert.ok(same(track.client[end], at), `client ended at (${track.client[end].x}, ${track.client[end].y})`)
    for (let i = landed + 1; i <= end; i++) {
      assert.ok(same(track.server[i], track.client[i - 1]), `tick ${i + 1}: server (${track.server[i].x}, ${track.server[i].y}) is not where the client was a tick earlier (${track.client[i - 1].x}, ${track.client[i - 1].y})`)
    }
    assert.equal(local.tag, MIDDLE)
    assert.equal(player.tag, MIDDLE)
  })
}

test('a held click is dropped by a stop, so it never survives into the next run', () => {
  portalOn(TOP, MIDDLE)
  const player = playerOn(TOP, EXIT_CELL)
  const local = localFor(player)
  assert.equal(local.awaitingHop, true)
  const at = Hex.toPosition(new Vector(EXIT_CELL.x + 3, EXIT_CELL.y))
  local.setDestination(at.x, at.y)
  assert.deepEqual(local.waypoints, [], 'planned on the old layer')
  local.reset(player.position.x, player.position.y, MIDDLE, player.maxVelocity)
  local.changeLayer(BOTTOM)
  assert.deepEqual(local.waypoints, [], 'a held click survived a reset')
})

// --- Dash (decision #34): 3 cells of route at 2.5x, predicted -------------------
//
// The client dashes on the press; the server gets the press `late` ticks
// later. Both cover the same 135 units of route at dash speed, so they are
// apart while one has dashed and the other has not, and identical again once
// both are past it.

/** The server's Dash skill, pressed as a socket handler would (slot 0). */
function serverDash (player: Player): boolean {
  return player.skills[0].execute() as unknown as boolean
}

for (const late of [1, 2]) {
  test(`mirror: a dash on a route, the server ${late} tick${late > 1 ? 's' : ''} late, converges once both are past it`, () => {
    const player = playerOn(TOP, new Vector(20, 40))
    const local = localFor(player)
    routeBoth(player, local, new Vector(40, 40)) // 20 cells east, 900 units
    let clientDone = -1
    let serverDone = -1
    const track = run(player, local, 20, 1, (n) => {
      if (n === 2) assert.equal(local.dash(), true)
      if (n === 2 + late) assert.equal(serverDash(player), true, 'the server refused the dash')
      if (n > 2 && clientDone < 0 && local.dashLeft === 0) clientDone = n
      if (n > 2 + late && serverDone < 0 && player.dashLeft === 0) serverDone = n
    })
    // Identical before the press, apart while only one has dashed, identical after.
    assertSameTrack(track, 0, 2)
    assert.ok(!same(track.server[2], track.client[2]), 'the client\'s dash did nothing')
    assert.ok(clientDone > 0 && serverDone > 0, 'a dash never finished')
    assertSameTrack(track, Math.max(clientDone, serverDone))
    // 135 units at 2.5x speed is worth 135 * (1 - 1/2.5) = 81 units over
    // walking for the same time: 20 ticks at 35 is 700, so 781 along the q axis.
    const travelled = track.server[track.server.length - 1].sub(Hex.toPosition(new Vector(20, 40))).getMagnitude()
    assert.ok(Math.abs(travelled - (700 + Unit.DASH_CELLS * Hex.SIZE * (1 - 1 / Unit.DASH_MULTIPLIER))) < 1e-6, `travelled ${travelled}`)
  })
}

test('mirror: a dash with fewer than 3 cells left ends on the destination on both sides', () => {
  const player = playerOn(TOP, new Vector(26, 40))
  const local = localFor(player)
  routeBoth(player, local, new Vector(28, 40))
  const track = run(player, local, 6, 1, (n) => {
    if (n === 0) local.dash()
    if (n === 1) serverDash(player)
  })
  const destination = Hex.toPosition(new Vector(28, 40))
  assert.ok(same(track.server[track.server.length - 1], destination))
  assert.ok(same(track.client[track.client.length - 1], destination))
  assert.equal(player.dashLeft, 0, 'arrival did not clear the dash')
  assert.equal(local.dashLeft, 0, 'arrival did not clear the client\'s dash')
})

/**
 * Walk three cells east and stop, on both sides, so both stand facing East on
 * the same cell centre. The client keeps its destination (`_arrive`).
 */
function walkedEast (): { player: Player, local: Local } {
  const player = playerOn(TOP, new Vector(20, 40))
  const local = localFor(player)
  routeBoth(player, local, new Vector(23, 40))
  const track = run(player, local, 6)
  assertSameTrack(track)
  assert.equal(player.path.length, 0)
  assert.equal(local.path.length, 0)
  assert.equal(local.facingIndex, 0)
  assert.equal(World.FACING_INDEX(player.facing), 0)
  return { player, local }
}

test('mirror: a standing dash goes 3 cells along the facing and ends there on both sides', () => {
  const { player, local } = walkedEast()
  const track = run(player, local, 8, 1, (n) => {
    if (n === 0) assert.equal(local.dash(), true)
    if (n === 1) {
      assert.equal(serverDash(player), true)
      // The input packet after the press carries the client's new destination
      // (the dash's end cell), as `onPointer` would apply it.
      player.setWaypoints(local.waypoints.map((c) => new Vector(c.x, c.y)))
    }
  })
  const end = Hex.toPosition(new Vector(26, 40))
  assert.ok(same(track.server[track.server.length - 1], end), 'the server did not end 3 cells east')
  assert.ok(same(track.client[track.client.length - 1], end), 'the client did not end 3 cells east')
  assert.deepEqual(local.waypoints.map((c) => [c.x, c.y]), [[26, 40]], 'the client\'s destination is not the dash\'s end')
  // Faster than walking: 135 units in 135 / 350 s, under two ticks.
  const reached = track.client.findIndex((p) => same(p, end))
  assert.ok(reached >= 0 && reached <= 1, `took ${reached + 1} ticks`)
})

test('mirror: after walking north-west, a standing dash goes north-west on both sides', () => {
  // Not East, the default facing, so a side that failed to track its facing
  // would dash the wrong way.
  const player = playerOn(TOP, new Vector(20, 40))
  const local = localFor(player)
  routeBoth(player, local, new Vector(20, 37)) // three steps NW, (0, -1) each
  const walk = run(player, local, 6)
  assertSameTrack(walk)
  assert.equal(local.facingIndex, 4, 'the client does not face NW')
  assert.equal(World.FACING_INDEX(player.facing), 4, 'the server does not face NW')

  const track = run(player, local, 6, 1, (n) => {
    if (n === 0) assert.equal(local.dash(), true)
    if (n === 1) {
      assert.equal(serverDash(player), true)
      player.setWaypoints(local.waypoints.map((c) => new Vector(c.x, c.y)))
    }
  })
  const end = Hex.toPosition(new Vector(20, 34))
  assert.ok(same(track.server[track.server.length - 1], end), 'the server did not dash 3 cells NW')
  assert.ok(same(track.client[track.client.length - 1], end), 'the client did not dash 3 cells NW')
})

test('a standing dash stops before a rock and is refused, costing no cooldown, with a rock straight ahead', () => {
  const { player, local } = walkedEast()
  // A rock two cells ahead: the dash goes one cell.
  const two = Hex.toPosition(new Vector(25, 40))
  const rock = new Obstacle(two.x, two.y, TOP)
  World.addObstacle(rock)
  assert.deepEqual(player.dashCells().map((c) => [c.x, c.y]), [[24, 40]])

  // A rock right ahead: nowhere to go, refused on both sides.
  const one = Hex.toPosition(new Vector(24, 40))
  World.addObstacle(new Obstacle(one.x, one.y, TOP))
  assert.equal(local.dash(), false, 'the client dashed into a rock')
  assert.equal(serverDash(player), false, 'the server dashed into a rock')
  assert.equal(player.path.length, 0)
  // The cooldown was not spent: once the way is clear it fires at once.
  rock.destroy()
  World.removeObstacle(rock)
  const blocker = World.OBSTACLES.find((o) => o instanceof Obstacle && same(o.position, one)) as Obstacle
  blocker.destroy()
  World.removeObstacle(blocker)
  assert.equal(serverDash(player), true, 'the refused press spent the cooldown')
})

test('mirror: a standing dash onto a portal hops, and both sides land on its arrival cell', () => {
  const { player, local } = walkedEast()
  // Two cells ahead: the dash ends on it rather than running past.
  portalOn(TOP, MIDDLE, new Vector(25, 40))
  const arrival = Hex.toPosition(new Vector(26, 40))
  const track = run(player, local, 6, 1, (n) => {
    if (n === 0) assert.equal(local.dash(), true)
    if (n === 1) {
      assert.equal(serverDash(player), true)
      player.setWaypoints(local.waypoints.map((c) => new Vector(c.x, c.y)))
    }
  })
  assert.equal(player.tag, MIDDLE)
  assert.equal(local.tag, MIDDLE)
  assert.ok(same(track.server[track.server.length - 1], arrival))
  assert.ok(same(track.client[track.client.length - 1], arrival))
})

// --- the client's corrections around a dash ------------------------------------

/**
 * The game as it runs, not lockstep: the client predicts at 60 frames a
 * second and reconciles every server position it receives, a tick after the
 * server produced it; the server gets the dash press at its next tick after
 * the client pressed. Returns how many times the client was corrected (its
 * render offset set), and the two final positions.
 */
function playDash (pressAtFrame: number): { corrections: number, server: Vector, client: Vector } {
  const player = playerOn(TOP, new Vector(10, 40))
  const local = localFor(player)
  routeBoth(player, local, new Vector(40, 40)) // 30 cells: 1350 units, 9.6 s
  const FRAME = 1 / 60
  const frames = Math.round(11 / FRAME)
  const perTick = Math.round(TICK / FRAME)
  const sent: Vector[] = []
  let pressed = false
  let pendingFrom = -1
  let corrections = 0
  for (let f = 0; f < frames; f++) {
    if (f === pressAtFrame) { local.dash(); pendingFrom = f; pressed = true }
    if (f % perTick === 0) {
      // The press takes a tick to reach the server, which acts on it at its
      // next tick after that.
      if (pendingFrom >= 0 && f - pendingFrom >= perTick) { serverDash(player); pendingFrom = -1 }
      player.update(TICK)
      sent.push(player.position)
      // A tick of latency back: what arrives now is what the server sent two
      // ticks ago. (A server tick moves the player a whole tick ahead at once,
      // so one tick back would be no lead at all.) Without a dash that is a
      // lead of one tick's travel, inside the dead zone.
      const arrived = sent[sent.length - 3]
      if (arrived !== undefined) {
        local.reconcile(arrived.x, arrived.y)
        const offset = local as unknown as { _offsetX: number, _offsetY: number }
        if (offset._offsetX !== 0 || offset._offsetY !== 0) corrections++
      }
    }
    local.predict(FRAME)
  }
  assert.equal(pressed, pressAtFrame >= 0)
  return { corrections, server: player.position, client: new Vector(local.x, local.y) }
}

test('a predicted dash is not corrected while the server catches up with it', () => {
  // Control first: without a dash the client leads by about a tick and is
  // never corrected, so any correction below is the dash's.
  assert.equal(playDash(-1).corrections, 0, 'corrected with no dash at all')
  for (const frame of [30, 47, 61, 74]) {
    const { corrections, server, client } = playDash(frame)
    assert.equal(corrections, 0, `a dash pressed at frame ${frame} was corrected ${corrections} time(s)`)
    assert.ok(same(server, client), 'they did not end in the same place')
  }
})

// --- Hopper through walls (decision #44, walls step 2) -----------------------
//
// Hopper (`passesObstacles`) is stopped only by void and the map edge
// (`Unit.blocks`; the client's `Game.blocksLocal`): it routes and dashes
// through walls and StoneWall stones (#16 H2) and may stop on one (#23).

/** A wall across the straight line from (26, 40) to (32, 40). */
const WALL = [new Vector(29, 39), new Vector(29, 40), new Vector(29, 41)]

function wallUp (): void {
  for (const cell of WALL) World.block(cell.x, cell.y, TOP, null)
}

function hopperOn (cell: Vector): Player {
  const at = Hex.toPosition(cell)
  const player = new Player(at.x, at.y, TOP, 'hop', ARCHETYPES.hopper)
  World.PLAYERS.push(player)
  return player
}

const onWall = (path: Vector[]): boolean => path.some((c) => WALL.some((w) => w.x === c.x && w.y === c.y))

test('Hopper routes straight through a wall that Peep goes round', () => {
  wallUp()
  const hopper = hopperOn(new Vector(26, 40))
  hopper.setDestination(32, 40)
  const peep = playerOn(TOP, new Vector(26, 40))
  peep.setDestination(32, 40)
  assert.ok(onWall(hopper.path), 'Hopper went round the wall')
  assert.ok(!onWall(peep.path), 'Peep walked through the wall')
  assert.ok(hopper.path.length < peep.path.length, 'Hopper\'s route is no shorter')
})

test('Hopper may stop on a wall; Peep can\'t route there at all', () => {
  wallUp()
  const hopper = hopperOn(new Vector(26, 40))
  hopper.setDestination(29, 40)
  for (let n = 0; n < 12; n++) hopper.update(TICK)
  assert.ok(same(hopper.position, Hex.toPosition(new Vector(29, 40))), 'Hopper didn\'t end on the wall')
  const peep = playerOn(TOP, new Vector(26, 40))
  peep.setDestination(29, 40)
  assert.equal(peep.path.length, 0)
})

test('a standing dash carries Hopper over a wall, and stops Peep in front of it', () => {
  wallUp()
  for (const make of [hopperOn, (cell: Vector) => playerOn(TOP, cell)]) {
    const player = make(new Vector(27, 40))
    const cells = player.dashCells()
    const direction = World.FACING_INDEX(player.facing)
    const expected = player.archetype.passesObstacles ? 3 : 1
    assert.equal(cells.length, expected, `${player.archetype.key} dashed ${cells.length} cells`)
    let cell = player.cell
    for (const c of cells) {
      cell = Hex.neighbour(cell, direction)
      assert.ok(c.x === cell.x && c.y === cell.y)
    }
  }
})

test('void still stops Hopper', () => {
  const voids = new Set(WALL.map((c) => Hex.key(c.x, c.y)))
  World.VOIDS.set(TOP, voids)
  try {
    for (const cell of WALL) World.block(cell.x, cell.y, TOP, null)
    const hopper = hopperOn(new Vector(26, 40))
    hopper.setDestination(32, 40)
    assert.ok(hopper.path.length > 0)
    assert.ok(!onWall(hopper.path), 'Hopper crossed void')
    assert.equal(hopperOn(new Vector(27, 40)).dashCells().length, 1)
  } finally {
    World.VOIDS.delete(TOP)
  }
})

test('mirror: Hopper\'s client and server walk the same track through a wall', () => {
  wallUp()
  const player = hopperOn(new Vector(26, 40))
  // The client's rule for Hopper (`Game.blocksLocal`): void and the edge only.
  const local: Local = new LocalPlayer(
    (q: number, r: number) => World.isVoid(q, r, local.tag),
    () => undefined
  )
  local.reset(player.position.x, player.position.y, player.tag, player.maxVelocity)
  routeBoth(player, local, new Vector(32, 40))
  assert.ok(onWall(local.path), 'the client went round')
  const track = run(player, local, 12)
  assertSameTrack(track)
})

// --- Knockback (decision #51, l1-6): Player.knockback against LocalPlayer.knockback ---
//
// The server moves the player (a Compactor's slam) and sends effect 15 aimed
// at the landing cell; the client jumps there on the effect, which arrives
// `delay` ticks later with the update header of the same flush, whose
// `lastInputSeq` says which route the server held when it moved the player.
// Here the input is real too: the client's `sample` packets go through the
// server's own `Multiplayer.onPointer` a tick after they are sent.

interface KnockLocal extends Local {
  sample: (now: number) => ArrayBuffer | null
  knockback: (cell: { x: number, y: number }, ackedSeq: number) => void
}

interface KnockRun {
  server: Vector[]
  client: Vector[]
  player: Player
  local: KnockLocal
  landing: Vector
}

/**
 * The client clicks a cell east at tick 0; the server knocks the player
 * south-east `cells` cells at the start of tick `knockAt`; the client hears tick
 * n's flush (effect, then header and record) at tick n + `delay`; `click`, if
 * given, is a second click the client makes at tick `click.at`: after that
 * tick's flush is handled, or with `unsent` before it, so the knockback finds
 * it not yet sent.
 */
function knockRun (delay: number, knockAt: number, click?: { at: number, cell: Vector, unsent?: boolean }, cells = 2, ticks = 40): KnockRun {
  const player = playerOn(TOP, new Vector(26, 40))
  const local = localFor(player) as KnockLocal
  const connection = { player, lastWaypoints: [] as Vector[], lastInputSeq: 0, ackElapsedMs: 0 }
  player.connection = connection as unknown as Player['connection']
  const onPointer = (Multiplayer.prototype as unknown as { onPointer: (c: unknown, d: unknown) => void }).onPointer
  const dest = Hex.toPosition(new Vector(34, 40))
  local.setDestination(dest.x, dest.y)

  const inFlight: Array<{ due: number, data: Buffer }> = []
  const server: Vector[] = []
  const client: Vector[] = []
  let landing: Vector | undefined
  let acked = -1
  for (let n = 0; n < ticks; n++) {
    for (const packet of inFlight.filter((p) => p.due === n)) onPointer.call({}, connection, packet.data)
    if (n === knockAt) {
      landing = player.knockback(1, cells)
      assert.ok(landing !== undefined, 'the knockback found no landing')
      acked = connection.lastInputSeq
    }
    player.update(TICK)
    server.push(player.position)

    const clickNow = (): void => {
      if (click === undefined || n !== click.at) return
      const at = Hex.toPosition(click.cell)
      local.setDestination(at.x, at.y)
    }
    // An unsent click: made in the frames before the flush lands, not sampled yet.
    if (click?.unsent === true) clickNow()
    const heard = n - delay
    if (heard === knockAt && landing !== undefined) local.knockback(landing, acked)
    if (heard >= 0) local.reconcile(server[heard].x, server[heard].y)
    if (click?.unsent !== true) clickNow()
    local.predict(TICK)
    client.push(new Vector(local.x, local.y))
    const data = local.sample((n + 1) * TICK * 1000)
    if (data !== null) inFlight.push({ due: n + 1, data: Buffer.from(data) })
  }
  assert.ok(landing !== undefined)
  return { server, client, player, local, landing }
}

/** Identical, and standing on `at`, over the last `settled` ticks. */
function assertSettled (track: KnockRun, at: Vector, settled = 4): void {
  const end = track.server.length
  for (let i = end - settled; i < end; i++) {
    assert.ok(same(track.server[i], track.client[i]), `tick ${i + 1}: server (${track.server[i].x}, ${track.server[i].y}) vs client (${track.client[i].x}, ${track.client[i].y})`)
    assert.ok(same(track.server[i], at), `tick ${i + 1}: settled at (${track.server[i].x}, ${track.server[i].y}), not (${at.x}, ${at.y})`)
  }
  assert.deepEqual(track.player.path, [])
  assert.deepEqual(track.local.path, [])
}

for (const delay of [1, 2, 3]) {
  test(`mirror: a knockback mid-walk ends the route on both sides, on the landing cell (effect ${delay} tick${delay > 1 ? 's' : ''} late)`, () => {
    const track = knockRun(delay, 4)
    assertSettled(track, Hex.toPosition(track.landing))
    assert.deepEqual(track.local.waypoints, [], 'the next packet still asks for the old route')
  })

  test(`mirror: a knockback of a player standing at its destination leaves both on the landing cell (effect ${delay} tick${delay > 1 ? 's' : ''} late)`, () => {
    const track = knockRun(delay, 25)
    assertSettled(track, Hex.toPosition(track.landing))
  })

  test(`mirror: a one-cell knockback, inside the dead zone reconcile ignores, still moves the client (effect ${delay} late)`, () => {
    const track = knockRun(delay, 25, undefined, 1)
    assertSettled(track, Hex.toPosition(track.landing))
  })

  for (const offset of delay > 1 ? [0, delay - 1] : [0]) {
    test(`mirror: a click ${offset} tick${offset === 1 ? '' : 's'} after the knockback, before its effect (${delay} late), is walked from the landing cell on both sides`, () => {
      const target = new Vector(30, 46)
      const track = knockRun(delay, 4, { at: 4 + offset, cell: target })
      assertSettled(track, Hex.toPosition(target))
    })
  }

  test(`mirror: a click not yet sent when the knockback's effect lands is kept, sent, and walked from the landing cell on both sides (${delay} late)`, () => {
    const target = new Vector(30, 46)
    const track = knockRun(delay, 4, { at: 4 + delay, cell: target, unsent: true })
    assertSettled(track, Hex.toPosition(target))
  })

  // Archie's l1-6 review, F1: a re-click of the knocked route's own
  // destination before the next sample was never sent (the client still held
  // it as sent) and, sent, was dropped by the server as a repeat.
  test(`mirror: a re-click of the knocked route's destination as the effect lands is walked on both sides (${delay} late)`, () => {
    const dest = new Vector(34, 40)
    const track = knockRun(delay, 4, { at: 4 + delay, cell: dest })
    assertSettled(track, Hex.toPosition(dest))
  })

  test(`mirror: the same re-click a tick later is walked on both sides too (${delay} late)`, () => {
    const dest = new Vector(34, 40)
    const track = knockRun(delay, 4, { at: 5 + delay, cell: dest })
    assertSettled(track, Hex.toPosition(dest))
  })

  test(`mirror: a click the server had before the knockback is ended by it on both sides (effect ${delay} late)`, () => {
    // Sent two ticks before the knock, so the server applied it first and
    // the knockback stopped it: both stand on the landing cell.
    const track = knockRun(delay, 4, { at: 2, cell: new Vector(30, 46) })
    assertSettled(track, Hex.toPosition(track.landing))
  })
}
