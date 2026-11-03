import { Graphics } from 'pixi.js'
import { Hex } from '../utils/hex'
import { onGround } from '../objects/tilt'

/** Line and crosshair colour. Placeholder look (#58: "look not specified"). */
const COLOUR = 0xFFE15A
/** The no-target line, in cells: shorter than a target's, and fainter. */
const IDLE_CELLS = 2
/** Where the line starts and stops short of the units, in world units. */
const GAP = Hex.SIZE * 0.4

/** One end of the aim line, in world units. */
export interface AimPoint { x: number, y: number }

/**
 * The aim line (decision #58): from the own robot to the auto-aim target,
 * with a crosshair on the target; with no target, a shorter, fainter line
 * along the movement direction and no crosshair. Drawn on the ground, so the
 * tilted camera squashes it (`onGround`); hidden with `renderable`, never
 * `visible`. One per run (`Game.start`), re-parented to the player's plane
 * like the route marker. Redrawn every frame: the ends move with the units.
 * PROVISIONAL look, for Nick's play.
 */
export class AimLine extends Graphics {
  constructor () {
    super()
    onGround(this)
    this.eventMode = 'none'
    // Over the ground, threat cells (-2) and the route (-1); under the units
    // and props, which sort by their y.
    this.zIndex = -0.5
    this.renderable = false
  }

  hide (): void {
    if (!this.renderable) return
    this.clear()
    this.renderable = false
  }

  /**
   * To `target` (world units), its crosshair sized for `rings` (its body's
   * rings: 0 for one cell, 1 for a 7-cell body); undefined draws the
   * no-target line along (dirX, dirY), world space.
   */
  show (from: AimPoint, target: AimPoint | undefined, rings: number, dirX: number, dirY: number): void {
    this.clear()
    this.renderable = true

    if (target === undefined) {
      const len = Math.hypot(dirX, dirY)
      const ux = len > 1e-9 ? dirX / len : 1
      const uy = len > 1e-9 ? dirY / len : 0
      const end = IDLE_CELLS * Hex.SIZE
      this.lineStyle(3, COLOUR, 0.35)
      this.moveTo(from.x + ux * GAP, from.y + uy * GAP)
      this.lineTo(from.x + ux * end, from.y + uy * end)
      return
    }

    const dx = target.x - from.x
    const dy = target.y - from.y
    const len = Math.hypot(dx, dy)
    const radius = Hex.SIZE * (0.45 + rings)
    if (len > GAP + radius) {
      const ux = dx / len
      const uy = dy / len
      this.lineStyle(3, COLOUR, 0.75)
      this.moveTo(from.x + ux * GAP, from.y + uy * GAP)
      this.lineTo(target.x - ux * radius, target.y - uy * radius)
    }

    // The crosshair: a ring and four ticks crossing it.
    this.lineStyle(3, COLOUR, 0.9)
    this.drawCircle(target.x, target.y, radius)
    const inner = radius * 0.55
    const outer = radius * 1.3
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      this.moveTo(target.x + ux * inner, target.y + uy * inner)
      this.lineTo(target.x + ux * outer, target.y + uy * outer)
    }
  }
}
