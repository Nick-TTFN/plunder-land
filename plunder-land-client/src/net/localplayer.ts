import { Session } from './session'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Path } from '../utils/path'

/**
 * The layer a portal on cell (q, r) of the local player's layer leads to, or
 * undefined if there is no portal there. `Game.PORTALS` in the game.
 */
export type PortalLookup = (q: number, r: number) => number | undefined

/**
 * How far ahead of the server the prediction is allowed to be before it counts
 * as divergence rather than lead, in ticks of travel.
 *
 * The client walks the route in real time; the server's last packet describes
 * where it was a tick ago plus however long the wire took. Being ahead by that
 * much is not an error, it is the entire point of predicting - and correcting it
 * drags the render back toward a stale position on every packet, which is felt
 * as the player sliding rather than walking.
 *
 * Two ticks covers the lead plus a normal amount of latency. Beyond it, both
 * sides walking the same integer route at the same speed cannot have drifted
 * apart on their own: something happened - a wall across the route, a portal, a
 * respawn - and that is worth correcting.
 */
const LEAD_TICKS = 2

/**
 * Disagreement above this is a teleport - a respawn. Snap, don't ease. A
 * portal hop is only a cell or so, so it snaps on the layer change instead
 * (`changeLayer`).
 */
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

  /**
   * The way we last walked, unit length, East until the first move: the
   * direction of the last segment `_step` walked, as server `Unit.facing` is
   * set by `walkPath`. A walk ends facing along its last step between two
   * cell centres, so both sides snap it to the same one of six, which is
   * where a standing dash goes (`dash`).
   */
  facingX: number = 1
  facingY: number = 0

  /**
   * Route distance still to cover at dash speed. **Mirrors server
   * `Unit.dashLeft`** and is spent the same way (`_routeBudget`); cleared by
   * `stop`, `_arrive` and a layer change, kept across a re-route.
   */
  dashLeft: number = 0

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
  /**
   * The waypoints last sent, as `q,r;q,r;...`, or undefined when nothing has
   * been sent for this run (`reset`), so the first sample of a run always goes.
   */
  private _sentRoute: string | undefined

  /** The last position the server reported for us, for the portal hop (`changeLayer`). */
  private _serverX: number | undefined
  private _serverY: number | undefined

  private readonly _isBlocked: (q: number, r: number) => boolean
  private readonly _portalTo: PortalLookup

  /**
   * `isBlocked` and `portalTo` answer for the local player's current layer.
   * There are no colliders any more: nothing pushes the player out of
   * anything (hex-cells P2), so all prediction needs to know is which cells
   * are blocked and which are portals.
   */
  constructor (isBlocked: (q: number, r: number) => boolean, portalTo: PortalLookup = () => undefined) {
    this._isBlocked = isBlocked
    this._portalTo = portalTo
  }

  /**
   * Positional disagreement below this is prediction lead, not divergence.
   * Derived rather than a constant so it follows the server's own cadence.
   */
  private get _deadZone (): number {
    const lead = (Session.tickMs / 1000) * this.maxVelocity * LEAD_TICKS
    return this._sinceDash < this._dashWindow ? lead + LocalPlayer.DASH_GAIN : lead
  }

  /**
   * Seconds since the last predicted dash. A dash puts the client a further
   * `DASH_GAIN` ahead of a server that has not had the press yet, and once
   * the server has dashed too it is back to the usual lead. Correcting in
   * between pulled the dash back and then forward again, so the dead zone
   * widens by the gain for as long as the two can be out of step
   * (`_dashWindow`).
   */
  private _sinceDash: number = Infinity

  /**
   * How long after a dash the dead zone stays wide: the time the dash's
   * stretch takes at normal speed, plus the lead the dead zone already allows
   * for the press to reach the server.
   */
  private get _dashWindow (): number {
    return (LocalPlayer.DASH_CELLS * Hex.SIZE) / this.maxVelocity + (Session.tickMs / 1000) * LEAD_TICKS
  }

  /** The distance a dash gains over walking: its stretch less the time it saves. */
  static get DASH_GAIN (): number {
    return LocalPlayer.DASH_CELLS * Hex.SIZE * (1 - 1 / LocalPlayer.DASH_MULTIPLIER)
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
    this._serverX = undefined
    this._serverY = undefined
    // A new player faces East until it moves, as server `Unit.facing` does.
    this.facingX = 1
    this.facingY = 0
    this.stop()
    this._sentRoute = undefined
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

    // Only skip the search while we are still walking to that cell. The
    // waypoint outlives the walk now - it has to, see `_arrive` - so testing it
    // alone would refuse to re-route to a cell we have already reached and then
    // been shoved off, which is a click that visibly does nothing.
    if (
      this.path.length > 0 && this.waypoints.length === 1 &&
      this.waypoints[0].x === cell.x && this.waypoints[0].y === cell.y
    ) return

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
    this._endAtPortal()

    if (this.path.length === 0) this.waypoints = []
  }

  /** True if a portal on this cell of our layer would take us to another layer. */
  private _stopsOn (q: number, r: number): boolean {
    const to = this._portalTo(q, r)
    return to !== undefined && to !== this.tag
  }

  /**
   * Cut the route after its first portal cell. **Mirrors server
   * `Unit.endAtPortal`.** The server moves the player to the portal's arrival
   * cell on the other layer the tick they stand in it; the client does not
   * predict that, and instead walks to the portal's centre and waits there
   * for the new tag (`changeLayer`).
   */
  private _endAtPortal (): void {
    for (let i = this.pathIndex; i < this.path.length; i++) {
      if (this._stopsOn(this.path[i].x, this.path[i].y)) {
        this.path.length = i + 1
        return
      }
    }
  }

  /**
   * A portal has just come into view (`Game.onObjectCreated`): cut the route
   * we are walking at it, as the server cut its copy when it was planned. Cut
   * in place rather than re-planned, because a fresh search from where we
   * stand can pick a different route of the same length than the server's.
   */
  portalAppeared (): void {
    this._endAtPortal()
  }

  /** The `Hex.DIRECTIONS` index nearest `facing`: server `World.FACING_INDEX`, copied. */
  get facingIndex (): number {
    const sixths = Math.atan2(this.facingY, this.facingX) / (Math.PI / 3)
    const index = Math.floor(sixths + 0.5 + 1e-9)
    return ((index % 6) + 6) % 6
  }

  /**
   * Dash, predicted on the press (decision #34). **Mirrors server
   * `Unit.dash`**: on a route, the next `DASH_CELLS` cells of it at
   * `DASH_MULTIPLIER` times the speed; standing, a route of up to
   * `DASH_CELLS` cells along the facing, stopping before a blocked cell and
   * at a portal, whose last cell becomes the destination - so the next input
   * packet asks the server for the same cell and a re-plan cannot undo it.
   * False, and nothing changes, when a standing dash has nowhere to go; the
   * server refuses that press too.
   *
   * Distance, not time, so the server covers the same stretch of route even
   * though it gets the press a tick or so later.
   */
  dash (): boolean {
    if (!this.ready) return false
    if (this.path.length === 0) {
      const direction = this.facingIndex
      const cells: Vector[] = []
      let cell = this.cell
      for (let i = 0; i < LocalPlayer.DASH_CELLS; i++) {
        cell = Hex.neighbour(cell, direction)
        if (this._isBlocked(cell.x, cell.y)) break
        cells.push(cell)
        if (this._stopsOn(cell.x, cell.y)) break
      }
      if (cells.length === 0) return false
      this.path = cells
      this.pathIndex = 0
      this.waypoints = [cells[cells.length - 1]]
    }
    this.dashLeft = LocalPlayer.DASH_CELLS * Hex.SIZE
    this._sinceDash = 0
    return true
  }

  /**
   * How far along the route we get in `dt`, dash included. **Mirrors server
   * `Unit.routeBudget`**, and like it is exact however `dt` is sliced, which is
   * what lets frame-rate prediction match a server walking in whole ticks.
   */
  private _routeBudget (dt: number): number {
    const normal = dt * this.maxVelocity
    if (this.dashLeft <= 0) return normal
    const fast = Math.min(this.dashLeft, normal * LocalPlayer.DASH_MULTIPLIER)
    this.dashLeft -= fast
    return fast + normal - fast / LocalPlayer.DASH_MULTIPLIER
  }

  /** True if any cell still to be walked is this one. */
  pathCrosses (q: number, r: number): boolean {
    for (let i = this.pathIndex; i < this.path.length; i++) {
      if (this.path[i].x === q && this.path[i].y === r) return true
    }
    return false
  }

  /**
   * Drop the route and the intent behind it, and stand still.
   *
   * This is what the *player* asking to stop looks like, and it is what a
   * teleport does. It empties the waypoints, so the next packet tells the
   * server to stop as well.
   */
  stop (): void {
    this.path = []
    this.pathIndex = 0
    this.waypoints = []
    this.dashLeft = 0
  }

  /**
   * The server says we are on layer `tag`. If that is a change, jump to where
   * the server put us and stop.
   *
   * Mirrors server `Unit.changeLayer`, which a portal hop runs as it moves the
   * player to the portal's arrival cell (`Player.hopPortal`): a route planned
   * on one layer means nothing on another, so both sides drop it. The server
   * acts a tick or so before this runs. Meanwhile the client has walked to the
   * portal's centre and waited there (`_endAtPortal`), and the packets still
   * asking for the old route are ignored as repeats (`sameCells` in
   * `onPointer`). Emptying the waypoints makes the next packet a stop, which
   * the server already is.
   *
   * The arrival cell is one cell from the portal, well inside the dead zone
   * that `reconcile` leaves alone and far under `SNAP_DISTANCE`, so the
   * position that came with the tag would otherwise be ignored or eased. A
   * hop is a teleport: take the server's position as it stands, no easing.
   * `Game.onObjectUpdated` reconciles a record's position before its tag, so
   * that position is the one from the same record.
   *
   * Not `_arrive`: a hop is not arriving, and the destination has to go too,
   * or the next packet asks the server to plan it on the new layer.
   */
  changeLayer (tag: number): void {
    if (tag === this.tag) return
    this.tag = tag
    if (this._serverX !== undefined && this._serverY !== undefined) {
      this.x = this._serverX
      this.y = this._serverY
      this._offsetX = 0
      this._offsetY = 0
    }
    this.stop()
  }

  /**
   * We have finished the walk. Drop the route but keep the destination.
   *
   * Deliberately not `stop()`. The client walks in real time and the server
   * starts a tick or so later, so the client always gets there first - and
   * clearing the waypoints here made the very next packet a "stop" that landed
   * on a server still a cell short of the destination. It obeyed, and the
   * authoritative player came to rest somewhere the client had already left,
   * which is invisible until the next click routes from a different cell on
   * each side.
   *
   * Keeping the waypoint means the packet keeps saying "I want to be there"
   * until the server has been. The server ignores a repeat of what it is
   * already walking (`sameCells` in `onPointer`), so this costs one comparison
   * per tick and no search.
   */
  private _arrive (): void {
    this.path = []
    this.pathIndex = 0
    this.dashLeft = 0
  }

  /**
   * Emit at the server's cadence rather than at pointer-event rate, and only
   * when the route has changed since the last send. Returns the payload when
   * it is time to send, otherwise null.
   *
   * It used to go every tick whether or not the route changed, "so a dropped
   * one costs nothing"; but a WebSocket drops nothing and delivers in order,
   * so the repeats carried no information, and receiving them was most of the
   * server's input cost (server-cpu-trim, 2026-09-26). Nothing reads the
   * acknowledgement the server sends back for the sequence number. A new run
   * sends its first sample whatever it holds (`reset`), and the server forgets
   * the last route when a new player joins (`Multiplayer.attach`), so the two
   * never disagree about what was last asked for.
   */
  sample (now: number): ArrayBuffer | null {
    const interval = Session.tickMs
    if (now - this._lastSample < interval) return null
    this._lastSample = now

    const count = Math.min(this.waypoints.length, MAX_WAYPOINTS)
    let route = ''
    for (let i = 0; i < count; i++) route += `${this.waypoints[i].x},${this.waypoints[i].y};`
    if (route === this._sentRoute) return null
    this._sentRoute = route

    const seq = this._seq
    this._seq = (this._seq + 1) & 0xffff
    if (this._seq === 0) this._seq = 1

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

    this._sinceDash += dtSeconds
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
    this._serverX = serverX
    this._serverY = serverY

    if (!this.ready) {
      this.x = serverX
      this.y = serverY
      this.ready = true
      return
    }

    const errX = serverX - this.x
    const errY = serverY - this.y
    const error = Math.sqrt(errX * errX + errY * errY)

    // Walking the same route at the same speed, the two cannot drift apart on
    // their own, so anything inside the lead is left alone entirely - no nudge,
    // no easing. Whatever lead is left resolves for free at the end of the
    // route, because both sides finish on the same cell centre.
    if (error <= this._deadZone) return

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
   * Re-aim after something has shoved us off the route, and nothing else.
   *
   * Scans forward from the index we already hold, one cell and no further, and
   * leaves it alone when nothing matches. All three rules matter, and all three
   * are copied from `Unit.followPath` because the two have to agree:
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
   * - **Capping the index at the last cell is what stops the route ending
   *   early.** Entering the final cell is not arriving at it. This used to run
   *   the index off the end and clear the route the frame the player crossed the
   *   boundary, so a walk came to rest about half a cell short of the middle,
   *   every time. `_step` is the only thing that ends a route now, and it ends
   *   it on the centre.
   */
  private _followPath (): void {
    if (this.path.length === 0) return

    const here = this.cell
    const last = this.path.length - 1

    const limit = Math.min(this.path.length, this.pathIndex + PATH_LOOKAHEAD + 1)
    for (let i = this.pathIndex; i < limit; i++) {
      if (this.path[i].x === here.x && this.path[i].y === here.y) {
        this.pathIndex = Math.min(i + 1, last)
        break
      }
    }
  }

  /**
   * Walk the route by one frame's worth of distance (dash included,
   * `_routeBudget`), then clamp to the map. Nothing pushes the player out of
   * anything: routes only cross free cells, and nothing else is solid
   * (hex-cells P2, the same change on the server's `Unit.update`).
   *
   * Mirrors `Unit.walkPath`: leftover distance carries from one cell into the
   * next, and the walk finishes exactly on the last cell's centre. Aiming at the
   * next centre and taking one straight step instead would overshoot every
   * centre by a different amount, so the player came to rest wherever they
   * happened to cross into the final cell - a different point from the server's,
   * which the correction then slid them across at the end of every walk. Each
   * segment walked sets the facing, as there.
   */
  private _step (x: number, y: number, dt: number): { x: number, y: number } {
    if (dt <= 0) return { x, y }

    let budget = this.path.length > 0 ? this._routeBudget(dt) : 0
    while (budget > 0 && this.pathIndex < this.path.length) {
      const centre = Hex.toPosition(this.path[this.pathIndex])
      const dx = centre.x - x
      const dy = centre.y - y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > 0) {
        this.facingX = dx / distance
        this.facingY = dy / distance
      }

      if (distance <= budget) {
        x = centre.x
        y = centre.y
        budget -= distance
        this.pathIndex++
      } else {
        x += (dx / distance) * budget
        y += (dy / distance) * budget
        budget = 0
      }
    }

    if (this.path.length > 0 && this.pathIndex >= this.path.length) this._arrive()

    const map = Session.mapSize
    if (x < 0) x = 0
    if (x > map) x = map
    if (y < 0) y = 0
    if (y > map) y = map

    return { x, y }
  }

  /** Dash speed as a multiple of `maxVelocity`. Must match server `Unit.DASH_MULTIPLIER`. */
  static DASH_MULTIPLIER = 2.5

  /** Cells of route a dash covers. Must match server `Unit.DASH_CELLS`. */
  static DASH_CELLS = 3

  /** The portal object type, the one `Game.PORTALS` is built from. */
  static PORTAL_TYPE = 1 << 3
}
