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
cd plunder-land-client        && npm run typecheck   # 37 errors — see baseline below
cd services/battle-royale-server && npm run typecheck # must stay at 0
```

Builds:

```
cd plunder-land-client        && npm run build   # webpack -> dist/
cd services/battle-royale-server && npm run build   # swc -> dist/
```

### Client typecheck baseline (2026-09-08: 36 errors)

The client is **not** at zero and fixing it to zero is not expected. Known-benign:

- ~9 × `Type 'Point' is missing ... from type 'ObservablePoint'`. Verified harmless:
  pixi's `set anchor` (and the other transform setters) do `this._anchor.copyFrom(value)`,
  so assigning a plain `Point` works correctly at runtime. Typings quirk only.
- 18 × `Property 'setHP' / 'setMaxHP' / 'loot' / 'pushState' ... does not exist on type
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

**`services/saved/redis` must exist too**, and is also gitignored. It is redis's data volume;
without it redis cannot write its snapshot, sets `stop-writes-on-bgsave-error`, and starts
refusing every write. The game server's stats writes then throw `ReplyError: MISCONF` and it
restart-loops — which from the browser looks like the game randomly dropping the connection
and resetting the world, not like a missing directory. `mkdir -p services/saved/redis`.

The client's server address lives in `src/config.ts` and defaults to production. Point it
at a local server with a query param — no source edit needed:

```
http://localhost:3000/?server=http://localhost:8000
```

Smoke-test without a browser: connect a `socket.io-client`, emit `start_requested`, and
count the `create` records. A healthy join streams ~420 objects (20 Portals, 8 Exits,
~270 Obstacles, ~70 Consumables, 50 Mobs).

## Bundle size

Production build, 2026-09-08: **699 KB** JS + 327 KB atlas + 30 KB atlas.json + 48 KB hex.png
+ 10 KB hex.json + 15 KB font = **~1.13 MB** total. Measure with `npm run build` and read
`dist/main.*.js`; the build also writes `dist/report.html` (webpack-bundle-analyzer) for a
breakdown.

`import firebase from 'firebase'` pulls the entire Firebase SDK and cost **832 KB** on its
own — more than the rest of the game combined. It is now `firebase/app` + `firebase/analytics`.
Never widen that import back. Only `analytics` is used.

## The hex sheet is generated, and its sources are not in the repo

`assets/res/hex.png` + `hex.json` are baked by `tools/bake-hex-atlas.py` from two 1254x1254
art drops that live **outside** the repo (`~/.codex/.chatgpt-projects/.../assets/hex_tileset`,
the `pixel-art-clean-alpha` pair). They are ~5 MB each against a 3.4 MB repo, so only the
48 KB output is committed. Re-bake with:

```
cd plunder-land-client && python3 tools/bake-hex-atlas.py [source-dir]
```

It needs `pillow` and `numpy`, and uses `pngquant` + `oxipng` if they are installed — they
take the sheet from 193 KB to 48 KB with no visible difference, and it warns and ships the
larger file if they are missing.

The script owns three things worth knowing before touching either sheet:

- **Pads are baked to their exact on-screen size** for `Hex.SIZE = 45` (`HexTerrain.BAKED_FOR`),
  because the game draws at 1:1 with `ROUND_PIXELS` and a texture baked to size never gets
  resampled. Change `Hex.SIZE` and the pads still tile - `HexTerrain` rescales them - but
  they stop being crisp. Re-bake instead.
- **A pad is a regular hexagon 7% larger than the lattice.** The art is 4.5% short of regular,
  and tiling a short hex leaves a transparent notch on every diagonal edge; the 7% is what
  makes neighbours overlap once positions are rounded to whole pixels.
- **Both sheets' 6x6 grids are measured, not assumed.** Neither is on the clean 209 px pitch
  the image size implies, and one prop has a stray pixel that reads as a seventh row.

