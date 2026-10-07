# Plunderland — working notes

This file is loaded into every session, so it holds only what every session needs: what the
game is, how to verify, the rules at consumed boundaries, and the traps that fail silently.
**Everything else is in `docs/`** (index below). Read the doc for an area before changing it.

## What this is

An **extraction game**, not a battle royale: no rounds, no lobby match, no shrinking zone.
Players join a `World` at a random point, loot, and leave through an `Exit` (a channel of
`LAYERS.extractMs`), which banks the run; death scatters their loot (`createLootFrom`). A
process holds several worlds (`WORLD_CAP`, `src/network/worlds.ts`). Three ground layers,
tags 0 / -1 / -2, deeper is richer and deadlier; every per-layer number is in `LAYERS`
(`src/archetypes/archetypes.ts`), every unit stat in `ARCHETYPES` beside it, and **the client
never hardcodes a layer tag** (`hello.layers`). `services/battle-royale-server` is a leftover
name. The world lives in memory only; Postgres holds accounts, progression and the stash,
Redis cumulative `stats-*`. So: no serverless or sleep-enabled hosting.

Decisions are numbered (#1–#51) in the project memory's `decisions.md`; task records and the
backlog are there too (`.claude/TEAM.md` explains the crew and the task store).

## Where things are documented

| Topic (quoted section names in the docs) | File |
|---|---|
| World, layers, portals, spawns, valleys, walls ("What this actually is", "Walls inside the islands"), known-unfixed | `docs/world.md` |
| Server invariants: worlds per process, `World.run`, `Timers`, cell indexes, dead units, spec flakes ("Things that are deliberate") | `docs/server-invariants.md` |
| Verification detail, builds, Node/swc, Railway IaC, running locally, Sentry, GA4, bundle size, lockfiles | `docs/dev-and-ops.md` |
| Load harness, tickbench, CPU per player | `docs/load-testing.md` |
| Wire format: frames, records, field indices, interest/fog ("Who gets what"), every event, draining, burst capacity | `docs/wire-format.md` |
| Hex grid, routing, prediction, interpolation, mob steps, liveness | `docs/movement.md` |
| Robot stats table, rigs, eye shot, finishes | `docs/robots.md` |
| Generated sheets (hex, ground, arena, blasts), tilt, unused atlas frames | `docs/art-pipeline.md` |
| Settings, lobby, stash panel, fog drawing, markers, run card, input and touch | `docs/client-ui.md` |
| Accounts, loadouts, XP, seasons, energy, stash store, admin endpoints ("Accounts") | `docs/accounts.md` |
| Skills, areas of effect, projectiles, StoneWall, gear and merge ("Skills", "Gear") | `docs/skills-and-gear.md` |
| Bots and spectating | `docs/bots-and-spectate.md` |
| NPC roster, packs, mob attacks and their timers, Broodlings, NPC rigs ("Attacks", "Client: rigs and sprites") | `docs/npcs.md` |

## Verification

```
cd plunder-land-client           && npm run typecheck   # 22 errors baseline, see below
cd services/battle-royale-server && npm run typecheck   # must stay at 0
cd services/battle-royale-server && npm test            # node --test via ts-node
```

- Only the **server's** typecheck is enforced by a build. The client builds through Babel,
  which strips types, so client type errors never fail a build.
- The server's `tsconfig` excludes `*.spec.ts`: **specs run but are never typechecked**.
- `pgstore.spec.ts` and `stashpg.spec.ts` need `TEST_DATABASE_URL` (otherwise 23 skips) and
  refuse any non-local host. Throwaway container, removed by name afterwards:
  `docker run -d --name plunder-pg-spec -p 5439:5432 -e POSTGRES_PASSWORD=spec postgres:18-alpine`,
  then `TEST_DATABASE_URL=postgres://postgres:spec@127.0.0.1:5439/postgres npm test`.
- A fresh worktree needs `npm ci` in `plunder-land-client` too: many server specs import
  client modules.
- Builds: `npm run build` in each package (client webpack, server swc to ES2022).
- **Tick time is noisy.** Judge a CPU change only old vs new commit back to back, twice each,
  or with `tools/load/tickbench.cjs`; see `docs/load-testing.md`. State tickbench before/after
  for any per-player cost and ask Nick.
- The load harness refuses ports 6379 and 8000 and stops processes by PID; keep it that way.

### Client typecheck baseline: 22 errors

Fixing them to zero is not expected. Known-benign: 3 × `Point` vs `ObservablePoint` (pixi
copies the value; typings only), 17 × `setHP`/`setMaxHP`/`loot`/`pushState` missing on
`GameObject` in `game.ts`'s `onObjectUpdated` (`LOOKUP` typed too wide; a deliberate
non-refactor), 2 nits (`skills/dash.ts` possibly-undefined, `skills/skill.ts` `uiTexture`
uninitialised). **Anything outside these groups is a regression. Compare the sorted error
list, not the count.**

## Running locally

```
mkdir -p services/saved/redis                # redis refuses all writes without it
cd services && docker compose up -d          # redis + postgres 18 + game server on :8000
cd plunder-land-client && npm start          # dev server, defaults to http://localhost:8000
```

`services/battle-royale-server/.env` (gitignored) must exist:

```
PORT=8000
REDIS_HOST=redis
REDIS_PORT=6379
DATABASE_URL=postgres://postgres:plunderland@postgres:5432/plunderland
```

