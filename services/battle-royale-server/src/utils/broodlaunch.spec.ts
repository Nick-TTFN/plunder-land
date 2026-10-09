import test from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import { ARCHETYPES } from '../archetypes/archetypes'
import { ARC_PX, FLIGHT_MS, LAUNCH_MS, REFILL_GROW_MS, SOCKET_REFILL_MS, emptySocket, flightAt, pickSocket, socketLoaded, socketScale } from '../../../../plunder-land-client/src/vfx/broodlaunch'
import { EMERGE_ABOVE_MS } from '../../../../plunder-land-client/src/vfx/broodpick'
import { BROOD_RIG, SPAWN_EVENT, type BroodState } from '../../../../plunder-land-client/src/npcs/brood/rig'
import { BROODLING_RIG, sample as broodlingPose } from '../../../../plunder-land-client/src/npcs/broodling/rig'

/**
 * The Brood's "loaded + launch" (Nick, 2026-10-09, decisions.md "Brood
 * stream"), the pure parts the client draws from (`vfx/broodlaunch.ts`):
 * where the sockets are, which one a launch leaves from, when it refills, and
 * the flight's path and timing against the Brood's clip and the Broodling's
 * emerge. The pixi side (`BroodSockets`, `Mob.launchFrom`/`fly`) is checked
 * by the frames harness, not here.
 */

void Multiplayer
const down = { x: 0, y: 1 }

test('the launch is the Brood clip\'s `spawn` event; the flight lands inside the emerge, curled at the launch and still mostly curled on landing', () => {
  assert.equal(LAUNCH_MS, Math.round(SPAWN_EVENT * 1000))
  const landsAt = LAUNCH_MS + FLIGHT_MS
  assert.equal(landsAt, 630)
  // Inside the server's emerge hold (it stands still on its cell), and inside the over-the-Brood depth (lane 5).
  const fuse = ARCHETYPES.broodling.routines.find((r) => r.kind === 'broodling') as { emergeMs: number }
  assert.ok(landsAt < fuse.emergeMs, `lands at ${landsAt}, after the ${fuse.emergeMs} ms emerge`)
  assert.ok(landsAt < EMERGE_ABOVE_MS)
  // The emerge plays from `spawn.from` at the effect: curled (fold 1) at the
  // launch, and unfolding has barely begun on landing; ready (2.8 s) is the emerge's end.
  const spawn = BROODLING_RIG.roles.spawn!
  assert.equal(broodlingPose('emerge', spawn.from + LAUNCH_MS / 1000).fold, 1)
  assert.ok(broodlingPose('emerge', spawn.from + landsAt / 1000).fold >= 0.85, 'unfolded in the air')
  assert.equal(Math.round((spawn.ready - spawn.from) * 1000), fuse.emergeMs)
  // One flight is over before the next regular beat.
  const release = ARCHETYPES.brood.routines.find((r) => r.kind === 'brood') as { intervalMs: number }
  assert.ok(landsAt < release.intervalMs)
})

test('the Brood\'s pose carries the package\'s three sockets (crown, left, right), moving with its body', () => {
  const idle = BROOD_RIG.pose('idle', 0, down, undefined, undefined, { clock: 0 })
  const state = idle.state as BroodState
  assert.deepEqual(state.sockets.map((s) => s.id), ['crown', 'left', 'right'])
  assert.deepEqual(idle.sockets, state.sockets.map((s) => s.screen))
  // The idle bob moves them.
  const later = BROOD_RIG.pose('idle', 0, down, undefined, undefined, { clock: 1 })
  assert.notDeepEqual(later.sockets, idle.sockets)
  // The release's heave: pressed down before the launch, thrown up after.
  const pressed = BROOD_RIG.pose('spawn', 0.12, down, undefined, undefined, { clock: 0 }).sockets!
  const thrown = BROOD_RIG.pose('spawn', 0.2, down, undefined, undefined, { clock: 0 }).sockets!
  for (let i = 0; i < 3; i++) assert.ok(thrown[i].y < pressed[i].y, `socket ${i} not thrown up by the heave`)
  // A death from a pose still has them (BroodSockets hides them all on a death).
  assert.equal(BROOD_RIG.pose('death', 1, down, undefined, idle).sockets?.length, 3)
})

