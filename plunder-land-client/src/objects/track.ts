import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * A remote unit's drawn position from its server states (`Unit.update`),
 * pulled out of `Unit` so specs can run it without pixi's display tree
 * (`track.spec.ts`, server). Two rules beyond plain interpolation (#52,
 * anim-sync lane 1):
 *
 * - **No overshoot on a stop (O1).** When the buffer runs dry the unit is
 *   extrapolated along its last velocity for a bounded time, which covers a
 *   late packet mid-walk. A unit whose last state is a cell centre has
 *   almost always stopped there (every walk, mob step and knockback ends on
 *   one), so it is held there instead: before this, a remote unit came to
 *   rest up to speed x `extrapolationCap` past its stop and jumped back on
 *   its next move. The cost: a late packet that happens to land on an exact
 *   centre mid-walk holds for that moment instead of gliding on.
 * - **Catch-up (S1, `CatchUp`).** On a planting effect the render clock of
 *   that one unit is run forward onto its newest state, so the planted clip
 *   starts where the server has the unit rather than ~`interpolationDelay`
 *   behind it.
 */
export interface TrackState {
  /** Client clock at which this state arrived. */
  t: number
  x: number
  y: number
}

/**
 * Whether a position, as the wire carries it (floored to whole units, server
 * `GameObject` 'position'), is a cell centre: the floor of its cell's centre.
 * `utils/hex.ts` is byte-identical on both sides, so both compute the same centre.
 */
export function onCellCentre (x: number, y: number): boolean {
  const c = Hex.toPosition(Hex.toCell(new Vector(x, y)))
  return Math.floor(c.x) === x && Math.floor(c.y) === y
}

/** The position at `renderTime` along `states` (oldest first, at least one). */
export function sampleTrack (states: readonly TrackState[], renderTime: number, extrapolationCap: number): { x: number, y: number } {
  if (renderTime <= states[0].t) {
    // Not enough history yet to render in the past: hold at the oldest state
    // rather than inventing motion.
    return { x: states[0].x, y: states[0].y }
  }
  let i = states.length - 1
  while (i > 0 && states[i].t > renderTime) i--

  const a = states[i]
  const b = states[i + 1]
  if (b !== undefined) {
    const span = b.t - a.t
    const f = span > 0 ? (renderTime - a.t) / span : 1
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
  }

  // The buffer has run dry - a packet is late, or the unit stopped. Continue
  // along the last known velocity for a bounded time, then hold. Holding is
  // honest; extrapolating indefinitely walks units through walls. A last
  // state on a cell centre is a stop: hold it (O1, above).
  const last = states[states.length - 1]
  const prev = states.length > 1 ? states[states.length - 2] : undefined
  const span = prev !== undefined ? last.t - prev.t : 0
  const ahead = Math.min(renderTime - last.t, extrapolationCap)
  if (prev !== undefined && span > 0 && ahead > 0 && !onCellCentre(last.x, last.y)) {
    return {
      x: last.x + ((last.x - prev.x) / span) * ahead,
      y: last.y + ((last.y - prev.y) / span) * ahead
    }
  }
  return { x: last.x, y: last.y }
}

/**
 * One unit's render clock run ahead of everyone else's, for a catch-up (S1):
 * `renderTime` is `now - delay + lead`. `start` eases the lead up over `MS`
 * so that the clock reaches the newest state's arrival time at the end of the
 * ease: the unit is drawn along its real track, a few times faster, to where
 * the server has it. The lead never runs the clock backwards, and from there
 * it is given back without moving the unit: while the clock is at or past the
 * newest state (the unit holds still, as a planted NPC does), the lead shrinks
 * to just reach it, and is gone `delay` after that state arrived. A unit
 * that moves again before then interpolates with the lead left, which only
 * shortens its delay; with a lead it is never extrapolated.
 */
export class CatchUp {
  /** How long the ease onto the newest state takes, ms. */
  static readonly MS = 100

  private lead = 0
  private from = 0
  private to = 0
  private startedAt = 0
  private easing = false

  /** Ease onto the state that arrived at `newestT` (client clock), starting `now`. */
  start (now: number, delay: number, newestT: number): void {
    const current = this.leadAt(now)
    this.from = current
    // At the ease's end, (now + MS) - delay + to = newestT.
    this.to = Math.max(current, newestT - (now + CatchUp.MS - delay))
    this.startedAt = now
    this.easing = true
    this.lead = current
  }

  /** The render time for this unit at `now`, its newest state having arrived at `lastT`. */
  renderTime (now: number, delay: number, lastT: number): number {
    const base = now - delay
    let lead = this.leadAt(now)
    if (lead > 0 && base + lead >= lastT) {
      // At (or past) the newest state: give the lead back, unmoved (during an
      // ease too; it then only stops the clock short of running past it).
      lead = Math.max(0, lastT - base)
    }
    this.lead = lead
    return base + lead
  }

  /** True while it runs ahead of the shared clock. */
  get active (): boolean {
    return this.easing || this.lead > 0
  }

  private leadAt (now: number): number {
    if (!this.easing) return this.lead
    const u = (now - this.startedAt) / CatchUp.MS
    if (u >= 1) {
      this.easing = false
      return this.to
    }
    if (u <= 0) return this.from
    return this.from + (this.to - this.from) * u * u * (3 - 2 * u)
  }
}
