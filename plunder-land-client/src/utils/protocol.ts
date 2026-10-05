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
 * 48-6 (seasons) needed none: a new `season` event, which older clients ignore.
 * 5: energy (#48 step 7). A start can now be refused (`start_refused`), which
 * an older client never hears: its READY would leave it on an empty screen.
 * 6: gear in the run (#49, 49-2). New field indices 25 `gear`, 26 `carried`
 * and 27 `speed`: an older client stops parsing its own player's create at
 * 26/27 (and so loses its speed, which now goes out as 27 only) and drops a
 * gear pickup's fields.
 */
export const PROTOCOL = 6
