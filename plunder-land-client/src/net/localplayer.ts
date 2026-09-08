import { Session } from './session'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Path } from '../utils/path'

export interface Collider {
  x: number
  y: number
  radius: number
  tag: number | undefined
}

interface Input {
  seq: number
  /** Client clock at which this input became the current one. */
  t: number
}

/** Squared distance below which two bodies count as coincident. */
const EPSILON = 1e-9

/** Corrections smaller than this are ignored; they are noise, not divergence. */
const DEAD_ZONE = 0.75

/** Corrections larger than this are a teleport, not an error. Snap, don't ease. */
const SNAP_DISTANCE = 220

/** Visual correction half-life, ms. Lower is snappier and more visible. */
const SMOOTHING_HALF_LIFE = 90

/** Must match `Multiplayer.MAX_WAYPOINTS`; the server drops anything longer. */
const MAX_WAYPOINTS = 16

/**
 * The local player, simulated on the client and reconciled against the server.
 *
 * Input is a destination cell now, not a direction. The client runs the same
 * bounded BFS over the same occupancy the server has, so both derive the same
 * route - identically, because it is integer graph search rather than
 * floating-point integration. Prediction is then just "how far along an agreed
 * polyline am I", which is a far smaller thing to be wrong about than a free 2D
 * heading was.
 *
 * What has not changed: this is still the one object in the scene never fed
 * through `onObjectUpdated`, and the replay is still exact rather than
 * approximate because the server reports both which input it last consumed and
 * how long it has been applying it.
 */
export class LocalPlayer {
  maxVelocity: number = 140
  tag: number | undefined

  /** Authoritative-plus-replay position. What the game logic should believe. */
  x: number = 0
  y: number = 0

  /** Cells still to walk. Recomputed only when the route changes. */
  path: Vector[] = []

  /**
   * The cells we are routing through, in order. A list rather than one cell
   * because a route can be built up leg by leg with shift-click, and the whole
   * list goes to the server so it routes the same legs that are drawn on screen.
   */
  waypoints: Vector[] = []

  /** Decaying visual offset, so corrections are eased rather than snapped. */
  private _offsetX: number = 0
  private _offsetY: number = 0

  /**
   * Movement produced by the last predicted frame, with no correction in it.
   * The rendered position carries both, and a correction is not movement - using
   * the rendered delta to drive animation started the run cycle and flipped the
   * sprite while the player was standing still.
   */
  moveX: number = 0
  moveY: number = 0

  private _seq: number = 1
  private readonly _inputs: Input[] = []
  private _lastSample: number = 0

  private readonly _colliders: () => Collider[]
  private readonly _isBlocked: (q: number, r: number) => boolean

  constructor (colliders: () => Collider[], isBlocked: (q: number, r: number) => boolean) {
    this._colliders = colliders
    this._isBlocked = isBlocked
  }

  get renderX (): number { return this.x + this._offsetX }
  get renderY (): number { return this.y + this._offsetY }

  /** True once the server has told us where we start. */
  ready: boolean = false

  reset (x: number, y: number, tag: number | undefined, maxVelocity: number): void {
    this.x = x
    this.y = y
    this.tag = tag
    if (maxVelocity > 0) this.maxVelocity = maxVelocity
    this._offsetX = 0
    this._offsetY = 0
    this._inputs.length = 0
    this.path = []
    this.waypoints = []
    this.ready = true
  }

  /** The cell we are standing in. */
  get cell (): Vector {
    return Hex.toCell(new Vector(this.x, this.y))
  }

  /**
   * Route to a world position - wherever the player clicked.
   *
   * An unreachable destination clears the path and leaves us standing, which is
   * what the server does with the same input, so the two agree about doing
   * nothing just as they agree about where to walk.
   */
  setDestination (worldX: number, worldY: number): void {
    const cell = Hex.toCell(new Vector(worldX, worldY))
    if (this.waypoints.length === 1 && this.waypoints[0].x === cell.x && this.waypoints[0].y === cell.y) return

    this.waypoints = [cell]
    this._repath()
  }

  /**
   * Add a leg, running from where the route currently ends to this point.
   *
   * Shift-click. Appending from the last waypoint rather than from the player
   * is what makes it a continuation instead of a replacement.
   */
  appendDestination (worldX: number, worldY: number): void {
    const cell = Hex.toCell(new Vector(worldX, worldY))

    const last = this.waypoints[this.waypoints.length - 1]
    if (last !== undefined && last.x === cell.x && last.y === cell.y) return

    this.waypoints = [...this.waypoints, cell]
    this._repath()
  }

