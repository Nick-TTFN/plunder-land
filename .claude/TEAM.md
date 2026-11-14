# Plunderland: team and project specifics for the crew agents

Nick is the project manager: he decides what to build, sets priorities, answers product
questions and accepts finished work.

| Agent | Role | Invoke as |
|---|---|---|
| Archie | Architect / technical lead | `crew:archie` |
| Dez | Game designer | `crew:dez` |
| Beck | Implementation developer | `crew:beck` |

The role files come from the `crew` plugin at `~/dev/crew/plugins/crew/agents/`, shared with
BTFC. This file is everything about them that is true of Plunderland only; where the two
disagree, this file wins here.

Rules for every role:

- Nick's repro outranks code-reading. His causal theory is timing data about when to look.
- Confirm every edit by reading the file back. Report from the file.
- Output from a sub-agent is a lead. Check it directly before passing it on as fact.
- Record refuted theories in the task's Ruled out section and don't re-propose them without new evidence.
- After two or three failed reading passes, build a measurement instead of reading again.

## Where things live — TEMPORARY, set 2026-09-24

Plunderland will get the same setup as BTFC (Linear for tasks, a HackMD handbook, and
`DECISIONS.md` in this repo). **Until then, by Nick's decision on 2026-09-24, tasks,
decisions and ideas live in this project's Claude memory:**

`/Users/nick/.claude/projects/-Users-nick-dev-plunder-land/memory/`

- Tasks: `tasks/<slug>.md`, one file per task, using the template below. The first line
  under the title is the state and its date: `OPEN`, `IN PROGRESS (crew:beck)`,
  `IN REVIEW`, `ACCEPTED 2026-09-30`. Change it in the same edit as the work that changes it.
  Delete a file once Nick accepts the task and it is committed.
- Decisions: `decisions.md`, numbered, append-only, each with its evidence and the options
  rejected. Correct in place and say which claim is stale.
- Ideas: `ideas/<slug>.md`, Dez's idea store.

This is a temporary exception. The standing rule is that memory holds no progress state,
because state kept there rots silently. When Linear and HackMD are set up, move these files
across and delete this section.

The older top-level memory files (`plunderland-*.md`) are notes from earlier sessions. Several
carry states such as `NOT YET FIXED`; check them against the code before relying on them.

### Task template

```
# <imperative title naming the change>
<STATE> <date>

**Why:** the problem, linking the idea, decision or snag it comes from.
**Spec:** what the change does. For balance work, the values Dez proposed and Nick accepted.
**Branch:** the branch to cut the worktree from.
**Allowed paths:** the files and folders Beck may edit.
**Contract change:** yes or no. If yes, name both the server and client sides.
**Completion criteria:** checkable statements. Typecheck, tests and build passing are assumed.
**Ruled out** (bugs only): refuted theories, who refuted them and how.

---
**Handoff note** (Beck): what changed, tests covering it, mutation checks run, what couldn't be verified, proposed doc changes.
**Code review** (Archie): files read, tests re-run, contract check, result.
**Behavioural review** (Dez): what was re-run, match against spec, result.
**Accepted** (Nick): date.
```

## Repo and contract

One repo holds both sides: `plunder-land-client/` and `services/battle-royale-server/`.
Beck's worktree covers both. Nick often has uncommitted work in the main checkout; it is his.

There is no separate contract directory. These are the contract, and each must change on
both sides in the same task (details in `docs/wire-format.md`):

- The field tables: `fieldOrder` in server `src/objects/gameobject.ts` and `allFields` in
  client `src/game.ts`. Identical and **append-only**.
- The binary record layouts: `Multiplayer.packRecords` / `Game.unpackRecords`, the 8-byte
  `update` header, the 4-byte `pointer` input, and `hello`.
- The `standings` record (`[0][uint16 rank]` after the name): server `Multiplayer.rankStandings`
  / `StandingsBoard`, client `src/ui/components/standings.ts` (`decodeStanding`, `pickShown`).
