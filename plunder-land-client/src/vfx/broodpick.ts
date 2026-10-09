/**
 * Which Broodling the Brood's release (effect 19) is about (l1-7 F6).
 *
 * **This file imports nothing, on purpose**, like `cells.ts`: the server's
 * `brood.spec.ts` runs it against the server's own positions. The caller
 * passes the release cell's centre (`Hex.toPosition(aimCell)`), because the
 * client's `Hex` pulls in pixi through `Vector`.
 *
 * The record names a cell, not the Broodling, and the Broodling is not
 * reliably on that cell. The server releases it from a timer at the top of a
 * tick and it chases in that same tick, so by the flush it is 32.5 px off the
 * cell's centre at a 250 ms tick and 45.5 at 350 (a cell's edge is 22.5 px
 * out). The create built in its constructor still carries the centre, and a
 * frame's updates are applied after its effects (`unpackFrame` emits `update`
 * last), but a viewer who first sees it through `Multiplayer.update` is sent
 * the moved position, and the drawn position lags or leads the record by
 * interpolation. So the pick does not depend on the cell: a live Broodling
 * on the Brood's layer **created in this same frame** (`createdInFrame`, the
 * frame the effect arrived in), the nearest to the cell's centre within
 * `PICK_REACH` px. A Broodling created in an earlier frame is never picked,
 * so a late viewer, or one that walked past the cell, gets no emerge.
 */

/** What the pick reads of a client mob. */
export interface ReleaseCandidate {
  readonly x: number
  readonly y: number
  readonly tag: number | undefined
  readonly killed: boolean
  readonly archetype?: { readonly key: string }
  readonly createdInFrame: number
}

/**
 * Three cells (`Hex.SIZE` 45): a Broodling (130 u/s) covers 45.5 px in a
 * 350 ms tick, 130 in a full second's stall. Further than this it is another
 * Broodling, created in the same frame by something else.
 */
export const PICK_REACH = 135

/** The released Broodling (see the file comment), or undefined. Ties go to the first in `mobs`. */
export function pickReleased<T extends ReleaseCandidate> (
  mobs: readonly T[],
  tag: number | undefined,
  centre: { readonly x: number, readonly y: number },
  frame: number
): T | undefined {
  let best: T | undefined
  let bestDistance = PICK_REACH
  for (const mob of mobs) {
    if (mob.archetype?.key !== 'broodling' || mob.killed || mob.tag !== tag || mob.createdInFrame !== frame) continue
    const distance = Math.hypot(mob.x - centre.x, mob.y - centre.y)
    if (distance <= bestDistance && (best === undefined || distance < bestDistance)) {
      best = mob
      bestDistance = distance
    }
  }
  return best
}

/**
 * How long a released Broodling is drawn over the Brood that released it
 * (decision #52 open items, 5): its emerge, the server's `emergeMs`
 * (`brood.spec.ts` holds the two equal). Its release cell is on ring 2 of the
 * Brood's (ring footprint, option B), and the Brood, drawn about three cells
 * wide, still covers a ring-2 cell on its north side.
 */
export const EMERGE_ABOVE_MS = 1500

/** Who a new Broodling is drawn over, and until when (`performance.now()` ms). */
export interface EmergeAbove {
  readonly parent: { readonly y: number, readonly killed: boolean, readonly destroyed: boolean }
  readonly until: number
}

/**
 * A unit's depth (`zIndex`) at ground `y`: its `y`, as every unit's, unless
 * it is emerging over a live parent, then just over the parent's (the
 * parent's `y`, which is its depth this frame whichever of the two updates
 * first). Back to its `y` once `until` has passed or the parent is gone.
 */
export function emergeDepth (y: number, above: EmergeAbove | undefined, now: number): number {
  if (above === undefined || now >= above.until || above.parent.killed || above.parent.destroyed) return y
  return Math.max(y, above.parent.y + 1)
}