  /**
   * Rebuild the route through the waypoints, one leg at a time.
   *
   * Mirrors `Unit.repath` on the server, including stopping at the first leg
   * that cannot be reached rather than skipping to the next waypoint - so the
   * two stop in the same place.
   */
  private _repath (): void {
    this.path = []
    let from = this.cell

    for (const waypoint of this.waypoints) {
      const leg = Path.find(from, waypoint, this._isBlocked)
      if (leg.length === 0) break
      for (const cell of leg) this.path.push(cell)
      from = waypoint
    }

    if (this.path.length === 0) this.waypoints = []
  }

  /** Drop the route and stand still. */
  stop (): void {
    this.path = []
    this.waypoints = []
  }

  /**
   * Emit at the server's cadence rather than at pointer-event rate. Returns the
   * 6-byte payload when it is time to send, otherwise null.
   *
   * Sent every tick whether or not the destination changed, so the newest packet
   * always carries complete current intent - the property the old direction
   * packet had and an on-change-only message would lose.
   */
  sample (now: number): ArrayBuffer | null {
    const interval = Session.tickMs
    if (now - this._lastSample < interval) return null
    this._lastSample = now

    const seq = this._seq
    this._seq = (this._seq + 1) & 0xffff
    if (this._seq === 0) this._seq = 1

    this._inputs.push({ seq, t: now })
    // Bounded: anything this old is either acknowledged or lost for good.
    while (this._inputs.length > 64) this._inputs.shift()

    const count = Math.min(this.waypoints.length, MAX_WAYPOINTS)

    const buf = new ArrayBuffer(1 + count * 4 + 2)
    const view = new DataView(buf)
    view.setUint8(0, count)
    for (let i = 0; i < count; i++) {
      view.setInt16(1 + i * 4, this.waypoints[i].x)
      view.setInt16(1 + i * 4 + 2, this.waypoints[i].y)
    }
    view.setUint16(1 + count * 4, seq)
    return buf
  }

  /** Advance the prediction by one rendered frame. */
  predict (dtSeconds: number): void {
    if (!this.ready) return

    const next = this._step(this.x, this.y, dtSeconds)
    this.moveX = next.x - this.x
    this.moveY = next.y - this.y
    this.x = next.x
    this.y = next.y

    // Ease any outstanding correction towards zero.
    if (this._offsetX !== 0 || this._offsetY !== 0) {
      const decay = Math.pow(0.5, (dtSeconds * 1000) / SMOOTHING_HALF_LIFE)
      this._offsetX *= decay
      this._offsetY *= decay
      if (Math.abs(this._offsetX) < 0.05) this._offsetX = 0
      if (Math.abs(this._offsetY) < 0.05) this._offsetY = 0
    }
  }

  /**
   * Fold in the server's version of events.
   *
   * @param ackSeq        last input the server consumed
   * @param ackElapsedMs  how long it has been applying that input
   */
  reconcile (serverX: number, serverY: number, ackSeq: number, ackElapsedMs: number, now: number): void {
    if (!this.ready) {
      this.x = serverX
      this.y = serverY
      this.ready = true
      return
    }

    const beforeX = this.x
    const beforeY = this.y

    // Drop everything the server has already finished with.
    while (this._inputs.length > 0 && seqBefore(this._inputs[0].seq, ackSeq)) {
      this._inputs.shift()
    }

    // How much client time the server has not yet accounted for. The acked input
    // has been applied for ackElapsedMs, but on this client it was current for
    // longer than that; without the second number every reconciliation drags the
    // player backwards by a fraction of a tick.
    let unackedMs = 0
    if (this._inputs.length > 0 && this._inputs[0].seq === ackSeq) {
      const acked = this._inputs[0]
      const endOfAcked = this._inputs.length > 1 ? this._inputs[1].t : now
      unackedMs = Math.max(0, (endOfAcked - acked.t) - ackElapsedMs)
      for (let i = 1; i < this._inputs.length; i++) {
        const end = i + 1 < this._inputs.length ? this._inputs[i + 1].t : now
        unackedMs += Math.max(0, end - this._inputs[i].t)
      }
    } else {
      // The server acknowledged an input we no longer hold - it skipped ours, or
      // we have been away. Its word is final; replay whatever we still have.
      for (let i = 0; i < this._inputs.length; i++) {
        const end = i + 1 < this._inputs.length ? this._inputs[i + 1].t : now
        unackedMs += Math.max(0, end - this._inputs[i].t)
      }
    }

    // Replaying is one call now rather than one per held input: the route is
    // shared state both sides agree on, so walking it forward from the server's
    // position for the unacknowledged time reproduces where we should be.
    const replayed = this._step(serverX, serverY, unackedMs / 1000)
    this.x = replayed.x
    this.y = replayed.y

    const errX = beforeX - this.x
    const errY = beforeY - this.y
    const error = Math.sqrt(errX * errX + errY * errY)

    if (error > SNAP_DISTANCE) {
      // Respawn, portal, or a correction too large to hide. Show it honestly.
      this._offsetX = 0
      this._offsetY = 0
    } else if (error > DEAD_ZONE) {
      // Keep rendering where we were and walk the difference off over ~100ms.
      this._offsetX += errX
      this._offsetY += errY
    }
  }

