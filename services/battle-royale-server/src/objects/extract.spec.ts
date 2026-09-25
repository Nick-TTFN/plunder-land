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
import { ITEMS } from '../archetypes/archetypes'
import { detonate } from '../items/bomb'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Extraction is a channel on the exit's cell (#16): 5 / 7 / 9 s by layer,
 * cancelled by stepping off or by a hit that does damage. Exits stopped being
 * solid to players for it, on both sides, and the second half of this file
 * holds the client's `LocalPlayer` to the server's `Unit.update` on that.
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
// the server's tsconfig, which they were never written for (TS2729 on
// `LocalPlayer.RADIUS`). The client has its own typecheck.
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

// --- the pad is a zone to players and solid to mobs -------------------------

test('a player standing on an exit is not pushed off it', () => {
  const exit = exitOn(TOP)
  const player = playerOn(TOP)
  player.position = exit.position.add(new Vector(5, 0))
  player.update(TICK)
  assert.equal(player.position.sub(exit.position).getMagnitude(), 5)
})

test('a mob is still pushed off an exit, as off a portal', () => {
  const exit = exitOn(TOP)
  const at = exit.position.add(new Vector(5, 0))
  const mob = new Unit(ObjectType.Mob, at.x, at.y, 10, TOP)
  mob.maxVelocity = 140
  World.MOBS.push(mob)
  mob.update(TICK)
  assert.equal(Math.round(mob.position.sub(exit.position).getMagnitude()), exit.radius + mob.radius)
})

// --- the client mirror --------------------------------------------------------

interface Local {
  x: number
  y: number
  waypoints: Vector[]
  path: unknown[]
  repath: () => void
  reset: (x: number, y: number, tag: number, maxVelocity: number, radius: number) => void
  predict: (dt: number) => void
}

/**
 * The server's player and the client's `LocalPlayer` walk the same route over
 * the same objects; the client's colliders are whatever `SOLID_TYPES` lets
 * through, as `Game.onObjectCreated` builds them. Returns both tracks.
 */
function walkBoth (from: Vector, to: Vector, ticks: number): { server: Vector[], client: Vector[] } {
  const player = playerOn(TOP, from)
  const colliders = World.OBSTACLES
    .filter((obj) => (LocalPlayer.SOLID_TYPES as number[]).includes(obj.type))
    .map((obj) => ({ x: obj.position.x, y: obj.position.y, radius: obj.radius, tag: obj.tag }))
  const local: Local = new LocalPlayer(() => colliders, (q: number, r: number) => World.isBlocked(q, r, TOP))
  local.reset(player.position.x, player.position.y, TOP, player.maxVelocity, player.radius)

  player.setWaypoints([to])
  local.waypoints = [new Vector(to.x, to.y)]
  local.repath()
  assert.ok(local.path.length > 0 && player.path.length > 0, 'no route')

  const server: Vector[] = []
  const client: Vector[] = []
  for (let n = 0; n < ticks && !player.exited; n++) {
    player.update(TICK)
    local.predict(TICK)
    server.push(player.position)
    client.push(new Vector(local.x, local.y))
  }
  return { server, client }
}

function assertSameTrack (track: { server: Vector[], client: Vector[] }): void {
  track.server.forEach((s, i) => {
    const c = track.client[i]
    assert.ok(
      Math.abs(s.x - c.x) < 1e-6 && Math.abs(s.y - c.y) < 1e-6,
      `tick ${i + 1}: server (${s.x}, ${s.y}) vs client (${c.x}, ${c.y})`
    )
  })
}

test('mirror: client and server both walk straight across an exit\'s pad', () => {
  const exit = exitOn(TOP)
  // A rock beside the route too, so the colliders are not just the exit.
  World.OBSTACLES.push(new Obstacle(Hex.toPosition(new Vector(30, 39)).x, Hex.toPosition(new Vector(30, 39)).y, TOP))
  const track = walkBoth(new Vector(27, 40), new Vector(33, 40), 12)
  assertSameTrack(track)
  const closest = Math.min(...track.server.map((p) => p.sub(exit.position).getMagnitude()))
  // Samples are a tick (35 units) apart, so they straddle the centre. A solid
  // exit would have held the player at 64 (its 50 plus a peep's 14).
  assert.ok(closest < 20, `the walk never got onto the pad (closest ${closest})`)
})

test('mirror: both end on an exit\'s centre when it is the destination', () => {
  const exit = exitOn(TOP)
  const track = walkBoth(new Vector(26, 40), EXIT_CELL, 8)
  assertSameTrack(track)
  const last = track.server[track.server.length - 1]
  assert.ok(last.sub(exit.position).getMagnitude() < 1e-6)
})

test('mirror: both are pushed out of a portal identically', () => {
  const at = Hex.toPosition(EXIT_CELL)
  // A portal to its own layer, so the crossing cannot change the server's tag.
  const portal = new Portal(at.x, at.y, TOP, TOP)
  World.OBSTACLES.push(portal)
  const track = walkBoth(new Vector(26, 40), EXIT_CELL, 10)
  assertSameTrack(track)
  const last = track.server[track.server.length - 1]
  assert.equal(Math.round(last.sub(portal.position).getMagnitude()), portal.radius + 14)
})

