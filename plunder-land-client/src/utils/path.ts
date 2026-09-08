import { Vector } from './vector'
import { Hex } from './hex'

/**
 * Breadth-first search over a bounded window of the hex grid.
 *
 * BFS rather than A*: every step on a hex grid costs the same, so a heap and a
 * heuristic are pure overhead over a few hundred cells. The window is what makes
 * that true - the search can never sprawl, so there is no budget to tune and no
 * partial-result path to handle.
 *
 * The window is also why the client and the server agree. Both search the same
 * disc around the same origin with the same occupancy, so both derive the same
 * path - identically, not approximately, because it is integer graph search
 * rather than floating-point integration. **If one side's window differs from
 * the other's by a single cell, that agreement is gone**, so WINDOW and the disc
 * test below are a contract between the two, not an implementation detail.
 *
 * Mirrored in the client at the same path; the two copies must stay byte
 * identical, and `mirror.spec.ts` fails if they drift.
 */
export class Path {
  /**
   * Search radius in cells. Cells further than this from the start are not
   * considered, so a destination beyond it is simply unreachable and the caller
   * gets an empty path.
   */
  static WINDOW = 10

  private static readonly SPAN = 2 * Path.WINDOW + 1

  // Allocated once at import and reused by every call, in every world. The
  // search itself allocates nothing; only the returned path does. `unit.ts` was
  // rewritten to scalar maths for the same reason - a throwaway object per
  // candidate is what turns a cheap loop into GC pressure, and GC is what makes
  // a tick miss its deadline.
  private static readonly _cameFrom = new Int16Array(Path.SPAN * Path.SPAN)
  private static readonly _queue = new Int16Array(Path.SPAN * Path.SPAN)
  private static readonly _seen = new Uint8Array(Path.SPAN * Path.SPAN)

  /** Index into the scratch arrays for a cell offset from the search origin. */
  private static _index (dq: number, dr: number): number {
    return (dq + Path.WINDOW) * Path.SPAN + (dr + Path.WINDOW)
  }

  /**
   * The cells to walk to get from `from` to `to`, first step first and excluding
   * `from` itself. Empty if the destination is the origin, outside the window,
   * blocked, or unreachable within the window.
   *
   * `isBlocked` takes axial coordinates rather than a `Vector` so the hot loop
   * allocates nothing; close over whatever else it needs, such as the plane tag.
   */
  static find (
    from: Vector,
    to: Vector,
    isBlocked: (q: number, r: number) => boolean
  ): Vector[] {
    const dq = to.x - from.x
    const dr = to.y - from.y

    if (dq === 0 && dr === 0) return []
    if ((Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 > Path.WINDOW) return []
    if (isBlocked(to.x, to.y)) return []

    const target = Path._index(dq, dr)
    const origin = Path._index(0, 0)

    Path._seen.fill(0)
    Path._seen[origin] = 1
    Path._cameFrom[origin] = -1

    Path._queue[0] = origin
    let head = 0
    let tail = 1

    while (head < tail) {
      const current = Path._queue[head++]
      if (current === target) return Path._reconstruct(from, target)

      const cq = Math.floor(current / Path.SPAN) - Path.WINDOW
      const cr = (current % Path.SPAN) - Path.WINDOW

      for (const direction of Hex.DIRECTIONS) {
        const nq = cq + direction.x
        const nr = cr + direction.y

        // The window is a disc, not the square the scratch arrays cover. The
        // corners of that square are outside it and must not be searched, or the
        // two sides stop agreeing wherever a path grazes a corner.
        if ((Math.abs(nq) + Math.abs(nr) + Math.abs(nq + nr)) / 2 > Path.WINDOW) continue

        const next = Path._index(nq, nr)
        if (Path._seen[next] === 1) continue
        if (isBlocked(from.x + nq, from.y + nr)) continue

        Path._seen[next] = 1
        Path._cameFrom[next] = current
        Path._queue[tail++] = next
      }
    }

    return []
  }

  /** Walk `_cameFrom` back from the target and hand it back start-first. */
  private static _reconstruct (from: Vector, target: number): Vector[] {
    const result: Vector[] = []

    let step = target
    while (step !== -1) {
      const q = Math.floor(step / Path.SPAN) - Path.WINDOW
      const r = (step % Path.SPAN) - Path.WINDOW
      // Drop the origin: `path[0]` is the first cell to move to, so that
      // `pathIndex` starts at 0 on a unit that has not moved yet.
      if (q !== 0 || r !== 0) result.push(new Vector(from.x + q, from.y + r))
      step = Path._cameFrom[step]
    }

    result.reverse()
    return result
  }
}
