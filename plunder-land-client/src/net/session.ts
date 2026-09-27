import { Hex } from '../utils/hex'

/**
 * Everything the client would otherwise have to hardcode about the server.
 *
 * Two separate things live here and they are deliberately not the same number:
 * what the server *says* its cadence is (`tickMs`, from the `hello` payload),
 * and what this connection is *actually* delivering (`arrivalP95`, measured).
 * Interpolation is timed off the measured value, because a server ticking every
 * 250 ms down a link that clumps packets into 400 ms bursts is a 400 ms problem.
 */
export class Session {
  /** Server-advertised tick length. Replaced the moment `hello` lands. */
  static tickMs: number = 250
  static mapSize: number = 4000
  static interestRadius: number = 500
  /**
   * Every ground layer's tag, top (layer 01) first, from `hello.layers`. The
   * default is what a server from before three layers ships (and sends no
   * `layers` for): 0 above -1.
   */
  static layers: number[] = [0, -1]
  /**
   * Each layer's void cells (the valleys), as `Hex.key`s, in `layers` order,
   * from `hello.voids`. Empty for a server from before the valleys.
   */
  static voids: Array<Set<number>> = []
  static known: boolean = false

  /** Rolling window of observed gaps between update packets, in ms. */
  private static readonly _gaps: number[] = []
  private static _lastArrival: number = 0
  private static _p95: number = 250

  static onHello (data: { tick?: number, map?: number, interest?: number, layers?: unknown, voids?: unknown }): void {
    if (typeof data?.tick === 'number' && data.tick > 0) Session.tickMs = data.tick
    if (typeof data?.map === 'number' && data.map > 0) Session.mapSize = data.map
    if (typeof data?.interest === 'number' && data.interest > 0) Session.interestRadius = data.interest
    // Tags are signed bytes on the wire, and a layer list with a repeat would
    // map two layers to one plane. Anything else, including no list at all,
    // is read as a server from before three layers.
    const layers = data?.layers
    Session.layers = (
      Array.isArray(layers) && layers.length > 0 &&
      layers.every((t) => Number.isInteger(t) && t >= -128 && t <= 127) &&
      new Set(layers).size === layers.length
    )
      ? layers as number[]
      : [0, -1]
    const voids = data?.voids
    Session.voids = Session.layers.map((_, i) =>
      Array.isArray(voids) ? Session.decodeRuns(voids[i], Session.mapSize) : new Set<number>())
    Session.known = true

    // Seed the measurement so the first second of play is not timed off a guess.
    if (Session._gaps.length === 0) Session._p95 = Session.tickMs
  }

  /**
   * `hello.voids[i]`: alternating free and void run lengths over
   * `Hex.mapCells(size)` (the server's `encodeRuns`, valleys.ts), starting
   * with a free run. Anything malformed, or runs that don't cover the map
   * exactly, reads as no valleys: the server still blocks them, so the worst
   * case is routes that it corrects.
   */
  static decodeRuns (runs: unknown, size: number): Set<number> {
    const out = new Set<number>()
    if (!Array.isArray(runs) || !runs.every((n) => Number.isInteger(n) && n >= 0)) return out
    const cells = Hex.mapCells(size)
    if ((runs as number[]).reduce((a, b) => a + b, 0) !== cells.length) return out
    let i = 0
    ;(runs as number[]).forEach((length, n) => {
      for (let j = 0; j < length; j++, i++) if (n % 2 === 1) out.add(Hex.key(cells[i].x, cells[i].y))
    })
    return out
  }

  /** A layer's number as players see it, 1 for the top layer; undefined for an unknown tag. */
  static layerNumber (tag: number | undefined): number | undefined {
    const index = tag === undefined ? -1 : Session.layers.indexOf(tag)
    return index < 0 ? undefined : index + 1
  }

  /** Called once per received update packet. */
  static onPacket (now: number): void {
    if (Session._lastArrival > 0) {
      const gap = now - Session._lastArrival
      // Ignore absurd gaps: a backgrounded tab is not a network measurement.
      if (gap > 0 && gap < 5000) {
        Session._gaps.push(gap)
        if (Session._gaps.length > 48) Session._gaps.shift()
        Session._recompute()
      }
    }
    Session._lastArrival = now
  }

  private static _recompute (): void {
    const sorted = [...Session._gaps].sort((a, b) => a - b)
    Session._p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  }

  static get arrivalP95 (): number {
    return Session._p95
  }

  /**
   * How far behind live to render remote units. One whole worst-case gap plus a
   * margin, so the buffer still has a state to interpolate towards when a packet
   * arrives late rather than falling through to extrapolation on every hiccup.
   */
  static get interpolationDelay (): number {
    const d = Session._p95 * 1.15 + 15
    return d < 60 ? 60 : d > 500 ? 500 : d
  }

  /** How long a unit may be dead-reckoned past its last known state. */
  static get extrapolationCap (): number {
    const cap = Session._p95 * 0.6
    return cap > 150 ? 150 : cap
  }

  /** A unit unheard from for this long is stale and gets hidden. */
  static get stalenessLimit (): number {
    return Math.max(1000, Session._p95 * 6)
  }

  static reset (): void {
    Session._gaps.length = 0
    Session._lastArrival = 0
  }
}
