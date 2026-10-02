import { Container, Graphics, Sprite, type Texture } from 'pixi.js'
import { Hex } from '../utils/hex'
import { FOG_TINT, SEEN, type Seen } from './fog'
import { HexTerrain } from './hexterrain'
import { shadowOffset } from './shadow'
import { TILT } from './tilt'

/** One wall cell: its pieces, kept for re-tinting. */
interface Piece {
  node: Container
  face: Sprite
  left: Sprite
  right: Sprite
  q: number
  r: number
}

/**
 * One plane's walls (decision #44): short raised runs of cells inside the
 * islands, from `hello.walls` (`Game.WALLS`). Drawn from the ground's own art
 * (Nick, 2026-10-02: "use same tiles and wall drop offs, let's see how it
 * looks"): each wall cell is the steel face its ground cell wears
 * (`HexTerrain.faceOf`) lifted `HEIGHT` px, with the ground's edge drop-offs
 * (the fade halves `HexTerrain` hangs under an edge above void) hung under its
 * two lower edges at full strength, and a shadow to the bottom right.
 *
 * Each cell is its own object in the plane, sorted by `y` with the units
 * (`zIndex`, just under a unit on the same cell), so a wall hides the feet of
 * whoever stands north of it. Added to a `TiltedContainer`, it stands up: the
 * face and fades are baked already squashed by the tilt, as the ground's are.
 *
 * Shown only once the fog has seen its cell, and tinted by the fog and the
 * plane like the ground (`retint`, every frame). Rebuilt on every `hello`
 * (`set`): a new run may be in another world.
 */
export class Walls {
  /** How far a wall stands up, CSS px: 60% of the first 18 (Nick, 2026-10-02). */
  static readonly HEIGHT = 11

  /**
   * The white over each top face, so a wall reads lighter than the floor it
   * wears the same face as (Nick: "brighter tile, maybe overlay"). A tint
   * can only darken.
   */
  static readonly HIGHLIGHT = 0.16

  private readonly pieces: Piece[] = []

  constructor (private readonly plane: Container, private readonly terrain: HexTerrain, private readonly tint: number) {}

  /** Replace every wall with `cells` (`Hex.key`s) of a map `mapSize` units across. */
  set (cells: ReadonlySet<number> | undefined, mapSize: number): void {
    for (const piece of this.pieces) {
      piece.node.parent?.removeChild(piece.node)
      piece.node.destroy({ children: true })
    }
    this.pieces.length = 0
    if (cells === undefined) return
    for (const cell of Hex.mapCells(mapSize)) {
      if (!cells.has(Hex.key(cell.x, cell.y))) continue
      const at = Hex.toPosition(cell)
      const piece = this.build(cell.x, cell.y)
      piece.node.position.set(at.x, at.y)
      piece.node.zIndex = at.y - 0.5
      piece.node.renderable = false
      this.plane.addChild(piece.node)
      this.pieces.push(piece)
    }
  }

  /** Show and tint each wall by what the fog says of its cell. */
  retint (seenOf: ((q: number, r: number) => Seen) | undefined): void {
    for (const piece of this.pieces) {
      const seen = seenOf?.(piece.q, piece.r) ?? SEEN.VISIBLE
      piece.node.renderable = seen !== SEEN.UNKNOWN
      if (!piece.node.renderable) continue
      const tint = Walls.multiply(FOG_TINT[seen], this.tint)
      piece.face.tint = tint
      const fade = Walls.multiply(tint, HexTerrain.FADE_TINT)
      piece.left.tint = fade
      piece.right.tint = fade
    }
  }

  /** One wall cell, in screen px about its ground centre. */
  private build (q: number, r: number): Piece {
    const node = new Container()
    node.eventMode = 'none'
    const h = Walls.HEIGHT
    // The shadow: the cell's hex swept from the ground to where its top's
    // shadow falls (`shadowOffset`, the way every cast shadow leans), which
    // for a convex shape is the hull of the two.
    const w = Hex.SIZE / 2
    const v = Hex.SIZE / Math.sqrt(3) * TILT
    const base = [[0, -v], [w, -v / 2], [w, v / 2], [0, v], [-w, v / 2], [-w, -v / 2]]
    const o = shadowOffset(h)
    const shadow = new Graphics()
      .beginFill(0x000000, 0.3)
      .drawPolygon(hull([...base, ...base.map(([x, y]) => [x + o.x, y + o.y])]).flat())
      .endFill()
    // The face's highlight: the pad is a hex 7% larger than the lattice.
    const k = 1.07
    const highlight = new Graphics()
      .beginFill(0xffffff, Walls.HIGHLIGHT)
      .drawPolygon(base.flatMap(([x, y]) => [x * k, y * k - h]))
      .endFill()
    const sprite = (texture: Texture): Sprite => {
      const s = new Sprite(texture)
      s.anchor.copyFrom(texture.defaultAnchor)
      s.roundPixels = false
      s.scale.set(Hex.SIZE / HexTerrain.BAKED_FOR)
      s.y = -h
      return s
    }
    const left = sprite(this.terrain.fadeLeft)
    const right = sprite(this.terrain.fadeRight)
    const face = sprite(this.terrain.faceOf(q, r))
    node.addChild(shadow, left, right, face, highlight)
    return { node, face, left, right, q, r }
  }

  /** Two 0xRRGGBB tints multiplied channel by channel, as `HexTerrain` does. */
  private static multiply (a: number, b: number): number {
    const r = ((a >> 16 & 255) * (b >> 16 & 255) / 255) | 0
    const g = ((a >> 8 & 255) * (b >> 8 & 255) / 255) | 0
    const bl = ((a & 255) * (b & 255) / 255) | 0
    return (r << 16) | (g << 8) | bl
  }
}

/** The convex hull of `points` (monotone chain), counter-clockwise. */
function hull (points: number[][]): number[][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: number[], a: number[], b: number[]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: number[][] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: number[][] = []
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}
