import { kilnFlight } from './kilnflight'

/**
 * The Brood's "loaded + launch" (Nick, 2026-10-09, decisions.md "Brood
 * stream"): Broodlings sit in the Brood's open sockets, and each release
 * (effect 19) launches one off its socket in an arc down to its landing
 * cell. Client only, looks only: no wire change.
 *
 * **This file imports nothing that draws** (only `kilnflight.ts`, which
 * imports nothing), so the server's specs can run it (`broodlaunch.spec.ts`).
 *
 * Coordinates are the layer's screen space: x is world x, y is world y times
 * `TILT` (the camera's squash), and an offset inside an upright unit adds to
 * it as it is. So a socket's point (inside the Brood's drawing) and a ground
 * point (a unit's position, squashed) can be compared directly.
 *
 * - **Sockets are cosmetic.** The client can't know how many Broodlings the
 *   server's Brood has left (fog, late viewers), and the server keeps none in
 *   its sockets anyway (`BroodRelease`: the children "in their sockets" are
 *   not units). So every socket starts loaded, empties when a Broodling
 *   launches from it, and refills `SOCKET_REFILL_MS` after that launch.
 * - **The flying Broodling is the real one.** The server creates it on its
 *   landing cell with the release, and the client draws that unit, from the
 *   effect, sitting in the socket, then flying down to its own cell
 *   (`flightAt`): it is never drawn on the ground before it lands, and there
 *   is nothing to hand over.
 */

/** How long an emptied socket stays empty from its launch, ms (cosmetic). */
export const SOCKET_REFILL_MS = 800

/**
 * The launch, ms after effect 19: the Brood's `spawn` clip is started at the
 * effect (`Mob.playAttackFromStart`) and its `spawn` event, the launch, is
 * 0.18 s in (`npcs/brood/rig.ts` `SPAWN_EVENT`; the spec holds them equal).
 */
export const LAUNCH_MS = 180

/**
 * The flight from the socket to the landing cell, ms. Lands at
 * `LAUNCH_MS + FLIGHT_MS` = 630 ms after the effect, inside the Broodling's
 * 1500 ms emerge (the server holds it still that long; the client plays its
 * `emerge` from 1.3 s, curled to 1.8 s, unfolding to 2.8 s): it flies curled
 * and unfolds on the ground.
 */
export const FLIGHT_MS = 450

/** The arc's rise above the straight line from socket to cell, screen px. */
export const ARC_PX = 36

/** How long a refilled socket takes to grow back to full size, ms. */
export const REFILL_GROW_MS = 160

export interface Point { readonly x: number, readonly y: number }

/** Whether socket `i` holds a Broodling at `now` (`performance.now()` ms). */
export function socketLoaded (loadedAt: readonly number[], i: number, now: number): boolean {
  return now >= loadedAt[i]
}

/** Empties socket `i` for a Broodling that launches at `launchAt`: refilled `SOCKET_REFILL_MS` later. */
export function emptySocket (loadedAt: number[], i: number, launchAt: number): void {
  loadedAt[i] = launchAt + SOCKET_REFILL_MS
}

/** How big socket `i`'s Broodling is drawn, 0-1: growing back in over `REFILL_GROW_MS` once loaded, 0 while empty. */
export function socketScale (loadedAt: readonly number[], i: number, now: number): number {
  if (!socketLoaded(loadedAt, i, now)) return 0
  return Math.min(1, 0.4 + 0.6 * (now - loadedAt[i]) / REFILL_GROW_MS)
}

/**
 * Which socket a Broodling landing toward `toward` (a direction in screen
 * space, from the Brood to the landing cell) leaves from: the loaded socket
 * whose way out of the body (from the sockets' mean, the body's middle as far
 * as they say) points most nearly along `toward`. With none loaded, the best
 * of them all (the launch still flies; the client's count is cosmetic). With
 * no direction, the first loaded. -1 with no sockets.
 */
export function pickSocket (sockets: readonly Point[], toward: Point, loadedAt: readonly number[], now: number): number {
  if (sockets.length === 0) return -1
  let cx = 0
  let cy = 0
  for (const s of sockets) { cx += s.x; cy += s.y }
  cx /= sockets.length
  cy /= sockets.length
  const tl = Math.hypot(toward.x, toward.y)
  const along = (i: number): number => {
    if (tl < 1e-9) return 0
    const dx = sockets[i].x - cx
    const dy = sockets[i].y - cy
    const dl = Math.hypot(dx, dy)
    return dl < 1e-9 ? 0 : (dx * toward.x + dy * toward.y) / (dl * tl)
  }
  const best = (loadedOnly: boolean): number => {
    let pick = -1
    let score = -Infinity
    for (let i = 0; i < sockets.length; i++) {
      if (loadedOnly && !socketLoaded(loadedAt, i, now)) continue
      const a = along(i)
      if (a > score) { pick = i; score = a }
    }
    return pick
  }
  const loaded = best(true)
  return loaded >= 0 ? loaded : best(false)
}

/**
 * Where the launched Broodling is drawn at `elapsedMs` after effect 19, or
 * undefined once it has landed. `seat` is its ground point while it sits in
 * the socket (the socket's point, moved down so its curled body sits in the
 * hole), `floorY` the Brood's ground line (its feet), and `landing` its own
 * ground point on its cell, all in screen space.
 *
 * `ground` is the point on the floor under it, which goes in a straight line
 * from under the seat to the landing; `lift` is how high above that point it
 * is drawn, px: the seat's height, falling linearly to 0, plus a parabola of
 * `ARC_PX` (the Kiln slug's arc, `KilnLobEffect`). Before the launch it sits
 * in the seat (`kilnFlight` undefined): t 0.
 */
export function flightAt (elapsedMs: number, seat: Point, floorY: number, landing: Point): { ground: Point, lift: number, t: number } | undefined {
  if (elapsedMs >= LAUNCH_MS + FLIGHT_MS) return undefined
  const t = kilnFlight(elapsedMs, LAUNCH_MS + FLIGHT_MS, LAUNCH_MS) ?? 0
  const start = { x: seat.x, y: floorY }
  const height = Math.max(0, floorY - seat.y)
  return {
    ground: { x: start.x + (landing.x - start.x) * t, y: start.y + (landing.y - start.y) * t },
    lift: height * (1 - t) + ARC_PX * 4 * t * (1 - t),
    t
  }
}