  /**
   * The next cell to walk towards from a position, or undefined when the route
   * is finished.
   *
   * Derived from the position rather than held as an index, which is what makes
   * replay a single call: the same path walked from the server's position gives
   * the same answer without any per-frame state to rewind. It mirrors the
   * server's `Unit.followPath`, including the forward scan that skips cells a
   * push-out may have carried us past.
   */
  private _target (x: number, y: number): Vector | undefined {
    const index = this._indexAt(x, y)
    return index < this.path.length ? this.path[index] : undefined
  }

  /**
   * How far along the route a position is. See `_target` for why it is derived
   * rather than counted.
   *
   * First match, not last, matching `Unit.followPath`: an appended route can
   * cross itself and the last match would skip the whole middle of it.
   *
   * Known limit of the temporary unlimited-range mode: the server scans forward
   * from the index it already holds, while this has to start from zero to stay
   * replayable. On a route that crosses itself the two can disagree about which
   * visit we are on, and the player mispredicts until the server corrects them.
   * It goes away when the route is a single leg again.
   */
  private _indexAt (x: number, y: number): number {
    if (this.path.length === 0) return 0

    const here = Hex.toCell(new Vector(x, y))

    for (let i = 0; i < this.path.length; i++) {
      if (this.path[i].x === here.x && this.path[i].y === here.y) return i + 1
    }
    return 0
  }

  /**
   * The cells still to walk from where we are now - what the route marker draws.
   * Shrinks as the player advances, because the index comes from the position
   * rather than from a counter something has to remember to increment.
   */
  get remaining (): Vector[] {
    if (this.path.length === 0) return []
    return this.path.slice(this._indexAt(this.x, this.y))
  }

  /**
   * One integration step. Aims at the next cell on the route, moves, then pushes
   * out of every collider sharing our plane and clamps to the map.
   *
   * The push-out still mirrors the server's while both sides still run it. Once
   * routes are trusted enough for the server to drop it, this goes with it.
   */
  private _step (x: number, y: number, dt: number): { x: number, y: number } {
    if (dt <= 0) return { x, y }

    const target = this._target(x, y)
    if (target !== undefined) {
      const centre = Hex.toPosition(target)
      const dx = centre.x - x
      const dy = centre.y - y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > 0) {
        const step = dt * this.maxVelocity
        x += (dx / distance) * step
        y += (dy / distance) * step
      }
    }

    for (const c of this._colliders()) {
      if (c.tag !== this.tag) continue

      const sumWidth = c.radius + PLAYER_RADIUS
      const cdx = c.x - x
      const cdy = c.y - y
      const sqr = cdx * cdx + cdy * cdy
      if (sqr < sumWidth * sumWidth) {
        if (sqr > EPSILON) {
          const magnitude = Math.sqrt(sqr)
          x = c.x - (sumWidth * cdx) / magnitude
          y = c.y - (sumWidth * cdy) / magnitude
        } else {
          x = c.x - sumWidth
          y = c.y
        }
      }
    }

    const map = Session.mapSize
    if (x < 0) x = 0
    if (x > map) x = map
    if (y < 0) y = 0
    if (y > map) y = map

    return { x, y }
  }

  /** Server-side radius for a level-1 player: 2 * sqrt(maxHP), maxHP 50. */
  static RADIUS = 2 * Math.sqrt(50)
}

const PLAYER_RADIUS = LocalPlayer.RADIUS

/** Wrap-safe "is a strictly before b" over a 16-bit sequence space. */
function seqBefore (a: number, b: number): boolean {
  return ((a - b + 0x10000) & 0xffff) > 0x8000
}
