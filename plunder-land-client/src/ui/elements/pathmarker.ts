import { Graphics } from 'pixi.js'
import { type Vector } from '../../utils/vector'
import { Hex } from '../../utils/hex'

/** Warm off-white. Reads on both the ground and the grass plane. */
const COLOUR = 0xF2E4C4

/**
 * Laid under every mark, a pixel down and slightly wider.
 *
 * The route used to be flat off-white on a flat tiling background, where it was
 * perfectly legible. Textured ground took that away - cobbles and flowers are
 * the same size and nearly the same value as the dots, so half the route
 * disappeared into them. A dark edge is what puts it back without making the
 * marks any louder.
 */
const SHADOW = 0x1A1208

/**
 * The route the local player is walking: a dot on each cell still to come, and
 * a ring on the destination.
 *
 * It draws `LocalPlayer.remaining` rather than the whole path, so it empties out
 * behind the player as they advance. That is worth saying because it makes the
 * marker a readout of the prediction rather than a decoration next to it - if
 * the dots ever disagree with where the player walks, the prediction is wrong
 * and this is the thing that shows it.
 *
 * Lives on the player's own plane layer with a negative zIndex, so units and
 * loot draw over it.
 *
 * Both radii are fractions of the cell rather than pixel counts, so the marker
 * keeps its proportions when `Hex.SIZE` moves. They were 4 and 11 px, tuned
 * against a 35-unit cell, and they stopped fitting the moment it grew.
 */
export class PathMarker extends Graphics {
  /** What is currently drawn, so a redraw only happens when the route changes. */
  private _drawn: string = ''

  constructor () {
    super()
    this.zIndex = -1
    this.eventMode = 'none'
  }

  setPath (cells: Vector[]): void {
    // Length plus both ends is enough to notice any change that matters: walking
    // a step shortens it, and re-routing moves an end. Without this the marker
    // re-tessellates every circle every frame for a route that has not moved.
    const signature = cells.length === 0
      ? ''
      : `${cells.length}:${cells[0].x},${cells[0].y}:${cells[cells.length - 1].x},${cells[cells.length - 1].y}`

    if (signature === this._drawn) return
    this._drawn = signature

    this.clear()
    if (cells.length === 0) return

    const dot = Hex.SIZE * 0.11

    for (let i = 0; i < cells.length - 1; i++) {
      const centre = Hex.toPosition(cells[i])
      // Faint near the player and firmer further out, so the eye is drawn along
      // the route to where it ends rather than to the step underfoot.
      const alpha = 0.35 + 0.45 * (i / cells.length)

      this.beginFill(SHADOW, alpha * 0.55)
      this.drawCircle(centre.x, centre.y + 1, dot + 1.5)
      this.endFill()

      this.beginFill(COLOUR, alpha)
      this.drawCircle(centre.x, centre.y, dot)
      this.endFill()
    }

    const end = Hex.toPosition(cells[cells.length - 1])
    const ring = Hex.SIZE * 0.31

    this.lineStyle(4, SHADOW, 0.5)
    this.drawCircle(end.x, end.y + 1, ring)
    this.lineStyle(2, COLOUR, 0.9)
    this.drawCircle(end.x, end.y, ring)
    this.lineStyle(0)
  }
}