`?server=<url>` overrides the server address at run time. A production client build fails
without `SERVER_URL`. Smoke-test recipe, Postgres volume notes and more: `docs/dev-and-ops.md`.

## Consumed boundaries: additive only, client first

Old clients stay open across releases and other code reads these formats, so:

- **Wire field indices** (`GameObject.fieldOrder` on the server, `allFields` on the client)
  are identical (`fieldtable.spec.ts`) and **append-only**. A new index breaks old clients
  mid-record, so **ship the client first**. No square brackets in comments inside the
  client's `allFields` (the spec's regex stops at the first `]`).
- **Bump `PROTOCOL`** (`utils/protocol.ts`) for any change an older client can't read or would
  silently misbehave against.
- Append-only too: frame kinds and version, archetype ids, effect types (`NPC_EFFECT`, both
  sides), item/skill/finish/gear-stat ids, Redis `stats-*` keys, projectile kinds, `Standing`
  statuses, stash `source` values, GA4 event names and params (`src/analytics.ts`), Postgres migrations (`db/migrations.ts`: additive, because the old
  server runs on the new schema during a drain). **Renames are removals.**
- `utils/{hex,path,archetypes,items,finishes,protocol,skills,gear}.ts` are **byte-identical in
  both packages** (`mirror.spec.ts`). Change both.
- A uint8/uint16 wire field fed by an unbounded value can throw inside `World.update`, skip
  `flushAll` and freeze the world every tick. Saturate or clamp at the encoder.
- Lockfiles are committed. Never re-ignore them; smoke-test any dependency bump (an unpinned
  socket.io-parser once broke the game completely).

## Traps that fail silently

- **Never declare `armor`, `maxArmor` or `kills` on `Unit`/`Player`**: it shadows
  `GameObject`'s accessor and the field is never sent. The server typecheck (TS2610) catches
  it; swc alone does not. Fields a base constructor sets from a hook must be `declare`d.
- **The client's Babel rejects `declare`.** A client field set from a base-constructor hook
  gets no initialiser and no `declare` (Babel drops an uninitialised field, as `Mob.npc` and
  `Player.robot` rely on); an initialiser would reset it after the hook ran.
- **Mob skills are server classes; never add one to the mirrored `utils/skills.ts`.**
  `rollGear` picks uniformly over `SKILL_LIST`, so it would drop as a player item.
- **A status re-applied every tick goes through a one-per-unit buff** (`FieldSlow.apply`), never
  `Unit.addBuff`, which stacks duplicates and compounds the effect each tick.
- **Delayed world work goes through `Timers`, never `setTimeout`** (which runs outside the
  tick's error boundary). Give a timer the object whose state it changes as owner.
- **A stats write ends in `.catch(Multiplayer.logStatsFailure)`, never `void`**: an unhandled
  rejection kills the process.
- **After an `await` no world is current.** Capture what the promise needs first; `World.strict`
  makes a stray `World.X` throw, on purpose.
- **A dead unit stays findable until the next sweep.** Anything that damages, credits or
  destroys a unit checks `destroyed` first. Count `!destroyed`, not `World.MOBS.length`.
- **Add and remove through the indexes** (`World.addUnit`, `World.PICKUPS.push`/`remove`,
  `World.addObstacle`…), never on the lists directly.
- **Type 128 is both `ItemPickup` and `GearPickup`.** Every place that walks `ITEMS` must
  decide what it does with `World.GEAR`; missing it sends nothing and errors nothing.
- **Projectiles are removed only in `World.updateProjectiles`** (walks backwards).
- **`LocalPlayer._step` mirrors the server's `Unit.walkPath`, and `LocalPlayer.knockback`
  mirrors `Player.knockback`** (effect 15, applied with the same flush's `lastInputSeq`):
  change one, change the other (`extract.spec.ts` will tell you).
- **A new ground-plane overlay needs `onGround`** or it draws unsquashed by the tilt.
- **`app.stage.hitArea` must cover the canvas** and `onPointerDown` ignores non-stage targets;
  a HUD button listens on its container, not its background.
- **Use `renderable` for fog, not `visible`** (other code drives `visible`).
- **A sprite name missing from every sheet** is fetched as a URL and throws on every use
  (`textures.spec.ts` checks literal names only).
- **Specs that tick a real `new World()`** get random exits, portals and mobs; clear them
  unless the test is about the map.
- Never `git checkout <file>` to undo a temporary edit; restore from a copy.

## Deliberate: do not "fix"

- Three movement mechanisms (predicted local player, interpolated remotes, animation from
  intent). Do not collapse them.
- **Do not tune `TICK_MS` as a latency fix**; that was tried and reverted repeatedly.
- StoneWall goes **behind** the caster. Mobs step greedily and may stall on valleys and walls.
  Walls don't stop shots. Effects aren't fogged inside the 500 box.
- The server deals ranged damage on the press; the client holds the beam to the eye shot.
- An energy refund is +1 whatever the stock (can end at cap + 1).
- XP is fixed at the run's end; a later kill doesn't add XP.
- `Unit.level` stays 1; account levels are separate.

## Keeping this file small

This file is the index and the rules, not the record. When a feature lands:

- Its mechanism, wire detail, numbers and rationale go in the matching `docs/<area>.md` (add a
  file and a row in the table above for a new area).
- Only a new **invariant, consumed-boundary rule or silent trap** comes here, as one bullet.
- No history ("was X before"), measurements, dates or attributions here. Those go in the
  docs, `decisions.md` or the task record.
