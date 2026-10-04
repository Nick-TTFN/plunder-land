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
both sides in the same task (details in CLAUDE.md, "Wire format"):

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
- `PROTOCOL` (`utils/protocol.ts`, mirrored; 5 since #48 step 7): bump it with any change an older
  client can't read, or (as in #48) one an older client would silently misbehave against.
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
cd services/battle-royale-server && npm test            # node --test over src/**/*.spec.ts
```

The client has no tests, and its build does not run the typechecker, so a client build
passing proves nothing about types. Any client error outside the three known groups listed in
CLAUDE.md is a regression; compare the sorted list, not just the count. (Measured 2026-10-03,
after 48-6: client 22, server 0, 825 tests with 13 pg skips.)

`src/db/pgstore.spec.ts` needs `TEST_DATABASE_URL`; without it the suite reports 13 pg skips. It drops the
`public` schema, so it refuses any host but localhost; use a throwaway `postgres:18-alpine`
container on a spare port, removed by name (command in CLAUDE.md, "Verification path"). Never
point it at Railway.

Running and smoke-testing locally: CLAUDE.md, "Running it locally".

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
  stats, timings, as CLAUDE.md already measures the dash and the tick) or on reasoning plus
  Nick's playtest, and say which.
- Tunable values are not separated from mechanism code. Known ones: `IMPULSE_FRICTION` in
  server `src/objects/unit.ts`, `World.DROPPED_LOOT_LIFETIME` in `src/objects/world.ts`, level
  handling in server `src/objects/player.ts` (`setLevel`), and `LEVEL_THRESHOLDS` in client
  `src/ui/components/playerstats.ts`, and `PROGRESSION` in server `src/progress/xp.ts` (XP
  formula and level curve, #48), `SEASON` in `src/progress/xp.ts` (season eligibility, credit cap and tiers, server only), `unlockLevel` on the robot rows of the mirrored `utils/archetypes.ts` and the colour and pattern rows of `utils/finishes.ts` (a retune needs both deploys, client first), `unlockLevel` and `LOADOUT_SLOTS` in the mirrored `utils/skills.ts` (a retune needs both deploys, client first), and `botKit` in `bots/brain.ts`. Dez states values in the spec and Beck applies them.
- **Do not re-propose tuning the tick (`TICK_MS`) as a latency fix.** See CLAUDE.md,
  Known-unfixed.
- Art is Nick's boundary. Every unit and two player clips are still missing (the arena pass of
  2026-09-28 covered everything else); list them, don't make them.
