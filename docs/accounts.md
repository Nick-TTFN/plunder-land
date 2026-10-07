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
taken if it landed, so a slow store makes one row per connection, not one per PLAY AGAIN. Still failing, the
run plays offline under the same id. Every PLAY AGAIN while offline waits on the store again (up
to 3 s while it hangs).
Sentry hears of account failures once per stretch (`Worlds.accountFailure`: the first after a
success, then one per `ACCOUNTS_REPORT_MS`, 10 min), and of a failing migration runner once per
run of failures (`db/open.ts`), which also covers not-migrated. Migrations are
TypeScript strings in `db/migrations.ts` (a `.sql` file would not reach `dist`), **additive
only** (overlap and drain run the old server on the new schema for up to 10 min), applied at
boot in the background under an advisory lock, retried every 30 s; boot never waits. Without
`DATABASE_URL` the store is in memory (never evicts) and logs `accounts: in memory (no
DATABASE_URL)`, reported to Sentry once on Railway (`RAILWAY_ENVIRONMENT_NAME` set). The token is never stored, logged or reported;
only its SHA-256 is kept. **Railway runs Postgres 18** (`ghcr.io/railwayapp-templates/postgres-ssl:18`,
provisioned 2026-10-03), and the server's `DATABASE_URL` is `${{Postgres.DATABASE_URL}}`;
compose and the pg spec's container use `postgres:18-alpine` to match (see "Running it
locally").

**Loadouts** (#48 step 4): migration 3, table `loadouts (account_id, robot key, slot_index,
skills smallint[4])` keyed by (account, robot, index), CHECKs as a backstop; written by one upsert
(`saveLoadout`, which `close` waits for), read by `resolve` in the same round trip (`json_agg`).
Rows are untrusted: `kitFor` checks each at every join. Finishes are not in loadouts.

**XP and levels** (#48 step 3, `src/progress/`). Every number is `PROGRESSION` in
`progress/xp.ts` (Dez's v1, `ideas/meta-progression-numbers.md` §1-2, pinned by `xp.spec.ts`); a
mob key missing from it pays `mobDefault` 2 (no such mob exists yet; Nick/Dez to confirm 2 or 0
before a fourth mob type). Kills are tallied by victim from `Player.onKill` (`progress/run.ts`
`countKill`); time XP uses `run_end`'s rounded `seconds`, so it agrees with GA. `account_progress`
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
adds `season_entries` (with `name`, the sanitised name of the run that last credited it), `seasons`
(a row only once paid) and `season_payouts`. The credit rides in the run's grant statement, so it
lands exactly when the XP does: once per run, never offline, never for a bot (a bot has no
connection, so it never reaches `grant`); a paid season takes no more entries. Each server's
`SeasonPayer` (a plain unref'd timer: store work, not world work; stopped before `accounts.close()`)
calls `payDue` 30 s after boot and every 5 min. A payout is one transaction per season, guarded five
ways: `payAll` lists only unpaid seasons, `pg_try_advisory_xact_lock(SEASON_LOCK)`, a paid check
inside the lock, the `seasons` primary key (a 23505 there is logged, `seasons: … already paid`, and
counts as paid) and `season_payouts`' key; `close` waits for one in flight, and a killed one rolls
back whole. The client hears `season` (`SeasonView`, relative `endsInMs`) after `account` and after
each grant; the lobby shows a line under the name pill and the last payout once per season
(`plunderland_season_seen`). A payout's XP shows at the next connect or after the next run, not live.
`GET /season`: the top 10 as `{ rank, name, id, banked }`, the ranked count and places, cached 30 s;
names are sanitised and public, and the ids link them to `/stats` (disclosed on the privacy page,
Nick 2026-10-04). **Deleting a player's season data** (privacy requests, by hand through `railway
connect`): find the account by `season_entries.name` (names aren't unique: confirm by id or dates),
then `DELETE FROM season_payouts WHERE account_id = $1; DELETE FROM season_entries WHERE account_id =
$1;` (both reference `accounts`, so they go before any account row; so do `energy`, `loadouts`,
`account_progress` and, since #49, `stash_items`: add `DELETE FROM stash_items WHERE account_id = $1;`).

**Energy** (#48 step 7, `progress/energy.ts`; numbers are `ENERGY` in `progress/xp.ts`, Nick's #48:
1 play per 30 min, cap 3, a new account starts with 6, nothing regenerates above the cap). A run
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
(`energyAt`), never a timer; no row reads as 6, so accounts from before it start full. **Kept on
purpose (Nick, 2026-10-04: "greedy baseline with occasional fair surprise"):** a refund is +1 whatever the stock, so a run spent at the cap and extracted after more
than 30 minutes ends at cap + 1 (never higher: above the cap no clock runs). The lobby shows the
plays under READY (`net/energy.ts` `energyLine`, counted forward on the client) and disables READY
at 0 until the next play is due; the server decides regardless. Every start now waits one database
round trip (a transaction of four statements) before its `hello`.

**Stash** (#49, 49-3..49-5, live 2026-10-05; see "Gear" for the items themselves). Migration 6:
`stash_items` (a row is `state` 0 stashed or 1 carried; a carried row names `holder`, the boot id of
the process whose memory may hold its copy; `source` 1 found, 2 merged, 3 admin, append-only) and
`gear_holders` (each process's last heartbeat). **The invariant that keeps items single:** an
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
exactly the shapes `rollGear` makes, all or none within `STASH_MAX`, under `settleGear`'s per-account
lock). **A missing or wrong key, or admin off, answers exactly as an unknown route** (404, empty), so
nothing says the routes exist. The key is kept only as its SHA-256 and compared with `timingSafeEqual`
over the two hashes; it is never logged, reported or echoed. One log line per call (`admin: <method>
<route> <id> <status> <outcome>`); refused keys are counted in at most one line a minute. Store-only
(`AdminStore`, both stores, `adminContract`): a player sees the change at their next connect or run.
Bodies at most 16 KB (413), 400 on malformed input. The key goes on Railway only with Nick's go; keep a
copy outside any repo and never print it.
