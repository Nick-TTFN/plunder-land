import { Hex } from '../utils/hex'

/** What the local player knows about a cell. */
export const SEEN = { UNKNOWN: 0, EXPLORED: 1, VISIBLE: 2 } as const
export type Seen = typeof SEEN[keyof typeof SEEN]

/**
 * Pad tints per state (decision #36, tile art pass). An unknown cell is not
 * tinted: `HexTerrain` draws it as the ground sheet's outline instead of a
 * face. Keep the fog legend's swatches (`FogLegend` in
 * ui/components/layerspanel.ts) roughly in step with these.
 */
export const FOG_TINT: Readonly<Record<Seen, number>> = {
  [SEEN.VISIBLE]: 0xFFFFFF,
  [SEEN.EXPLORED]: 0x707C92,
  [SEEN.UNKNOWN]: 0xFFFFFF
}

/**
 * Each plane's ground tint, top (01) first, multiplied into the fog's: the
 * same steel gets darker and colder the deeper you are. A layer past the end
 * takes the last entry.
 */
export const LAYER_TINT: readonly number[] = [0xFFFFFF, 0xD2DAEC, 0xAEBAD8]

/**
 * Tile fog of war (fog-of-war, M2). Cells within `radius` rings of the
 * player's cell are visible; cells seen before on a layer are explored (the
 * ground and its terrain drawn dim, no units or pickups); the rest are
 * unknown. Per layer, per run (`reset` at each own create).
 *
 * **Cosmetic** (decision #36): the server still sends every unit in its
 * interest box, and this only decides what is drawn. The radius is the
 * robot's `vision` (utils/archetypes.ts, mirrored), so Periscope's larger one
 * needs no change here. With no radius (an archetype without fog), everything
 * reads visible, as before fog existed.
 *
 * Recomputed only when the player's cell or layer changes (`update` returns
 * true then, and `version` moves), which at walking pace is about three times
 * a second; everything else reads `state`.
 */
export class Fog {
  radius: number | null = null
  /** Moves whenever the visible set changes, for anyone caching a redraw. */
  version = 0
  private readonly _explored = new Map<number, Set<number>>()
  private _visible = new Set<number>()
  private _tag: number | undefined
  private _q = NaN
  private _r = NaN

  /** A new run: forget every layer, and see `radius` rings (null: no fog). */
  reset (radius: number | null): void {
    this.radius = radius
    this._explored.clear()
    this._visible = new Set()
    this._tag = undefined
    this._q = NaN
    this._r = NaN
    this.version++
  }

  /** The player is on cell (q, r) of layer `tag`. True if what is visible changed. */
  update (q: number, r: number, tag: number | undefined): boolean {
    if (q === this._q && r === this._r && tag === this._tag) return false
    this._q = q
    this._r = r
    this._tag = tag
    this._visible = new Set()
    const radius = this.radius
    if (radius !== null && tag !== undefined) {
      let explored = this._explored.get(tag)
      if (explored === undefined) {
        explored = new Set()
        this._explored.set(tag, explored)
      }
      // The disc of `radius` rings: every (dq, dr) with |dq|, |dr|, |dq + dr| <= radius.
      for (let dq = -radius; dq <= radius; dq++) {
        const lo = Math.max(-radius, -dq - radius)
        const hi = Math.min(radius, -dq + radius)
        for (let dr = lo; dr <= hi; dr++) {
          const key = Hex.key(q + dq, r + dr)
          this._visible.add(key)
          explored.add(key)
        }
      }
    }
    this.version++
    return true
  }

  /** What the player knows about cell (q, r) of layer `tag`. */
  state (q: number, r: number, tag: number | undefined): Seen {
    if (this.radius === null) return SEEN.VISIBLE
    if (tag !== this._tag) return this._explored.get(tag as number)?.has(Hex.key(q, r)) === true ? SEEN.EXPLORED : SEEN.UNKNOWN
    const key = Hex.key(q, r)
    if (this._visible.has(key)) return SEEN.VISIBLE
    return this._explored.get(tag as number)?.has(key) === true ? SEEN.EXPLORED : SEEN.UNKNOWN
  }
}
