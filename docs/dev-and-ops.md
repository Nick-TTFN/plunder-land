# Development, builds and operations

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Verification path

Both packages typecheck, but **only the server's typecheck is enforced by its build**.
The client compiles through `babel-loader` + `@babel/preset-typescript`, which strips
types without checking them, so `tsc` errors never fail a client build.

```
cd plunder-land-client        && npm run typecheck   # 22 errors — see baseline below
cd services/battle-royale-server && npm run typecheck # must stay at 0
cd services/battle-royale-server && npm test          # node --test via ts-node
```

The server's `tsconfig` excludes `*.spec.ts`, so **specs run but are never typechecked**. A
type error in a spec only shows up if ts-node trips over it at run time.

**`src/db/pgstore.spec.ts` and `src/gear/stashpg.spec.ts` run only with `TEST_DATABASE_URL`**
and otherwise the suite reports 23 pg skips (995 tests after admin-endpoints, measured 2026-10-05).
pgstore.spec drops and recreates the `public` schema, so it refuses (fails, not skips) any host but
127.0.0.1, localhost or ::1 (`isLocalDatabase`); stashpg.spec works in its own database
(`plunder_stash_spec`) on the same server, because spec files run in parallel. Use a throwaway container on the same major as
Railway, removed by name afterwards:
`docker run -d --name plunder-pg-spec -p 5439:5432 -e POSTGRES_PASSWORD=spec postgres:18-alpine`,
then `TEST_DATABASE_URL=postgres://postgres:spec@127.0.0.1:5439/postgres npm test`.