- `utils/skills.ts` (mirrored; ids append-only), `hello.skills` and the `skill` slot as an index into it, `start_requested.loadout`, `save_loadout`/`loadout_saved`, and `account.loadouts` (#48 step 4); the `full` event (burst-capacity; server `network/worlds.ts` `refuseFull`; client `net/full.ts`, `game.ts`, `ui/lobby/lobby.ts`); `account.energy`, the `energy` event and `start_refused` (#48 step 7; server `network/worlds.ts` `admit`/`refundRun`, `progress/energy.ts`; client `net/energy.ts`, `game.ts` `onStartRefused`, `ui/lobby/lobby.ts`); the `season` event and `/season` (#48 step 6; server `network/worlds.ts`, `progress/seasons.ts`, `db/pgstore.ts` `RANK_ORDER`; client `net/season.ts`; `/season` rows carry sanitised names with public ids); `start_requested.robot`/`.finish` played as the account's level allows and `save_loadout` refusing a locked robot (#48 step 5; server `progress/unlocks.ts`, `multiplayer.ts` `startRequested`, `progress/loadouts.ts` `parseSave`; client `ui/lobby/locks.ts`, `lobby.ts`) (step 4: server `progress/loadouts.ts`, `network/worlds.ts`, `multiplayer.ts`; client `net/loadout.ts`, `net/session.ts`, `net/account.ts`, `ui/lobby/loadoutpanel.ts`).
- `utils/hex.ts` and `utils/path.ts`, byte-identical in both packages; `mirror.spec.ts`
  enforces it.
- `LocalPlayer._step` (client) mirrors `Unit.update` (server). If one changes, so does the other.
- The `account` event and the handshake `auth.token` (#48; server `network/worlds.ts`,
  `db/accounts.ts` `TOKEN_SHAPE`; client `net/account.ts`, `index.ts`). The token shape is
  duplicated on both sides by hand. Also its standing fields (`xp, level, levelAt, nextAt`) and
  the `progress` event (#48 step 3; server `network/worlds.ts` `grant`, `progress/xp.ts`
  `standingOf`; client `net/account.ts`, `index.ts`, `ui/popups/runsummary.ts`, `ui/lobby/lobby.ts`).
- `utils/gear.ts` (mirrored; `GEAR_STATS` ids append-only; `encodeGear`/`decodeGear` are the
  instance bytes inside fields 25 and 26), the fields 25 `gear`, 26 `carried` and 27 `speed`
  (`WIRE_NAME` maps `maxVelocity` to 27; index 10 is never written) and `use_item` slots 2-3 casting
  gear (#49, 49-1/49-2; server `objects/gameobject.ts`, `objects/player.ts`, `objects/gearpickup.ts`,
  `network/multiplayer.ts`; client `game.ts`, `net/records.ts`, `objects/gearpickup.ts`,
  `ui/components/gearpanel.ts`; spec `gear/gearwire.spec.ts`). **Type 128 is shared by item and gear
  pickups**: anything that walks `World.ITEMS` must decide what it does with `World.GEAR`.
- `start_requested.bring` and the `stash` event (with `run`) (#49, 49-4; server `network/worlds.ts`
  `admit`/`gearEnded`, `gear/stash.ts`, `multiplayer.ts` `parseStart`; client `net/stash.ts`,
  `ui/lobby/stashpanel.ts`, `lobby.ts`, `game.ts`, `index.ts`, `ui/popups/runsummary.ts`; spec
  `gear/stashclient.spec.ts`), and `merge`/`merged`, `scrap`/`scrapped` (49-5; server
  `network/worlds.ts`, `gear/merge.ts`; client `net/stash.ts`, `ui/lobby/stashpanel.ts`; spec
  `gear/stasheditclient.spec.ts`, which runs the client's `mergeCheck` against the server's
  `mergeOutcome`). `run_end`'s `gear_brought`, `gear_found`, `gear_kept` are append-only like every
  GA param. Migration 6 (`stash_items`, `gear_holders`) is additive only, as every migration.
- `PROTOCOL` (`utils/protocol.ts`, mirrored; 9 since the re-test build, #58 retest-8, `307cb56`, not yet live 2026-11-03; 8 since pve-2, live at `502b902` (confirmed 2026-10-12: Railway `release 502b902`, a production join got `protocol: 8`); 7 since L1, l1-2; ice-1's effect 21 needed no bump): bump it with any change an older
  client can't read, or (as in #48) one an older client would silently misbehave against.
- **The NPC roster (#51, L1):** the mirrored `utils/archetypes.ts` rows 9-15 with `rarity` and
  `attack` (`NPC_SHARED`; the client draws and threat-marks `attackCells`, `effectcells.spec.ts`);
  effect types 9-21 (server `archetypes/npceffects.ts` `NPC_EFFECT`, client `vfx/npceffects.ts`,
  `npceffects.spec.ts`; append-only; drawn in `game.ts` `onEffect` and `src/vfx/*.effect.ts`;
  **every new effect type goes in this table, NPC or not**, and it keeps the name `NPC_EFFECT`
  (a rename is a removal): 21 `frozen` is the ice skills' (#54, ice-1; drawn by ice-2's
  `vfx/frozen.effect.ts`), and effect 16 (slowed) is now also sent by Icicle and Ice Breath; 14,
  the old Compactor line, is sent by no server since pve-2 and its client case goes in pve-3); the
  knockback mirror, server `Player.knockback` against client `LocalPlayer.knockback` with `Game`
  applying effect 15 after the same flush's `lastInputSeq` (`extract.spec.ts`); a Broodling's
  remaining fuse in `lifetime` (9) on its create (server `mobskills/broodling.ts`, client
  `objects/mob.ts` `fuseEndsAt`); gear tier 4 in fields 25/26 and `stash` (mirrored `utils/gear.ts`,
  `GEAR_TIERS` 4), migration 7 (`stash_items_tier_check` 1-4), and Redis `stats-*`
  `commonKills..legendaryKills` (`bossKills` frozen); `bodyRings` on every row of the mirrored
  `utils/archetypes.ts` (#52 ring footprint; not on the wire, read by the server's hit and step
  rules and the client's beam). Docs: `docs/npcs.md`.
- **The re-test build (#58, retest-1..8):** the server event **`handoff`** `{}` (server
  `network/worlds.ts` `Worlds.handoff`, emitted before the shared world's `hello`; client `game.ts`
  `onHandoff`, `net/handoff.ts`; `firstrun.spec.ts`, `runmap.spec.ts`); **`start_requested.firstRun`**
  (client `game.ts`, always `true`; server `multiplayer.ts` `parseStart`, a literal `true` only;
  order-independent); the first run's pad is portal type 8 with `to === tag` (`firstrun/gate.ts`;
  no new type id); **migration 8** `first_runs` (additive like 6/7, no backfill; `db/migrations.ts`,
  `pgstore.ts` `resolve`/`finishFirstRun`); **archetype 16 `rock`** (mirrored `utils/archetypes.ts`,
  server row in `archetypes/archetypes.ts`, client `objects/archetypesprites.ts` `LOOKS.rock`;
  `wire.spec.ts`); the mirrored `utils/skills.ts` unlock levels (Melee 2, Defend 3) and `START_KIT`
  `[1, 3, 0, 0]`; GA `first_run_start`/`first_run_done`/`first_run_left` (append-only); and
  **PROTOCOL 9**. Auto-aim changed no byte: the client sends its picked cell in the unchanged
  `skill`/`use_item` message (`skills/autoaim.ts`, pinned against the server's ranges by
  `autoaim.spec.ts`), and it must target only what the client draws (`renderable`), a reader of
  who-is-sent-what below. Docs: `docs/world.md` and `docs/accounts.md` ("First run"),
  `docs/skills-and-gear.md` ("Auto-aim").
- **Private layers (#60, private-1..10):** `hello.voids[i]` is one all-void run `[0, cells]` (and
  `walls[i]` `[]`) for a layer the world does not hold (server `World.unheldRuns`, `multiplayer.ts`
  hello; client `net/session.ts` `decodeRuns`, no edit); `hello.layers` stays every tag in every
  world, five since private-8 (tags -3, -4 appended; the client reads any list). A pad out of the
  world is a wire Portal (type 8) with a real `to` the world doesn't hold: the server's
  `Player.stopsOn` (`portalOn || padOn`) must match the client's `LocalPlayer._stopsOn`. A run can
  get **two `handoff`s** (first run's pad, then the private world's, `Worlds.padHandoff`; client
  `net/handoff.ts`, `runmap.spec.ts` plays both); the pad's join sends no second `run_start`
  (`Join.continues`). GA `private_done { seconds }` (append-only). Docs: `docs/world.md` "Partial
  worlds", "Private worlds"; `docs/wire-format.md` (`hello`, `handoff`).
- **Portal accounts (CrazyGames identity, g2-6b server / g2-6c client; decision #62):** the handshake
  `auth.portalToken` (CG's `IN_GAME_AUTH` JWT, 1-4096 chars, read only with `auth.portal:
  'crazygames'`; server `network/portaltoken.ts` `portalTokenOf`, client `net/account.ts`
  `handshakeAuth`); `account.portal` (a linked account, and then **never** `account.token`) and
  `account.linkable: true` (the rule 4b offer; nothing set until the answer); the client event
  `portal_link { accept: boolean }` (READY first is a decline); server `network/worlds.ts`
  `lookup`/`portalLookup`/`portalLink`/`accountMessage`, client the `account` handler in `index.ts`.
  Additive, no PROTOCOL bump: an old client sends neither key and sees neither field; a new client
  on an old server gets guest play, so it **never waits for `linkable`**. Store: `PortalStore`
  (`db/accounts.ts`, memory and pg; `portalContract` in `db/storecontract.ts`) and **migration 10
  `account_links`** (PK `(portal, external_id)`, UNIQUE `(portal, account_id)`; additive; a future
  userbase reset must empty it too). **A linked account is never entered with a guest token (rule
  4d)**: `lookup` and `retryAccount` both treat a resolved account with `portal` as no account.
  The verifier pins `alg` RS256 and `kid` `ingame-auth` before any key is read; the JWKS URL is a
  constant, never an env var. Inert until `CRAZYGAMES_GAME_ID` is set on Railway. GA `portal_link
  { result }` (append-only). Docs: `docs/accounts.md` "Portal accounts", `docs/wire-format.md`
  (`account`), `docs/dev-and-ops.md` (`CRAZYGAMES_GAME_ID`).
- **Who is hit against what the client draws** (no byte, but both sides): server
  `World.FIRST_ON_LINE` with `RangedAttack.stopsOn` (a mob's shot passes mobs) and the 7-cell
  bodies (`World.bodyAt`), against client `vfx/cells.ts` `firstOnLine`/`lineIndexOf` and the
  candidate filter in `vfx/rangedattack.effect.ts` (`effectcells.spec.ts` sweeps `firstOnLine`;
  the filter is unspecced). Likewise `FIND_IN_CELLS`/`CONE_CELLS` against `discCells`/`coneCells`
  and every NPC `attackCells`, including the Compactor's slam: server `FIND_IN_CELLS(stepTo ?? cell,
  rings)` against client `attackCells(disc, centre)` from effect 20's centre cell
  (`shockwave.spec.ts`, with the caster seen a cell off). Change a hit rule, change the drawing.
- **Who is sent what is a contract too, though no byte changes** (server fog, #48):
  `Multiplayer.viewOf` and the effect paths (`effect`, `effectAt`) on the server against what
  the client draws (`objects/fog.ts`, `Game.onEffect`). `interest.spec.ts` (and
  `interest.framed.spec.ts` over frames) holds exact held sets every tick.
- **A new run may be in another world** (#39): the client clears its map, fog and ids on every
  `Game.start` (`resetForRun`, `net/runmap.ts`). Any new per-run client state must be reset there;
  `runmap.spec.ts` plays a run in one world and the next in another.

## Verification

```
cd plunder-land-client           && npm run typecheck   # baseline 22 errors (2026-10-02), see CLAUDE.md
cd services/battle-royale-server && npm run typecheck   # must stay at 0
cd services/battle-royale-server && npm test            # node --test over src/**/*.spec.ts, memory-guarded (never bypass)
```

The client has no tests, and its build does not run the typechecker, so a client build
passing proves nothing about types. Any client error outside the three known groups listed in
CLAUDE.md is a regression; compare the sorted list, not just the count. (Measured 2026-10-05 at
`cb645f2`, after #49: client 22, server 0, 979 tests with 21 pg skips; 995 / 23 after admin-endpoints.) A fresh worktree needs
`npm ci` in `plunder-land-client` as well, or the server specs that import client modules fail to load.

`src/db/pgstore.spec.ts` and `src/gear/stashpg.spec.ts` need `TEST_DATABASE_URL`; without it the suite reports 23 pg skips. pgstore.spec drops the
`public` schema, so it refuses any host but localhost; use a throwaway `postgres:18-alpine`
container on a spare port, removed by name (command in CLAUDE.md, "Verification path"). Never
point it at Railway.

Running locally: CLAUDE.md, "Running locally"; smoke-testing: `docs/dev-and-ops.md`.

## Running Beck lanes in parallel

Learned running two or three Beck worktrees at once through M0 and M1 (2026-09-24/25). Put
rules 1–3 in every Beck brief, and follow 4–6 at every hand-back.

1. **A Beck worktree is created at a stale commit (`2458cf0`), not at `main`.** It happened on
   every spawn. The brief must say: "`git log --oneline -1` must show `<current main>`; if
   it doesn't and the tree is clean, reset to `main`."
2. **Assign wire indices centrally.** Two lanes appending to `fieldOrder` will take the same
   index (extraction and items both took 17). Tell each lane which index is free, or have it
   keep the index in one constant and ask at merge. `fieldtable.spec.ts` catches a
   client/server mismatch, not a collision in intent.
3. **Leave Nick's local stack alone.** Each Beck runs its own server and its own Redis
   container on spare ports, never 6379 or 8000, and stops its processes **by PID, never
   with `pkill -f`**. A pattern kill takes out other lanes' servers too.
4. **Merge one lane at a time, rebase the others, then run the full suite at least 10
   times.** Rebases silently broke the other lane's new specs more than once, and rare flakes
   only showed on the combined code. Capture a flake by name in a loop; never wave it
   through. So far every one came from a spec ticking a random `new World()` (CLAUDE.md).
5. **Review the diff before merging.** Look closely at accessor and field changes (the
   class-field shadowing trap in CLAUDE.md) and at anything the hand-back calls "code-read
   only".
6. **A stalled Beck (the 600 s watchdog) can be resumed.** Check its worktree first, then send
   a narrow "finish only X, and check no mutation is still applied" message.
   **"Waiting on its own background work" is not a stall.** Before calling a Beck stuck, look
   for its processes by what they are (listening ports via `lsof -nP -iTCP -sTCP:LISTEN`, and
   `ps` for `ramp.sh`/`loadbot`), not by its worktree path: a load run started from the
   scratchpad doesn't have the path on its command line. On 2026-09-26 a path-only grep said
   "nothing running", and the message that followed made P3's Beck stop its own load run.
7. **One suite at a time across all lanes.** On 2026-10-03/04 several Becks, an Archie and the
   lead ran `npm test` loops at once; the load average reached 60, a 3 s accounts spec hung for
   925 s, and Becks stalled on the watchdog four times. A Beck that has stalled twice carries a
   huge context and tends to stall again, often at once on resume: commit its work-in-progress
   from the lead session (`WIP` commit), then either finish small fixes there or start a fresh
   Beck from that commit (48-5 finished that way on 2026-10-04).

And check any value, pattern or count before putting it in a brief. An example gets built
literally: an id pattern given as "for example" would have locked out every real client.

## Deploy

- **The client deploys to Cloudflare as an assets-only Worker, `plunder-land`, on any push to
  `main`** (decision #40; a Worker with Workers Builds instead of Pages since 2026-10-02):
  root `plunder-land-client`, build `npm ci && npm run build`, deploy `npx wrangler deploy`,
  which serves `dist` per `plunder-land-client/wrangler.jsonc` (its `name` must match the
  Worker). **`SERVER_URL` is a build variable** of the Worker's build settings, not a runtime
  variable: webpack bakes it in. Node 22 (`.node-version`, and `NODE_VERSION` in the build
  variables). Firebase Hosting was removed
  on 2026-09-28 (Firebase Analytics left the client on 2026-10-02, #46). The repo is
  `github.com/Nick-TTFN/plunder-land` (moved from LTcolombo 2026-10-02; push over SSH as
  Nick-TTFN). `main` was first pushed 2026-10-02 (`fdbe8c7`). Every push to `main` is a
  release: push only when Nick says so, for that push.
- **The server deploys to Railway** (project `plunderland`, region EU West Amsterdam, since
  2026-10-02), built by Railway's GitHub integration from `main`: root
  `services/battle-royale-server`, `npm run build`, then `node dist/index.js`, with a Railway
  Redis (`REDIS_URL`) and a Railway **Postgres 18** (decision #48;
  `ghcr.io/railwayapp-templates/postgres-ssl:18`, provisioned 2026-10-03), which the server's
  `DATABASE_URL=${{Postgres.DATABASE_URL}}` references. Without it the server runs on the
  in-memory account store and Sentry says so. Migrations run at boot in the background and are
  additive only, because overlap and drain run the old server on the new schema. Keep compose's
  image on the same major. **Deploy settings are on the service** (set through `railway api`,
  `serviceInstanceUpdate`): start `node dist/index.js` (not `npm start`, so SIGTERM reaches
  node), healthcheck `/healthcheck` 60 s, restart on failure ×10, sleep off, overlap 30 s,
  draining 600 s. Railway deprecated `railway.json` on 2026-10-02 in favour of
  `.railway/railway.ts`; not adopted yet. It
  redeploys only on a push that touches `services/battle-royale-server/**` (watch paths).
  **A redeploy drains** (decision #46): the old process takes no new runs and plays out the
  live ones for up to `DRAIN_MAX_MS` (570 s) after SIGTERM, then stops. The client still ships
  first, and a server push is still a release. Public URL: `https://server-production-e1da2.up.railway.app`,
  which is the client Worker's `SERVER_URL` build variable. Check a deploy with
  `railway logs --service server` and a socket.io join (`hello`, then `create`/`update`).
- There is no config endpoint to poll, so a client deploy can only be reported as pushed.
  Report the Worker deployment's result if it can be read (the account token reads
  `workers/scripts/plunder-land/deployments` but not Workers Builds logs, [[reference-deploy-credentials]] in memory); otherwise say it is unverified.

## Dez

- **There is no simulator yet.** Dez's first task is to spec one (`tasks/spec-simulator.md`).
  Until it exists, proposals rest on measured runs (a scripted `socket.io-client` bot, logged
  stats, timings, as the docs already measure the dash and the tick) or on reasoning plus
  Nick's playtest, and say which.
- Tunable values are not separated from mechanism code. Known ones: `IMPULSE_FRICTION` in
  server `src/objects/unit.ts`, `World.DROPPED_LOOT_LIFETIME` in `src/objects/world.ts`, level
  handling in server `src/objects/player.ts` (`setLevel`), and `LEVEL_THRESHOLDS` in client
  `src/ui/components/playerstats.ts`, and `PROGRESSION` in server `src/progress/xp.ts` (XP
  formula and level curve, #48), `SEASON` in `src/progress/xp.ts` (season eligibility, credit cap and tiers, server only), `unlockLevel` on the robot rows of the mirrored `utils/archetypes.ts` and the colour and pattern rows of `utils/finishes.ts` (a retune needs both deploys, client first), `unlockLevel` and `LOADOUT_SLOTS` in the mirrored `utils/skills.ts` (a retune needs both deploys, client first), and `botKit` in `bots/brain.ts`, and **`BOT_SKILL`** in `bots/brain.ts` (#58, retest-7: one row per layer, top first: `reactionMs`, `aimMiss`, `engageRings`, `descend`, `robots`, `temperaments`, `cargo {chance, tier}`, `hpScale`, `damageScale` (#60 Q7: 0.5 / 0.75 / 1); five rows since private-8; 900 ms / 60% on layer 01, #58 addendum 4; server only), and for auto-aim (#58, retest-1): **`AUTO_AIM`** in client `skills/autoaim.ts` (`ACQUIRE_RINGS` 6, `KEEP_RINGS` 7, `REPICK_MARGIN` 2, `BOMB_MIN_CELLS` 3; client only, one deploy; `AIM_RANGE_CELLS` beside it copies server constants and is not a tunable, `autoaim.spec.ts` pins it), and for the first run (#58, retest-4/5): **`FIRST_RUN_CAP`** (env on the server, default `FIRST_RUN_CAP_DEFAULT` 50 per process, provisional; over it a start plays a normal run), `HANDOFF_CLEARANCE` 6 in `network/worlds.ts`, and the strip in `FIRST_RUN` (`firstrun/scenario.ts`: map size, legs, rock, Crawler, Compactor and pad positions; server only), and for the private layers (#60): **`PRIVATE_CAP`** (env, default `PRIVATE_CAP_DEFAULT` 500 per process, provisional; over it a start is sent `full`; 0 = no cap), **`PRIVATE_BOTS`** (env, a comma list of bots per private layer top first, default `PRIVATE_BOTS_DEFAULT` `[2, 3]`), `PRIVATE_MAP_SIZE` 2000 and `PREFILL_TICKS` 32 in `network/worlds.ts`, `PRIVATE_MAP_SEED` in `objects/privatemap.ts` and the `owned` flag on `LAYERS` rows (a changed seed, generator or private row is a new map for every player, `privatemap.spec.ts` `DIGEST`; server only), and for gear (#49): the `GEAR_STATS` ranges (a T4 column since L1) and caps and `rollCount` in the mirrored `utils/gear.ts` (both deploys, client first), mob drops by rarity in `MOB_GEAR_CHANCE`/`MOB_GEAR_ROLLS` and the caches and `mobMix` in `LAYERS[].gear`, all in `archetypes/archetypes.ts` (server only), `PART_MERGE_SKILL_CHANCE` in `gear/merge.ts` (four keys since L1, `{1: 0.15, 2: 0.25, 3: 0.35, 4: 1}`; server only; the client copies no odds), and `BOT_CARGO` in `bots/brain.ts` (only `skillShare` 0.3 since #58 retest-7; the cargo chance and tier are per layer in `BOT_SKILL`'s `cargo`: 25% T1, 25% T1, 40% T2, 50% T2, 40% T3), and for ice (#54): `FREEZE` in `buffs/freeze.ts` (normal and boss chill rules, freeze lengths, lockout, weaker metal x1.5, the ice slow; server only, the client reads a freeze's length from effect 21's lifetime and a slow from `speed` (27)). And for the NPCs (#51, L1; l1-0 accepted, retuned by #53): `NPC_NUMBERS` in
  `archetypes/archetypes.ts` (stats, guards, attacks, timings, pack sizes, per-layer populations;
  server only) and `NPC_SHARED` in the mirrored `utils/archetypes.ts` (Crawler range and every
  attack's cells; both deploys, client first); NPC kill XP in `PROGRESSION.kills.mob`. Some
  timings in `NPC_NUMBERS` are the approved clips' (Reactor, Coil, Brood release): retuning them
  desyncs the art, and the #52 wind-up holds must outlast their clip's wind-up event and the
  render delay (`windupclient.spec.ts`). Dez states values in the spec and Beck applies them.
- **Do not re-propose tuning the tick (`TICK_MS`) as a latency fix.** See `docs/world.md`,
  Known-unfixed.
- Art is Nick's boundary. Two player clips are still missing (the arena pass of 2026-09-28
  covered everything else); all seven NPCs are drawn from Codex rigs, five of them (Kiln, Coil,
  Compactor, Reactor, Brood) PROVISIONAL until Nick approves their packages (l1-9), and the NPC
  effects from the `npc-fx` sheet, PROVISIONAL too (l1-11). Sizes, gaits and holds are #52's. #53
  made no art: the Compactor's strike clip starting partway, its wave cells turned outward for
  the radial slam, and the Coil's art over 3 rings are PROVISIONAL for Nick's look (`docs/npcs.md`).
  The frozen look (#54, ice-2: ice tint 0x9fd8ff and the arena's snowflakes) is PROVISIONAL too; no
  ice art exists (wanted: an ice shell or frozen overlay and a frozen-status loop, for 1-cell and
  7-cell bodies, and optionally a thaw one-shot; `docs/npcs.md`, "Frozen look").
  List what is missing, don't make it.
