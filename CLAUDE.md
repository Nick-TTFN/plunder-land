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
cd plunder-land-client        && npm run typecheck   # 36 errors — see baseline below
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
- 23 × `Property 'setHP' / 'setLevel' / 'loot' / 'pushState' ... does not exist on type
  'GameObject'` in `game.ts`'s `onObjectUpdated`. `LOOKUP` is typed as `GameObject` but holds `Unit`
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

**The `update` event additionally carries an 8-byte header before the records:**

```
[uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]
```

and it is emitted **every tick for every connection with a player, even when it holds no
records**, because that header is the client's clock and its input acknowledgement. Split
it with `Game.splitRecords(buffer, 8)`; `unpackRecords` is the headerless form used by the
other four events.

`ackElapsedMs` is how long the server has been applying `lastInputSeq`. It exists because
the sequence number alone does not say how far *into* an input the server has got, and
without it every reconciliation drags the player backwards by a fraction of a tick. A
control run with the field forced to zero doubled the median correction (2.00 vs 1.00
units) and introduced a systematic backward bias.

**Client → server `pointer` is 4 bytes:** `[int8 dirX][int8 dirY][uint16 seq]`, direction
scaled by 127. It is sampled once per server tick, not per pointer event. The server
ignores any payload that is not a buffer of at least 4 bytes.

**`hello`** is emitted once on join: `{ tick, map, interest }`. Nothing on the client may
hardcode these — see `src/net/session.ts`.

Each record is a sequence of `[field index][payload]`, indexed into `GameObject.fieldOrder`
(server) / `allFields` (client). **These two tables must stay identical and are
append-only** — an index is a consumed boundary, so never reorder or remove one.

`direction` and `impulse` have serialiser cases on both sides but are **not** in
`fieldOrder`, so `indexOf` returns -1 and they would encode as key index 255. They are
currently unreachable because `dirtyFields.add('direction')` / `('impulse')` are commented
out in `gameobject.ts`. Add them to `fieldOrder` before ever re-enabling those.

`maxVelocity` is in `allFieldsOwn` and dirty-tracked, because local prediction cannot run
without it. It is deliberately **not** in `allFields`: remote units are interpolated between
known positions and never need a speed.

`lifetime` is encoded as centiseconds in one signed byte (`value / 100`, clamped to 127)
because the client decodes it as `byte * 100`. Encoding it raw throws `ERR_OUT_OF_RANGE`
for every real value including 1000.

## Movement: three different mechanisms, deliberately

Do not collapse these into one. They were one before, and that is what made the game feel
like it did.

1. **The local player is predicted.** `Game.LOCAL` (`src/net/localplayer.ts`) applies input
   immediately and reconciles against the server. It is the one object in the scene that is
   never fed through `onObjectUpdated` — `Game.PLAYER`'s position comes from
   `Game.LOCAL.renderX/renderY` in `Game.update`. `LocalPlayer._step` mirrors the server's
   `Unit.update` integration and push-out; **if one changes, the other has to change with
   it** or prediction starts fighting the authority.
2. **Remote units are interpolated**, not chased. `Unit.pushState` records authoritative
   states and `Unit.update` renders at `now - Session.interpolationDelay`, interpolating
   between the two states straddling that time, extrapolating for a bounded window on
   underrun, then holding.
3. **Corrections are eased, not snapped.** `LocalPlayer` keeps a decaying render offset so a
   small disagreement is walked off over ~100 ms; a disagreement over 220 units is treated as
   a teleport and shown immediately.

`Session` (`src/net/session.ts`) owns every timing constant, and separates what the server
*says* (`tickMs`, from `hello`) from what the connection *delivers* (`arrivalP95`, measured).
Interpolation is timed off the measured value.

**Liveness is not a heartbeat.** Idle units now send nothing at all, so "hasn't updated
recently" no longer means "gone". `Game.stillPresent` treats a silent unit as present if it
is inside the interest radius and absent otherwise. The old per-player 3-byte id heartbeat
is gone; the update header replaced it with a fixed per-connection cost instead of a
per-visible-player one (break-even at about three visible players).

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
- **AI targets are released when they die.** `GuardPosition` only scans for a new target
  while `owner.target` is null, so a target that dies or extracts used to leave the unit
  permanently blind — wandering, while `UseSkillOnTarget` (which only tests for null) kept
  attacking the corpse. Anything that latches onto a target must clear it the same way.
  Note the acquisition loop still takes the *last* match from `FIND_AROUND`, not the nearest.
- **Player-versus-player collision is not predicted.** `LocalPlayer._step` replicates the
  server's obstacle push-out but not its player push-out, so shoving another player produces
  a correction. Rare and small; revisit if it reads badly in a crowd.
- **`tickLengthMs` is `TICK_MS` in the environment**, default 250, and is sent to the client
  in `hello`. **Do not re-propose tuning it as a latency fix** — git history shows six changes
  in eight days that ended where they started, and the measured tick is healthy: 200
  concurrent players hold 249ms with a 255ms p95. Latency was architectural, not cadence.