// --- a portal hop ends the route (gate-hygiene) -------------------------------
//
// A route is planned against one layer's rocks. A portal moves the player to
// another layer at the spot it pushed them out to, and a route that carried on
// from there walked the new layer along cells chosen on the old one. Both
// sides now stop on a layer change: the server as the portal moves the player
// (`Unit.changeLayer`), the client when that tag reaches it
// (`LocalPlayer.changeLayer`, called from `Game.onObjectUpdated`).

function portalOn (tag: number, to: number, cell: Vector = EXIT_CELL): Portal {
  const at = Hex.toPosition(cell)
  const portal = new Portal(at.x, at.y, to, tag)
  World.OBSTACLES.push(portal)
  return portal
}

test('a portal hop mid-route stops the player where the portal put them', () => {
  const portal = portalOn(TOP, MIDDLE)
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
  const landed = player.position
  assert.equal(Math.round(landed.sub(portal.position).getMagnitude()), portal.radius + player.radius)
  assert.deepEqual(player.path, [], 'the route planned on layer 01 survived the hop')
  assert.deepEqual(player.waypoints, [], 'the waypoints survived the hop')

  for (let n = 0; n < 8; n++) player.update(TICK)
  assert.equal(player.tag, MIDDLE)
  assert.deepEqual(player.position, landed, 'the player walked on across layer 02')
})

test('a portal to the player\'s own layer is not a hop and leaves the route alone', () => {
  portalOn(TOP, TOP)
  const player = playerOn(TOP, new Vector(26, 40))
  player.setWaypoints([new Vector(34, 40)])
  for (let n = 0; n < 6; n++) player.update(TICK)
  assert.ok(player.path.length > 0, 'a same-layer contact ended the route')
  assert.equal(player.waypoints.length, 1)
})

test('a mob pushed out of a portal keeps its route: it never changes layer', () => {
  portalOn(TOP, MIDDLE)
  const at = Hex.toPosition(new Vector(26, 40))
  const mob = new Unit(ObjectType.Mob, at.x, at.y, 14, TOP)
  mob.maxVelocity = 140
  World.MOBS.push(mob)
  mob.setWaypoints([new Vector(34, 40)])
  for (let n = 0; n < 8; n++) mob.update(TICK)
  assert.equal(mob.tag, TOP)
  assert.ok(mob.path.length > 0)
})

interface LayeredLocal extends Local {
  tag: number
  changeLayer: (tag: number) => void
}

/**
 * `walkBoth` across a portal, with the tag reaching the client `delay` ticks
 * after the server changed it, the way an `update` record does. What the
 * client does with it is what `Game.onObjectUpdated` does: hand it to
 * `LocalPlayer.changeLayer`. Colliders carry their tag, and `_step` skips any
 * not on the client's current layer, as in the game.
 */
function walkAcross (from: Vector, to: Vector, ticks: number, delay: number): { server: Vector[], client: Vector[], local: LayeredLocal, player: Player } {
  const player = playerOn(TOP, from)
  const colliders = World.OBSTACLES
    .filter((obj) => (LocalPlayer.SOLID_TYPES as number[]).includes(obj.type))
    .map((obj) => ({ x: obj.position.x, y: obj.position.y, radius: obj.radius, tag: obj.tag }))
  const local: LayeredLocal = new LocalPlayer(() => colliders, (q: number, r: number) => World.isBlocked(q, r, local.tag))
  local.reset(player.position.x, player.position.y, TOP, player.maxVelocity, player.radius)

  player.setWaypoints([to])
  local.waypoints = [new Vector(to.x, to.y)]
  local.repath()
  assert.ok(local.path.length > 0 && player.path.length > 0, 'no route')

  const tags: number[] = []
  const server: Vector[] = []
  const client: Vector[] = []
  for (let n = 0; n < ticks; n++) {
    player.update(TICK)
    tags.push(player.tag)
    const arrived = tags[n - delay]
    // Game.onObjectUpdated, on a tag that differs from the one it holds.
    if (arrived !== undefined && arrived !== local.tag) local.changeLayer(arrived)
    local.predict(TICK)
    server.push(player.position)
    client.push(new Vector(local.x, local.y))
  }
  return { server, client, local, player }
}

test('mirror: an ordinary arrival still keeps the client\'s destination, and a same-layer tag changes nothing', () => {
  // CLAUDE.md, "Arriving does not clear the waypoints, only the path".
  const track = walkAcross(new Vector(26, 40), new Vector(30, 40), 8, 1)
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

for (const delay of [1, 2, 3]) for (const route of HOP_ROUTES) {
  test(`mirror: a portal hop ${route.name} stops both sides at the same spot (tag ${delay} tick${delay > 1 ? 's' : ''} late)`, () => {
    const portal = portalOn(TOP, MIDDLE)
    // A rock on layer 02 across the old route, so walking on would show.
    const rock = Hex.toPosition(new Vector(32, 40))
    World.OBSTACLES.push(new Obstacle(rock.x, rock.y, MIDDLE))
    const track = walkAcross(new Vector(26, 40), route.to, 16, delay)
    assertSameTrack(track)
    assert.equal(track.player.tag, MIDDLE)
    assert.equal(track.local.tag, MIDDLE)
    assert.deepEqual(track.local.path, [])
    assert.deepEqual(track.local.waypoints, [], 'the next input packet would still ask for the old route')
    const last = track.server[track.server.length - 1]
    assert.equal(Math.round(last.sub(portal.position).getMagnitude()), portal.radius + 14)
  })
}
