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

/** Squared distance below which two bodies count as coincident. */
const EPSILON = 1e-9

/** Positional disagreement below this is noise, not divergence. */
const DEAD_ZONE = 4

/** Disagreement above this is a teleport - respawn or portal. Snap, don't ease. */
const SNAP_DISTANCE = 220

/** Visual correction half-life, ms. Lower is snappier and more visible. */
const SMOOTHING_HALF_LIFE = 90

/** Must match `Multiplayer.MAX_WAYPOINTS`; the server drops anything longer. */
const MAX_WAYPOINTS = 16

/** Must match `Unit.PATH_LOOKAHEAD`; see `_followPath` for why it is one. */
const PATH_LOOKAHEAD = 1

/**
 * The local player, simulated on the client and corrected by the server.
 *
 * The model is deliberately plain: **walk my own route, and if the server says I
 * am somewhere else, accept that and carry on walking from there.** There is no
 * input replay and no sequence arithmetic, because there is nothing left to
 * replay - both sides derive the same route from the same integers and walk it
 * at the same speed, so the only thing they can disagree about is how far along
 * it we are, and that is a distance you can simply correct.
 *
 * That replaces the machinery this class carried when input was a direction. The
 * `ackElapsedMs` reconciliation was load-bearing then and is documented as such,
 * but it answered "how far into a heading has the server got", and a heading is
 * no longer what gets sent. The server still reports it; nothing here reads it.
 *
 * Two bugs came out of the replay it replaces, and they compounded:
 *
 * - The route index was derived from position on every call and returned zero
 *   whenever the player's cell was not on the route - which happens the moment an
 *   obstacle nudges them off it. Zero means `path[0]`, the *start* of the route,
 *   so the player turned round and walked back, and the marker sprang back to
 *   full length as though a new route had been drawn.
 * - Replay covered the whole unacknowledged distance as one straight line towards
 *   a single cell, so it cut corners and landed off the route, which then
 *   triggered the first bug.
 *
 * The index is held rather than derived now, and only ever scans forward - which
 * is exactly what `Unit.followPath` does on the server.
 */
export class LocalPlayer {
  maxVelocity: number = 140
  tag: number | undefined

  /** Authoritative-plus-prediction position. What the game logic should believe. */
  x: number = 0
  y: number = 0

