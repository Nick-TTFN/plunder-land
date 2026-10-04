/**
 * The wire protocol's version, byte-identical in both packages (mirror.spec.ts).
 *
 * The server sends it in `welcome`, the first thing on every connection, before
 * any run. A client whose own number differs reloads the page to fetch the
 * client that matches (`plunder-land-client/src/net/protocol.ts`), at the
 * lobby, never mid-run. A server from before it sends no `welcome`, and the
 * client takes that as a match.
 *
 * **Bump it with any change an older client can't read**: a new field index or
 * event an old client would choke on, a changed record layout, a reordered
 * table. Additive changes an old client already skips (a new `hello` key) need
 * no bump. The client still ships first; this catches the tabs left open
 * across a release, which "client first" can't.
 *
 * 2: guest accounts and server fog (#48 steps 1-3). 3: skill loadouts (#48
 * step 4). An older client sends the `skill` slot as an index into the old
 * eight, which this server reads as an index into the player's 4: Q, W and E
 * would still work with the start kit, but R would fire whatever is in slot 3
 * and T to I would do nothing. That silent misbehaviour is why it is bumped.
 * 4: robot and finish locks (#48 step 5). An older client offers every robot
 * and finish; this server plays a locked one as Peep or the group's default
 * without saying so.
 */
export const PROTOCOL = 4
