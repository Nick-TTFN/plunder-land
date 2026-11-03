import { Graphics } from 'pixi.js'
import { Hex } from '../utils/hex'
import { onGround } from '../objects/tilt'

/** Line and crosshair colour. */
const COLOUR = 0xFFE15A
/** The no-target aim point, in cells along the movement direction. */
const IDLE_CELLS = 2
/** Where the line starts and stops short of the units, in world units. */
const GAP = Hex.SIZE * 0.4
/** The dotted line: dash and gap lengths, width, in world units. */
const DASH = 7
const DASH_GAP = 9
const WIDTH = 2
/** Alphas: subtle line, crosshair a little stronger; fainter with no target. */
const LINE_ALPHA = 0.45
const IDLE_LINE_ALPHA = 0.22
const CROSS_ALPHA = 0.9
const IDLE_CROSS_ALPHA = 0.4
/** The no-target crosshair's radius, in cells. */
const IDLE_RADIUS = 0.3
/** Locked-on animation: scale pulse (fraction, per second) and spin (rad/s). */
const PULSE = 0.1
const PULSE_HZ = 1.6
const SPIN = 1.2
/** Above every unit and prop, which sort by their y. */
const CROSS_Z = 1e7

/** One end of the aim line, in world units. */
export interface AimPoint { x: number, y: number }

/**
 * The aim line (decision #58): a dotted line from the own robot to the
 * auto-aim target, with a crosshair on the target that pulses and turns; with
 * no target, a fainter, shorter line along the movement direction to a still
 * crosshair (where a press would go). Both lie on the ground (`onGround`) and
 * hide with `renderable`, never `visible`. The line sits under the units; the
 * crosshair is its own object (`cross`) with a z above them all, kept in the
 * line's plane (`show` re-parents it). One per run (`Game.start`).
 */
export class AimLine extends Graphics {
  readonly cross: Graphics

  constructor () {
    super()
    onGround(this)
    this.eventMode = 'none'
    // Over the ground, threat cells (-2) and the route (-1); under the units
    // and props, which sort by their y.
    this.zIndex = -0.5
    this.renderable = false

    this.cross = onGround(new Graphics())
    this.cross.eventMode = 'none'
    this.cross.zIndex = CROSS_Z
    this.cross.renderable = false
    drawCrosshair(this.cross, 1)
  }

  hide (): void {
    if (!this.renderable && !this.cross.renderable) return
    this.clear()
    this.renderable = false
    this.cross.renderable = false
  }

  /**
   * To `target` (world units), its crosshair sized for `rings` (its body's
   * rings: 0 for one cell, 1 for a 7-cell body); undefined draws the
   * no-target line along (dirX, dirY), world space.
   */
  show (from: AimPoint, target: AimPoint | undefined, rings: number, dirX: number, dirY: number): void {
    if (this.parent !== null && this.cross.parent !== this.parent) this.parent.addChild(this.cross)
    this.clear()
    this.renderable = true
    this.cross.renderable = true

    if (target === undefined) {
      const len = Math.hypot(dirX, dirY)
      const ux = len > 1e-9 ? dirX / len : 1
      const uy = len > 1e-9 ? dirY / len : 0
      const end = IDLE_CELLS * Hex.SIZE
      const radius = Hex.SIZE * IDLE_RADIUS
      this.dotted(from.x + ux * GAP, from.y + uy * GAP, from.x + ux * (end - radius), from.y + uy * (end - radius), IDLE_LINE_ALPHA)
      this.place(from.x + ux * end, from.y + uy * end, radius, 0, IDLE_CROSS_ALPHA)
      return
    }

    const dx = target.x - from.x
    const dy = target.y - from.y
    const len = Math.hypot(dx, dy)
    const radius = Hex.SIZE * (0.45 + rings)
    if (len > GAP + radius) {
      const ux = dx / len
      const uy = dy / len
      this.dotted(from.x + ux * GAP, from.y + uy * GAP, target.x - ux * radius, target.y - uy * radius, LINE_ALPHA)
    }
    const t = performance.now() / 1000
    const pulse = 1 + PULSE * Math.sin(t * Math.PI * 2 * PULSE_HZ)
    this.place(target.x, target.y, radius * pulse, t * SPIN, CROSS_ALPHA)
  }

  destroy (options?: Parameters<Graphics['destroy']>[0]): void {
    this.cross.destroy()
    super.destroy(options)
  }

  private place (x: number, y: number, radius: number, rotation: number, alpha: number): void {
    this.cross.position.set(x, y)
    this.cross.scale.set(radius)
    this.cross.rotation = rotation
    this.cross.alpha = alpha
  }

  private dotted (x0: number, y0: number, x1: number, y1: number, alpha: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 1) return
    const ux = (x1 - x0) / len
    const uy = (y1 - y0) / len
    this.lineStyle(WIDTH, COLOUR, alpha)
    for (let d = 0; d < len; d += DASH + DASH_GAP) {
      const e = Math.min(d + DASH, len)
      this.moveTo(x0 + ux * d, y0 + uy * d)
      this.lineTo(x0 + ux * e, y0 + uy * e)
    }
  }
}

/**
 * The crosshair at radius 1 (scaled by `place`): four arcs with gaps, so the
 * spin shows, and four ticks inward. Line width is divided by the scale's
 * typical size so it draws about `WIDTH` world units at a one-cell target.
 */
function drawCrosshair (g: Graphics, radius: number): void {
  const width = WIDTH / (Hex.SIZE * 0.45)
  g.lineStyle(width, COLOUR, 1)
  const arc = Math.PI / 2
  const gap = 0.5
  for (let i = 0; i < 4; i++) {
    const start = i * arc + gap / 2
    g.moveTo(Math.cos(start) * radius, Math.sin(start) * radius)
    g.arc(0, 0, radius, start, start + arc - gap)
  }
  for (let i = 0; i < 4; i++) {
    const a = i * arc
    g.moveTo(Math.cos(a) * radius * 0.55, Math.sin(a) * radius * 0.55)
    g.lineTo(Math.cos(a) * radius * 1.0, Math.sin(a) * radius * 1.0)
  }
}
