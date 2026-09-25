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
- The order of `Player.skills` (server `src/objects/player.ts`) against the HUD bar.
- `utils/hex.ts` and `utils/path.ts`, byte-identical in both packages; `mirror.spec.ts`
  enforces it.
- `LocalPlayer._step` (client) mirrors `Unit.update` (server). If one changes, so does the other.

## Verification

```
cd plunder-land-client           && npm run typecheck   # baseline 28 errors, see CLAUDE.md
cd services/battle-royale-server && npm run typecheck   # must stay at 0
cd services/battle-royale-server && npm test            # node --test over src/**/*.spec.ts
```

The client has no tests, and its build does not run the typechecker, so a client build
passing proves nothing about types. Any client error outside the three known groups listed in
CLAUDE.md is a regression; compare the sorted list, not just the count. (Measured 2026-09-25:
client 28, server 0.)

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

And check any value, pattern or count before putting it in a brief. An example gets built
literally: an id pattern given as "for example" would have locked out every real client.

## Deploy

- **The client deploys to Firebase Hosting (project `plunderland`) on any push to `main`**,
  via `.github/workflows/firebase-hosting-merge.yml`. Local `main` is well ahead of
  `origin/main` (check with `git rev-list --count origin/main..main`) and has never been
  pushed, so **the first push is a release.** Push only when Nick says so, for that push.
- The server is not deployed anywhere. There is no server deploy sequence yet.
- There is no config endpoint to poll, so a client deploy can only be reported as pushed.
  Report the GitHub Actions run's result if it can be read; otherwise say it is unverified.

## Dez

- **There is no simulator yet.** Dez's first task is to spec one (`tasks/spec-simulator.md`).
  Until it exists, proposals rest on measured runs (a scripted `socket.io-client` bot, logged
  stats, timings, as CLAUDE.md already measures the dash and the tick) or on reasoning plus
  Nick's playtest, and say which.
- Tunable values are not separated from mechanism code. Known ones: `IMPULSE_FRICTION` in
  server `src/objects/unit.ts`, `World.DROPPED_LOOT_LIFETIME` in `src/objects/world.ts`, level
  handling in server `src/objects/player.ts` (`setLevel`), and `LEVEL_THRESHOLDS` in client
  `src/ui/components/playerstats.ts`. Dez states values in the spec and Beck applies them.
- **Do not re-propose tuning the tick (`TICK_MS`) as a latency fix.** See CLAUDE.md,
  Known-unfixed.
- Art is Nick's boundary. Four skill icons, two player clips and an icicle sprite are missing;
  list them, don't make them.
