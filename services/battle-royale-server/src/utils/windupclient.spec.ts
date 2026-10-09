import test from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import { ARCHETYPES, type RoutineSpec } from '../archetypes/archetypes'
import { kilnFlight } from '../../../../plunder-land-client/src/vfx/kilnflight'
import { NPC_RIGS } from '../../../../plunder-land-client/src/npcs/npcrig'
import { LAUNCH } from '../../../../plunder-land-client/src/npcs/kiln/rig'
import { SPAWN_EVENT } from '../../../../plunder-land-client/src/npcs/brood/rig'
import { SHOT } from '../../../../plunder-land-client/src/robots/eyeshot'
import { Session } from '../../../../plunder-land-client/src/net/session'

/**
 * The client's side of the NPC wind-up holds (#52 lane 2): the Kiln's slug
 * leaves at its clip's launch and lands on the server's landing, and every
 * hold is long enough for what the client plays on it and for the render
 * lag (Archie's lane-1 F8).
 */

const TICK_MS = 250

/** An effect's lifetime as the client reads it: the wire's tenths of a second. */
const onWire = (ms: number): number => Multiplayer.effectLifetime(ms) * 100

const holdOf = (key: keyof typeof ARCHETYPES): number => {
  for (const r of ARCHETYPES[key].routines as readonly RoutineSpec[]) {
    if ((r.kind === 'useSkillOnTarget' || r.kind === 'shockwave' || r.kind === 'brood') && r.holdMs !== undefined) return r.holdMs
    if (r.kind === 'broodling') return r.emergeMs
  }
  throw new Error(`${key}: no hold`)
}

test('the Kiln slug waits in the Kiln until the launch, then flies the rest and lands on the flight\'s end', () => {
  const flight = onWire(1250)
  const launch = LAUNCH * 1000
  assert.equal(NPC_RIGS.kiln?.roles.attack?.event, LAUNCH, 'the launch is the rig\'s attack event')
  assert.equal(kilnFlight(0, flight, launch), undefined)
  assert.equal(kilnFlight(launch - 1, flight, launch), undefined)
  assert.equal(kilnFlight(launch, flight, launch), 0)
  assert.ok(Math.abs((kilnFlight((launch + flight) / 2, flight, launch) as number) - 0.5) < 1e-9)
  // Lands exactly at the marker's end: the dodge window is the marker's whole lifetime, as before.
  assert.equal(kilnFlight(flight, flight, launch), 1)
  assert.equal(kilnFlight(flight + 500, flight, launch), 1)
  // It still flies a visible arc: over half a second.
  assert.ok(flight - launch >= 500, `flies only ${flight - launch} ms`)
  // Without the clip (no rig), the arc as before: the whole lifetime from 0.
  assert.equal(kilnFlight(0, flight, 0), 0)
  assert.equal(kilnFlight(flight / 4, flight, 0), 0.25)
  // A launch past the end (a retuned server) never flies backwards or past 1.
  assert.equal(kilnFlight(flight, flight, flight + 100), 1)
})

test('each rest-first NPC\'s wind-up and attack event fall inside its server hold', () => {
  // The client starts the Kiln's and the Brood's clips at t = 0 on the effect
  // (`Mob.playAttackFromStart`), so the event is `event` s after it; the
  // Crawler's at `SHOT.fire` after it (`NpcSprite.play`'s default lead).
  const kiln = NPC_RIGS.kiln?.roles.attack
  const brood = NPC_RIGS.brood?.roles.attack
  const crawler = NPC_RIGS.crawler?.roles.attack
  assert.ok(kiln !== undefined && brood !== undefined && crawler !== undefined)
  assert.equal(brood.event, SPAWN_EVENT)
  assert.ok(kiln.event * 1000 <= holdOf('kiln'), `kiln launch ${kiln.event} s after its hold ${holdOf('kiln')} ms`)
  assert.ok(brood.event * 1000 <= holdOf('brood'), `brood launch ${brood.event} s after its hold`)
  assert.ok(SHOT.fire * 1000 <= holdOf('crawler'), `crawler discharge ${SHOT.fire} s after its hold`)
  // The Broodling's emerge, `spawn.from` to `spawn.ready`, is its hold.
  const spawn = NPC_RIGS.broodling?.roles.spawn
  assert.ok(spawn !== undefined)
  assert.equal(Math.round((spawn.ready - spawn.from) * 1000), holdOf('broodling'))
})

test('F8: every hold outlasts the longest render delay, so a caught-up NPC has given its lead back before it moves on', () => {
  // The longest delay the client ever renders at (`Session.interpolationDelay`'s clamp).
  const s = Session as unknown as { _p95: number }
  const saved = s._p95
  s._p95 = 1e6
  const maxDelay = Session.interpolationDelay
  s._p95 = saved
  assert.equal(maxDelay, 500)
  // A rest-first NPC's newest state (its landing on the centre) went out at
  // least one tick before the cast, so its lead is gone by cast + delay - tick;
  // its first moved state goes out at cast + hold.
  for (const key of ['crawler', 'kiln', 'brood'] as const) {
    assert.ok(holdOf(key) + TICK_MS > maxDelay, `${key}: hold ${holdOf(key)} ms`)
  }
  // The Compactor plants at the cast (the step in progress may land later):
  // its hold alone must outlast the delay.
  assert.ok(holdOf('compactor') > maxDelay)
})
