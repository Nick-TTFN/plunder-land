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
 */
export const PROTOCOL = 1