`tiles/grass.png`, `tiles/ground.png` and the four `obstacle_*` groups in the TexturePacker
atlas are now unused — the ground and every obstacle come from the hex sheet. They stay
because regenerating that atlas needs TexturePacker, which is not in this toolchain; that is
about 40 KB of the 327 KB atlas sitting there for nothing.

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

`maxHp` is sent per unit so the client does not have to infer a health bar's scale from the
first hp value it happens to see. **The field table is append-only** — new fields go on the
end of `fieldOrder` (server) and `allFields` (client), and the two must stay identical.

**`hello`** is emitted once on join: `{ tick, map, interest }`. Nothing on the client may
hardcode these — see `src/net/session.ts`.

Each record is a sequence of `[field index][payload]`, indexed into `GameObject.fieldOrder`
(server) / `allFields` (client). **These two tables must stay identical and are
append-only** — an index is a consumed boundary, so never reorder or remove one.

`direction` and `impulse` have serialiser cases on both sides but are **not** in
`fieldOrder`, so `indexOf` returns -1 and they would encode as key index 255. They are
currently unreachable because `dirtyFields.add('direction')` / `('impulse')` are commented
out in `gameobject.ts`. Add them to `fieldOrder` before ever re-enabling those.

**Skills aim with `Unit.facing`, not `direction`, and `facing` is server-only.** `stop()` zeroes
`direction`, so aiming with it made every skill fire at the caster's own feet once they stood
still. `facing` is the last non-zero direction (unit length, East until the unit first moves),
kept current by `Unit`'s `direction` setter. `fix-direction-on-wire` should send `facing`, not
`direction`.

`maxVelocity` is in `allFieldsOwn` and dirty-tracked, because local prediction cannot run
without it. It is deliberately **not** in `allFields`: remote units are interpolated between
known positions and never need a speed.

`lifetime` is encoded as centiseconds in a **uint16** (`value / 100`), giving a range of
about 65,000 seconds. It was a single signed byte, which silently capped every lifetime at
12.7s — long enough for a 3s fireball, wrong for the 60s timer on dropped loot. Encoding it
raw in milliseconds throws `ERR_OUT_OF_RANGE` for every real value including 1000.

## The grid, and how it is drawn

`Hex.SIZE` is **45 world units** and `utils/hex.ts` + `utils/path.ts` are byte-identical in
both packages (`mirror.spec.ts` enforces it). It was 35, picked so 140 u/s covered one cell
per 250 ms tick; that coincidence lost to legibility — the player sprite is 50 px and the
game draws at 1:1, so a 35-unit cell was smaller than the character standing on it. Movement
is continuous along the path, so nothing depended on it and no speed changed.

Anything that moves with `Hex.SIZE` should be **derived from it, not written down**:
`Path.WINDOW` (140, the longest hex distance across a 4000-unit map), the path marker's
radii, the eastern-edge cell in `world.spec.ts`. Three separate literals went stale the one
time the cell size moved.

**Entering the last cell of a route is not arriving at it.** `followPath` (server `unit.ts`,
client `localplayer.ts`) re-aims the index after a shove and nothing else; it caps the index at
the last cell and never ends a route. `walkPath` / `_step` is the only thing that does, and it
finishes exactly on the centre. The two were in the wrong order once and a walk came to rest
about half a cell short of the middle, every time — invisible while a cell was 35 units and a
tick's travel was also 35, because the two crossings then fell in the same tick.

**Arriving does not clear the waypoints, only the path.** The client walks in real time and the
server starts a tick later, so the client always finishes first; clearing the waypoints on
arrival made the next input packet a "stop" that landed on a server still short of the
destination. `LocalPlayer._arrive` keeps the destination so the packet keeps asking for it, and
the server's `sameCells` check makes the repeat free. `stop()` stays for a real stop.

`HexTerrain` (`src/objects/hexterrain.ts`) draws the ground as one sprite per cell, pooled,
rebuilt only when the camera's own cell changes. Two things about it are load-bearing:

- **A cell's face is derived from the cell, never drawn at random**, or the ground boils as
  you walk and every re-entry into view reshuffles it.
- **A value-noise field picks the *palette*, and a hash of the cell picks a face within it.**
  Choosing per cell out of one palette was the first build and it looked like static —
  patches are what makes it read as ground. `meta.regions` in `hex.json` fixes the order the
  palettes lie along the field; value noise is centre-heavy, so the middle ones dominate.

An invisible plane sets `layer.visible = false` rather than sitting at alpha 0 — `visible` is
the only flag that skips PIXI's transform pass as well as the draw, and there are now about a
thousand pads behind it.

## Input: the stage has to be its own hit target

**`app.stage.hitArea` must cover the canvas** (set in `onResize`), or click-to-move works only
where something happens to be drawn. pixi dispatches a pointer event to the innermost thing
under the pointer and bubbles up from there; with no hit at all there is no event and the
stage's listener never runs. That was free while the ground was one `TilingSprite` over the
whole map — every click landed on a sprite. Hex pads are `eventMode: 'none'`, so clicks on bare
ground stopped reaching anything and routing worked only when a mob, a rock or a pickup was
under the pointer. It reads as "click-to-move is flaky", which is a long way from its cause.

The other half of the same rule: **`onPointerDown` ignores anything whose target is not the
stage.** Events bubble, so a press on a skill button reached the world handler too and walked
the player in under the HUD. With the hitArea in place, "target is the stage" means exactly
"nothing interactive was hit", which is the world.

Movement is click-to-move only. The on-screen joystick is gone — it was a second way to say the
same thing, it aimed at a cell five out rather than at a destination, and its
`pointerDown` flag was a hidden gate on the world's own click handler.

`GameObject.DEBUG_COLLIDERS` is off. It draws a magenta disc the size of the collider under
every object; the `// return` that used to switch it off had been commented out, so the
shipping game had one under everything.

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
3. **Animation follows intent, not rendered movement.** `Unit.applyPosition` takes an optional
   motion hint; the local player passes `LocalPlayer.moveX/moveY`, which is the predicted step
   with no correction in it. Driving the run cycle and the sprite flip from the rendered delta
   made the player jog on the spot and flip to face the wrong way every time the server nudged
   them, because the render position carries the decaying correction offset. Remote units have no
   intent to read and correctly fall back to the rendered delta.
4. **Corrections are eased, not snapped.** `LocalPlayer` keeps a decaying render offset so a
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

## Skills

All eight are equipped: Dash, MeleeAttack, RangedAttack, Defend, StoneWall, ThrowFireball,
Throwicicle, IceBreath. **The order of `Player.skills` is a wire contract** — the client sends
the index of the slot pressed and `tryExecuteSkill` indexes straight into the server's array,
so the two lists must stay identical. The HUD bar binds them to `q w e r t y u i`.

**Four of them use placeholder icons.** The atlas ships exactly four control icons (dash,
defend, melee, ranged); StoneWall, ThrowFireball, Throwicicle and IceBreath each borrow the
closest one, listed in `src/skills/placeholders.ts`. The key letter on the button is what
distinguishes them until real art exists. Also missing and wanted: `player/magic/frame` and
`player/shoot/shot` clips (Defend and RangedAttack used to call them and only logged an
error), and an icicle projectile sprite — thrown icicles currently render as fireballs.

