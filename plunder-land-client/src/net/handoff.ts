import { type Fog } from '../objects/fog'
import { resetForRun, type RunMap } from './runmap'

/**
 * The first run's handoff (decision #58, task retest-4), pixi-free so the
 * server's `runmap.spec.ts` can play a client through it.
 *
 * The server sends `handoff` (no payload) when the player steps on the
 * private world's pad, then, in the same ordered stream, the shared world's
 * `hello`, join snapshot and `create_own`, exactly as for a new run. Object
 * ids from the two worlds collide (each world has its own id pool), so
 * everything the client holds of the private world must go **before** any
 * record of the new one is read: `Game.onHandoff` does the per-run reset of
 * `Game.start` (objects, `LOOKUP`, the map and fog here, the local player,
 * auto-aim's target) without the lobby, without dropping the run's socket
 * handlers and without clearing the HUD.
 *
 * The run record continues (decision #58 addendum 5: one run card covers
 * intro and run): the own create that follows a handoff doesn't restart
 * `Game.RUN` (`takeOwnCreate`).
 */
export class Handoff {
  /** A handoff happened and its own create hasn't arrived yet. */
  private static _pending = false

  /** The private world goes: its map, fog and session state. */
  static begin (map: RunMap, fog: Fog): void {
    resetForRun(map, fog)
    Handoff._pending = true
  }

  /** At an own create: true (once) if it continues a run across a handoff. */
  static takeOwnCreate (): boolean {
    const pending = Handoff._pending
    Handoff._pending = false
    return pending
  }

  /** A run started from the lobby: nothing to continue. */
  static reset (): void {
    Handoff._pending = false
  }
}
