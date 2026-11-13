import { callsign } from '../utils/callsign'
import type { Connection } from './multiplayer'

/**
 * The name a human's run is shown under, to everyone, its own client
 * included (decision #62, g2-9): **the one place a human's name is chosen**.
 * Nobody types a name, and the server ignores any `name` a client still sends
 * (`Multiplayer.parseStart` drops it; an old tab keeps sending one), so today
 * this is the id's callsign for everyone. `Multiplayer.startRequested` calls
 * it; the `Player` constructor runs the result through `Player.displayName`
 * as a backstop.
 *
 * g2-6b extends it with the CrazyGames username a verified portal token on
 * `connection` carries (Nick, 2026-11-14: a CG player shows their CG name),
 * checked by `Player.sanitiseName` and falling back to the callsign on a hit.
 * Bots don't come here: `BotFill.spawn` draws each a callsign of its own.
 *
 * Its own module, not a static on `Player`: `multiplayer.ts` imports `Player`
 * as a type only, and a value import there changes the module load order so
 * that `Mob extends Unit` runs before `Unit` exists (every spec fails to
 * load). Whatever g2-6b imports here must not bring that import back.
 */
export function displayNameFor (playerId: string, connection?: Connection): string {
  void connection
  return callsign(playerId)
}
