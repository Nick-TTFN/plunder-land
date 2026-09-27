import { Container, Sprite, type Texture } from 'pixi.js'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { FOG_TINT, SEEN, type Seen } from './fog'
import { ROW_SCREEN, TILT } from './tilt'

/**
 * The ground of one plane, drawn as one sprite per cell.
 *
 * This replaces a `TilingSprite` of a square texture stretched over the whole
 * 4000-unit map. That was cheap and it was also the reason the grid was
 * invisible: the thing you move on is a hex, and nothing on screen said so, so
 * a route read as dots floating over wallpaper.
 *
 * Only what the camera can see is built, and only when the camera's own cell
 * changes - about three times a second at a walk. A 1920x1080 view is roughly
 * 1400 cells, so the sprites are pooled and repositioned rather than recreated.
 * The whole map would be about 9,000 cells per plane, which is a lot of sprites
 * to sort every frame for ground that never changes.
 *
 * **Which texture a cell gets is derived from the cell, not drawn at random.**
 * That is the load-bearing part: a cell has to come back with the same face
 * every time it re-enters view, or the ground boils as you walk. It also means
 * nothing about the ground has to travel over the wire.
 *
 * It is derived in two steps, and the second one is what makes it read as
 * ground. A value-noise field over the world picks which *palette* a cell
 * belongs to, so sand borders sand and stone borders stone in patches a few
 * cells across; a hash of the cell then picks a face from within that palette.
 * Choosing a face per cell out of one big palette was the first attempt and it
 * looked like static - every tile as different from its neighbour as the
 * palette allowed, which is the one thing real ground never is.
 *
 * **Seen through the tilted camera** (objects/tilt.ts). This container stands
 * upright, so it lays its own rows out at `TILT` of their pitch and its pads
 * are baked already squashed, which keeps them texel for pixel.
 *
 * A known cell (visible or explored) is a raised slab: its face plus a short
 * wall hanging below it (`tools/bake-ground-atlas.py`), anchored at the face's
 * centre. Rows are laid out top to bottom, so each row's faces cover the walls
 * of the row above, and a wall shows only where the cell below is unknown.
 * An unknown cell is the void: a faint outline on the lattice, in a layer
 * behind every slab, so walls fall in front of it. A valley's cell is
 * always unknown (`Game.VOIDS`, set in `Game.onHello`).
 *
 * **Pads are not pixel-rounded.** PIXI's `roundPixels` rounds to
 * `settings.RESOLUTION` (1), not the renderer's 2x, which snapped pads to
 * whole CSS pixels a different way on each row. Instead every pad sits on a
 * whole device pixel by construction: the column pitch is 45, the row shift
 * 22.5 and the row pitch `ROW_SCREEN` 29, the frames put the face centre on a
 * whole texel, and `Game` snaps the camera to device pixels.
 */
export class HexTerrain extends Container {
  /**
   * The cell spacing the pad and prop art was baked at - see
   * `tools/bake-ground-atlas.py` and `tools/bake-hex-atlas.py`.
   *
   * Art is baked to its exact on-screen size (pads at 2x, which the sheet's
   * `meta.scale` accounts for) so it lands texel for pixel, which is what
   * keeps it crisp under `ROUND_PIXELS`. If
   * `Hex.SIZE` moves without a re-bake this rescales them so the world is still
   * correct, just softer; re-bake rather than living on it.
   */
  static BAKED_FOR = 45

  /** Vertical distance between rows, from the grid itself. */
  private static readonly ROW_PITCH = Hex.toPosition(new Vector(0, 1)).y

  /**
   * How far apart the region palettes vary, in cells. Small enough that a
   * screen holds several patches, large enough that a patch is a place rather
   * than a speckle.
   */
  private static readonly REGION_CELLS = 5

  /** Screen distance between rows: the grid's, through the tilt. A whole pixel. */
  private static readonly ROW_SCREEN = ROW_SCREEN

