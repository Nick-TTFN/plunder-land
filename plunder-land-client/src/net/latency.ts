/**
 * The round trip to the game server, for the HUD's latency readout.
 *
 * Every `INTERVAL_MS` the client emits `latency` with an ack; the server acks
 * at once (`Worlds.onConnection`), outside any world and any tick, so the
 * time is the network plus the server's event loop. The shown value is the
 * median of the last `KEEP` answers, so one slow packet doesn't make the
 * number jump. A server from before this event never answers: after
 * `STALE_MS` without an answer the reading is `undefined` ("--").
 *
 * Pixi-free and `window`-free: callers pass the clock and the emit in.
 */

export const INTERVAL_MS = 2000
export const TIMEOUT_MS = 4000
export const STALE_MS = 6000
export const KEEP = 5

/** Under this: green. */
export const GOOD_MS = 100
/** Under this: amber. At or over: red. */
export const FAIR_MS = 200

export type LatencyBand = 'good' | 'fair' | 'poor' | 'none'

export function bandOf (ms: number | undefined): LatencyBand {
  if (ms === undefined) return 'none'
  return ms < GOOD_MS ? 'good' : ms < FAIR_MS ? 'fair' : 'poor'
}

/** Sends a probe; calls `done(true)` on the server's answer, `done(false)` on a timeout. */
export type Probe = (done: (answered: boolean) => void) => void

export class Latency {
  private readonly _samples: number[] = []
  private _lastAnswerAt = -Infinity

  constructor (private readonly _now: () => number) {}

  /** One probe, timed from now. */
  measure (probe: Probe): void {
    const sentAt = this._now()
    probe((answered) => {
      if (!answered) return
      const at = this._now()
      this.record(at - sentAt, at)
    })
  }

  record (ms: number, at: number): void {
    this._samples.push(ms)
    if (this._samples.length > KEEP) this._samples.shift()
    this._lastAnswerAt = at
  }

  /** The median of the recent answers, rounded; undefined if none came lately. */
  get ms (): number | undefined {
    if (this._samples.length === 0 || this._now() - this._lastAnswerAt > STALE_MS) return undefined
    const sorted = [...this._samples].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    return Math.round(median)
  }

  /** After a reconnect the old answers describe another connection. */
  reset (): void {
    this._samples.length = 0
    this._lastAnswerAt = -Infinity
  }
}
