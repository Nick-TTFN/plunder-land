import test from 'node:test'
import assert from 'node:assert/strict'
import Multiplayer from './multiplayer'
import type Player from '../objects/player'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { ARCHETYPES } from '../archetypes/archetypes'
// Pixi-free, so it loads here (as standings.spec.ts loads the client's standings).
import {
  stillPresent, presenceReach, SLACK_RINGS,
  VIEW_MARGIN_RINGS, VIEW_EXIT_RINGS, EXIT_MARGIN, type Viewpoint
} from '../../../../plunder-land-client/src/net/presence'

/**
 * The client's `Game.stillPresent` (`net/presence.ts`): a held unit that has
 * gone silent stays shown while the server could still be holding the client
 * to it. Two bugs it fixes: a spectator (no own robot) hid every silent unit
 * after a second, and Periscope's leave radius (13 rings, 585 units east-west)
 * reached past the 500 box the client used to measure by.
 */

const INTEREST = Multiplayer.INTEREST_RADIUS
const NOW = 100_000
const STALE_BEFORE = NOW - 1000
const SILENT = NOW - 5000
const PERISCOPE = 11
const PEEP = 6

function silentAt (x: number, y: number): { x: number, y: number, lastUpdate: number } {
  return { x, y, lastUpdate: SILENT }
}

/** The server's verdict for a viewer at `from` with `vision`, on a point at `at`. */
function serverView (from: Vector, vision: number | null, at: Vector): number {
  const viewer = { position: from, archetype: { vision } } as unknown as Player
  return Multiplayer.viewOf(viewer, at.x, at.y, Hex.toCell(at))
}

test('the client copies the server view radii', () => {
  assert.equal(VIEW_MARGIN_RINGS, Multiplayer.VIEW_MARGIN_RINGS)
  assert.equal(VIEW_EXIT_RINGS, Multiplayer.VIEW_EXIT_RINGS)
  assert.equal(EXIT_MARGIN, Multiplayer.EXIT_MARGIN)
})

test('a unit heard from recently is present whatever the viewpoint', () => {
  const unit = { x: 99_999, y: 99_999, lastUpdate: NOW }
  assert.equal(stillPresent(unit, STALE_BEFORE, undefined, INTEREST), true)
  assert.equal(stillPresent(unit, STALE_BEFORE, { x: 0, y: 0, vision: PEEP }, INTEREST), true)
})

test('spectating: a silent unit near the watched robot stays, measured from it', () => {
  // The dead player's own robot is gone (Game.PLAYER undefined); the camera
  // follows the watched one, 2000 units from where the dead one fell.
  const watched: Viewpoint = { x: 2000, y: 2000, vision: PEEP }
  const idleMob = silentAt(2000 + 4 * Hex.SIZE, 2000)
  assert.equal(stillPresent(idleMob, STALE_BEFORE, watched, INTEREST), true)
  // A watched Periscope sees further, and so does its spectator (#48).
  const farIdle = silentAt(2000 + 13 * Hex.SIZE, 2000)
  assert.equal(stillPresent(farIdle, STALE_BEFORE, { ...watched, vision: PERISCOPE }, INTEREST), true)
  // With no viewpoint at all (between runs, a watch that ended) silence is
  // absence, as before: the server forgets what it held without destroys.
  assert.equal(stillPresent(idleMob, STALE_BEFORE, undefined, INTEREST), false)
})

test('Periscope: a silent unit on the leave ring east-west stays, past the old 500 box', () => {
  const from = Hex.toPosition(new Vector(40, 40))
  const leave = PERISCOPE + VIEW_MARGIN_RINGS + VIEW_EXIT_RINGS
  const at = Hex.toPosition(new Vector(40 + leave, 40))
  assert.equal(serverView(from, PERISCOPE, at), Multiplayer.VIEW_EDGE, 'the server still holds it')
  assert.ok(Math.abs(at.x - from.x) >= INTEREST, 'the old 500 box would have dropped it')
  assert.equal(stillPresent(silentAt(at.x, at.y), STALE_BEFORE, { x: from.x, y: from.y, vision: PERISCOPE }, INTEREST), true)
})

test('every point the server still holds is present, for every robot and none (population)', () => {
  const visions = new Set<number | null>([null])
  for (const row of Object.values(ARCHETYPES)) if (row.kind === 'robot') visions.add(row.vision)
  assert.ok(visions.has(PERISCOPE) && visions.has(PEEP))

  // Viewpoints at cell centres and off-centre within their cells; units on a
  // 9-unit grid over a box wider than any leave radius.
  const centre = Hex.toPosition(new Vector(50, 50))
  const offsets = [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20], [11, 18], [-11, -18]]
  let held = 0
  for (const vision of visions) {
    for (const [ox, oy] of offsets) {
      const from = new Vector(centre.x + ox, centre.y + oy)
      const vp: Viewpoint = { x: from.x, y: from.y, vision }
      const span = 20 * Hex.SIZE
      for (let dx = -span; dx <= span; dx += 9) {
        for (let dy = -span; dy <= span; dy += 9) {
          const at = new Vector(from.x + dx, from.y + dy)
          if (serverView(from, vision, at) === Multiplayer.VIEW_OUT) continue
          held++
          assert.equal(stillPresent(silentAt(at.x, at.y), STALE_BEFORE, vp, INTEREST), true,
            `vision ${String(vision)}: (${dx}, ${dy}) is held by the server but hidden`)
        }
      }
    }
  }
  assert.ok(held > 10_000, `checked ${held} held points`)
})

test('a silent unit far beyond the leave radius is dropped', () => {
  const from = Hex.toPosition(new Vector(40, 40))
  for (const vision of [PEEP, PERISCOPE, null]) {
    const reach = presenceReach(vision, INTEREST)
    const vp: Viewpoint = { x: from.x, y: from.y, vision }
    // Just beyond the reach, on either axis: gone.
    assert.equal(stillPresent(silentAt(from.x + reach + 1, from.y), STALE_BEFORE, vp, INTEREST), false)
    assert.equal(stillPresent(silentAt(from.x, from.y - reach - 1), STALE_BEFORE, vp, INTEREST), false)
    // And the reach is only the slack beyond what the server could hold.
    const serverBound = vision === null
      ? INTEREST + EXIT_MARGIN
      : (vision + VIEW_MARGIN_RINGS + VIEW_EXIT_RINGS + 1) * Hex.SIZE
    assert.equal(reach, Math.max(INTEREST, serverBound + SLACK_RINGS * Hex.SIZE))
  }
  // Periscope at 20 cells east: the server let it go long ago.
  const far = Hex.toPosition(new Vector(60, 40))
  assert.equal(serverView(from, PERISCOPE, far), Multiplayer.VIEW_OUT)
  assert.equal(stillPresent(silentAt(far.x, far.y), STALE_BEFORE, { x: from.x, y: from.y, vision: PERISCOPE }, INTEREST), false)
})
