import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import Player from '../objects/player'
// The client's copies (byte-identical to the server's, mirror.spec.ts), so
// the types line up with the client modules under test.
import { Hex } from '../../../../plunder-land-client/src/utils/hex'
import { Vector } from '../../../../plunder-land-client/src/utils/vector'
import { Path } from '../../../../plunder-land-client/src/utils/path'
import {
  STICK_CELLS, STICK_SECTORS, SECTOR_HYSTERESIS, StickSteer, sectorAngle, sectorOf, steer, stickTarget
} from '../../../../plunder-land-client/src/input/stick'
import { LocalPlayer } from '../../../../plunder-land-client/src/net/localplayer'
import { RunMap } from '../../../../plunder-land-client/src/net/runmap'

/**
 * The left-thumb joystick (decision #59, mobile-2;
 * plunder-land-client/src/input/stick.ts): the stick's target is the farthest
 * free cell along its line, always reachable inside a small disc, re-targets
 * are capped at one a tick, and a release stops both sides on the same cell
 * with a one-waypoint packet, never a bare stop (count 0).
 */

const TAG = 0
const MAP = 4000
const TICK = 0.25
const TICK_MS = 250

beforeEach(() => {
  const noop = (): void => {}
  Multiplayer.Instance = {
    create: noop, update: noop, destroy: noop, effect: noop, effectAt: noop
  } as unknown as Multiplayer
  World.mapSize = MAP
  World.BLOCKED.clear()
  World.VOIDS.clear()
  World.OBSTACLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

/** A seeded RNG, so a failure names a case that repeats. */
function rng (seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

/**
 * The client's own blocked rule, as `Game.isBlocked` builds it: off the map,
 * or a valley, a wall or a blocked cell (rocks, stones, exits) in its
 * `RunMap` (`net/runmap.ts` `has`).
 */
function clientBlocked (map: RunMap): (q: number, r: number) => boolean {
  return (q, r) => !Hex.onMap(q, r, MAP) || map.has(q, r, TAG)
}

function emptyMap (): RunMap {
  const map = new RunMap()
  map.setVoids([TAG], [new Set()])
  map.setWalls([TAG], [new Set()])
  return map
}

const MID = new Vector(40, 40)
const EAST = 0

// --- the target --------------------------------------------------------------

test('stick: on open ground the target is STICK_CELLS out along the stick, on its line', () => {
  const blocked = clientBlocked(emptyMap())
  for (let sector = 0; sector < STICK_SECTORS; sector++) {
    const target = stickTarget(MID, sectorAngle(sector), blocked)
    assert.ok(target !== undefined, `sector ${sector}: no target`)
    assert.equal(Hex.distance(MID, target), STICK_CELLS, `sector ${sector}`)
    // The world direction to it is within a sector of the stick's.
    const a = Hex.toPosition(MID)
    const b = Hex.toPosition(target)
    let off = Math.atan2(b.y - a.y, b.x - a.x) - sectorAngle(sector)
    off = Math.atan2(Math.sin(off), Math.cos(off))
    assert.ok(Math.abs(off) <= Math.PI / 6 + 1e-9, `sector ${sector}: aimed ${off} rad off`)
  }
  assert.deepEqual(stickTarget(MID, EAST, blocked), new Vector(MID.x + STICK_CELLS, MID.y))
})

/** Each kind of cell the client refuses, placed on cell `at` of `map`. */
const BLOCKERS: Array<[string, (map: RunMap, at: Vector) => void]> = [
  ['a valley (void)', (map, at) => { map.setVoids([TAG], [new Set([Hex.key(at.x, at.y)])]) }],
  ['a wall', (map, at) => { map.setWalls([TAG], [new Set([Hex.key(at.x, at.y)])]) }],
  ['a blocked cell (rock, stone, exit)', (map, at) => { map.block(at.x, at.y, TAG) }]
]

for (const [name, place] of BLOCKERS) {
  test(`stick: the target stops before ${name}, and is none when it is the first cell`, () => {
    for (let k = 1; k <= STICK_CELLS; k++) {
      const map = emptyMap()
      place(map, new Vector(MID.x + k, MID.y))
      const target = stickTarget(MID, EAST, clientBlocked(map))
      if (k === 1) assert.equal(target, undefined, 'blocked first cell: stand')
      else assert.deepEqual(target, new Vector(MID.x + k - 1, MID.y), `blocker ${k} out`)
    }
  })
}

test('stick: the farthest cell before the FIRST blocked one, never a free cell past it', () => {
  const map = emptyMap()
  map.block(MID.x + 2, MID.y, TAG)
  // Cell 3 is free, but past the blocker.
  assert.deepEqual(stickTarget(MID, EAST, clientBlocked(map)), new Vector(MID.x + 1, MID.y))
})

test('stick: the map edge stops the target, and at the edge there is none', () => {
  const blocked = clientBlocked(emptyMap())
  // The west edge: x = SIZE * (q + r/2) < 0 is off the map.
  const r = 40
  const edgeQ = -r / 2 // x = 0 exactly: on the map
  assert.ok(!blocked(edgeQ, r) && blocked(edgeQ - 1, r))
  assert.deepEqual(stickTarget(new Vector(edgeQ + 2, r), Math.PI, blocked), new Vector(edgeQ, r), 'two cells from the edge: stops on the last cell')
  assert.equal(stickTarget(new Vector(edgeQ, r), Math.PI, blocked), undefined, 'on the edge, aimed off it: stand')
})

test('stick: Hopper\'s rule (only valleys and the edge) is the one used, whatever it is', () => {
  const map = emptyMap()
  map.setWalls([TAG], [new Set([Hex.key(MID.x + 1, MID.y)])])
  const hopper = (q: number, r: number): boolean => !Hex.onMap(q, r, MAP) || map.voids.get(TAG)?.has(Hex.key(q, r)) === true
  assert.deepEqual(stickTarget(MID, EAST, hopper), new Vector(MID.x + STICK_CELLS, MID.y), 'Hopper goes through the wall')
  assert.equal(stickTarget(MID, EAST, clientBlocked(map)), undefined, 'Peep does not')
})

test('stick: for random maps and angles every target is reached by Path.find inside the STICK_CELLS disc', () => {
  const random = rng(59)
  let targets = 0
  let maxSearched = 0
  let none = 0
  for (let trial = 0; trial < 3000; trial++) {
    const density = [0.1, 0.3, 0.5][trial % 3]
    const map = emptyMap()
    const walls = new Set<number>()
    const voids = new Set<number>()
    for (let q = MID.x - 6; q <= MID.x + 6; q++) {
      for (let r = MID.y - 6; r <= MID.y + 6; r++) {
        if (q === MID.x && r === MID.y) continue
        const roll = random()
        if (roll < density / 3) map.block(q, r, TAG)
        else if (roll < 2 * density / 3) walls.add(Hex.key(q, r))
        else if (roll < density) voids.add(Hex.key(q, r))
      }
    }
    map.setWalls([TAG], [walls])
    map.setVoids([TAG], [voids])
    const blocked = clientBlocked(map)
    const angle = random() * 2 * Math.PI
    const target = stickTarget(MID, angle, blocked)
    if (target === undefined) { none++; continue }
    targets++
    assert.ok(!blocked(target.x, target.y), 'a blocked target')
    const searched = new Set<number>()
    const counting = (q: number, r: number): boolean => { searched.add(Hex.key(q, r)); return blocked(q, r) }
    const path = Path.find(MID, target, counting)
    assert.ok(path.length > 0, `trial ${trial}: (${target.x}, ${target.y}) unreachable`)
    assert.ok(path.length <= STICK_CELLS, `trial ${trial}: ${path.length} steps, more than ${STICK_CELLS}`)
    // BFS reaches depth <= STICK_CELLS, so it looks at nothing beyond the
    // neighbours of that disc.
    for (let q = MID.x - 10; q <= MID.x + 10; q++) {
      for (let r = MID.y - 10; r <= MID.y + 10; r++) {
        if (searched.has(Hex.key(q, r))) assert.ok(Hex.distance(MID, new Vector(q, r)) <= STICK_CELLS + 1, `trial ${trial}: searched (${q}, ${r})`)
      }
    }
    maxSearched = Math.max(maxSearched, searched.size)
  }
  assert.ok(targets > 1000 && none > 0, `targets ${targets}, none ${none}`)
  // The disc of radius STICK_CELLS + 1 has 1 + 3 * 4 * 5 = 61 cells.
  assert.ok(maxSearched <= 1 + 3 * (STICK_CELLS + 1) * (STICK_CELLS + 2), `searched ${maxSearched} cells`)
})

// --- bins and the cap ------------------------------------------------------------

test('stick: a sector does not flip at its boundary; it changes only past the hysteresis', () => {
  const width = (2 * Math.PI) / STICK_SECTORS
  const edge = width / 2 // between sector 0 and 1
  const margin = width * SECTOR_HYSTERESIS
  assert.equal(sectorOf(edge - 1e-6), 0)
  assert.equal(sectorOf(edge + 1e-6), 1)
  // Held in 0, wobbling across the edge by less than the margin: stays 0.
  for (const wobble of [-margin * 0.9, -1e-6, 1e-6, margin * 0.5, margin * 0.99]) {
    assert.equal(sectorOf(edge + wobble, 0), 0, `wobble ${wobble}`)
  }
  assert.equal(sectorOf(edge + margin * 1.01, 0), 1, 'past the margin: changes')
  // And back the other way from 1.
  assert.equal(sectorOf(edge - margin * 0.99, 1), 1)
  assert.equal(sectorOf(edge - margin * 1.01, 1), 0)
  // Wraps at +-pi and 0.
  assert.equal(sectorOf(-1e-6, 0), 0)
  assert.equal(sectorOf(2 * Math.PI - 1e-6), 0)
  assert.equal(sectorOf(-edge - margin * 0.5, 0), 0)
  assert.equal(sectorOf(-edge - margin * 1.01, 0), STICK_SECTORS - 1)
})

test('stick: a held stick on a boundary changes its route at most once however the thumb trembles', () => {
  const stick = new StickSteer()
  const edge = Math.PI / STICK_SECTORS
  let changes = 0
  let last: number | undefined
  const random = rng(7)
  for (let i = 0; i < 500; i++) {
    stick.aim(edge + (random() - 0.5) * 2 * edge * SECTOR_HYSTERESIS * 0.95)
    if (stick.sector !== last) { changes++; last = stick.sector }
  }
  assert.equal(changes, 1, 'the first bin only')
})

/** A LocalPlayer on open ground at `cell`, as the game makes it. */
function localAt (cell: Vector, blocked: (q: number, r: number) => boolean): LocalPlayer {
  const local = new LocalPlayer(blocked)
  const at = Hex.toPosition(cell)
  local.reset(at.x, at.y, TAG, 140)
  return local
}

test('stick: re-targets are capped at one per tick, even with the bin changing every frame', () => {
  const blocked = clientBlocked(emptyMap())
  const local = localAt(MID, blocked)
  let routes = 0
  const set = local.setDestination.bind(local)
  local.setDestination = (x: number, y: number) => { routes++; set(x, y) }
  const stick = new StickSteer()
  const perTick = new Map<number, number>()
  // 60 fps for 20 ticks, a new bin on every frame.
  for (let frame = 0; frame < 300; frame++) {
    const now = frame * (1000 / 60)
    stick.aim(sectorAngle(frame % STICK_SECTORS))
    const before = routes
    steer(local, stick, now, TICK_MS, blocked)
    if (routes > before) {
      const tick = Math.floor(now / TICK_MS)
      perTick.set(tick, (perTick.get(tick) ?? 0) + 1)
    }
    local.predict(1 / 60)
  }
  for (const [tick, n] of perTick) assert.ok(n <= 1, `tick ${tick}: ${n} re-targets`)
  assert.ok(routes >= 18, `only ${routes} re-targets in 20 ticks`)
})

test('stick: a held stick keeps walking: it re-targets when 1 cell or less is left, and after a stop', () => {
  const blocked = clientBlocked(emptyMap())
  const local = localAt(MID, blocked)
  const stick = new StickSteer()
  stick.aim(EAST)
  let now = 0
  for (let frame = 0; frame < 240; frame++) {
    steer(local, stick, now, TICK_MS, blocked)
    local.predict(1 / 60)
    now += 1000 / 60
  }
  // 4 s at 140 a second is about 12 cells.
  assert.ok(local.cell.x - MID.x >= 11, `only got to ${local.cell.x}`)
  assert.ok(local.path.length > 0, 'still walking')
  // A knockback-style stop: the stick re-targets on the next due frame.
  local.stop()
  steer(local, stick, now + TICK_MS, TICK_MS, blocked)
  assert.ok(local.path.length > 0, 'did not resume')
})

// --- release: client LocalPlayer against server Player ---------------------------

interface Packet { frame: number, count: number, cells: Vector[] }

function decode (data: ArrayBuffer): { count: number, cells: Vector[] } {
  const view = new DataView(data)
  const count = view.getUint8(0)
  const cells: Vector[] = []
  for (let i = 0; i < count; i++) cells.push(new Vector(view.getInt16(1 + i * 4), view.getInt16(1 + i * 4 + 2)))
  return { count, cells }
}

const FRAMES = 5 // per tick: 50 ms frames
const START = new Vector(26, 40)

interface ReleaseRun {
  server: Vector
  client: Vector
  serverPath: number
  clientPath: number
  packets: Packet[]
  /**
   * Where in the step the release fell: `before` the midpoint (still in the
   * cell the robot left, heading out of it toward the cut cell), `after` it
   * (rounded into a cell whose centre it is not walking to, so it is heading
   * back across it toward the cut cell), or `centre` (on a centre). Measured as
   * the sign of (position - own cell's centre) . (cut cell's centre - own
   * cell's centre), so it holds along any sector, not only East.
   */
  phase: 'before' | 'after' | 'centre'
  walking: boolean
  cut: Vector | undefined
}

/**
 * The stick held along `sector` (East is 0) from frame 0 and released at `releaseFrame`; the
 * client runs `FRAMES` frames a tick (steer, sample, predict, as `frame()`
 * does), each packet reaches the server's own `Multiplayer.onPointer`
 * `delay` ticks after the tick it was sent in, and the client hears the
 * server's position a tick after each server tick (`reconcile`).
 */
function releaseRun (delay: number, releaseFrame: number, sector = 0, ticks = 30): ReleaseRun {
  const at = Hex.toPosition(START)
  const player = new Player(at.x, at.y, TAG, 'bot')
  World.PLAYERS.push(player)
  const connection = { player, lastWaypoints: [] as Vector[], lastInputSeq: 0, ackElapsedMs: 0 }
  player.connection = connection as unknown as Player['connection']
  const onPointer = (Multiplayer.prototype as unknown as { onPointer: (c: unknown, d: unknown) => void }).onPointer
  const blocked = (q: number, r: number): boolean => World.isBlocked(q, r, TAG)
  const local = localAt(START, blocked)
  local.reset(player.position.x, player.position.y, TAG, player.maxVelocity)
  const stick = new StickSteer()
  stick.aim(sectorAngle(sector))

  const inFlight: Array<{ due: number, data: Buffer }> = []
  const packets: Packet[] = []
  let phase: ReleaseRun['phase'] = 'centre'
  let walking = false
  let cut: Vector | undefined
  const dt = TICK / FRAMES
  for (let n = 0; n < ticks; n++) {
    if (n > 0) local.reconcile(player.position.x, player.position.y)
    for (let f = 0; f < FRAMES; f++) {
      const frame = n * FRAMES + f
      // From 1 s: `sample` holds its first packet until a tick after 0.
      const now = 1000 + frame * dt * 1000
      if (frame === releaseFrame) {
        walking = local.path.length > 0
        if (walking) {
          cut = local.path[local.pathIndex]
          const own = Hex.toPosition(local.cell)
          const to = Hex.toPosition(cut)
          const dot = ((local.x - own.x) * (to.x - own.x) + (local.y - own.y) * (to.y - own.y)) / (Hex.SIZE * Hex.SIZE)
          phase = dot > 0.02 ? 'before' : dot < -0.02 ? 'after' : 'centre'
        }
        stick.release()
        local.cutToNextCell()
      }
      steer(local, stick, now, TICK_MS, blocked)
      const data = local.sample(now)
      if (data !== null) {
        packets.push({ frame, ...decode(data) })
        inFlight.push({ due: n + delay, data: Buffer.from(data) })
      }
      local.predict(dt)
    }
    for (const packet of inFlight.filter((p) => p.due === n)) onPointer.call({}, connection, packet.data)
    player.update(TICK)
  }
  return {
    server: new Vector(player.position.x, player.position.y), client: new Vector(local.x, local.y),
    serverPath: player.path.length, clientPath: local.path.length,
    packets, phase, walking, cut
  }
}

/**
 * The release rule over `frames` release points from the third frame on,
 * along `sector`: both sides end on the same cell, the cut cell, stopped; no
 * count-0 packet ever; the release packet is the cut cell alone, unless the
 * route already ended there. Returns how the releases fell in the step.
 */
function assertReleases (delay: number, sector: number, frames: number): { before: number, after: number, sent: number } {
  let before = 0
  let after = 0
  let sent = 0
  for (let releaseFrame = 3; releaseFrame < 3 + frames; releaseFrame++) {
    const run = releaseRun(delay, releaseFrame, sector)
    const label = `sector ${sector}, release at frame ${releaseFrame} (${run.phase} the midpoint)`
    assert.ok(run.walking, `${label}: not walking`)
    if (run.phase === 'before') before++
    if (run.phase === 'after') after++
    assert.deepEqual(Hex.toCell(run.server), Hex.toCell(run.client), `${label}: server cell vs client cell`)
    assert.deepEqual(Hex.toCell(run.client), run.cut, `${label}: did not stop on the cut cell`)
    assert.equal(run.serverPath, 0, `${label}: server still walking`)
    assert.equal(run.clientPath, 0, `${label}: client still walking`)
    for (const p of run.packets) assert.ok(p.count >= 1, `${label}: a count-0 packet at frame ${p.frame}`)
    const release = run.packets.filter((p) => p.frame >= releaseFrame)
    if (release.length > 0) {
      sent++
      assert.equal(release.length, 1, `${label}: ${release.length} packets after the release`)
      assert.equal(release[0].count, 1)
      assert.deepEqual(release[0].cells, [run.cut])
    } else {
      const last = run.packets[run.packets.length - 1]
      assert.deepEqual(last.cells, [run.cut], `${label}: nothing sent and the last route was not the cut cell`)
    }
  }
  return { before, after, sent }
}

for (const delay of [0, 1, 2]) {
  test(`stick release (server ${delay} tick${delay === 1 ? '' : 's'} behind): before and after the step's midpoint both sides end on the same cell, and the release sends one waypoint, never count 0`, () => {
    // Releases across about two cells of walking East.
    const { before, after, sent } = assertReleases(delay, 0, 16)
    assert.ok(before >= 3 && after >= 3, `releases before the midpoint ${before}, after ${after}`)
    assert.ok(sent >= 8, `only ${sent} of 16 releases sent a cut packet`)
  })

  // Off East: the other hex directions (2, 10) and the bins between them,
  // whose lines zig-zag (1, 3, 5, 7), on open ground.
  for (const sector of [1, 2, 3, 5, 7, 10]) {
    test(`stick release along sector ${sector} (server ${delay} tick${delay === 1 ? '' : 's'} behind): same cell on both sides, one waypoint, never count 0`, () => {
      const { before, after, sent } = assertReleases(delay, sector, 24)
      assert.ok(before >= 3 && after >= 3, `releases before the midpoint ${before}, after ${after}`)
      assert.ok(sent >= 8, `only ${sent} of 24 releases sent a cut packet`)
    })
  }
}

test('stick release while standing sends nothing new', () => {
  const blocked = clientBlocked(emptyMap())
  const local = localAt(MID, blocked)
  assert.ok(local.sample(1000) !== null, 'the run\'s first sample')
  local.cutToNextCell()
  assert.equal(local.sample(1000 + TICK_MS), null)
  assert.deepEqual(local.waypoints, [])
})

test('stick release in the last cell of the route keeps that cell as the waypoint, though the client\'s own path to it is empty', () => {
  const blocked = clientBlocked(emptyMap())
  const local = localAt(MID, blocked)
  const to = Hex.toPosition(new Vector(MID.x + 1, MID.y))
  local.setDestination(to.x, to.y)
  assert.ok(local.sample(1000) !== null)
  // Past the midpoint: rounded into the last cell, not at its centre.
  local.predict(0.25)
  assert.deepEqual(local.cell, new Vector(MID.x + 1, MID.y))
  assert.ok(local.path.length > 0)
  local.cutToNextCell()
  assert.deepEqual(local.waypoints, [new Vector(MID.x + 1, MID.y)])
  // No change from the route already sent: nothing new, and certainly no stop.
  assert.equal(local.sample(1000 + TICK_MS), null)
  local.predict(0.25)
  assert.deepEqual(new Vector(local.x, local.y), to, 'walked on to the centre')
})
