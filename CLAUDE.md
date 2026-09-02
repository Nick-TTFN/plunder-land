# Plunderland — working notes

## What this actually is

An **extraction game**, not a battle royale. There is no round, no lobby, no match
start/end and no shrinking play area. `World` is constructed once at process start and
runs forever; players join at a random point when they connect and leave through an
`Exit`, which banks the run. Death scatters your loot on the ground via
`createLootFrom(player)` — the same path mobs use.

The `services/battle-royale-server` directory name and `area/circlearea.ts` (an unused
storm-shaped damage area) are leftovers from an abandoned BR direction. Nothing imports
`circlearea.ts`.

The world is three vertically stacked planes. The server ships `World.TAGS = [-1, 0]`;
the client ships `tags = [-1, 0, 1]` where tag 1 is airborne. **Nothing spawns on the
third plane and no portal routes there** — `world.ts` says `// we dont have obstacles in
the air yet`.

## Verification path

Both packages typecheck, but **only the server's typecheck is enforced by its build**.
The client compiles through `babel-loader` + `@babel/preset-typescript`, which strips
types without checking them, so `tsc` errors never fail a client build.

```
cd plunder-land-client        && npm run typecheck   # 34 errors — see baseline below
cd services/battle-royale-server && npm run typecheck # must stay at 0
```

Builds:

```
cd plunder-land-client        && npm run build   # webpack -> dist/
cd services/battle-royale-server && npm run build   # swc -> dist/
```

### Client typecheck baseline (2026-09-02)

The client is **not** at zero and fixing it to zero is not expected. Known-benign:

- ~9 × `Type 'Point' is missing ... from type 'ObservablePoint'`. Verified harmless:
  pixi's `set anchor` (and the other transform setters) do `this._anchor.copyFrom(value)`,
  so assigning a plain `Point` works correctly at runtime. Typings quirk only.
- 21 × `Property 'setHP' / 'setLevel' / 'loot' ... does not exist on type 'GameObject'`
  in `game.ts`'s `onObjectUpdated`. `LOOKUP` is typed as `GameObject` but holds `Unit`
  subclasses. Runtime-correct, type-unsafe. Fixing it properly means introducing a union
  or widening the base class — a real refactor, deliberately not done.

Anything **outside** these two families is a new regression. Check before dismissing.

## Running it locally

```
cd services && docker compose up -d          # redis + game server on :8000
cd plunder-land-client && npm start          # webpack dev server
```

`services/battle-royale-server/.env` is gitignored and must exist:

```
PORT=8000
REDIS_HOST=redis
REDIS_PORT=6379
```

The client's server address lives in `src/config.ts` and defaults to production. Point it
at a local server with a query param — no source edit needed:

```
http://localhost:8080/?server=http://localhost:8000
```

Smoke-test without a browser: connect a `socket.io-client`, emit `start_requested`, and
count the `create` records. A healthy join streams ~420 objects (20 Portals, 8 Exits,
~270 Obstacles, ~70 Consumables, 50 Mobs).

## Bundle size

Production build, 2026-09-02: **696 KB** JS + 327 KB atlas + 30 KB atlas.json + 15 KB font
= **~1.07 MB** total. Measure with `npm run build` and read `dist/main.*.js`; the build also
writes `dist/report.html` (webpack-bundle-analyzer) for a breakdown.

`import firebase from 'firebase'` pulls the entire Firebase SDK and cost **832 KB** on its
own — more than the rest of the game combined. It is now `firebase/app` + `firebase/analytics`.
Never widen that import back. Only `analytics` is used.

## Lockfiles are committed. Keep them that way.

Both packages previously listed `package-lock.json` in `.gitignore`. Combined with caret
ranges (`socket.io: ^4.5.4`, `socket.io-client: ^4.6.1`), a clean install in 2026 resolved
`socket.io-parser@4.2.7`, whose `maxAttachments: 10` cap **broke the game completely** —
see the wire format note below. The dependency tree is now pinned. Do not re-ignore the
lockfiles, and treat any dependency bump as something to smoke-test.

## Wire format

Server → client messages (`create`, `create_own`, `update`, `destroy`, `effect`) are
binary. Each event is **one** buffer containing length-prefixed records:

```
[uint16 length][record bytes][uint16 length][record bytes]...
```

Pack: `Multiplayer.packRecords` (server). Unpack: `Game.unpackRecords` (client).

Each record is a sequence of `[field index][payload]`, indexed into `GameObject.fieldOrder`
(server) / `allFields` (client). **These two tables must stay identical and are
append-only** — an index is a consumed boundary, so never reorder or remove one.

`direction` and `impulse` have serialiser cases on both sides but are **not** in
`fieldOrder`, so `indexOf` returns -1 and they would encode as key index 255. They are
currently unreachable because `dirtyFields.add('direction')` / `('impulse')` are commented
out in `gameobject.ts`. Add them to `fieldOrder` before ever re-enabling those.

`maxVelocity` is in neither `allFields` nor `allFieldsOwn` and its dirty flag is also
commented out, so the client never receives a speed value from the server. This matters if
you add client-side prediction.

`lifetime` is encoded as centiseconds in one signed byte (`value / 100`, clamped to 127)
because the client decodes it as `byte * 100`. Encoding it raw throws `ERR_OUT_OF_RANGE`
for every real value including 1000.

## Things that are deliberate

- **One world per process.** `World.PLAYERS`, `MOBS`, `OBSTACLES`, `CONSUMABLES`,
  `AREA_EFFECT`, `TAGS`, `mapSize`, `config` are all `static`, and `Multiplayer.Instance`
  is a static singleton. No rooms, no world reset without a restart, and multi-region means
  separate non-communicating worlds. Converting these to instance state is the one genuinely
  structural change the codebase would need for concurrent rooms.
- **Nothing is persisted.** The world lives entirely in memory. Redis holds only cumulative
  `stats-*` hashes. This is why the tick has an error boundary — an uncaught throw would
  otherwise take every in-flight run down with the process. It also rules out serverless,
  edge, and sleep-enabled hosting: a sleep/wake cycle wipes the world.

## Known-unfixed

- **Loot is never awarded.** `player.ts` heals on pickup (`this.hp += obj.loot`) and
  `Player.addLoot()` has zero callers, so `player.loot` is always 0 and so is
  `stats.lootCollected`. Left alone pending a deliberate game-design pass on whether a
  pickup should heal, bank, or split into two pickup types.
- **The six skills are unequipped.** Players get `[Dash, MeleeAttack]` from a 6-slot bar.
  `Defend`, `RangedAttack`, `FireBreath`, `IceBreath`, `StoneWall`, `ThrowFireball`,
  `ThrowIcicle` exist and are unreachable.
- **Levels never change.** `setLevel(1)` is called once; `LEVEL_THRESHOLDS` sits commented
  out in `playerstats.ts`, so the per-level damage tables always index level 1.
  Note `Player.setLevel()` zeroes `this.loot` — probably leftover init, but nobody has
  decided whether that is meant to be "spend your haul on power or carry it to the gate".
- **No client-side prediction.** `Game.PLAYER` goes through the same
  `onObjectUpdated` → `setMoveTarget` → interpolate path as every remote unit, so your own
  character does not move until a packet returns. Input-to-motion is RTT + up to one 250ms
  tick. What exists is interpolation, not prediction, despite the commit named
  "client prediction 0.1". **Do not re-propose tuning `tickLengthMs`** — git history shows
  six changes in eight days that ended where they started.
