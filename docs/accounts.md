# Accounts, progression and stash

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Accounts

**Guest accounts** (decision #48 step 1, shipped 2026-10-03; `src/db/`). The server owns the
player id. On a connection's first play with no known token it creates an account (Postgres
`accounts`: internal `id`, 16-hex `public_id`, `token_hash` the SHA-256 of a 32-byte base64url
token) and sends `account { id, token }` before that run's `hello`. The client keeps the token
in localStorage `plunderland_token` (`net/account.ts`) and sends it in every socket.io
handshake (`auth`, a function, so a reconnect re-reads it); the server looks it up on connect
(`Worlds`, so READY doesn't wait on the database) and answers `account { id }`. The player id
(Redis keys, `/stats`, GA `client_id`, the callsign) is the account's `publicId`;
`start_requested`'s `id` is ignored. Creation is on first play, not on connect, so lobby
bounces and crawlers make no rows. **Fail open, no grants:** a store that is down, slow (pool
2 s connect and query timeouts, `Worlds` `accountTimeoutMs` 3 s) or not yet migrated gives the
connection an offline account, which plays, writes no Redis stats (`Multiplayer.isOffline`), is
sent no token (`account { id, offline: true }`, so a returning player's stored token survives
the outage) and tags its GA events `offline: 1`. An offline connection tries the store again at
each later start (`Worlds.retryAccount`: the handshake token looked up again, same timeout and
Sentry throttle) and creates an account only once the store has answered that it knows none (or
there is no token), never while a lookup is unanswered, failed or timed out. At most one creation is in flight per connection
(`Worlds.create`): one the timeout gave up on is waited on again at the next start and its account
taken if it landed, so a slow store makes one row per connection, not one per run start. Still failing, the
run plays offline under the same id. Every run start while offline waits on the store again (up
to 3 s while it hangs).
Sentry hears of account failures once per stretch (`Worlds.accountFailure`: the first after a
success, then one per `ACCOUNTS_REPORT_MS`, 10 min), and of a failing migration runner once per
run of failures (`db/open.ts`), which also covers not-migrated. Migrations are
TypeScript strings in `db/migrations.ts` (a `.sql` file would not reach `dist`), **additive
only** (overlap and drain run the old server on the new schema for up to 10 min); the one
deliberate exception is migration 9, **the userbase reset of 2026-11-10** (Nick: "reset userbase",
everything): it copies every player table to `reset_20261110_*` and empties it, schema unchanged,
and `resetRedisOnce` (`src/resetredis.ts`, marker key `reset-20261110`) deletes `stats-*` and
`player-*` once at boot. Old tokens no longer resolve, so a returning client is a new guest on its
next start. Drop the copies once nobody needs them. Migrations are applied at
boot in the background under an advisory lock, retried every 30 s; boot never waits. Without
`DATABASE_URL` the store is in memory (never evicts) and logs `accounts: in memory (no
DATABASE_URL)`, reported to Sentry once on Railway (`RAILWAY_ENVIRONMENT_NAME` set). The token is never stored, logged or reported;
only its SHA-256 is kept. **Railway runs Postgres 18** (`ghcr.io/railwayapp-templates/postgres-ssl:18`,
provisioned 2026-10-03), and the server's `DATABASE_URL` is `${{Postgres.DATABASE_URL}}`;
compose and the pg spec's container use `postgres:18-alpine` to match (see "Running it
locally").

**Names: callsigns** (decision #62, task g2-9; Nick 2026-11-13, "drop name entirely for now"). Nobody
types a name: the lobby has no name field, and every player, the viewer included, and every bot is
shown as a callsign, a word and a three-digit number (`ROOK-421`; the mirrored `utils/callsign.ts`,
64 words x 900 numbers = 57,600; two players sharing one is possible and only cosmetic). A human's
is the account `publicId`'s, so it is the same in every run, world and season, and the lobby shows
it from `account.id` with no wire change; a bot's is drawn from the fill's RNG. The server ignores
any `name` a start carries (an old tab still sends one) and picks the run's name in one function,
`displayNameFor` (`network/displayname.ts`), which g2-6b extends: a player with a verified
CrazyGames token shows their CG username (Nick 2026-11-14), through `Player.sanitiseName`, the
callsign on a hit. `sanitiseName` stays for that and as every name's backstop. Where the name is
read, all of them now a callsign: the create record to other clients, standings, `spectate`,
`World.FINISHED`, the season credit (`season_entries.name`, public on `/season`). Why: PEGI 12 on
CrazyGames against free-text names that the filter (English only) can't police. Nothing stores the
typed names old tabs still send. The callsign generator is a consumed format in effect: a change to
its words, numbers or hash renames every player (`names.spec.ts` pins three).

### Portal accounts

**CrazyGames users are linked to accounts** (task g2-6b, plan g2-0; CG's Full Launch "account
integration": logged-in users are registered and logged in automatically, guests play as guests,
no other login). Our progress is server-side, so we link CG's `userId` to one of our accounts
(Postgres `account_links`, migration 10: `(portal, external_id) -> account_id`, primary key
`(portal, external_id)`, `UNIQUE (portal, account_id)`) rather than using CG's Data module. Never
the username, which CG lets users change.

**The token.** The client asks CG's SDK for `getUserToken({ signingKeyType: "IN_GAME_AUTH" })`
and sends it as the handshake's `auth.portalToken` (at most 4096 characters), read only when
`auth.portal` is `crazygames`. `network/portaltoken.ts` verifies it **by hand, no JWT library**:
header `alg` exactly `RS256` and `kid` exactly `ingame-auth` (so `none`, `HS256` key confusion, every
other alg and the `ingame-auth-legacy` key are refused before any key is read; a `crit` header too),
the signature with Node's `crypto.verify('RSA-SHA256')` against the JWKS key (RSA, 2048+ bits, built
from `n`/`e` only), then `exp`/`iat` with 60 s skew, `gameId === CRAZYGAMES_GAME_ID` as a string (a
numeric `gameId` compares by its decimal form), and `userId` 1-128 printable ASCII. The JWKS
(`https://userportal.crazygames.com/.well-known/jwks.json`) is fetched on the first token, kept,
and fetched again at most once a minute (failed attempts count) when the kid is missing, when a
signature fails against the kept key (rotation under the same kid) or after an hour; each fetch has
a 3 s timeout. **Everything fails closed to guest play**: a token that doesn't verify, a JWKS that
can't be fetched, `CRAZYGAMES_GAME_ID` unset (every token ignored, logged once at boot), or a store
without the portal half (`portalStoreOf`). A JWKS outage makes logged-in users guests for that
session: their progress is safe, not visible. The JWKS URL and the clock are constructor parameters
for the specs, never an env var.

**The rules** (`Worlds.lookup` / `portalLookup`, at connect):

- **4a** Valid token, user linked: that account at once; `auth.token` is ignored.
- **4b** Valid token, no link, and `auth.token` resolves to a guest account with no link: the server
  sends that account's `account` with `linkable: true` and sets nothing; the client shows CG's link
  prompt and answers `portal_link { accept }`. Accept: `linkPortal` links that guest account (no
  merge: it becomes the CG user's, whoever on the device made it); a READY meanwhile waits for the
  write. Decline, anything but `accept: true`, or **READY before an answer**: a new account, created
  and linked at that READY as a guest's is.
- **4c** Valid token, no link, no usable guest token (none, unknown, or one already linked to someone):
  a new linked account at the first READY, no prompt.
- **4d** No or an invalid token: today's guest rules, **except** that a guest token whose account is
  linked counts as no token (a new guest at READY), so a logged-out sibling on the same device never
  gets the CG user's account. Also on `retryAccount`.

A linked account's `account` carries `portal: 'crazygames'` and **never a token** (it is reached
through CG's token; a created linked account's `token_hash` is a random token's that is never sent).
Two tabs racing are safe by the two unique keys: `createLinked` rolls back and returns the winner,
`linkPortal` answers `taken`. An offline connection with a verified token retries the user's link
at its next start. GA `portal_link { result: linked | declined | taken | auto }` measures it.

**Name.** A connection with a verified token is shown under the token's `username` if it has CG's
documented shape (6-20 of `[A-Za-z0-9._]`), through `setPortalName` / `displayNameFor`; the `Player`
constructor's `displayName` runs it through `sanitiseName`, so a filtered name (profanity, `YOU`)
falls back to the callsign, and a 17-20 character username is cut to `NAME_MAX` (16). Taken from
each new token, so a changed CG username shows on the next connection. Everyone else, bots
included, keeps the callsign. `profilePictureUrl` is not stored or relayed.

**Any future userbase reset like migration 9 must empty `account_links` too**, or a CG user lands
on a missing account (the foreign key would also block emptying `accounts`).

**Loadouts** (#48 step 4): migration 3, table `loadouts (account_id, robot key, slot_index,
skills smallint[4])` keyed by (account, robot, index), CHECKs as a backstop; written by one upsert
(`saveLoadout`, which `close` waits for), read by `resolve` in the same round trip (`json_agg`).
Rows are untrusted: `kitFor` checks each at every join. Finishes are not in loadouts.

**XP and levels** (#48 step 3, `src/progress/`). Every number is `PROGRESSION` in
`progress/xp.ts` (Dez's v1, `ideas/meta-progression-numbers.md` §1-2, pinned by `xp.spec.ts`); a
mob key missing from it pays `mobDefault` 2 (every mob has an entry since L1). Kills are tallied by victim from `Player.onKill` (`progress/run.ts`
`countKill`); the NPC roster's kill XP (#51) is in `docs/npcs.md`. Redis `stats-<id>` gains
`commonKills`, `rareKills`, `epicKills` and `legendaryKills` with L1 (every NPC kill credits
`mobKills` and its rarity's key); **`bossKills` stops growing with L1** and stays readable
(renames are removals); time XP uses `run_end`'s rounded `seconds`, so it agrees with GA. `account_progress`
(migration 2) holds the total; the level is derived by the curve and never stored, so a curve
change re-levels everyone (Nick, #48). One grant per run at its end, from `Multiplayer.destroy` →
`runEnded` → `Worlds.grant` (death, extraction, disconnect, a drain's cut-off; `Player.runOver`, set at the top of
`Multiplayer.destroy`'s player block, keeps it single with the stats write and `run_end`, however
the end is reported), as one atomic upsert; offline runs and bots earn nothing; a failed grant is logged and
reported, never retried. `PgAccountStore.close` waits for grants in flight. The account level is
not `Unit.level`, which stays 1 (skill damage reads it). `Multiplayer.drop` still never destroys an extracted player again (`!player.exited`), because `exit` frees the id itself and a second destroy freed it twice. **A kill credited after the run's XP was computed** (a fireball landing after its caster extracted) counts in `kills` but not in XP: XP is fixed at the run's end, by design (48-3b review).

**Weekly seasons** (#48 step 6, `progress/seasons.ts`; numbers are `SEASON` in `progress/xp.ts`, Dez's
v1, pinned by `seasons.spec.ts`). A season runs Monday 00:00 UTC to the next and is named by its
start date; a run counts in the season of its end (`Worlds`' `now()`). Score: banked loot of
extractions, at most `creditCap` 6,000 a run (`creditOf`). Ranked: 3 runs, 1 extraction and some
loot banked. Ties go to whoever reached the score first (`banked_at`, the run's end time passed in),
then the older account (`compareEntries` = pg `RANK_ORDER`, held equal by the store contract). Paid
at end + 10 min: the top `max(1, floor(0.01 N))` / `floor(0.10 N)` / `floor(0.25 N)` places
(cumulative, `tierPlaces`) get 1,000 / 500 / 250 XP, each at most the season's run XP. Migration 4
adds `season_entries` (with `name`, the name of the run that last credited it: its callsign since g2-9, "Names" below), `seasons`
(a row only once paid) and `season_payouts`. The credit rides in the run's grant statement, so it
lands exactly when the XP does: once per run, never offline, never for a bot (a bot has no
connection, so it never reaches `grant`); a paid season takes no more entries. Each server's
`SeasonPayer` (a plain unref'd timer: store work, not world work; stopped before `accounts.close()`)
calls `payDue` 30 s after boot and every 5 min. A payout is one transaction per season, guarded five
ways: `payAll` lists only unpaid seasons, `pg_try_advisory_xact_lock(SEASON_LOCK)`, a paid check
inside the lock, the `seasons` primary key (a 23505 there is logged, `seasons: … already paid`, and
counts as paid) and `season_payouts`' key; `close` waits for one in flight, and a killed one rolls
back whole. The client hears `season` (`SeasonView`, relative `endsInMs`) after `account` and after
each grant; the lobby shows a line under the callsign pill and the last payout once per season
(`plunderland_season_seen`). A payout's XP shows at the next connect or after the next run, not live.
`GET /season`: the top 10 as `{ rank, name, id, banked }`, the ranked count and places, cached 30 s;
names are callsigns (sanitised typed names in entries from before g2-9) and public, and the ids
link them to `/stats` (disclosed on the privacy page, Nick 2026-10-04). **Deleting a player's season data** (privacy requests, by hand through `railway
connect`): find the account by `season_entries.name` (a callsign is the account id's, but callsigns
aren't unique: confirm by id or dates),
then `DELETE FROM season_payouts WHERE account_id = $1; DELETE FROM season_entries WHERE account_id =
$1;` (both reference `accounts`, so they go before any account row; so do `energy`, `loadouts`,
`account_progress` and, since #49, `stash_items`: add `DELETE FROM stash_items WHERE account_id = $1;`;
since #58, `first_runs` too: `DELETE FROM first_runs WHERE account_id = $1;`).

**Energy** (#48 step 7, `progress/energy.ts`; numbers are `ENERGY` in `progress/xp.ts`, Nick's #48:
1 play per 30 min, cap 3, a new account starts with 10 (6 until 2026-11-13, #62), nothing regenerates above the cap). A run
costs a play, spent in `Worlds.admit` before the run begins by one atomic check-and-spend
(`AccountStore.spend`; pg: a transaction holding the `energy` row `FOR UPDATE`, after an `INSERT …
ON CONFLICT DO NOTHING` of the start stock, so two starts at once with one play left get one run).
None left: `start_refused`. Given back (`refundRun`) on an extraction or a run the server cut short
(`closeAll` sets `Connection.cutOff`: a drain's deadline, Nick's #48 build call 8), never on a death
or the player's own disconnect; once per run (`runEnded` is). A play spent for a run that then
doesn't start (the socket closed or a drain began during the spend, the join threw) is given back.
**Fail open** (build call 9): an offline account, or a spend that fails or takes over
`accountTimeoutMs`, plays free and refunds nothing; a spend the timeout gave up on may still land, so
that play is lost (needs a 3 s database stall; accepted like a lost grant). Bots never spend (they
never reach `Worlds.start`). Migration 5, `energy (account_id, stock, as_of)`: regeneration is lazy
(`energyAt`), never a timer; no row reads as `ENERGY.start` (10), so accounts from before it start full. **Kept on
purpose (Nick, 2026-10-04: "greedy baseline with occasional fair surprise"):** a refund is +1 whatever the stock, so a run spent at the cap and extracted after more
than 30 minutes ends at cap + 1 (never higher: above the cap no clock runs). The lobby shows the
plays under READY (`net/energy.ts` `energyLine`, counted forward on the client) and disables READY
at 0 until the next play is due; the server decides regardless. Every start now waits one database
round trip (a transaction of four statements) before its `hello`.
**Across a private world's pad** (#60, private-6; `docs/world.md`, "Private worlds"): a run in a
private world and its continuation in a shared world are one run and cost **one** play. The play
spent at the start moves to the shared world's player at the pad (`paid`, `padHandoff`), so the
run's extraction refunds it wherever it happens (layers 01-02 or deeper) and its death or the
player's own disconnect keeps it spent, as for any run. A pad whose join throws refunds the play
and redirects. At `PRIVATE_CAP` a start is sent `full` before the account and the play, so
nothing is spent. Below it, a start over the tick's budget waits in the start queue **before**
the play is spent (private-15; `docs/world.md`, "Under load"): a queued start that disconnects
or times out to `full` has spent nothing.

**First run** (decision #58 and addenda 5-6; tasks retest-3/4; the world: `docs/world.md`,
"First-run worlds"; `Worlds`: `docs/server-invariants.md`). **Once per account.** Migration 8,
`first_runs (account_id bigint PK REFERENCES accounts(id), done_at timestamptz NOT NULL)`, additive,
**no backfill: every existing account gets the first run once** (#58 addendum 6, Nick's and
Jeremy's included). `Account.firstRunDone?`: `resolve` reads it in the same round trip (`EXISTS`),
so a persisted account with no row reads `false`; `create` gives `false`; **`offlineAccount()` reads
`true`** (no first run without a store to record it). The field is optional and only an explicit
`false` plays a first run (`Worlds.firstRunFor`), so an `Account` literal without it (specs) fails
closed to a normal run; that polarity is not pinned by a spec. `finishFirstRun(publicId, nowMs)` is
one statement, `ON CONFLICT DO NOTHING` (the first `done_at` stays), throws for an unknown account,
and `close` waits for it. It is on its own interface, **`FirstRunStore`** (`firstRunStoreOf(store)`),
not `AccountStore`, for the same reason as `GearStore`/`AdminStore`: spec wrappers implement
`AccountStore` and a required method would stop them loading. A store without it never plays a first
run. **Who gets one** at `Worlds.start`: the start asks (`start_requested.firstRun: true`; every
current client sends it, the server decides), the account is persisted with `firstRunDone === false`,
the store has `finishFirstRun`, no drain, and fewer than `FIRST_RUN_CAP` first runs open. Otherwise
today's run, and the account stays not done. **Energy:** intro + the run after it cost **one** play,
spent at the start as usual; at the handoff the paid play moves to the private world's player (and
at its pad to the shared one's, above), so that run's extraction refunds it and its death doesn't. **Leaving halfway** (disconnect, closed tab)
refunds the play and leaves the account not done, so the next start replays the first run from its
beginning (#58 addendum 5, Archie's default). The account is marked done at the handoff (in memory
at once, the store write not awaited); a handoff that can't join (drain, `begin`
threw) refunds and redirects, and the account stays done. **No `bring`:** a start that will be a
first run equips no stash gear. **XP:** the first run's kills are carried (`carryKills`) and paid at
the shared run's end with its loot; nothing is granted at the handoff. With the strip's content the
kill credit is 9 XP (3 rocks at `mobDefault` 2, Crawler 1, Compactor 2; Dez's estimate was ~5, open
for Dez/Nick: a `rock` key in `PROGRESSION.kills.mob` would change it), and everything carryable
banked at once is 23 XP, below level 2's 40, so the first run alone doesn't open level 2 (Defend since 2026-11-10; spec'd).
Redis `stats-lootCollected` gets the carried loot at the shared run's end. Two tabs on one account can
each play a first run (the in-memory flag is per connection); accepted. An invite link opened by a
new account plays the first run first, then its private world, then hands off at the pad into the
friend's world (open for Nick).

**Stash** (#49, 49-3..49-5, live 2026-10-05; see "Gear" for the items themselves). Migration 6:
`stash_items` (a row is `state` 0 stashed or 1 carried; a carried row names `holder`, the boot id of
the process whose memory may hold its copy; `source` 1 found, 2 merged, 3 admin, append-only) and
`gear_holders` (each process's last heartbeat). **Migration 7** (#51, l1-2) widens
`stash_items_tier_check` from 1-3 to 1-4 for Legendary: one `ALTER TABLE` that drops and re-adds
the constraint under the same name inside the migration's transaction, so there is no moment
without a CHECK. **Widening a CHECK counts as additive** (every row and write of the old server
still passes), though it is not literally "no drops". A merge to T4 before it lands fails the
CHECK and answers `store`, inputs intact (`pgstore.spec`, `stashpg.spec`). `storable()`
(`db/accounts.ts`) bounds the tier by `GEAR_TIERS`, not a literal. The old server during a drain
loads a T4 row, carries it with every roll worth 0 (`rollValue` has no T4 range) and returns it
by `rowId` (an `UPDATE`, never `storable`): no dupe, no loss; old clients never see it (`itemOf`
refuses tier 4). Same after a rollback: T4 rows stay stored and inert. **The invariant that keeps items single:** an
instance with a `rowId` only ever moves or deletes its own row, conditionally on `state = 1 AND
holder = <this boot>`, and is never inserted; only rowless (found) instances are inserted, once, at
the run end of whoever takes them out, and they come off the player in the same synchronous step.
The worst a failure can do is lose an item or return it to its last owner. The stash methods are
not on `AccountStore` (six specs outside `db/` implement it): carrying and settling are `GearStore`
(found by `gearStoreOf` at run time; a store without all six methods plays with no stash, and boot
warns `gear: the account store has no stash methods`), merge and scrap are `StashEdits`
(`stashEditsOf`). Merge takes the rule as a callback (`mergeOutcome`, `gear/merge.ts`), so a Q11
reroll, if Nick says yes, would call it again without touching store code. **`GearLedger`**
(`gear/ledger.ts`, one per process, per worker under `WORKERS`): a random boot id, refcounted claims
on row ids (a claim is taken before the carry is issued and let go only when the write that resolves
it settles or times out), and a heartbeat at boot and every 60 s (a plain unref'd timer, store
work). No carry before a heartbeat has landed within `FRESH_MS` (5 min): a holder missing from
`gear_holders` reads as dead. Each heartbeat also returns this holder's rows that it no longer holds
and that were carried over `RECONCILE_AFTER_MS` (2 min) ago. **A dead holder's rows return to the
stash 15 minutes after its last heartbeat** (`STALE_CARRY_MS`, at the owner's next `loadStash`), not
15 minutes after the carry: counted from the carry, a run longer than 15 minutes would have its item
returned while still in the world, which dupes (Archie's reading of the spec, told to Nick). The
start carries `bring` in the same transaction as the energy spend (`ledger.carry`); `admit` first
waits for the connection's previous settle (bounded), whose rows are still carried; a store failure
plays free and with no gear; whatever was carried but isn't on a live run's player goes back
(`uncarry`). **Every run end** (`Multiplayer.gearEnded`, from the `runOver` block, bots included):

| End | Found (no `rowId`) | Stash row (`rowId`) |
|---|---|---|
| Extraction or drain cut-off, persisted account owning the run | inserted (`settleGear`, up to `STASH_MAX`) | kept or transferred (`settleGear`) |
| Death or own disconnect | nothing written; dropped on death | nothing written; dropped keeping `rowId` |
| Extraction offline, under another account, or a bot's | lost | deleted (`discardGear`) |

A private world's pad (#60, private-7) is **not** a run end: the run's gear (slots, bag, same
instances and rows) moves to the shared world's player before the private world closes, so the table
applies once, where the run ends; a pad whose join throws `uncarry`s the carried rows and loses found
items (`docs/world.md`, "Private worlds").
Keep and discard take the gear off the player before the write, so a cut-off player's disconnect
sweep drops nothing. A dropped stash item expiring on the ground, and every stash item in a world
being closed, is deleted too. Extraction never loses an item (Nick, #49): above 12 the stash asks for
a merge or scrap, and `STASH_MAX` 100 is only a storage ceiling. No XP for kept items. A merge or
scrap is one transaction on stashed rows only; one stash write in flight per connection, none while
its start is. **On a drain, `ledger.close()` before `accounts.close()`** (`index.ts`): it waits for
the settles the disconnects issued, then `releaseHolder` hands back every row this boot still
carries; SIGINT skips it and the stale return covers a crash. A death in the last ~30 s before a
deploy or crash may return the dead owner's items (Nick: accepted, favours the player).
**Known, not fixed:** merge locks its rows `ORDER BY id FOR UPDATE`, but the carry's `UPDATE … id =
ANY` locks in plan order, so a deadlock is possible (unseen in 24 rounds of `pgstore.spec`'s race 2
under load). Postgres would abort one side: the merge answers `store`, or the spend rolls back and
the start plays free without gear; never a duplicate. If it shows in the logs, lock the carry's rows
first with `SELECT … ORDER BY id FOR UPDATE`. A `GearTimeoutError` names its operation (`op`: `beat`,
`carry`, `resolve:settle|discard|uncarry`, `close:release`) in its message and as the Sentry tag
`gear_op` (#50); `ledger.resolve` requires the call's kind, so a new call site can't forget it. One
on 2026-10-05, before the label, was a slow heartbeat, harmless.

**Admin endpoints** (decision #50, `network/admin.ts`): off unless `ADMIN_KEY` holds 32+ characters
(boot logs `admin: on`/`admin: off`, never the key). Then, with `Authorization: Bearer <key>`:
`GET /admin/account/:id`, `POST /admin/account/:id/xp { xp }` (set, 0..10,000,000), `/energy { stock }`
(0..99, as of now), `/gear { items: [{ tier, skill, rolls: [[stat, q]] }] }` (stashed rows of source 3,
exactly the shapes `rollGear` makes, tier checked against `GEAR_TIERS` (so T4 with 3 rolls since L1), all or none within `STASH_MAX`, under `settleGear`'s per-account
lock). **A missing or wrong key, or admin off, answers exactly as an unknown route** (404, empty), so
nothing says the routes exist. The key is kept only as its SHA-256 and compared with `timingSafeEqual`
over the two hashes; it is never logged, reported or echoed. One log line per call (`admin: <method>
<route> <id> <status> <outcome>`); refused keys are counted in at most one line a minute. Store-only
(`AdminStore`, both stores, `adminContract`): a player sees the change at their next connect or run.
Bodies at most 16 KB (413), 400 on malformed input. The key goes on Railway only with Nick's go; keep a
copy outside any repo and never print it.