**Every area of effect is a set of hex cells, not a radius.** A unit is inside if the cell
under its centre is. `World.FIND_IN_CELLS` covers rings around a cell: melee is 2 rings
around the caster, and the fireball/icicle blast is 1 ring around **the cell of the unit
struck** (or the projectile's own cell if it expires). Centring a distance blast on the
projectile missed the unit it had just hit, because a projectile's 50-unit collider sets
it off before the target is inside a 70-unit blast. Breath cones are `World.CONE_CELLS`: the
facing snaps to one of the six `Hex.DIRECTIONS`, and each ring is the three forward
neighbours of the ring before, so ring k has 2k+1 cells. No angle test. The client effects
still draw the old distances (`vfx-match-cells`).

**Projectiles are not solid.** A `Throwable` still lives in `World.OBSTACLES`, because that
is how the tick finds it to update, but `Unit.update`'s push-out skips it, and it does its
own hit test after moving, which never matches its owner. When it was solid, every fireball
exploded on its caster.

**StoneWall is placed behind the caster on purpose**, to block chasers. Do not "fix" it to
the front.

## Known-unfixed

- **Levels never change.** `setLevel(1)` is called once; `LEVEL_THRESHOLDS` sits commented
  out in `playerstats.ts`, so the per-level damage tables always index level 1.
  Note `Player.setLevel()` zeroes `this.loot` — probably leftover init, but nobody has
  decided whether that is meant to be "spend your haul on power or carry it to the gate".
- **Our client-side teardown is `dispose()`, not `destroy()`.** `destroy()` belongs to PIXI and
  overriding it with a different signature meant PIXI's own cleanup could never run. `dispose()`
  deliberately does *not* chain to `super.destroy()`: effects hold a reference to their target
  for up to a second after it dies, and freeing the container under them throws. Dropping every
  reference — `LOOKUP`, `COLLIDERS` and the per-type arrays, all done in `onObjectDestroyed` —
  is what actually lets it be collected.
- **AI targets are released when they die.** `GuardPosition` only scans for a new target
  while `owner.target` is null, so a target that dies or extracts used to leave the unit
  permanently blind — wandering, while `UseSkillOnTarget` (which only tests for null) kept
  attacking the corpse. Anything that latches onto a target must clear it the same way.
  Note the acquisition loop still takes the *last* match from `FIND_AROUND`, not the nearest.
  **Being hit by a player also sets the target** (`GuardPosition.provoke`), so a mob can no
  longer be killed from beyond its 200-unit notice range without reacting. It chases until
  the attacker is more than max(250, the distance at the hit + 50) away, and always switches
  to whoever hit it last. Breath damage has no attacker attached, so being inside a player's
  cone counts as a hit.
- **A pickup both banks and heals.** One consumable does double duty; splitting them into
  separate loot and health pickups is a later decision, not an oversight.
- **Dropped loot expires after `World.DROPPED_LOOT_LIFETIME` (30s); natural spawns do not.**
  The world's own spawner is bounded by a count, drops were not.
- **Impulse decay is a constant applied to the magnitude** (`IMPULSE_FRICTION`, currently 3.0).
  Duration is `impulse magnitude / IMPULSE_FRICTION`; Dash starts at 1.5, so 0.5s. Measured: the
  dash adds ~81 units over two ticks, against a 35-unit baseline tick. **Note the tick
  granularity** — the server applies the current impulse for a whole tick *then* decays, so a
  dash can never be shorter than one 250ms tick no matter how high the friction goes. Two earlier
  versions were wrong: `dt / sqMagnitude` made decay inversely proportional to the square of the
  impulse, and `reduceBy(dt * F)` decayed each axis independently, so an axis-aligned dash lasted
  √2 longer than a diagonal one.
- **Player-versus-player collision is not predicted.** `LocalPlayer._step` replicates the
  server's obstacle push-out but not its player push-out, so shoving another player produces
  a correction. Rare and small; revisit if it reads badly in a crowd.
- **`tickLengthMs` is `TICK_MS` in the environment**, default 250, and is sent to the client
  in `hello`. **Do not re-propose tuning it as a latency fix** — git history shows six changes
  in eight days that ended where they started, and the measured tick is healthy: 200
  concurrent players hold 249ms with a 255ms p95. Latency was architectural, not cadence.
