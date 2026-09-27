import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * The valleys: the void that cuts each layer into regions (tile art pass,
 * 2026-09-27). About a third of a layer's cells are void, in winding chasms,
 * and every free cell stays reachable from every other: a region the chasms
 * cut off is joined back by a bridge carved across the narrowest stretch of
 * void, and a scrap too small to be a place is filled in.
 *
 * Generated once per layer when the world is built (`World.carveValleys`), at
 * random, so every server start is a new map. Void cells are blocked cells
 * (`World.BLOCKED`, blocker null) and reach the client as runs in
 * `hello.voids` (`encodeRuns`), not as objects.
 */

/** How wide one bend of a chasm is, in cells: the noise's base period. */
const PERIOD_CELLS = 16

/** A free region smaller than this is filled in rather than bridged to. */
const MIN_REGION = 30

/**
 * A patch of void smaller than this is ground instead: a few loose holes read
 * as bites out of the floor, not as a valley.
 */
const MIN_VOID = 12

/**
 * Void cells of a map `size` units across, `share` of them (roughly: bridges
 * take a little back and filled scraps add a little). `random` is injectable
 * so a spec can pin a map.
 */
export function carveValleys (size: number, share: number, random: () => number = Math.random): Set<number> {
  const cells = Hex.mapCells(size)
  const byKey = new Map<number, Vector>()
  for (const cell of cells) byKey.set(Hex.key(cell.x, cell.y), cell)

  // Ridged noise: two octaves of value noise folded about their middle, so
  // the lowest values run along winding lines rather than sitting in blobs.
  // The lowest `share` of cells are the chasms.
  const lattice = new Map<number, number>()
  const at = (x: number, y: number): number => {
    const key = Hex.key(x, y)
    let v = lattice.get(key)
    if (v === undefined) {
      v = random()
      lattice.set(key, v)
    }
    return v
  }
  const noise = (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const u = smooth(x - xi)
    const v = smooth(y - yi)
    const top = at(xi, yi) * (1 - u) + at(xi + 1, yi) * u
    const bottom = at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u
    return top * (1 - v) + bottom * v
  }
  const span = Hex.SIZE * PERIOD_CELLS
  const ridge = new Map<number, number>()
  for (const cell of cells) {
    const p = Hex.toPosition(cell)
    const fbm = noise(p.x / span, p.y / span) * 0.7 + noise(p.x / span * 2.3 + 50, p.y / span * 2.3 + 50) * 0.3
    ridge.set(Hex.key(cell.x, cell.y), Math.abs(fbm - 0.5))
  }
  const sorted = [...ridge.values()].sort((a, b) => a - b)
  const threshold = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]
  const voids = new Set<number>()
  for (const [key, value] of ridge) if (value < threshold) voids.add(key)

  // Specks first: filling void in can only join free ground, never split it.
  for (const patch of groups(voids, byKey, true)) {
    if (patch.length < MIN_VOID) for (const key of patch) voids.delete(key)
  }
  connect(voids, byKey)
  return voids
}

function smooth (t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * Make the free cells one region. The largest region is the mainland; any
 * other region under `MIN_REGION` cells is filled in, and the rest are joined
 * to whatever free ground is nearest across the void, by the shortest line of
 * void cells (a breadth-first search out of the region), which is carved free.
 * One at a time, largest first, until one region is left.
 */
function connect (voids: Set<number>, byKey: Map<number, Vector>): void {
  for (;;) {
    const regions = groups(voids, byKey, false)
    if (regions.length <= 1) return
    regions.sort((a, b) => b.length - a.length)

    let bridged = false
    for (const region of regions.slice(1)) {
      if (region.length < MIN_REGION) {
        for (const key of region) voids.add(key)
        continue
      }
      if (!bridged) {
        bridge(region, voids, byKey)
        bridged = true
      }
    }
    // Filling scraps can't merge regions and a bridge merges one pair, so the
    // regions are recounted after each bridge.
    if (!bridged) return
  }
}

/** Connected groups of void cells (`ofVoid`) or of free cells, as keys. */
function groups (voids: Set<number>, byKey: Map<number, Vector>, ofVoid: boolean): number[][] {
  const seen = new Set<number>()
  const regions: number[][] = []
  for (const key of byKey.keys()) {
    if (voids.has(key) !== ofVoid || seen.has(key)) continue
    const region = [key]
    seen.add(key)
    for (let i = 0; i < region.length; i++) {
      const cell = byKey.get(region[i]) as Vector
      for (let d = 0; d < 6; d++) {
        const n = Hex.neighbour(cell, d)
        const k = Hex.key(n.x, n.y)
        if (!byKey.has(k) || voids.has(k) !== ofVoid || seen.has(k)) continue
        seen.add(k)
        region.push(k)
      }
    }
    regions.push(region)
  }
  return regions
}

/** Carve the shortest run of void from `region` to any other free cell. */
function bridge (region: number[], voids: Set<number>, byKey: Map<number, Vector>): void {
  const inRegion = new Set(region)
  const from = new Map<number, number>()
  const queue: number[] = []
  for (const key of region) {
    const cell = byKey.get(key) as Vector
    for (let d = 0; d < 6; d++) {
      const n = Hex.neighbour(cell, d)
      const k = Hex.key(n.x, n.y)
      if (voids.has(k) && !from.has(k)) {
        from.set(k, key)
        queue.push(k)
      }
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]
    const cell = byKey.get(key) as Vector
    for (let d = 0; d < 6; d++) {
      const n = Hex.neighbour(cell, d)
      const k = Hex.key(n.x, n.y)
      if (!byKey.has(k) || from.has(k) || inRegion.has(k)) continue
      if (!voids.has(k)) {
        // Free ground outside the region: carve the way back.
        for (let step: number | undefined = key; step !== undefined && voids.has(step); step = from.get(step)) {
          voids.delete(step)
        }
        return
      }
      from.set(k, key)
      queue.push(k)
    }
  }
}

/**
 * The void cells as alternating run lengths over `Hex.mapCells(size)`'s order:
 * free, void, free, ... starting with a (possibly empty) free run. This is
 * `hello.voids[i]`; the client's `decodeRuns` (src/net/session.ts) reads it.
 */
export function encodeRuns (voids: Set<number>, size: number): number[] {
  const runs: number[] = []
  let current = false
  let length = 0
  for (const cell of Hex.mapCells(size)) {
    const isVoid = voids.has(Hex.key(cell.x, cell.y))
    if (isVoid !== current) {
      runs.push(length)
      current = isVoid
      length = 0
    }
    length++
  }
  runs.push(length)
  return runs
}