test('a launch leaves from the loaded socket pointing most nearly its way; an empty one gives way to the next best; none loaded, the best of all', () => {
  const sockets = BROOD_RIG.pose('idle', 0, down).sockets!
  const loaded = [-Infinity, -Infinity, -Infinity]
  const CROWN = 0
  const LEFT = 1
  const RIGHT = 2
  // Screen directions from the Brood to the landing cell.
  assert.equal(pickSocket(sockets, { x: 0, y: -1 }, loaded, 0), CROWN)
  assert.equal(pickSocket(sockets, { x: -1, y: 0 }, loaded, 0), LEFT)
  assert.equal(pickSocket(sockets, { x: 1, y: 0 }, loaded, 0), RIGHT)
  assert.equal(pickSocket(sockets, { x: 0, y: 1 }, loaded, 0), RIGHT, 'south: the right socket is lowest')
  assert.equal(pickSocket(sockets, { x: -1, y: 1 }, loaded, 0), LEFT)

  const crownEmpty = [1000, -Infinity, -Infinity]
  assert.equal(pickSocket(sockets, { x: 0, y: -1 }, crownEmpty, 500), LEFT, 'north with the crown empty: the left is nearer than the right')
  assert.equal(pickSocket(sockets, { x: 0, y: -1 }, crownEmpty, 1000), CROWN, 'refilled')
  assert.equal(pickSocket(sockets, { x: 0, y: -1 }, [1000, 1000, 1000], 500), CROWN, 'none loaded: the best still flies')
  assert.equal(pickSocket(sockets, { x: 0, y: 0 }, [1000, -Infinity, -Infinity], 500), LEFT, 'no direction: the first loaded')
  assert.equal(pickSocket([], { x: 1, y: 0 }, [], 0), -1)
})

test('a socket empties at its launch and refills SOCKET_REFILL_MS (800) after it, growing back in', () => {
  assert.equal(SOCKET_REFILL_MS, 800)
  const loadedAt = [-Infinity, -Infinity, -Infinity]
  assert.ok(socketLoaded(loadedAt, 1, 0))
  // Effect 19 at 1000, launch at 1180.
  emptySocket(loadedAt, 1, 1000 + LAUNCH_MS)
  assert.equal(socketLoaded(loadedAt, 1, 1000), false, 'still loaded at the effect: the real Broodling sits there now')
  assert.equal(socketLoaded(loadedAt, 1, 1000 + LAUNCH_MS + 799), false)
  assert.equal(socketLoaded(loadedAt, 1, 1000 + LAUNCH_MS + 800), true)
  assert.ok(socketLoaded(loadedAt, 0, 1000) && socketLoaded(loadedAt, 2, 1000), 'emptied the others')
  assert.equal(socketScale(loadedAt, 1, 1500), 0)
  assert.equal(socketScale(loadedAt, 1, 1980), 0.4)
  assert.equal(socketScale(loadedAt, 1, 1980 + REFILL_GROW_MS), 1)
  assert.equal(socketScale(loadedAt, 0, 0), 1)
  // At a 1000 ms beat a socket is loaded again before the next launch.
  const release = ARCHETYPES.brood.routines.find((r) => r.kind === 'brood') as { intervalMs: number }
  assert.ok(SOCKET_REFILL_MS < release.intervalMs)
})

test('the flight: in the seat until the launch, then from under the seat to the landing in FLIGHT_MS on an arc, then over', () => {
  const seat = { x: 10, y: -100 }
  const floorY = 0
  const landing = { x: 210, y: 80 }
  for (const ms of [0, 90, LAUNCH_MS - 1]) {
    assert.deepEqual(flightAt(ms, seat, floorY, landing), { ground: { x: 10, y: 0 }, lift: 100, t: 0 }, `at ${ms}`)
  }
  assert.deepEqual(flightAt(LAUNCH_MS, seat, floorY, landing), { ground: { x: 10, y: 0 }, lift: 100, t: 0 })
  const mid = flightAt(LAUNCH_MS + FLIGHT_MS / 2, seat, floorY, landing)!
  assert.deepEqual(mid.ground, { x: 110, y: 40 })
  assert.equal(mid.lift, 50 + ARC_PX)
  const near = flightAt(LAUNCH_MS + FLIGHT_MS - 1, seat, floorY, landing)!
  assert.ok(Math.hypot(near.ground.x - landing.x, near.ground.y - landing.y) < 1)
  assert.ok(near.lift < 1)
  assert.equal(flightAt(LAUNCH_MS + FLIGHT_MS, seat, floorY, landing), undefined)
  // Drawn point (ground raised by lift) moves at most a few px a 10 ms frame: no jump.
  let last: { x: number, y: number } | undefined
  for (let ms = 0; ms < LAUNCH_MS + FLIGHT_MS; ms += 10) {
    const at = flightAt(ms, seat, floorY, landing)!
    assert.ok(at.lift >= 0)
    const drawn = { x: at.ground.x, y: at.ground.y - at.lift }
    if (last !== undefined) assert.ok(Math.hypot(drawn.x - last.x, drawn.y - last.y) < 12, `jump at ${ms}`)
    last = drawn
  }
  // A seat below the floor line (never in the art) is not lifted below the ground.
  assert.equal(flightAt(0, { x: 0, y: 5 }, 0, landing)!.lift, 0)
})