**A fresh worktree needs `npm ci` in `plunder-land-client` too**, not only in the server: many
server specs import client modules, and without the client's `node_modules` (pixi's types among
them) those fail to load (15 spec files in 49-3's worktree).

Load testing (`tools/load/`, `tickbench.cjs`) is in `docs/load-testing.md`; the unit stats table in `docs/robots.md`.

Builds:

```
cd plunder-land-client        && npm run build   # webpack -> dist/
cd services/battle-royale-server && npm run build   # swc -> dist/
```

**The server builds to ES2022** (`.swcrc`: `jsc.target` with `useDefineForClassFields: true`,
server-cpu-trim, 2026-09-26). With no target swc compiled to ES5, which is slower and also
**differed from what the specs run**: it rewrites `\p{…}` regexes into code-point tables from
its own Unicode version, and `Player.sanitiseName` then failed the names fuzz spec 20 times
out of 20 against the swc build (0 of 20 at ES2022, which keeps the regexes native). The specs
run through ts-node (tsc, `ESNext`, define semantics), and define semantics are pinned in
`.swcrc` so the two agree on class fields. **The server runs Node 24** (`.node-version`, pinned 2026-10-02: Railway's Railpack had picked its LTS default, 24.21, and docker compose ran an end-of-life 18; now `node:24-alpine`). The server has no `dotenv` since then: Railway and compose inject the environment, and a bare local run is `node --env-file=.env dist/index.js`.

**Railway is defined in `.railway/railway.ts`** (infrastructure as code, 2026-10-04; Railway's
`railway.json` config-as-code is deprecated with a cutoff of 2026-12-01, and this project never had
one: the settings had been set through `railway api`). Imported with `railway config pull`; `railway
config plan` previews (read-only, said "already up to date" when committed), `railway config apply`
changes Railway. Variables are `preserve()`, so no secret is in the file. It needs the `railway` SDK
(`railway/iac`), the repo root's only package (`package.json`, exact version, lockfile committed); the
game's packages don't depend on it. A change to the server's settings (replicas, draining, `WORKERS`)
goes in that file and through `plan` first.

### Client typecheck baseline (22 errors, re-measured 2026-10-03; 36 on 2026-09-08)

The client is **not** at zero and fixing it to zero is not expected. Known-benign:

- 3 × `Type 'Point' is missing ... from type 'ObservablePoint'`. Verified harmless:
  pixi's `set anchor` (and the other transform setters) do `this._anchor.copyFrom(value)`,
  so assigning a plain `Point` works correctly at runtime. Typings quirk only.
- 17 × `Property 'setHP' / 'setMaxHP' / 'loot' / 'pushState' ... does not exist on type
  'GameObject'` in `game.ts`'s `onObjectUpdated`. `LOOKUP` is typed as `GameObject` but holds `Unit`
  subclasses. Runtime-correct, type-unsafe. Fixing it properly means introducing a union
  or widening the base class — a real refactor, deliberately not done.

- 2 strictness nits that predate 2026-09-24, listed by file so they can be recognised:
  `skills/dash.ts` (one "possibly undefined"), `skills/skill.ts` (`uiTexture` not
  initialised). (`ui/elements/progressbar.ts`'s went with that file in `world-markers`. The two
  implicit `any` parameters in `vfx/meleeattack.effect.ts` went when that file was
  rewritten; `game.ts`'s four "possibly undefined" went with the layer code they were in.)

Anything **outside** these three groups is a new regression. The count is 22: 3 `Point`,
17 `GameObject`, 2 nits (unchanged through #48 on 2026-10-03; measured 2026-09-28, arena art pass, whose rewritten props no longer
assign a `Point`; 24 after `world-markers`, which deleted `progressbar.ts`;
25 after `hud-rebuild`, where one `Point` went with the deleted `playerstats.ts`; 26 after
`hex-cells-p4-cleanup` dropped the two `impulse` errors, 28 before). Compare the
sorted error list, not just the count, before dismissing.

## Running it locally

```
cd services && docker compose up -d          # redis + postgres + game server on :8000
cd plunder-land-client && npm start          # webpack dev server
```

`services/battle-royale-server/.env` is gitignored and must exist:

```
PORT=8000
REDIS_HOST=redis
REDIS_PORT=6379
DATABASE_URL=postgres://postgres:plunderland@postgres:5432/plunderland
```

**Compose runs `postgres` too** (guest accounts, #48): `postgres:18-alpine`, no published port
(the server reaches it as `postgres:5432`), data in **`services/saved/postgres18`**
(gitignored with the rest of `saved/`). Its major version follows Railway's, which is 18. From
18 the image keeps its data in `/var/lib/postgresql/18/docker` and wants the volume on
`/var/lib/postgresql`; it refuses to start with a volume on the old `/var/lib/postgresql/data`
or old data at `/var/lib/postgresql`. So 17's `services/saved/postgres` can't be reused and
can be deleted (local accounts are disposable). Without `DATABASE_URL` the server uses the
in-memory account store.

**`services/saved/redis` must exist too**, and is also gitignored. It is redis's data volume;
without it redis cannot write its snapshot, sets `stop-writes-on-bgsave-error`, and starts
refusing every write. `mkdir -p services/saved/redis`. Before `d7a7deb` the game server's
stats writes then threw `ReplyError: MISCONF` and it restart-looped, which from the browser
looked like the game randomly dropping the connection and resetting the world. Now a failed
stats write is caught and logged, throttled to one line a minute (`stats write failed: …`),
and the world keeps running. Stats are simply lost, so that log line is the symptom to look
for. (The `MISCONF` path is covered by the same catch but wasn't run; a dead Redis port was.)

The stats.js performance overlay (fps, socket bytes) shows only with `?stats=1` or the
settings' PERFORMANCE OVERLAY since `hud-rebuild`: it sat on top of the HUD's status panel for
every player. Since the SDK cleanup (2026-10-02) it is a separate chunk loaded only then.

The client's server address is baked in at build time from **`SERVER_URL`**
(`webpack.config.js` → `src/config.ts`). A production build **fails without it**, so a deploy
can't ship a dead default; the client Worker's build variables on Cloudflare hold the Railway URL (decision #40; `plunder-land-client/wrangler.jsonc`).
A development build (`npm start`) defaults to `http://localhost:8000`. A query param overrides
either at run time — no source edit needed:

```
http://localhost:3000/?server=http://localhost:8000
```

Smoke-test without a browser: connect a `socket.io-client`, emit `start_requested` (an
object; the bare string is gone since #48; the server sends `account` first and makes a guest
account for it), and count the `create` records. Since interest filtering (#35) a join gets
only layer 01's terrain (10 portals and 4 exits; the valleys come in `hello.voids`, about 1 KB
a layer) plus the units, pickups and StoneWall stones within its robot's `vision` + 1 rings
(server fog, #48), and its own `create_own`. (Before the valleys it was about 150 terrain records plus 10-20, 4-11 KB, not
re-measured since.) The whole-world counts (per layer: the void share, 150 loot, the item and mob
numbers in `LAYERS`) are checked by the world specs, not by a join.

## Bundle size

Main JS, 2026-10-02 with Sentry: **847 KB** parsed, 254 KB gzipped (Sentry is +89 / +30 of that;
758 / 225 after the SDK cleanup that morning, 889 / 259 before it;
it was 699 on 2026-09-08, before the arena, ground, rigs and lobby). Measure with
`npm run build` and read `dist/main.*.js`; `ANALYZE=1 npm run build` also writes
`dist/report.html` (webpack-bundle-analyzer) for a breakdown. It is no longer written by
default, because the site published it.

**Errors go to Sentry** (decision #46; EU region): `src/errors.ts` in both packages. The
client reports only in production builds and not with `?server=`; its DSN (a public key) is in
the source and its release is `WORKERS_CI_COMMIT_SHA`. The server reports when `SENTRY_DSN` is
set (Railway), from the four places that catch errors so the world keeps running: the loop,
each world's tick, timers and `guarded` socket handlers. No user fields, IPs, cookies or headers
(`dataCollection`, which replaced `sendDefaultPii` in v11), no tracing; a budget of 30 events
per 10 min (server) and 20 per page load (client). The server SDK costs about 25-30 MB of RSS.
An error may carry `reportTags` (string values), which the server's `captureError` adds as event tags
(`tagsFor`; its own `where` always wins): `GearTimeoutError` sends `gear_op`.
Source maps are not uploaded: Sentry fetches the public `.map` of the deployed build, so a
stack from an older deploy can't be mapped once a newer one replaces it.

**Game events go to GA4 from the server** (decision #46; `src/analytics.ts`, EU endpoint),
only when `GA_MEASUREMENT_ID` and `GA_API_SECRET` are set (Railway; never locally or in the load
harness): `run_start`, `first_loot`, `run_end`, one GA session per run, `client_id` the
account's `publicId` (#48; random per connection on an offline run). Their names and params are
listed in that file and are **append-only** (the reports are built on them). Every event of an
offline run carries `offline: 1`; its `run_start` has no `run_number`/`days_since_first` and
writes no `player-<id>`. Return is read from `run_start`'s `run_number` and `days_since_first`, because GA's own
new/returning counts need events only its web tag sends; the first day is in Redis
`player-<id>`, outside the public `stats-*` hashes. Two traps it hit: `Player.exit` sets
`exited` only after `Multiplayer.destroy`, so extraction is read from `extracted`; and a killing
hit destroys its victim before the attacker's `onKill` runs, so `run_end` goes a microtask later
to carry `killed_by`. `run_end` also carries `xp_gained` (#48 step 3: the formula's XP, 0 offline,
sent whether or not the grant lands) and, since #49, `gear_brought`, `gear_found` and `gear_kept`
(`gear_kept` is what the run's end sent to the stash, counted before the write, so it is sent
whether or not the settle lands). Smoke tests against production send real events, and since #48 the
server picks the id, so record the id the `account` event gives the smoke test.

**The client has no Firebase since 2026-10-02** (#46: game events go from the server to GA4).
It was `firebase/app` + `firebase/analytics`, about 96 KB parsed with its `tslib` and `idb`;
the whole `firebase` import once cost 832 KB. Also gone in that cleanup: `axios` (unused),
`fontfaceobserver` (`document.fonts.load`), Babel's `transform-runtime` + `@babel/runtime`
(Babel targets modern browsers through `browserslist` in `package.json`, so it no longer
compiles to ES5), and the client's eslint setup (eslint 8, unused, past end of life). Only the
five runtime packages are `dependencies`; the build chain is `devDependencies`.

## Lockfiles are committed. Keep them that way.

Both packages previously listed `package-lock.json` in `.gitignore`. Combined with caret
ranges (`socket.io: ^4.5.4`, `socket.io-client: ^4.6.1`), a clean install in 2026 resolved
`socket.io-parser@4.2.7`, whose `maxAttachments: 10` cap **broke the game completely** —
see the wire format note below. The dependency tree is now pinned. Do not re-ignore the
lockfiles, and treat any dependency bump as something to smoke-test.
