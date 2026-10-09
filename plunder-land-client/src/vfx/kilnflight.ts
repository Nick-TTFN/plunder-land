/**
 * Where a Kiln's slug is along its arc (#52 lane 2), pixi-free so the server
 * specs can run it (`windupclient.spec.ts`).
 *
 * Effect 9 arrives at the server's cast and lasts the flight (`durationMs`,
 * the server's 1250 as the wire's tenths). The Kiln now stands still from
 * the cast, and its rig plays `fire` from the start of its gather, so the
 * slug leaves at the clip's launch, `launchMs` after the effect, and flies
 * the time left: it still lands at `durationMs`, on the server's landing, and
 * the marker still shows for the whole flight (the dodge window is
 * unchanged). `launchMs` 0 is the arc as before (no clip shown).
 *
 * Returns the fraction of the flight done at `elapsedMs` after the effect,
 * 0 to 1, or undefined before the launch (the slug is still in the Kiln).
 */
export function kilnFlight (elapsedMs: number, durationMs: number, launchMs: number): number | undefined {
  const launch = Math.min(Math.max(launchMs, 0), durationMs)
  if (elapsedMs < launch) return undefined
  const flight = durationMs - launch
  if (flight <= 0) return 1
  return Math.min(1, (elapsedMs - launch) / flight)
}