  /** Cells still to walk, and how far along them we are. Mirrors `Unit`. */
  path: Vector[] = []
  pathIndex: number = 0

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
    this.stop()
    this.ready = true
  }

  /** The cell we are standing in. */
  get cell (): Vector {
    return Hex.toCell(new Vector(this.x, this.y))
  }

  /** The cells still to walk - what the route marker draws. */
  get remaining (): Vector[] {
    return this.path.slice(this.pathIndex)
  }

  /** Route to a world position, replacing whatever route we were on. */
  setDestination (worldX: number, worldY: number): void {
    const cell = Hex.toCell(new Vector(worldX, worldY))
    if (this.waypoints.length === 1 && this.waypoints[0].x === cell.x && this.waypoints[0].y === cell.y) return

    this.waypoints = [cell]
    this.repath()
  }

  /**
   * Add a leg, running from where the route currently ends to this point.
   *
   * Shift-click. Appending from the last waypoint rather than from the player is
   * what makes it a continuation instead of a replacement.
   */
  appendDestination (worldX: number, worldY: number): void {
    const cell = Hex.toCell(new Vector(worldX, worldY))

    const last = this.waypoints[this.waypoints.length - 1]
    if (last !== undefined && last.x === cell.x && last.y === cell.y) return

    this.waypoints = [...this.waypoints, cell]
    this.repath()
  }

  /**
   * Rebuild the route through the waypoints, one leg at a time.
   *
   * Mirrors `Unit.repath`, including stopping at the first leg that cannot be
   * reached rather than skipping to the next waypoint - so the two stop in the
   * same place.
   */
  repath (): void {
    this.path = []
    this.pathIndex = 0

    let from = this.cell
    for (const waypoint of this.waypoints) {
      const leg = Path.find(from, waypoint, this._isBlocked)
      if (leg.length === 0) break
      for (const cell of leg) this.path.push(cell)
      from = waypoint
    }

    if (this.path.length === 0) this.waypoints = []
  }

  /** True if any cell still to be walked is this one. */
  pathCrosses (q: number, r: number): boolean {
    for (let i = this.pathIndex; i < this.path.length; i++) {
      if (this.path[i].x === q && this.path[i].y === r) return true
    }
    return false
  }

  /** Drop the route and stand still. */
  stop (): void {
    this.path = []
    this.pathIndex = 0
    this.waypoints = []
  }

  /**
   * Emit at the server's cadence rather than at pointer-event rate. Returns the
   * payload when it is time to send, otherwise null.
   *
   * Sent every tick whether or not the route changed, so the newest packet
   * always carries complete current intent and a dropped one costs nothing.
   */
  sample (now: number): ArrayBuffer | null {
    const interval = Session.tickMs
    if (now - this._lastSample < interval) return null
    this._lastSample = now

    const seq = this._seq
    this._seq = (this._seq + 1) & 0xffff
    if (this._seq === 0) this._seq = 1

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

  /**
   * Advance one rendered frame: aim at the next cell, move, then ease off any
   * outstanding correction. The same two steps `Unit.update` runs on the server.
   */
  predict (dtSeconds: number): void {
    if (!this.ready) return

    this._followPath()

    const beforeX = this.x
    const beforeY = this.y
    const next = this._step(this.x, this.y, dtSeconds)
    this.x = next.x
    this.y = next.y
    this.moveX = this.x - beforeX
    this.moveY = this.y - beforeY

    if (this._offsetX !== 0 || this._offsetY !== 0) {
      const decay = Math.pow(0.5, (dtSeconds * 1000) / SMOOTHING_HALF_LIFE)
      this._offsetX *= decay
      this._offsetY *= decay
      if (Math.abs(this._offsetX) < 0.05) this._offsetX = 0
      if (Math.abs(this._offsetY) < 0.05) this._offsetY = 0
    }
  }

  /**
   * Fold in the server's position.
   *
   * No replay: take where the server says we are and keep walking our own route
   * from there. Because both sides walk the same cells at the same speed the
   * disagreement is small, and almost always inside the dead zone.
   */
  reconcile (serverX: number, serverY: number): void {
    if (!this.ready) {
      this.x = serverX
      this.y = serverY
      this.ready = true
      return
    }

    const errX = serverX - this.x
    const errY = serverY - this.y
    const error = Math.sqrt(errX * errX + errY * errY)

    if (error <= DEAD_ZONE) return

    this.x = serverX
    this.y = serverY

    if (error > SNAP_DISTANCE) {
      // A respawn or a portal. Show it honestly, and drop a route that describes
      // a journey from somewhere we no longer are.
      this._offsetX = 0
      this._offsetY = 0
      this.stop()
    } else {
      // Keep rendering where we were and walk the difference off over ~100 ms,
      // so accepting the server's word does not read as a jerk.
      this._offsetX -= errX
      this._offsetY -= errY
    }
  }

  /**
   * Advance `pathIndex` past the cell we are standing on, and stop when the route
   * runs out.
   *
   * Scans forward from the index we already hold, one cell and no further, and
   * leaves it alone when nothing matches. Both halves matter, and both are
   * copied from `Unit.followPath` because the two have to agree:
   *
   * - Leaving it alone on a miss is what stops the walk-backwards: a player
   *   nudged off the route by an obstacle keeps aiming at the cell it was
   *   already aiming at, rather than concluding it is back at the start.
   * - Bounding the look-ahead to one cell is what makes multi-leg routes work.
   *   An appended leg comes back through the cell the player is standing in
   *   right now, and matching that later occurrence sent them off toward the
   *   last leg's destination while the first leg was still ahead of them. Two
   *   adjacent cells are never equal, so one cell of look-ahead cannot land on a
   *   duplicate.
   */
  private _followPath (): void {
    if (this.path.length === 0) return

    const here = this.cell
    const limit = Math.min(this.path.length, this.pathIndex + PATH_LOOKAHEAD + 1)
    for (let i = this.pathIndex; i < limit; i++) {
      if (this.path[i].x === here.x && this.path[i].y === here.y) {
        this.pathIndex = i + 1
        break
      }
    }

    if (this.pathIndex >= this.path.length) this.stop()
  }

  /**
   * One integration step towards the current target cell, then push out of every
   * collider sharing our plane and clamp to the map.
   *
   * Deliberately one straight move at the frame's own dt, exactly like the
   * server's per-tick step - not a walk along the polyline. Matching the shape of
   * the server's integration matters more than being smoother than it.
   */
  private _step (x: number, y: number, dt: number): { x: number, y: number } {
    if (dt <= 0) return { x, y }

    const target = this.path[this.pathIndex]
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
