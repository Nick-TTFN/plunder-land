import { Graphics } from 'pixi.js'
import { type Vector } from '../../utils/vector'
import { Hex } from '../../utils/hex'

/** Warm off-white. Reads on both the ground and the grass plane. */
const COLOUR = 0xF2E4C4

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

    for (let i = 0; i < cells.length - 1; i++) {
      const centre = Hex.toPosition(cells[i])
      // Faint near the player and firmer further out, so the eye is drawn along
      // the route to where it ends rather than to the step underfoot.
      this.beginFill(COLOUR, 0.2 + 0.4 * (i / cells.length))
      this.drawCircle(centre.x, centre.y, 4)
      this.endFill()
    }

    const end = Hex.toPosition(cells[cells.length - 1])
    this.lineStyle(2, COLOUR, 0.85)
    this.drawCircle(end.x, end.y, 11)
    this.lineStyle(0)
  }
}
