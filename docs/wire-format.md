# Wire format

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Wire format

Server → client messages (`create`, `create_own`, `update`, `destroy`, `effect`,
`standings`) are binary. Each event is **one** buffer containing length-prefixed records.

**`standings`** goes out every 3 s (`Multiplayer.STANDINGS_INTERVAL_MS`, #38; it was 1 s)
(every `round(3000 / tick)` flushes, no timer),
**and only when the connection's buffer differs from the last one it was sent**
(`Connection.lastStandings`, cleared by `attach` so a new run always gets it; server-cpu-trim).
Each connection gets the top 10 rows of the board (`Multiplayer.STANDINGS_TOP`) plus its own
row, appended, when it is not among them (decision #30). The board is ranked once per send
(`Multiplayer.rankStandings`); `StandingsBoard.bufferFor` hands every connection in the top 10
the same buffer and appends the own row, found by player object, for the rest. The board is
every player plus the recently finished, ranked on the server by carried loot, ties by id;
finished rows rank by their loot and can hold top-10 places. A record is
`[uint16 id][uint8 status][uint32 loot][UTF-8 name][0][uint16 rank][uint8 flags]`, rank 1-based on the whole
board (ties get distinct ranks in id order), because the appended own row is not at its rank's
position. Flags (decision #47): bit 0 a bot; a client from before it ignores the byte. Status is 0 ACTIVE, 1 EXTRACTED, 2 DEAD (a disconnect counts as DEAD). The enum is
`Standing` in `world.ts`, copied by hand on the client in `src/ui/components/standings.ts`
(pixi-free, with the decoder and `pickShown`; `standings.spec.ts` runs them against the
server's bytes), and append-only. Finished players linger 10 s in `World.FINISHED`, capped at
64. The client finds its own row by id while it's ACTIVE (ids are recycled after a player
leaves), so the DEAD/EXTRACTED own row sent on the tick a run ends is not highlighted. The
client reads the rank when two bytes follow the NUL and otherwise ranks by position (a server
from before the rank); an older client stops at the NUL and ranks by position, so it would show
the appended own row as 11th. **Ship the client first.** Fields after the rank are for later
additions. Measured 2026-09-26 at 1 s: about 0.19 KB/s per client at both 100 and 400 players.

**WebSocket compression is on** (permessage-deflate, `src/index.ts`, #38): windowBits 12,
memLevel 4 (about 140 KB of RSS per connection once it has sent anything, measured 2026-09-27; 24 KB before its first write), threshold 32 bytes (engine.io's own
default of 1024 is above nearly every message). `WS_DEFLATE=0` in the environment turns it off
without a build; ws warns that zlib under concurrency can fragment memory on Linux, so watch RSS
after a deploy. Browsers negotiate it with no client change. The load harness's per-client
KB/s is decompressed payload; `sockKBPerTick` (spans, `--detail 1`) is what left the socket.

The other events' records are laid out like this:

```
[uint16 length][record bytes][uint16 length][record bytes]...
```

Pack: `Multiplayer.packRecords` (server). Unpack: `Game.unpackRecords` (client).

**One frame per tick (server-cpu-trim, 2026-09-26).** socket.io sends every binary event as
two WebSocket frames (a text placeholder, then the buffer), and a connection got up to five
binary events a tick; every frame is a socket write, and sending was the biggest single CPU
cost on the server. A client that connects with query `frames=1` is sent `frames: 1` in
`hello`, and from then on **one engine.io message per flush** (`socket.conn.write`, no
socket.io events at all after `hello`):

```
[uint8 version = 1][uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]
then sections to the end: [uint8 kind][uint32 length][payload]
kinds: 1 create, 2 create_own, 3 effect, 4 destroy, 5 standings, 6 update
```

Each payload is byte for byte the buffer that event carries unframed (the update section
without the header, which is the frame's). Sections go in the order the events always went
out; an empty one is left out. Pack: `Multiplayer.packFrame`. The client's
`src/net/framedparser.ts` is a socket.io `parser` whose decoder turns each frame back into
those events (`update` always last, the header alone when there are no records), so no game
handler knows the difference. It decodes normally until a `hello` with `frames: 1`, and again
after a disconnect, so a new client works against an old server, and an old client never asks
and gets the events as before. **Kinds and the version are append-only.** `frame.spec.ts`
checks framed against unframed flushes of the same outbox and that both kind tables agree;
`interest.framed.spec.ts` runs every interest test again over frames through the client's
decoder. `tools/load/loadbot.mjs` has its own JS copy of the decoder. **Ship the client
first** is not needed here (the flag is the negotiation), but the client must be deployed for
any player to get the saving. Client → server messages are still socket.io events, two frames
each for the binary ones (`pointer`, `skill`, `use_item`); that is the next thing to frame.

**The `update` event additionally carries an 8-byte header before the records:**

```
[uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]
```

and it is emitted **every tick for every connection with a player, even when it holds no
records**, because that header is the client's clock and its input acknowledgement. Split
it with `Game.splitRecords(buffer, 8)`; `unpackRecords` is the headerless form used by the
other four events.

**Who gets what (decision #35, interest-filtered-broadcasts; #38; server fog #48, shipped
2026-10-03).** Terrain (portals, exits and any untimed obstacle: `Multiplayer.isTerrain`; the
valleys and walls go in `hello`) goes to every connection on its layer, whatever the distance:
the client routes the whole layer. **StoneWall stones are not terrain since #38** and are
**fogged like pickups since #48** (Nick, 2026-10-03): brought into and out of view like
pickups, because layer-wide they were 41-52% of every client's bandwidth. A client
can route through a stone it hasn't been sent; the server corrects it and the client re-routes
when the stone arrives (`Game.block`). **Units, pickups, projectiles and stones go only to
connections whose client is on their layer (`Connection.layer`) and whose viewpoint sees them**
(`Multiplayer.viewOf`), counted in hex rings from the cell under the viewpoint's centre to the
cell under the object's: a `create` once within the robot's `vision` + `VIEW_MARGIN_RINGS` (1)
rings (from `Multiplayer.update`, whichever side moved, for units and projectiles), deltas while held, and a destroy with only `id` once
beyond `VIEW_EXIT_RINGS` (1) more, or off the layer. Peep and the other vision-6 robots: in at 7,
out beyond 8; Periscope (vision 10): in at 11, out beyond 12. So a modified client can know at most
`vision` + 2 rings (accepted by Nick, 2026-10-03). **Pickups and stones never move, so they come into and out of a
view only when its viewpoint changes cell** (`Multiplayer.pickupViews`, from `World.pickupPass` at
the end of `World.update`, pickup-pass 2026-10-04): a connection whose viewpoint is on the cell
where the pass last left it is skipped; after a move of one or two rings it looks only at the outer
rings round its new cell and at what it holds; anything else (first pass, layer change, new
viewpoint, a longer move, no vision) walks the lists. A pickup or stone that is new since the last
pass, or dirty, gets its own `update` first. `pickuppass.spec.ts` holds it to the old rule: after
every pass, every pickup's `update` queues nothing and changes no holder. The pass cost
0.47-0.56 ms a tick at 400 players before, about 0.2 after (tickbench, mixed robots). The viewpoint is `Multiplayer.viewpoint`:
the watched player for a spectator, who sees by that robot's vision, not its own dead robot's.
A viewpoint with no `vision` (none today) falls back to the old box: strictly inside
`INTEREST_RADIUS` (500), out beyond `+ EXIT_MARGIN` (2 cells). Who holds what is
`Connection.known` / `GameObject.knownBy`; updates and destroys go to exactly the holders.
Nothing is sent about an object after its destroy (`Multiplayer.gone`): a create after a
destroy in one flush is applied create first by the client and leaves a ghost. For the same
reason **an object that leaves a view and re-enters it within one flush** (a view re-centred
by `watch` or a layer change) has its destroy taken back and goes as a whole update
(`Multiplayer.enter` / `leave`, `06194a7`). A layer change swaps the client at the player's
own next update (`switchLayer`, which keeps what is within the leave radius), in the flush with
its new tag. The join snapshot is the layer's terrain plus what is in view. **Candidates come
from `World.INTEREST`**, per layer, in square buckets of `World.INTEREST_BUCKET`, derived (not
written down) from the largest robot vision in the mirrored `utils/archetypes.ts`:
max(`INTEREST_RADIUS`, (vision + 3) × `Hex.SIZE`) = 585 with Periscope's 10 (630 at 11, until 2026-10-03), so the 3 × 3
buckets cover the largest leave reach (`interest.spec.ts` checks it with random off-centre
positions). `hello.interest` is still `INTEREST_RADIUS`; the client's `stillPresent` no longer uses it for a
robot with vision but sizes by vision from the viewpoint it follows (see "Liveness is not a
heartbeat"). That closed two gaps found 2026-10-03 (`19afb95`): a silent unit at Periscope's
east-west edge was hidden though held, and a spectator hid every silent unit (since #47).
**Effects** (#48 follow-ups, `0a0b2d9`): **types 0-4** (breaths, melee, ranged, defend) are
drawn on their originator, so `Multiplayer.effect` sends them to exactly the connections that
hold it (`knownBy`: its own, those who see it and their spectators), skipping a connection
whose viewpoint died this tick and hasn't been re-centred yet. Under fog the 500 box had sent about
half of them to clients that dropped them unread (`Game.EFFECTS_UNHELD`, now near 0). **Types
5-8** (fireball and icicle blasts, bomb fuse and blast) are drawn on a cell and go through
`Multiplayer.effectAt` (`sendAt`) to connections on the effect's layer with the cell's centre
inside the 500 box around their viewpoint or within its leave radius (which reaches past the
box only for Periscope: 12 rings at vision 10 is up to 540 units east-west). **Fireball and icicle blasts go on the
projectile's layer**, not the thrower's (`63d8947`): a thrower who hopped a portal during the
flight used to send the blast to the wrong layer. Effects are not fogged inside the 500 box
(#48 rejected hiding them; Nick accepted): a blast or bomb in the dark is sent and drawn.
`changedAt`/`seen` and `pendingObjectIDs` are gone. Measured 2026-10-03 (`tools/load/`, Peep
bots): per-client bytes 36-40% lower at 100 and 400 players (about 270-410 B/s decompressed,
from 430-700), update records 55-63% fewer; Periscope bots only 10% lower. `Multiplayer.update`
cost 31% more (tickbench, 400 players: the whole tick 3.25 to 3.86 ms) from the wider buckets;
whether sending saves more than that is not measured.

`ackElapsedMs` is how long the server has been applying `lastInputSeq`. It exists because
the sequence number alone does not say how far *into* an input the server has got, and
without it every reconciliation drags the player backwards by a fraction of a tick. A
control run with the field forced to zero doubled the median correction (2.00 vs 1.00
units) and introduced a systematic backward bias.

**Client → server `pointer` is the route's waypoint cells:** `[uint8 count][int16 q][int16 r]
× count[uint16 seq]`, big-endian. It is sampled once per server tick, not per pointer event,
and **sent only when the route changed** since the last send (`LocalPlayer.sample`,
server-cpu-trim 2026-09-26). It used to go every tick "so a dropped one costs nothing", but a
WebSocket drops nothing, nothing reads the ack, and receiving the repeats was most of the
server's input cost. A run's first sample always goes (`LocalPlayer.reset`), and the server
forgets the last route when a player joins on a connection (`Multiplayer.attach`); without
both, a repeat of the previous run's route would read as no change. An older client that still
repeats is harmless (`sameCells`). The server ignores a buffer shorter than its own count says
(`Multiplayer.onPointer`). (It was a 4-byte direction before click-to-move routed along hex
centres.)

**Client → server `skill` is 5 bytes:** `[uint8 slot][int16 q][int16 r]`, **big-endian**; the slot is an index into the player's 4 (`hello.skills`), and an empty slot or 4-7 runs nothing,
where (q, r) is the **absolute** axial cell aimed at (decision #21). Not an offset from the
player: the predicting client and the server can disagree about the player's cell by one,
and an offset would then land a cell off. The server takes the offset from its own position.
A **bare number** (the original JSON form) is still accepted and means the slot with no
aim; anything else, including a buffer under 5 bytes or a slot that is not a whole number
in range, is ignored (`Multiplayer.parseSkill`, `Player.tryExecuteSkill`). The client sends
the cell under the desktop mouse (`src/skills/aim.ts`), or a bare number when the mouse is
off the map, on the HUD, on the player's own cell, or the input is touch. No aim, or an
aim at the caster's own cell, fires along `facing`. Fireball and icicle fly the hex line through the aimed cell, like ranged, for 10 cells. Ranged walks a hex line of cells toward the
aimed cell (see "Every area of effect" under Skills). Breaths snap the aim to one of
six and **hold** it for their lifetime (`SectorArea.fixedDirection`), while an unaimed breath
still follows facing. Dash, StoneWall, Melee and Defend ignore the aim. Mobs aim at their
target's cell (`UseSkillOnTarget`).

**`effect` records are `[int8 type][uint16 id][int8 lifetime / 100]`, plus `[int16 q][int16 r]`
(big-endian) only when the effect was aimed.** The record's length prefix says which: 4 bytes
unaimed, 8 aimed. The cell is where the effect points: the aimed cell for a ranged shot
(type 3), the cone's tip for a breath (types 0 and 1: `rings` cells straight out from the
caster's cell along the held direction, `SectorArea.tipCell`). The tip rather than the raw aim
because the client can place the caster a cell off; one cell sideways at 3 rings turns the
vector under 20 degrees, so snapping from the client's own view of the caster still lands on
the server's direction. **Types 5 and 6 are the fireball and icicle blasts**, always aimed:
their cell is the blast's centre (the struck unit's cell, or the last cell of its line if it
struck nobody). The client can't work that out for itself, because the destroy record carries no
position and its last known position is a tick behind the hit. Effects draw the cells the
server damages; the client's port of the cone and ring logic is `src/vfx/cells.ts`, and
`effectcells.spec.ts` checks it against the server's.

`maxHp` is sent per unit so the client does not have to infer a health bar's scale from the
first hp value it happens to see. **The field table is append-only** — new fields go on the
end of `fieldOrder` (server) and `allFields` (client), and the two must stay identical.

**`welcome`** is emitted on every connection, before anything else: `{ protocol }`, the
mirrored `utils/protocol.ts` `PROTOCOL` (decision #46). A client whose own number differs
reloads the page at the lobby (`net/protocol.ts`; retries every 20 s, at most 6 times per
number, while the matching client deploys). **Bump `PROTOCOL` with any change an older client
can't read**, or (as in #48) one an older client would silently misbehave against; additive
ones it already skips need none. Ship the client first all the same: the number only rescues
tabs left open across a release. **`PROTOCOL` is 6 since gear** (#49, 49-2, live 2026-10-05: field indices 25-27; an older client stops parsing its own player's create at 26 or 27, losing its speed, which now goes out as 27 only, and drops a gear pickup's fields); 5 was energy (#48 step 7, 2026-10-04: a start can be refused with `start_refused`, which an older client never hears, so its READY would leave it on an empty screen); 4 was robot and finish locks (an older client offers every robot and finish, which the server would silently replace); 3 was skill loadouts (an older client sends the `skill` slot as an index into eight), 2 guest accounts.

**`account`** (server → client, text; framed clients decode text events; #48): `{ id }` on
connect for a known handshake token, `{ id, token }` on a connection's first play without one
(before that run's `hello`), `{ id, offline: true }` when the account store failed. The client
sends the handshake `auth: { token }`, which the server checks against `TOKEN_SHAPE`
(`/^[A-Za-z0-9_-]{43}$/`, `db/accounts.ts`, copied by hand in the client's `net/account.ts`);
anything else is no token. Additive both ways. See Accounts. A persisted account's `account`
also carries its standing, `xp, level, levelAt, nextAt` (#48 step 3).

**`progress`** (server → client, text, #48 step 3): `{ gained, xp, level, levelAt, nextAt,
levelUp }` once a run's grant is written, a database round trip after the run's end (sometimes
before its own destroy reaches the client). Never sent after the next run's `hello` (`Worlds.grant` checks `connection.player`), so the client puts it on `Game.RUN`; then the new standing goes as a mid-run `account { id, xp, level, levelAt, nextAt }` instead, which moves only the lobby badge; the run card's
XP row says UNAVAILABLE after `PROGRESS_WAIT_MS` (6 s) without it, at once offline. Additive, no
PROTOCOL bump; until the server has it, every card says UNAVAILABLE.

**`energy`** (server → client, JSON, #48 step 7): `{ stock, cap, nextInMs, regenMs }`
(`nextInMs` relative, null at or above the cap), after each spend (the run began) and each refund;
also `account.energy` on connect and creation (not on the grant's mid-run `account`). **`start_refused
{ reason: 'energy', energy }`**: no play left; no run began, the connection is free to ask again,
and the client goes back to the lobby (`Game.onStartRefused`). An offline account is sent neither
(it plays free). See "Energy".

**`season`** (server → client, JSON, #48 step 6): `SeasonView` after `account` for a persisted account and after each grant; additive, no PROTOCOL bump (older clients have no handler). **`GET /season`**: see "Weekly seasons".

**`stash`** (server → client, JSON, #49, 49-4): `{ items: [{ id, tier, skill, rolls: [[stat, q], …] }],
away, run? }` (`gear/stash.ts` `stashEvent`). `items` are the stashed rows in row id order (`id` a
decimal string, `skill` 0 a part, `stat` a `GEAR_STATS` id, `q` 0-1000); `away` counts rows carried
right now (this run, another tab, or awaiting a stale return). Sent after every `account` of a
persisted account (through `loadStash`, which runs the stale return first), after a start that
carried anything, after a merge or scrap, and after an extraction's or cut-off's settle **with `run`
`{ kept, full }`** (rows now in the stash from this run, moved plus inserted; found items the store
turned away: the `STASH_MAX` ceiling, or one it can't store). Never to an offline account, after a
death, for a bot, or after a settle that failed or timed out. The client clears its view on every
connect. Additive, no PROTOCOL bump.

**`merge { ids: [a, b, c], keep? }`** → **`merged { ok, item?, reason? }`** and **`scrap { id }`** →
**`scrapped { id, ok, reason? }`** (client → server and back, JSON, #49, 49-5; `Worlds.merge` /
`scrap`). `ids` are 3 distinct stash row ids; `keep` is one of the skill-item inputs (absent or null:
the first skill item in `ids` order; with parts only it must be absent). `item` is in the `stash`
item shape. `scrapped.id` echoes what was sent, cut to 20 characters, or null. Reasons: `busy` (a
merge or scrap of this connection is in flight, or its start is: nothing written, no `stash`
follows), `invalid` (malformed, no account yet, or the store refused: a row missing, carried or
another account's, mixed tiers, a T3 merge with a skill item, a bad keep), `store` (offline, no
stash store, or the store failed or took over 3 s; a fresh `stash` is asked for). After `ok` or a
store-side `invalid` the same transaction's `stash` follows, without `run`. A merge the timeout gave
up on may still land: a retry of the same ids is then `invalid`, never doubled. Allowed in the lobby
and mid-run (only stashed rows are touched); persisted accounts only. Additive.

**`save_loadout { robot, index, skills }`** (client → server, text, in the lobby or mid-run, effective
at the next join) is answered by **`loadout_saved { robot, index, ok, skills, busy? }`**. Refused
unless the account is persisted, the robot selectable and unlocked at the account's level, the index one the level has and
`checkLoadout` passes; a refusal or failure answers with `kitFor`'s current answer so the lobby
snaps back. One write in flight per connection (a second meanwhile answers `busy`); the account in
memory changes only after the write resolves; one landing after the 3 s timeout is stored but
answered `ok: false` (the next connection reads it). READY waits up to 4 s for a save in flight.
The client applies every `loadout_saved` to its account in `index.ts`, so a late one still counts
after the lobby is gone; the LOADOUT panel is read-only until the account carries `loadouts`. A
persisted account's `account` carries `loadouts` (`loadoutsFor`: every robot, the level's loadouts,
each as a join would play it); the grant's mid-run `account` carries none and the client keeps the
last for that id.

**A server stops by draining** (decision #46, `Worlds.drain`, `index.ts`). On SIGTERM it takes
no new runs: lobby connections are sent on at once, a run card's when it asks for its next run,
a connection arriving later at once. "Sent on" is closing the transport (`Worlds.redirect`,
`socket.conn.close()`), never `socket.disconnect()`, after which a client does not reconnect.
Live runs play out; it stops when none is left or at `DRAIN_MAX_MS` (default 570 s, inside
Railway's 600 s `drainingSeconds`), and waits for the disconnects' stats writes before quitting
Redis. SIGINT is still an immediate stop.

**Burst capacity** (2026-10-04, `burst-capacity`, both off by default). **`WORKERS`** > 1:
`src/cluster.ts` forks that many servers on the one port (websocket-only, so no sticky sessions);
one that exits is re-forked (after 5 s if it lived under 10 s); SIGTERM reaches every worker, each
drains as above, and the primary exits after the last. `WORLD_CAP`, `MAX_PLAYERS` and `/stats`'
cache are per worker. **`MAX_PLAYERS`**: humans in runs per process (bots don't count); a start
over it is sent **`full { retryMs: 2000 }`** and its transport closed (as `redirect`), before the
account or the play, so nothing is spent. Soft by the starts already waiting on the database. The
client (`net/full.ts`) shows SERVER FULL · RETRYING IN Ns by READY and presses READY itself after
doubling backoff from 1 s to 15 s (never under `retryMs`, +-30% jitter); `hello` or its cross
clears it. An older client just lands back in the lobby: no PROTOCOL bump. The cap's value needs a
load test on Railway.

**`hello`** is emitted once on join: `{ tick, map, interest, layers, skills }`; `skills` is the run's 4 skill ids, Q W E R, as the server resolved them (#48 step 4), and the client resets `Session.skills` on every hello. Nothing on the client
may hardcode these — see `src/net/session.ts`. `layers` is every layer's tag, top (01) first;
the client builds one plane per entry when `hello` lands (it precedes the join's first
flush) and labels a portal "LAYER 0N" by its `to`'s position in the list. A `hello` without
`layers` (a server from before three layers) means `[0, -1]`. **Ship the client first**:
an older client hardcodes `[-1, 0, 1]` and has nowhere to draw tag -2.

**Invites** (decision #47): `start_requested` may carry `party`, a 6-12 character code of
`[0-9a-z]` (`Multiplayer.PARTY_SHAPE`; anything else is dropped). The server puts that run in the
world of a human in a run with the same code, if it is under the cap, else fill-first
(`Worlds.choose`). Every browser has its own random code (`plunderland_party`, never the player
id); the lobby's INVITE copies `?join=<code>&from=<name>`, and a tab opened from it sends the
inviter's code (sessionStorage `plunderland_join`; `ui/lobby/party.ts`, pixi-free and run by
`party.spec.ts`). Free-for-all all the same. Additive: an old server ignores it.

**Client → server `start_requested` is `{ id, name, finish, robot, party, loadout, bring }`** (`loadout` the robot's loadout index, raw; `kitFor` checks it; absent = 0) (`bring`, #49: up to 2 stash row ids as decimal strings, entry 0 for key 3 and entry 1 for key 4, so `[null, "7"]` brings row 7 into key 4; junk, repeats and entries past 2 are empty slots (`gear/stash.ts` `parseBring`); ignored offline, below `BRING_LEVEL` 3 and before the server's gear ledger has heartbeated; a row that doesn't come back, merged or already carried by another tab, leaves its slot empty; never refuses a join; the client sends it only when something is picked) (`robot` the picked
robot's key; anything not selectable, or not yet opened by the account's level, plays Peep with Peep's loadout; a locked colour or pattern plays as the group's default; never refused; no account (non-strict specs only) has no locks, an offline account has level 1's; until the lobby, the client sends `?robot=` or
`peep`) (`Multiplayer.parseStart`;
`finish` is the robot's finish as bytes, see `finish` (23), and anything unreadable in it becomes
the default, never a refused join; a client from before finishes sends none; `party`, see
Invites). The bare-string form is gone (#48). **`id` is ignored**: the player id is the
connection's account's `publicId` (see Accounts). The client still sends its old `genRanHex(6)`
id for one release, because an older server refuses a start without one, and drops it after
(`Lobby.loadId`). `Multiplayer.ID_SHAPE` (`/^[0-9a-f]{6,32}$/`) stays the guard on Redis keys:
every issued id is checked against it (`Worlds.setAccount`), and one that fails plays offline.
Without an account `startRequested` falls back to the start's `id` only while `World.strict` is
off (single-world specs joining through `Multiplayer.onConnect`; they must use hex ids);
production and every `Worlds` spec ignore such a start. **Redis stats are keyed by id, never
by name**.
The raw name is cut to `Player.NAME_RAW_MAX` (256 UTF-16 units) first, so a huge name costs
nothing, and then sanitised by `Player.sanitiseName`: NFKC, no control, zero-width, bidi, private-use
or blank-looking characters, no `< > & " '` or backtick, at most 16 code points, and "YOU" is
reserved (every client labels its own robot YOU). An empty result becomes a callsign hashed
from the player id (`Player.callsign`, for example `ROOK-42`), so a returning player keeps it. It travels
in the existing `name` field, NUL-terminated UTF-8.

Each record is a sequence of `[field index][payload]`, indexed into `GameObject.fieldOrder`
(server) / `allFields` (client). **These two tables must stay identical and are
append-only** — an index is a consumed boundary, so never reorder or remove one.
`fieldtable.spec.ts` enforces that they're identical. **A new field index breaks old clients**:
an old client stops parsing a record at an index it doesn't know, and fields are written
in dirty order, not table order, so it can lose a position update in the same record.
Ship the client before, or together with, the server.

`direction` has a serialiser case on the server but is **not** in `fieldOrder`, so
`indexOf` returns -1 and it would encode as key index 255, which the client (with no case
for it) reads as an unknown index and stops parsing the record. It is unreachable because
`dirtyFields.add('direction')` is commented out in `gameobject.ts`. Add it to `fieldOrder`
and `allFields` before ever re-enabling it. (`impulse` had the same, plus a client decoder
case; both went in hex-cells P4 with Dash's decaying velocity boost.)

**`Unit.facing` is the fallback aim and the "behind" reference.**
Aimed skills use the clicked cell (see `skill` above). Without an aim they use `facing`, and
Dash and StoneWall always do. `stop()` zeroes `direction`, so anything reading `direction`
fired at the caster's own feet once they stood still. `facing` is the last non-zero heading
(unit length, East until the unit first moves), kept current by `Unit`'s `direction` setter
and set by `walkPath` and `step` for each segment walked, so a walk ends facing along its last
centre-to-centre step. The client's `LocalPlayer.facingIndex` tracks it the same way, which
is what sends a standing dash the same way on both sides.
On the wire it is field `facing` (index 13): the `World.FACING_INDEX` of the vector, one byte,
0-5, marked dirty only when that index changes, so a unit walking straight sends nothing.
Remote sprites at rest face it.

**`armor` (14) and `maxArmor` (15)** are uint16, like `hp`/`maxHp`, and are sent only by
units that have an armor pool (players today). The client reads a missing field as 0. Damage
goes Defend → armor → hp (`Unit.hit`). The pool refills at the archetype's rate once its delay
has passed since the last hit that did damage (`Unit.refillArmor`). **Don't declare an `armor`
field on `Unit` or any subclass**: it would shadow `GameObject`'s accessor, and armor changes
would silently never be sent. The server typecheck (TS2610) catches it; swc alone does not.

**`archetype` (16)** is a uint8 id, sent in every unit's create and never as a delta: peep 1,
periscope 2, magnet 3, hopper 4, waddle 5 (both since 2026-10-01), grunt 6, boss 7, gunner 8, with 0 meaning never sent. **Ids are append-only**, like field
indices. They live in the byte-mirrored `utils/archetypes.ts`, together with kind, the Hopper
flag, vision and `rangedCells`, the RangedAttack range the client draws a beam at (unknown
id: players 6, mobs 6; players were 8 before #43). The client picks a sprite by id (`src/objects/archetypesprites.ts`) and
falls back to today's sprite for an unknown id. An object that comes into a
connection's range is sent a `create`. A whole record can still arrive in `update` when a
layer change keeps an object the client already holds (`switchLayer`).

**Extraction is a channel, and exits are zones.** A player whose centre is on an exit's cell
counts down that layer's `LAYERS.extractMs` (5 / 7 / 9 s). The check runs each tick at the
top of `Player.update` (`channelExtract`). Stepping off cancels it, and so does any hit that
lowers hp + armor (a hit that Defend floors to 0 doesn't). Finishing calls `player.exit()`,
and an exited player can't be hit. **Nothing is solid since hex-cells P2:** a player walks onto an exit's cell, and a mob never
steps onto one (`World.mobCanEnter`).
`extract.spec.ts` runs the client's real `LocalPlayer` and a server `Player` over the same
routes and asserts identical positions each tick. Change one and that spec will tell you.
**`extractProgress` (19)** is a uint8, 0 when not extracting, else 1–254 as 255ths of the
layer's time. It is sent on change only, to everyone in range, and never in a snapshot.

**`loot32` (20) carries `loot` as a uint32**, capped to that range and rounded down.
`GameObject.WIRE_NAME` maps the `loot` property to it. Index 5 `loot` (uint16) stays in the
table, deprecated and never sent, because indices are append-only. The client still decodes
it for older servers. A uint16 loot over 65,535 threw inside `World.update`, so the tick's
catch skipped `flushAll` and **the whole world froze**, every tick, because loot stayed
dirty. Any uint16/uint8 field fed by an unbounded value can do the same. Audit notes: effect
lifetime is an int8 of ms/100, clamped to 12.7 s since 2026-10-04 (`Multiplayer.effectLifetime`; a
12.8 s effect threw); ids are uint16 but recycled a
second after release, and a 200-bot stress run peaked at id 2,610.

**`kills` (21)** is a player's credited kills this run, a uint16 saturated at 65,535, for the
end-of-run card (`run-summary-card`, decision #36). A `GameObject` accessor like `armor` (so
never declare it on a subclass), in `Player.allFieldsOwn` only, incremented by `Player.onKill`
and sent as a delta to every holder, like loot. It counts what `onKill` credits: breath kills
have no attacker and don't count, as they don't in the redis `kills` stat. The frame puts
`update` last, so a kill in the same tick as the player's own destroy never reaches its card.
**Client first**, like every new index. The load bot's and `spans.cjs`'s `WIDTH` tables and
`archetype-bot.mjs` have the row.

**`projectile` (22)** is a uint8 on a `Throwable`'s create only: `Throwable.FIREBALL` 1,
`ICICLE` 2 (client `PROJECTILE` in `objects/throwable.ts`; `arenawire.spec.ts` compares the
two, append-only). The client draws the matching clip; a server from before it sends none and
everything flies as a fireball. **Client first.** The tools' tables have the row. A
**Consumable's create carries `loot`** (as `loot32`, 20) since the same pass, so the client can
size the crystal; no new index, and an older client already decodes it. The client draws a
projectile one tick behind, gliding between its server positions and pointed along the step
(`direction` is not on the wire), hidden until its second position.

**`finish` (23)** is a player's finish (robot-finishes, #41), on every create of a player
(`allFields` and `allFieldsOwn`), never a delta: `[uint8 count = 6]` then `[colour][pattern]`
for head, body and limbs, ids from the mirrored `utils/finishes.ts`. **Counted like
`inventory`**, so a later addition only lengthens it, and `finishFromBytes` reads the first six
bytes, falling back to the default per group for an id it doesn't know. It is the last field of
a player's creates, so an older client (which stops at an index it doesn't know) loses only the
finish (`finishwire.spec.ts`). **Client first**; a server from before it sends none and every
robot is mint. The tools' tables have the row (`-2`, counted).

**`collector` (24)** is a uint16 player id on a pickup's destroy record only, when a player took
it (`GameObject.destroyCollected`; pickup-reach, #42). The client flies the pickup into that unit
if it holds it, else disposes it as before. **Client first**; an older client stops at the index,
after `id`, and drops the pickup as before (`pickupwire.spec.ts`). Tools' tables have the row.

**`gear` (25), `carried` (26) and `speed` (27)** came with gear in the run (#49, 49-2; PROTOCOL 6,
client first; `gear/gearwire.spec.ts`; the tools' tables have the rows). **`gear`** is on a
`GearPickup`'s create only: `[uint8 n]` then one instance as `encodeGear` writes it (mirrored
`utils/gear.ts`: `[uint8 tier][uint8 skill][uint8 rollCount]` then per roll `[uint8 stat][uint16 q]`,
big-endian; a stash `rowId` is never on the wire). Counted, so a later addition only lengthens it;
`decodeGear` skips unknown stat ids and trailing bytes, and refuses an unknown skill or tier, which
the client then draws as an unknown item. **`carried`** is the player's gear, in the owner's create
and as a delta on change, like `inventory`: `[uint16 n]` then `[uint8 entries = 6]` and per entry
`[uint8 len][instance]`, len 0 empty; entries 0-1 are keys 3-4, 2-5 the bag. uint16 because six
entries can pass 255 bytes once rolls grow. **`speed`** is `maxVelocity` in tenths, a uint16,
rounded and saturated: `GameObject.WIRE_NAME` maps the `maxVelocity` property to it, as `loot` to
`loot32`, and **index 10 is never written since**. It was an int8 of tens, which floored a geared
149.8 to 140 and would have set prediction against reconciliation. The client still decodes 10 for
older servers. Why not a wider `inventory`: shipped clients read it as counts per fixed slot, so
instance bytes in it would show as garbage counts.

**`item` (17) and `inventory` (18)** belong to usable items. `item` is a uint8 item id on an
`ItemPickup`; `inventory` is `[uint8 slot count][uint8 count per slot]`, with fixed slots
(key 1 = medkit, key 2 = bomb, 5 empty; keys 3-4 are gear, carried in `carried` (26), not here). The item table's shared half is the mirrored
`utils/items.ts`. Its server half is `ITEMS` beside `ARCHETYPES` and `LAYERS`, and each row
names a behaviour (`heal`, `bomb`), not an item. **`type` is written as an unsigned byte**,
because `ItemPickup` is type 128. **Client → server `use_item`** has the same bytes as
`skill` (a slot, plus an optional absolute aim cell), inside `guarded`, validated by
`Player.tryUseItem`; a refused use spends nothing. Slots 2-3 (keys 3-4) cast the gear in them
through the same `Skill.execute` a kit skill uses; an empty one is refused. **Effect types 7 (bomb fuse) and 8 (bomb
blast)** go through `Multiplayer.effectAt`, which picks recipients from the effect's cell and
layer, not from the originator. A thrown bomb goes off even if its thrower has died or left
(its fuse timer has no owner), just as a fireball in flight outlives its caster.
`fieldtable.spec.ts` reads the client's `allFields` with a regex that stops at the first
`]`, so a comment inside that array must not contain square brackets.

`maxVelocity` (sent as `speed`, 27) is in `allFieldsOwn` and dirty-tracked, because local prediction cannot run
without it. It is deliberately **not** in `allFields`: remote units are interpolated between
known positions and never need a speed.

`lifetime` is encoded as centiseconds in a **uint16** (`value / 100`), giving a range of
about 65,000 seconds. It was a single signed byte, which silently capped every lifetime at
12.7s — long enough for a 3s fireball, wrong for the 60s timer on dropped loot. Encoding it
raw in milliseconds throws `ERR_OUT_OF_RANGE` for every real value including 1000.
