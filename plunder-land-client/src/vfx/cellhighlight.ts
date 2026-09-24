import TWEEN from '@tweenjs/tween.js'
import { Graphics, type Container } from 'pixi.js'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Game } from '../game'
import { type Cell, DIRECTIONS } from './cells'
import { type GameObject } from '../objects/gameobject'

/** Corner distance of a pointy-top cell whose centres are `Hex.SIZE` apart. */
const CORNER = Hex.SIZE / Math.sqrt(3)
/** Drawn a little inside the cell, so neighbouring cells read as separate. */
const INSET = 0.9

/**
 * The corners of one cell, relative to its centre. Pointy-top: a corner at the
 * top and bottom, flat sides left and right. Computed once.
 */
const CORNERS: number[] = []
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 3) * i + Math.PI / 6
  CORNERS.push(Math.cos(a) * CORNER * INSET, Math.sin(a) * CORNER * INSET)
}

/**
 * The plane layer a unit stands on, where a cell highlight belongs: under the
 * units on that plane, and hidden with it when the viewer is on another one.
 */
export function layerOf (tag: number | undefined): Container | undefined {
  return Game.Instance?.layerOf(tag)
}

/** A world-space unit vector for a `Hex.DIRECTIONS` index. */
export function directionVector (index: number): Vector {
  const d = DIRECTIONS[((index % 6) + 6) % 6]
  return Hex.toPosition(new Vector(d.x, d.y)).normalised()
}

/**
 * The hex facing a unit last reported (the `facing` field), or East for
 * anything that has never sent one. Used only by unaimed effects: an aimed
 * effect carries its own cell (decision #21).
 */
export function facingOf (owner: GameObject): number {
  // Structural rather than `instanceof Unit`: effects are handed a GameObject
  // from `LOOKUP`, and only units ever carry the field.
  return (owner as unknown as { facingIndex?: number }).facingIndex ?? 0
}

/** The cell under a drawn object: where the viewer sees it, not the server. */
export function cellOf (owner: { x: number, y: number }): Cell {
  const cell = Hex.toCell(new Vector(owner.x, owner.y))
  return { x: cell.x, y: cell.y }
}

/**
 * A set of cells lit on a plane and faded out: the telegraph an area skill
 * leaves on the ground, drawn over exactly the cells it damages.
 *
 * `follow`, when given, is asked for the cells again every frame and the
 * highlight redraws when the answer changes. The breaths need it: the server
 * re-evaluates a cone from the caster's current cell on every test, so the
 * cone moves with its caster for its whole lifetime.
 */
export class CellHighlight extends Graphics {
  private _drawn = ''

  constructor (
    private readonly _colour: number,
    private readonly _fillAlpha: number = 0.28
  ) {
    super()
    this.eventMode = 'none'
    // Over the ground (-1000) and the route marker (-1), under every unit,
    // whose zIndex is its y.
    this.zIndex = -0.5
  }

  draw (cells: Cell[]): void {
    const signature = cells.map((c) => `${c.x},${c.y}`).join(';')
    if (signature === this._drawn) return
    this._drawn = signature

    this.clear()
    for (const cell of cells) {
      const centre = Hex.toPosition(new Vector(cell.x, cell.y))
      const points: number[] = []
      for (let i = 0; i < CORNERS.length; i += 2) {
        points.push(centre.x + CORNERS[i], centre.y + CORNERS[i + 1])
      }
      this.lineStyle(2, this._colour, 0.8)
      this.beginFill(this._colour, this._fillAlpha)
      this.drawPolygon(points)
      this.endFill()
    }
  }

  /**
   * Light `cells` on `tag`'s plane for `lifetime` ms: full strength for the
   * first half, then fading. Returns the highlight, already parented, or
   * undefined when there is no scene to draw into.
   */
  static flash (
    tag: number | undefined,
    cells: Cell[],
    colour: number,
    lifetime: number,
    follow?: () => Cell[]
  ): CellHighlight | undefined {
    const layer = layerOf(tag)
    if (layer === undefined) return undefined

    const highlight = new CellHighlight(colour)
    highlight.draw(cells)
    layer.addChild(highlight)

    const state = { t: 0 }
    new TWEEN.Tween(state)
      .to({ t: 1 }, Math.max(lifetime, 100))
      .onUpdate(() => {
        if (follow !== undefined) highlight.draw(follow())
        highlight.alpha = state.t < 0.5 ? 1 : 1 - (state.t - 0.5) * 2
      })
      .onComplete(() => {
        highlight.parent?.removeChild(highlight)
        highlight.destroy()
      })
      .start()

    return highlight
  }
}