  /** One palette per region, in the order they lie along the noise field. */
  private readonly regions: Texture[][]
  /** What an unknown cell is drawn as instead of its face. */
  private readonly outline: Texture
  /** Behind `slabs`: the unknown cells' outlines. */
  private readonly voids = new Container()
  private readonly slabs = new Container()
  /** One outline per pooled pad, shown instead of it when the cell is unknown. */
  private readonly voidPool: Sprite[] = []
  private readonly pool: Sprite[] = []
  /** Each pooled pad's cell, for re-tinting without a relayout (`retint`). */
  private readonly padQ: number[] = []
  private readonly padR: number[] = []
  private _used = 0

  /**
   * What the player knows about cell (q, r): the fog's (fog-of-war, M2), set
   * by `Game` per layer. Unset draws every pad visible, as before fog.
   */
  seenOf: ((q: number, r: number) => Seen) | undefined

  /** This plane's own tint, multiplied into the fog's: deeper reads colder. */
  tint = 0xFFFFFF

  /**
   * The camera cell and view size the current layout was built for.
   *
   * Not `_width` / `_height`: `Container` already has those and shadowing them
   * with a private is a compile error, not a subtle bug, but only because the
   * base class happens to declare them public.
   */
  private _q = NaN
  private _r = NaN
  private _viewWidth = 0
  private _viewHeight = 0

  constructor (regions: Texture[][], outline: Texture) {
    super()
    this.regions = regions
    this.outline = outline
    // Nothing here overlaps anything but its own neighbours, and the row order
    // below is already the order it wants drawing in. Sorting ~1400 children
    // every frame for that would be pure cost.
    this.sortableChildren = false
    this.eventMode = 'none'
    for (const part of [this.voids, this.slabs]) {
      part.sortableChildren = false
      part.eventMode = 'none'
      this.addChild(part)
    }
  }

  /**
   * Lay out the cells covering a view of `width` x `height` centred on
   * (`x`, `y`), in this container's own coordinates.
   */
  update (x: number, y: number, width: number, height: number): void {
    const centre = Hex.toCell(new Vector(x, y))

    if (
      centre.x === this._q && centre.y === this._r &&
      width === this._viewWidth && height === this._viewHeight
    ) return

    this._q = centre.x
    this._r = centre.y
    this._viewWidth = width
    this._viewHeight = height

    const scale = Hex.SIZE / HexTerrain.BAKED_FOR

    // A row past each edge, because a pad reaches half its height beyond its
    // own centre and the row pitch is only three quarters of that height; and
    // one more below for the walls. The view covers `height / TILT` of world.
    const r0 = Math.floor((y - height / 2 / TILT) / HexTerrain.ROW_PITCH) - 1
    const r1 = Math.ceil((y + height / 2 / TILT) / HexTerrain.ROW_PITCH) + 2

    let used = 0

    for (let r = r0; r <= r1; r++) {
      // Rows are skewed, so the q range is per row rather than shared. Doing it
      // once for the whole block would have to cover the skew across every row
      // in view - about 15 cells of wasted width at the top and bottom.
      const shift = r / 2
      const q0 = Math.floor((x - width / 2) / Hex.SIZE - shift) - 1
      const q1 = Math.ceil((x + width / 2) / Hex.SIZE - shift) + 1

      for (let q = q0; q <= q1; q++) {
        let pad = this.pool[used]
        let hole = this.voidPool[used]
        if (pad === undefined || hole === undefined) {
          pad = new Sprite()
          pad.roundPixels = false
          hole = new Sprite(this.outline)
          hole.roundPixels = false
          hole.anchor.copyFrom(this.outline.defaultAnchor)
          this.pool.push(pad)
          this.voidPool.push(hole)
          this.slabs.addChild(pad)
          this.voids.addChild(hole)
        }
        used++

        pad.scale.set(scale)
        pad.x = Hex.SIZE * (q + shift)
        pad.y = HexTerrain.ROW_SCREEN * r
        hole.scale.set(scale)
        hole.x = pad.x
        hole.y = pad.y
        this.padQ[used - 1] = q
        this.padR[used - 1] = r
        this.dress(used - 1)
      }
    }
    this._used = used

    // Kept, not destroyed: the count swings by a row or two as the camera moves
    // and a resize is the only thing that changes it for good.
    for (let i = used; i < this.pool.length; i++) {
      this.pool[i].visible = false
      this.voidPool[i].visible = false
    }
  }

