import { callsign } from '../utils/callsign'
import type { Connection } from './multiplayer'

/**
 * The name a human's run is shown under, to everyone, its own client
 * included (decision #62, g2-9): **the one place a human's name is chosen**.
 * Nobody types a name, and the server ignores any `name` a client still sends
 * (`Multiplayer.parseStart` drops it; an old tab keeps sending one), so today
 * it is the id's callsign unless g2-6b below applies. `Multiplayer.startRequested` calls
 * it; the `Player` constructor runs the result through `Player.displayName`
 * as a backstop.
 *
 * g2-6b: a connection with a verified CrazyGames token (`Worlds`, through
 * `setPortalName`) is shown under the token's `username` (Nick Q1,
 * 2026-11-14: a logged-in CG player shows their CG name). Only a username
 * with CrazyGames' documented shape (`CG_USERNAME_SHAPE`, network/
 * portaltoken.ts) gets here; it is then checked by `Player.sanitiseName` in
 * the `Player` constructor (`Player.displayName`), which gives the callsign on
 * a hit (profanity, a reserved name) and cuts it to `Player.NAME_MAX`. That
 * backstop **is** the filter for CG names, so it must stay
 * (names.spec.ts pins it). Everyone else, and bots, keep the callsign.
 * Bots don't come here: `BotFill.spawn` draws each a callsign of its own.
 *
 * Its own module, not a static on `Player`: `multiplayer.ts` imports `Player`
 * as a type only, and a value import there changes the module load order so
 * that `Mob extends Unit` runs before `Unit` exists (every spec fails to
 * load). Whatever is imported here must not bring that import back, which is
 * why the filter runs in the constructor rather than here.
 */
export function displayNameFor (playerId: string, connection?: Connection): string {
  const portal = connection === undefined ? undefined : portalNames.get(connection)
  return portal ?? callsign(playerId)
}

/** The verified portal username of each connection that has one. Gone with the connection. */
const portalNames = new WeakMap<Connection, string>()

/**
 * Show the connection's runs under `username` (a verified token's, already
 * `CG_USERNAME_SHAPE`), or under the callsign again with undefined. Taken
 * from each new token, so a changed CG username shows on the next connection.
 */
export function setPortalName (connection: Connection, username: string | undefined): void {
  if (username === undefined) portalNames.delete(connection)
  else portalNames.set(connection, username)
}
