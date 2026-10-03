import { Hex } from '../utils/hex'

/**
 * Whether a unit this client holds is still there although it has gone
 * silent (`Game.stillPresent`). Pixi-free, so `presence.spec.ts` (server)
 * can check it against the server's own view radii.
 *
 * Idle units send nothing, so silence alone is not absence. Since #35 the
 * server sends a destroy when a held unit leaves a view, so a held unit is
 * present by definition; this test is only a backstop for a unit the server
 * dropped without telling us. It must never be tighter than the server's
 * leave radius, or a stopped unit the server still holds us to is hidden.
 */

/**
 * The client's copy of the server's `Multiplayer.VIEW_MARGIN_RINGS` and
 * `VIEW_EXIT_RINGS` (#48): a unit is kept until it is beyond the viewpoint's
 * `vision` + both. `presence.spec.ts` holds them equal to the server's.
 */
export const VIEW_MARGIN_RINGS = 1
export const VIEW_EXIT_RINGS = 1
/** The server's `Multiplayer.EXIT_MARGIN`, for a viewpoint with no vision. */
export const EXIT_MARGIN = 2 * Hex.SIZE
/**
 * Room for the drawn viewpoint not being where the server measured it from:
 * the own robot is predicted ahead, a spectated one interpolated behind, and
 * a dash covers 3 cells. Too loose only keeps a ghost a little longer; too
 * tight hides a real unit.
 */
export const SLACK_RINGS = 3

/** Where the camera looks from (the own robot, else the spectated one) and its robot's vision. */
export interface Viewpoint {
  x: number
  y: number
  vision: number | null | undefined
}

/**
 * Half-width, in world units, of the box around the viewpoint inside which a
 * silent unit is kept. It covers the server's leave radius on both axes: the
 * server's own bound (`Multiplayer.viewOf`'s `reach`) is (leave + 1) x
 * `Hex.SIZE`, leave being `vision` + `VIEW_MARGIN_RINGS` + `VIEW_EXIT_RINGS`
 * rings; with no vision, the interest box plus `EXIT_MARGIN`. Plus the slack,
 * and never less than the interest box, which was the rule before #48.
 */
export function presenceReach (vision: number | null | undefined, interestRadius: number): number {
  const slack = SLACK_RINGS * Hex.SIZE
  if (vision === null || vision === undefined) return interestRadius + EXIT_MARGIN + slack
  const leave = vision + VIEW_MARGIN_RINGS + VIEW_EXIT_RINGS
  return Math.max(interestRadius, (leave + 1) * Hex.SIZE + slack)
}

/**
 * True if a unit last heard from at `lastUpdate` should still be shown: heard
 * from since `staleBefore`, or silent but inside `presenceReach` of the
 * viewpoint. With no viewpoint (between runs, or a spectator whose watch
 * ended or whose watched unit has not arrived yet) a silent unit is gone:
 * the server sends such a client nothing more (`Multiplayer.stopWatching`
 * forgets what it held without destroys).
 */
export function stillPresent (
  unit: { x: number, y: number, lastUpdate: number },
  staleBefore: number,
  viewpoint: Viewpoint | undefined,
  interestRadius: number
): boolean {
  if (unit.lastUpdate > staleBefore) return true
  if (viewpoint === undefined) return false
  const r = presenceReach(viewpoint.vision, interestRadius)
  return Math.abs(unit.x - viewpoint.x) < r && Math.abs(unit.y - viewpoint.y) < r
}