  /**
   * Re-apply the fog to every pad in use, without laying them out again: the
   * fog moved but the camera's cell did not (or did, and `update` already
   * applied it; this is then a cheap repeat). About 1400 pads.
   */
  retint (): void {
    for (let i = 0; i < this._used; i++) this.dress(i)
  }

  /**
   * Show pooled cell `i` as the fog says: a slab with its face, tinted, or the
   * void's outline.
   */
  private dress (i: number): void {
    const q = this.padQ[i]
    const r = this.padR[i]
    const pad = this.pool[i]
    const seen = this.seenOf?.(q, r) ?? SEEN.VISIBLE
    const known = seen !== SEEN.UNKNOWN
    pad.visible = known
    this.voidPool[i].visible = !known
    if (!known) return

    const texture = this.faceOf(q, r)
    if (pad.texture !== texture) {
      pad.texture = texture
      // The frame's own anchor, at the face's centre: the wall below it makes
      // the frame taller than the face, so 0.5 would put the face high.
      pad.anchor.copyFrom(texture.defaultAnchor)
    }
    pad.tint = HexTerrain.multiply(FOG_TINT[seen], this.tint)
  }

  /** Two 0xRRGGBB tints multiplied channel by channel, as PIXI would apply both. */
  private static multiply (a: number, b: number): number {
    const r = ((a >> 16 & 255) * (b >> 16 & 255) / 255) | 0
    const g = ((a >> 8 & 255) * (b >> 8 & 255) / 255) | 0
    const bl = ((a & 255) * (b & 255) / 255) | 0
    return (r << 16) | (g << 8) | bl
  }

  /** The face this cell always wears: its region's palette, indexed by its hash. */
  private faceOf (q: number, r: number): Texture {
    const x = Hex.SIZE * (q + r / 2)
    const y = HexTerrain.ROW_PITCH * r
    const span = Hex.SIZE * HexTerrain.REGION_CELLS

    // Value noise is centre-heavy rather than uniform, so the palettes at the
    // ends of the list are the rare ones and the middle two carry most of the
    // map. That is deliberate and it is why the caller's order matters.
    const field = HexTerrain.noise(x / span, y / span)
    const region = this.regions[
      Math.min(this.regions.length - 1, Math.floor(field * this.regions.length))
    ]

    return region[HexTerrain.pick(q, r) % region.length]
  }

  /**
   * Value noise in [0, 1): a hash at each lattice point, smoothly interpolated.
   *
   * Not gradient noise. Value noise is a dozen lines, has no gradient table to
   * keep, and the difference between the two is invisible once the output is
   * quantised into four buckets.
   */
  private static noise (x: number, y: number): number {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi

    // Smoothstep, so patches meet in a curve rather than along the lattice.
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)

    const top = HexTerrain.lattice(xi, yi) * (1 - u) + HexTerrain.lattice(xi + 1, yi) * u
    const bottom = HexTerrain.lattice(xi, yi + 1) * (1 - u) + HexTerrain.lattice(xi + 1, yi + 1) * u

    return top * (1 - v) + bottom * v
  }

  /**
   * The noise field's value at one lattice point, in [0, 1).
   *
   * Salted, so a lattice point and the cell with the same coordinates do not
   * hash alike - otherwise the face picked inside a patch would correlate with
   * the patch it is in, and one tile per patch would always come up the same.
   */
  private static lattice (x: number, y: number): number {
    return HexTerrain.pick(x * 2 + 1, y * 2 + 1) / 4294967296
  }

  /**
   * A stable 32-bit hash of a cell.
   *
   * Cheap and well mixed enough that neighbouring cells do not land on the same
   * texture in stripes, which is what the obvious `(q * 31 + r)` does on a grid
   * where the two axes are correlated. `Math.imul` because a plain `*` on two
   * large ints goes through a double and loses the low bits that carry the mix.
   */
  private static pick (q: number, r: number): number {
    let h = Math.imul(q, 374761393) + Math.imul(r, 668265263)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return (h ^ (h >>> 16)) >>> 0
  }
}
