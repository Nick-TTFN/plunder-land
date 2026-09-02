import { Session } from './session'

export interface Collider {
  x: number
  y: number
  radius: number
  tag: number | undefined
}

interface Input {
  seq: number
  x: number
  y: number
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

/**
 * The local player, simulated on the client and reconciled against the server.
 *
 * This is the one object in the scene that is never `setState`-ed from the
 * network directly. Input applies here immediately; the server's version of
 * events arrives later and is folded in as a correction.
 *
 * The replay is exact rather than approximate because the server reports both
 * which input it last consumed *and* how long it has been applying it. Without
 * that second number the client cannot tell how far into an input the server
 * has got, and every reconciliation drags the player backwards by a fraction of
 * a tick — which reads as a permanent rubber-band while running.
 */
export class LocalPlayer {
  maxVelocity: number = 140
  tag: number | undefined

  /** Authoritative-plus-replay position. What the game logic should believe. */
  x: number = 0
  y: number = 0

  /** Decaying visual offset, so corrections are eased rather than snapped. */
  private _offsetX: number = 0
  private _offsetY: number = 0

  /**
   * Movement produced by the last predicted frame, with no correction in it.
   * The rendered position carries both, and a correction is not movement — using
   * the rendered delta to drive animation started the run cycle and flipped the
   * sprite while the player was standing still.
   */
  moveX: number = 0
  moveY: number = 0

  private _seq: number = 1
  private _dirX: number = 0
  private _dirY: number = 0
  private readonly _inputs: Input[] = []
  private _lastSample: number = 0

  private _colliders: () => Collider[]

  constructor (colliders: () => Collider[]) {
    this._colliders = colliders
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
    this._dirX = 0
    this._dirY = 0
    this.ready = true
  }

  /** Latest desired direction from pointer or joystick. Not yet sent. */
  setDirection (x: number, y: number): void {
    this._dirX = x
    this._dirY = y
  }

  /**
   * Emit at the server's cadence rather than at pointer-event rate. Returns the
   * 4-byte payload when it is time to send, otherwise null.
   */
  sample (now: number): ArrayBuffer | null {
    const interval = Session.tickMs
    if (now - this._lastSample < interval) return null
    this._lastSample = now

    const seq = this._seq
    this._seq = (this._seq + 1) & 0xffff
    if (this._seq === 0) this._seq = 1

    this._inputs.push({ seq, x: this._dirX, y: this._dirY, t: now })
    // Bounded: anything this old is either acknowledged or lost for good.
    while (this._inputs.length > 64) this._inputs.shift()

    const buf = new ArrayBuffer(4)
    const view = new DataView(buf)
    view.setInt8(0, Math.max(-127, Math.min(127, Math.round(this._dirX * 127))))
    view.setInt8(1, Math.max(-127, Math.min(127, Math.round(this._dirY * 127))))
    view.setUint16(2, seq)
    return buf
  }

  /** Advance the prediction by one rendered frame. */
  predict (dtSeconds: number): void {
    if (!this.ready) return
    const next = this._step(this.x, this.y, this._dirX, this._dirY, dtSeconds)
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

    let x = serverX
    let y = serverY

    if (this._inputs.length > 0 && this._inputs[0].seq === ackSeq) {
      // The acked input is still partly ahead of the server: it has been applied
      // for ackElapsedMs, but on this client it was current for longer than that.
      const acked = this._inputs[0]
      const endOfAcked = this._inputs.length > 1 ? this._inputs[1].t : now
      const remainder = Math.max(0, (endOfAcked - acked.t) - ackElapsedMs)
      const p0 = this._step(x, y, acked.x, acked.y, remainder / 1000)
      x = p0.x
      y = p0.y

      for (let i = 1; i < this._inputs.length; i++) {
        const input = this._inputs[i]
        const end = i + 1 < this._inputs.length ? this._inputs[i + 1].t : now
        const p = this._step(x, y, input.x, input.y, Math.max(0, end - input.t) / 1000)
        x = p.x
        y = p.y
      }
    } else {
      // The server acknowledged an input we no longer hold - it skipped ours, or
      // we have been away. Its word is final; replay whatever we still have.
      for (let i = 0; i < this._inputs.length; i++) {
        const input = this._inputs[i]
        const end = i + 1 < this._inputs.length ? this._inputs[i + 1].t : now
        const p = this._step(x, y, input.x, input.y, Math.max(0, end - input.t) / 1000)
        x = p.x
        y = p.y
      }
    }

    this.x = x
    this.y = y

    const errX = beforeX - x
    const errY = beforeY - y
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
   * One integration step, mirroring the server's `Unit.update`: normalised
   * direction, then push out of every collider sharing our plane, then clamp to
   * the map. Kept deliberately in step with the server - if that changes, this
   * has to change with it or prediction starts fighting the authority.
   */
  private _step (x: number, y: number, dirX: number, dirY: number, dt: number): { x: number, y: number } {
    if (dt <= 0) return { x, y }

    const dirSq = dirX * dirX + dirY * dirY
    if (dirSq > 0) {
      const inv = 1 / Math.sqrt(dirSq)
      const step = dt * this.maxVelocity
      x += dirX * inv * step
      y += dirY * inv * step
    }

    for (const c of this._colliders()) {
      if (c.tag !== this.tag) continue

      const sumWidth = c.radius + PLAYER_RADIUS
      const dx = c.x - x
      const dy = c.y - y
      const sqr = dx * dx + dy * dy
      if (sqr < sumWidth * sumWidth) {
        if (sqr > EPSILON) {
          const magnitude = Math.sqrt(sqr)
          x = c.x - (sumWidth * dx) / magnitude
          y = c.y - (sumWidth * dy) / magnitude
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
