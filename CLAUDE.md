# Plunderland — working notes

## What this actually is

An **extraction game**, not a battle royale. There is no round, no lobby, no match
start/end and no shrinking play area. A process holds one or more `World`s (#39): each run
goes to the fullest world under `WORLD_CAP`, a new one opens when all are full, and an empty
one closes after `WORLD_IDLE_MS` (one always stays open). Players join at a random point and leave through an
`Exit`, which banks the run. Death scatters your loot on the ground via
`createLootFrom(player)` — the same path mobs use.

The `services/battle-royale-server` directory name is a leftover from an abandoned BR
direction. So was `area/circlearea.ts`, an unused storm-shaped damage area, deleted in
hex-cells P4.

The world is **three ground layers**, 01 on top to 03 at the bottom, with tags **0, -1, -2**
(depth is `-tag`). Deeper is richer and more dangerous (decisions #3, #16, #26). **Every
per-layer number lives in one table, `LAYERS` in `src/archetypes/archetypes.ts`**: tag, loot
multiplier (×1 / ×1.75 / ×3 on natural pickups and on every mob's loot, not on what a dead
player drops), the void share (1/3 each, the valleys), natural loot cap (150 each, death drops
uncapped), portals up and down, exits (4 each, #10) and the mobs kept alive (grunts 22/18/14,
gunners 0/8/14, bosses 0/2/3, 81 in all). `World.refillLayer` tops each layer up to it every
tick, counting per layer. The layer tags reach the client in `hello.layers`; **the client
never hardcodes a tag**.

**Portals chain 01 ↔ 02 ↔ 03 and move players only** (#26): 10 down on 01, 5 up and 5 down
on 02, 10 up on 03. A player whose tick ends on a portal's cell is put down on that portal's
**arrival cell**, its east neighbour (`World.arrivalOf`, #31 Q3, #33), on the layer it leads
to, on the cell's centre, and stops (`Player.hopPortal`). Routes end on a portal's cell on
both sides (`Unit.endAtPortal` / `LocalPlayer._endAtPortal`, via `stopsOn`), so a dash can't
skip over one. A mob never steps onto a gate or an arrival cell (`World.mobCanEnter`) and
stays on its layer, so each layer keeps the danger designed for it. Portals aren't paired:
the arrival is the entered portal's own east neighbour on the `to` layer. Gates a player
could meet on one layer are at least `World.GATE_SPACING` (4) rings apart (#34), and
placement rejects a portal whose arrival cell is off the map, blocked or a gate. **Every gate
is `World.GATE_ROCK_RINGS` (2) rings clear of void** on its layer, and a portal is as clear on
the layer it leads to (`World.placeGate`; `World.gateKeepOut` is the same disc), which covers
each arrival cell and its neighbours, so a pad is always reachable and nobody lands in a
valley. Both are plain
constants since hex-cells P2; they were derived from push-out radii before. New players join
on layer 01 on a free cell centre at least `World.SPAWN_CLEARANCE` (3) cells from every
portal, exit and boss, and from mobs when possible (`World.spawnCell`). A fully random spawn
put about 1 join in 250 close enough to an exit to leave within a second. The airborne plane,
its clouds and the half-alpha "ground seen from above" are gone; only the player's own layer
is drawn.

## Verification path

Both packages typecheck, but **only the server's typecheck is enforced by its build**.
The client compiles through `babel-loader` + `@babel/preset-typescript`, which strips
types without checking them, so `tsc` errors never fail a client build.

```
cd plunder-land-client        && npm run typecheck   # 24 errors — see baseline below
cd services/battle-royale-server && npm run typecheck # must stay at 0
cd services/battle-royale-server && npm test          # node --test via ts-node
```

The server's `tsconfig` excludes `*.spec.ts`, so **specs run but are never typechecked**. A
type error in a spec only shows up if ts-node trips over it at run time.

**Server cost per player: `services/battle-royale-server/tools/load/`.** One command
builds the server, runs it with a timing probe, ramps headless bots and prints a table
(world ms per tick, CPU, per-client KB/s, join size, connect failures):

```
cd plunder-land-client           && npm ci   # the bots use its socket.io-client
cd services/battle-royale-server && tools/load/ramp.sh --steps "0 100 400" --step-secs 30
```

It defaults to port 8100 with Redis pointed at the dead port 6399, refuses 6379 and 8000,
and stops the server and every bot process by PID, on exit and on Ctrl-C. Give parallel
lanes their own `--port` and `--redis-port`. The 2026-09-25 baseline (`29e82fa`, M4 Max) is
in its README: 13.6 ms world per tick at 100 players, 60.2 at 400, one core saturated at
~684. **Tick time varies a lot between runs of the same commit** (at 100 players, 7.5 to
18.2 ms across four runs; bandwidth agrees within 5%), so judge a change only by running
the old and new commits back to back on the same machine, at least twice each.
`--detail 1` adds per-function timings (`spans.cjs`/`spans.py`: calls, self and inclusive ms
per tick for ~75 server functions, socket writes and emits per tick, and a CPU budget split
into tick / input / GC / networking / kernel). Judge a CPU change by **CPU ms per
player-second**, which it prints: on 2026-09-26 about 40% of the server's CPU was sending,
not simulating. `--frames 0` makes the bots connect as pre-frame clients.
**Several worlds** (worlds-per-process): `ramp.sh` passes its environment through, so
`WORLD_CAP=100 tools/load/ramp.sh …` runs 400 bots as 4 worlds. The probe then sums
`World.update` and `flushAll` over one pass of the loop (`Worlds.tickAll`), so "world ms" is
still per tick of the loop, and its counts are summed over the open worlds (`worlds` is the
number open). It reads each world's own lists: with `World.strict` on, a static `World.X`
outside `World.run` throws, which is the point, so anything added to the probe must do the
same.

**Unit stats live in one table**, `src/archetypes/archetypes.ts` (peep, magnet, grunt, boss, gunner).
**A robot's shown stats (HP, armor, speed, pickup reach, `damageScale`) are in the mirrored
`utils/archetypes.ts` `stats`** and its row takes them from there (`robot()`, robot-select #42), so
the lobby and the server read one table; `damageScale` multiplies every skill's damage through
`Skill.dealt` (`robotselect.spec.ts` fails on a hit that skips it). A join picks the robot by
`start_requested.robot` (a key), only from `SELECTABLE_ROBOTS` (peep, magnet), else peep
(`World.robotFor`). The rest of a row:
body, HP, speed, loot, contact damage with its cooldown and range in rings (`contact.rings`,
1 for every mob), kill-stat keys, skills with per-archetype overrides, and AI routines with
their parameters. `body` is the wire's `radius` and is drawing only: since hex-cells P1-P3
(#31) every gameplay rule reads cells, never a radius. There is no `Boss` class.
`src/archetypes/baseline.spec.ts` pins the pre-refactor behaviour; change it only on
purpose. `plunder-land-client/tools/archetype-bot.mjs <server-url>` records what a real
join sees on the wire (Node 22.18+).

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
`.swcrc` so the two agree on class fields. Node 18 (the container) runs ES2022.

### Client typecheck baseline (2026-09-08: 36 errors)

The client is **not** at zero and fixing it to zero is not expected. Known-benign:

- ~9 × `Type 'Point' is missing ... from type 'ObservablePoint'`. Verified harmless:
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
17 `GameObject`, 2 nits (measured 2026-09-28, arena art pass, whose rewritten props no longer
assign a `Point`; 24 after `world-markers`, which deleted `progressbar.ts`;
25 after `hud-rebuild`, where one `Point` went with the deleted `playerstats.ts`; 26 after
`hex-cells-p4-cleanup` dropped the two `impulse` errors, 28 before). Compare the
sorted error list, not just the count, before dismissing.

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
refusing every write. `mkdir -p services/saved/redis`. Before `d7a7deb` the game server's
stats writes then threw `ReplyError: MISCONF` and it restart-looped, which from the browser
looked like the game randomly dropping the connection and resetting the world. Now a failed
stats write is caught and logged, throttled to one line a minute (`stats write failed: …`),
and the world keeps running. Stats are simply lost, so that log line is the symptom to look
for. (The `MISCONF` path is covered by the same catch but wasn't run; a dead Redis port was.)

The stats.js performance overlay (fps, socket bytes) shows only with `?stats=1` since
`hud-rebuild`: it sat on top of the HUD's status panel for every player.

The client's server address is baked in at build time from **`SERVER_URL`**
(`webpack.config.js` → `src/config.ts`). A production build **fails without it**, so a deploy
can't ship a dead default; Cloudflare Pages' build settings hold the Railway URL (decision #40).
A development build (`npm start`) defaults to `http://localhost:8000`. A query param overrides
either at run time — no source edit needed:

```
http://localhost:3000/?server=http://localhost:8000
```

Smoke-test without a browser: connect a `socket.io-client`, emit `start_requested`, and
count the `create` records. Since interest filtering (#35) a join gets only layer 01's
terrain (10 portals, 4 exits and any live StoneWall stones; the valleys come in `hello.voids`,
about 1 KB a layer) plus the units and pickups inside its interest box, and its own
`create_own`. (Before the valleys it was about 150 terrain records plus 10-20, 4-11 KB, not
re-measured since.) The whole-world counts (per layer: the void share, 150 loot, the item and mob
numbers in `LAYERS`) are checked by the world specs, not by a join.

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

**The valleys replaced world rocks** (`src/objects/valleys.ts`, tile art pass 2026-09-27).
About a third of each layer (`LAYERS.voidShare`) is void: winding chasms from ridged value
noise, void specks under 12 cells filled back in, free scraps under 30 cells filled, and every
other cut-off region joined to the rest by a one-cell bridge carved across the shortest stretch
of void, so each layer's ground is one walkable region (`valleys.spec.ts`). Carved once per
layer in the `World` constructor, before the gates, at random (every server start is a new
map, ~30 ms a layer); void cells are in `World.BLOCKED` with a null blocker and in
`World.VOIDS`. They are not objects: they reach the client as **`hello.voids`**, per layer in
`layers` order, alternating free/void run lengths over `Hex.mapCells(map)` (mirrored in
`utils/hex.ts`, a consumed order), decoded by `Session.decodeRuns` into `Game.VOIDS`, which
routing (`Game.isBlocked`) and the ground (always unknown void) read. Additive: an older client
routes into valleys and gets corrected, so **ship the client first**. No world rock is placed
any more (`World.isRock` still tells StoneWall stones apart for the bomb). **Known gap:** mobs
still step greedily (`Unit.chooseStep`) and stall on valley edges; real mob pathing was
deferred on 2026-09-27.

**The camera is tilted, in drawing only** (`src/objects/tilt.ts`, tile art pass 2026-09-27).
`Game.CONTAINER.scale.y = TILT` (about 0.924: the art's 0.93 rounded so a tilted row is exactly 36 px; 0.744 until the flat-tile pass), so a world `y` draws at `y * TILT`; rules, wire and
server stay on the regular top-down grid, and `toLocal` undoes the squash for the pointer and
the aim. Anything **added straight to the camera or a plane stands up**: `TiltedContainer`
gives it an `UprightTransform`, which squashes its position and not its shape, and keeps its
own `scale` (and tweens on it) meaning what they did. Things that lie on the ground are marked
`onGround` and squash with it: the planes, `PathMarker`, `ThreatMarker`, `CellHighlight`, the
ranged beam. A new ground-plane overlay needs `onGround`, or it draws unsquashed.

**The ground pads are a separate sheet, `assets/res/ground.png` + `ground.json`**, baked by
`tools/bake-ground-atlas.py` from an art drop kept outside the repo
(`~/.codex/.chatgpt-projects/.../output/hex-arena/pointy-top-tiles-v1`: 12 flat top faces in
`transparent-top-faces/`, their vertices in `manifest.json`, and `edge-fade.png`): steel faces,
surface (satin, faceted, brushed, patched) by edge (clean, worn, chipped). It is baked **at 2x** (`meta.scale: 2`, linear filtering) and **already
squashed by `TILT`** (`meta.tilt`; the client warns on a mismatch), since `HexTerrain` stands up
and lays its rows at `TILT` of their pitch itself, which keeps pads texel for pixel. The bake
remaps each face band by band from the manifest's vertices onto a regular hex one cell wide
squashed by `TILT`; no overscale, so the bevels are the grid line. A known cell (visible or
explored) is a flat face; **under each of its two lower edges whose neighbour below is unknown
(void, valley or off the map), `HexTerrain` hangs that half of the edge fade** (`fade_left` /
`fade_right`, the fade cut at its apex, tinted `HexTerrain.FADE_TINT` times the fog and layer
tints, at `HexTerrain.FADE_ALPHA` 0.5). Cells never seen are the sheet's outline frame on the lattice; void cells (`HexTerrain.voidOf`: valleys and off the map) are that outline while unseen and **nothing at all once seen**. Three layers, back to front:
outlines, fades, faces, so a fade only ever shows over void.

**Why the ground doesn't wobble:** PIXI's `roundPixels` rounds to `settings.RESOLUTION` (1),
not the renderer's 2x, and with a fractional row pitch every row snapped differently. So pads
are not rounded; every pad lands on a whole device pixel by construction (column 45, row shift
22.5, row `ROW_SCREEN` 36, all face frames the same size with the face centre on a whole texel), and
the camera and `Game`'s own position are snapped to device pixels. Break any one and it wobbles. Every layer uses the same
set, tinted by `LAYER_TINT` (`objects/fog.ts`) times the fog's. The old `hexpad/*` frames in
`hex.json` are now unused and go at its next re-bake.

**Props, effects and icons are a third generated sheet, `assets/res/arena.png` + `arena.json`,
and the two blasts are a fourth, `blasts.png` + `blasts.json`** (arena art pass 2026-09-28),
baked by `tools/bake-arena-atlas.py` from an art drop kept outside the repo
(`~/.codex/.chatgpt-projects/.../output/extraction-arena-library-v2`; its `docs/INTEGRATION.md`
is the artist's contract). Scale 2 like the ground; each frame carries the drop's pivot as its
`anchor`, so sprites are drawn at scale 1 on their ground point and no client code knows a
pivot number. Clips list their fps and loop in `meta.clips`, which `AnimationClip` reads (it
searches `atlas.json`, then the arena sheets). Portal and extract pad are **pre-squashed for
the tilt**: they stand up, never `onGround`, or they squash twice. Skill icons are resampled
256 to 68 px. The enter-screen panel and button chrome in the drop are not baked; they wait
for the robot-preview milestone. JetBrains Mono (the HUD's `THEME.font`) ships in
`assets/res/fonts/` with its OFL licence; `index.ts` waits for it, and starts without it.
Loot crystals are picked by value (`Consumable.TIERS`: under 25 small, under 50 medium, else
large), which is why a pickup's create carries `loot` since this pass.

**Peep (every player robot) is a skeletal rig, not a frame sheet** (2026-09-30, from the v15
drop in `plunder-land-client/codex_output/`, not checked in; it is a custom JS rig, **not
Spine**). `src/peep/rig.ts` is a hand port of the drop's `rig.mjs` + `animations.mjs` (pose in,
bone matrices out, pixi-free); `peeprig.spec.ts` (server) checks it, and the drawn corners of
every part, against poses sampled from the drop's own modules. A new drop: re-run
`tools/peep-rig-sync.mjs <drop>` (hulls + fixtures), fix the port until the spec passes, and
`tools/bake-peep-atlas.py <drop>` (`peep.png`, 12 KB). The rig never reads an image's size, so
the bake resamples each part to its box in rig units at `RobotSprite.PEEP_HEIGHT` (44 CSS px, Nick:
a third of the 128 first tried) x 2; change the height in both. `RobotSprite` places 14 regions a frame (about 35 sprites with finish layers); no visor mask (Nick's
call). Clips: idle/run by movement (run at `RUN_RATE` 2x the drop's speed, Nick 2026-09-30, scaled
by ground speed over `STRIDE_SPEED` 140, clamped 0.5-3x, so a dash runs the legs 2.5x faster again;
`Player.applyPosition` measures it, for remote players too; backwards while moving against the
way it faces, e.g. aiming behind), swing on melee (press and effect, deduped by
`RETRIGGER_S`), shoot on the ranged effect turned and aimed at the shot's end (the rig draws
its own muzzle flash), hit on an hp or armor drop, fall_apart on death (removal after 3 s).
The eye smiles for `Player.LOOT_SMILE_S` (0.5 s, Nick) on a loot gain (not the first loot seen for a
robot coming into view); as in the drop's preview, a change of expression is a blink with the eye
swapped 0.06 s in, and auto-blink pauses while smiling (`RobotSprite.smile`).
Jump is unused (Nick). Your own robot's gun and eye follow the mouse (`Player.aimAt` from
`Aim.world`): facing flips to the mouse's side, the rig clamps aim to +-60, so straight up and
down are accepted dead zones; no mouse over the world gives facing back to movement. Other
players aim only in actions: aim isn't on the wire.

**Magnet is drawn by its own rig** (magnet-rig, #42, from `codex_output/magnet-animations-v2`):
`src/magnet/rig.ts` ports the drop's `rig.mjs` + `animations.mjs` (gun on the near arm, the magnet
on the far arm following 30% of the aim, swing with the magnet, a heavier magnet in fall_apart),
checked by `magnetrig.spec.ts` against 220 poses from the drop (`tools/peep-rig-sync.mjs magnet`).
One sprite class draws both: `src/robots/robotsprite.ts` (`RobotSprite`, was `PeepSprite`) over a
`RobotRig` (`src/robots/robotrig.ts`: sheet, regions, clips, pose, reference height, aim shoulder,
shadow and flash sizes). Every robot is drawn at Peep's pixels per rig unit, so Magnet (227.9 units)
stands about 41 px to Peep's 44. Its sheet is `magnet.json` (`tools/bake-peep-atlas.py magnet`,
15 KB). **The lobby draws robots from 2.75x sheets** (`peep-lobby.json` 45 KB, `magnet-lobby.json`
58 KB; `bake-peep-atlas.py <robot> --lobby`; `RobotSprite(host, rig, lobby)`), because it shows them up
to 5.5x the in-game size and the game sheet was visibly soft there (Nick, 2026-10-01: 2.75x, not
5.5x at ~260 KB). The game sheets stay texel for pixel. **Known: the Peep port predates a v15 revision of shoot and swing** (the drop's
`animations.mjs` was rewritten at 17:15 on 2026-09-30, two minutes after `43ee8e2`, adding head/gun
clearance); `peeprig.fixtures.json` still holds the earlier poses, and re-running the sync tool
for Peep shows 3 poses differ (head, eye, visor). Not yet ported.

**Finishes: each robot's head, body and limbs are painted separately** (robot-finishes,
decision #41, 2026-09-30), from the drop's material maps (`materials/`: neutral, masks,
lighting, pattern-data). Every painted part is one paint group; the bake asserts it. Such a part
is four kinds of layer in `peep.json` (`peep/<art>/shade|zebra|checker|camo|fixed|hi.png`, listed
in `meta.finish`): the shading tinted by the group's colour, the group's pattern at its opacity,
the unpainted details, and the highlights with `BLEND_MODES.ADD` (drawn normally they came out
up to 60/255 too dark; the cost is two batch breaks per part with highlights, six parts, so
roughly a dozen more draw calls per robot on screen: derived, not measured).
`RobotSprite.setFinish` applies one. The bake **checks itself** against the drop's
`compose.mjs`: interior p99 at most 17/255 (the drop clamps to white per pixel, which a
colour-free layer can't copy) and it fails above 24. Light above 1x (up to 1.36 on the torso)
is dropped, because a tint can't brighten; Nick accepted it. The colours and patterns are
`utils/finishes.ts`, mirrored like `items.ts`: the ten colours of the drop's six presets
(Claude's pick, Nick may change it), patterns none/zebra/checker/camo with the opacity fixed per
pattern (camo 0.45), and ids append-only. All are free until meta-progression. They are picked in the lobby.

**The lobby replaced the enter popup** (lobby-rework, #42; mockup in the project memory,
`ideas/lobby-mockup-2026-09-30.png`). `ui/lobby/lobby.ts`: pixi draws the backdrop, the platform
and the robots (the chosen one large, aiming at the pointer, the next one dimmed); DOM over the
canvas (`lobbystyle.ts`, all `lb-` classes, placeholder chrome) carries the name pill, robot cards
(stills rendered from the rigs; Periscope, Hopper and Waddle locked "SOON", `ui/lobby/roster.ts`,
whose class lines and taglines other than Peep's are placeholder copy), stat bars read from the
mirrored `stats`, CUSTOMIZE (head/body/limbs rows of the presets' swatches, or MIX for any colour
and pattern) and READY UP. Keys: left/right, E, Enter. It remembers robot, finish and name
(`plunderland_player_robot`, `_finish`, `_name`). Not done: the hangar background (art), the
COLLECTION tab, the title (PLUNDERLAND here; the mockup says SCAVENGERS). `assets/index.html`
now declares `<meta charset="utf-8">`: without it a server that sends no charset decoded the
bundle as Windows-1252 and every non-ASCII string (the lobby's arrows) came out as mojibake.

`tiles/grass.png`, `tiles/ground.png`, `cloud.png` (since the airborne plane went), `exit.png`,
`portal.png`, `fireball/*`, `explosion/*`, `resource/*`, the `UI/controls/*` icons and the
four `obstacle_*` groups in the TexturePacker atlas are now unused, and so are the `hexprop/*`
frames in `hex.json`. They stay
because regenerating that atlas needs TexturePacker, which is not in this toolchain; that is
about 40 KB of the 327 KB atlas sitting there for nothing.

## Lockfiles are committed. Keep them that way.

Both packages previously listed `package-lock.json` in `.gitignore`. Combined with caret
ranges (`socket.io: ^4.5.4`, `socket.io-client: ^4.6.1`), a clean install in 2026 resolved
`socket.io-parser@4.2.7`, whose `maxAttachments: 10` cap **broke the game completely** —
see the wire format note below. The dependency tree is now pinned. Do not re-ignore the
lockfiles, and treat any dependency bump as something to smoke-test.

## Wire format

Server → client messages (`create`, `create_own`, `update`, `destroy`, `effect`,
`standings`) are binary. Each event is **one** buffer containing length-prefixed records.

**`standings`** goes out every 3 s (`Multiplayer.STANDINGS_INTERVAL_MS`, #38; it was 1 s)
(every `round(3000 / tick)` flushes, no timer),
**and only when the connection's buffer differs from the last one it was sent**
(`Connection.lastStandings`, cleared by `attach` so a new run always gets it; server-cpu-trim).
Each connection gets the top 10 rows of the board (`Multiplayer.STANDINGS_TOP`) plus its own
row, appended, when it is not among them (decision #30). The board is ranked once per send
(`Multiplayer.rankStandings`); `StandingsBoard.bufferFor` hands every connection in the top 10
the same buffer and appends the own row, found by player object, for the rest. The board is
every player plus the recently finished, ranked on the server by carried loot, ties by id;
finished rows rank by their loot and can hold top-10 places. A record is
`[uint16 id][uint8 status][uint32 loot][UTF-8 name][0][uint16 rank]`, rank 1-based on the whole
board (ties get distinct ranks in id order), because the appended own row is not at its rank's
position. Status is 0 ACTIVE, 1 EXTRACTED, 2 DEAD (a disconnect counts as DEAD). The enum is
`Standing` in `world.ts`, copied by hand on the client in `src/ui/components/standings.ts`
(pixi-free, with the decoder and `pickShown`; `standings.spec.ts` runs them against the
server's bytes), and append-only. Finished players linger 10 s in `World.FINISHED`, capped at
64. The client finds its own row by id while it's ACTIVE (ids are recycled after a player
leaves), so the DEAD/EXTRACTED own row sent on the tick a run ends is not highlighted. The
client reads the rank when two bytes follow the NUL and otherwise ranks by position (a server
from before the rank); an older client stops at the NUL and ranks by position, so it would show
the appended own row as 11th. **Ship the client first.** Fields after the rank are for later
additions. Measured 2026-09-26 at 1 s: about 0.19 KB/s per client at both 100 and 400 players.

**WebSocket compression is on** (permessage-deflate, `src/index.ts`, #38): windowBits 12,
memLevel 4 (about 140 KB of RSS per connection once it has sent anything, measured 2026-09-27; 24 KB before its first write), threshold 32 bytes (engine.io's own
default of 1024 is above nearly every message). `WS_DEFLATE=0` in the environment turns it off
without a build; ws warns that zlib under concurrency can fragment memory on Linux, so watch RSS
after a deploy. Browsers negotiate it with no client change. The load harness's per-client
KB/s is decompressed payload; `sockKBPerTick` (spans, `--detail 1`) is what left the socket.

The other events' records are laid out like this:

```
[uint16 length][record bytes][uint16 length][record bytes]...
```

Pack: `Multiplayer.packRecords` (server). Unpack: `Game.unpackRecords` (client).

**One frame per tick (server-cpu-trim, 2026-09-26).** socket.io sends every binary event as
two WebSocket frames (a text placeholder, then the buffer), and a connection got up to five
binary events a tick; every frame is a socket write, and sending was the biggest single CPU
cost on the server. A client that connects with query `frames=1` is sent `frames: 1` in
`hello`, and from then on **one engine.io message per flush** (`socket.conn.write`, no
socket.io events at all after `hello`):

```
[uint8 version = 1][uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]
then sections to the end: [uint8 kind][uint32 length][payload]
kinds: 1 create, 2 create_own, 3 effect, 4 destroy, 5 standings, 6 update
```

Each payload is byte for byte the buffer that event carries unframed (the update section
without the header, which is the frame's). Sections go in the order the events always went
out; an empty one is left out. Pack: `Multiplayer.packFrame`. The client's
`src/net/framedparser.ts` is a socket.io `parser` whose decoder turns each frame back into
those events (`update` always last, the header alone when there are no records), so no game
handler knows the difference. It decodes normally until a `hello` with `frames: 1`, and again
after a disconnect, so a new client works against an old server, and an old client never asks
and gets the events as before. **Kinds and the version are append-only.** `frame.spec.ts`
checks framed against unframed flushes of the same outbox and that both kind tables agree;
`interest.framed.spec.ts` runs every interest test again over frames through the client's
decoder. `tools/load/loadbot.mjs` has its own JS copy of the decoder. **Ship the client
first** is not needed here (the flag is the negotiation), but the client must be deployed for
any player to get the saving. Client → server messages are still socket.io events, two frames
each for the binary ones (`pointer`, `skill`, `use_item`); that is the next thing to frame.

**The `update` event additionally carries an 8-byte header before the records:**

```
[uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]
```

and it is emitted **every tick for every connection with a player, even when it holds no
records**, because that header is the client's clock and its input acknowledgement. Split
it with `Game.splitRecords(buffer, 8)`; `unpackRecords` is the headerless form used by the
other four events.

**Who gets what (decision #35, interest-filtered-broadcasts; #38).** Terrain (portals, exits
and any untimed obstacle: `Multiplayer.isTerrain`; the valleys go in `hello`) goes to every
connection on its layer, whatever the distance: the client routes the whole layer. **StoneWall
stones are not terrain since #38**: they go by range, like pickups (created on arrival in range
and brought into and out of view by `World.pickupPass`), because layer-wide they were 41-52% of
every client's bandwidth. A client can route through a stone it hasn't been sent; the server
corrects it and the client re-routes when the stone arrives (`Game.block`). Units, pickups and
projectiles go only to connections whose client is on their layer (`Connection.layer`) with
them strictly inside the interest box: a `create` when they come into it (from
`Multiplayer.update`, whichever side moved; pickups get an update from the pass at the end
of `World.update`), deltas while held, and a destroy with only `id` once beyond
`INTEREST_RADIUS + EXIT_MARGIN` (2 cells) or off the layer. Who holds what is
`Connection.known` / `GameObject.knownBy`; updates and destroys go to exactly the holders.
Nothing is sent about an object after its destroy (`Multiplayer.gone`): a create after a
destroy in one flush is applied create first by the client and leaves a ghost. A layer
change swaps the client at the player's own next update (`switchLayer`), in the flush with
its new tag. The join snapshot is the layer's terrain plus what is in range. Effects are
layer-checked. `World.INTEREST` is per layer. `changedAt`/`seen` and `pendingObjectIDs` are
gone.

`ackElapsedMs` is how long the server has been applying `lastInputSeq`. It exists because
the sequence number alone does not say how far *into* an input the server has got, and
without it every reconciliation drags the player backwards by a fraction of a tick. A
control run with the field forced to zero doubled the median correction (2.00 vs 1.00
units) and introduced a systematic backward bias.

**Client → server `pointer` is the route's waypoint cells:** `[uint8 count][int16 q][int16 r]
× count[uint16 seq]`, big-endian. It is sampled once per server tick, not per pointer event,
and **sent only when the route changed** since the last send (`LocalPlayer.sample`,
server-cpu-trim 2026-09-26). It used to go every tick "so a dropped one costs nothing", but a
WebSocket drops nothing, nothing reads the ack, and receiving the repeats was most of the
server's input cost. A run's first sample always goes (`LocalPlayer.reset`), and the server
forgets the last route when a player joins on a connection (`Multiplayer.attach`); without
both, a repeat of the previous run's route would read as no change. An older client that still
repeats is harmless (`sameCells`). The server ignores a buffer shorter than its own count says
(`Multiplayer.onPointer`). (It was a 4-byte direction before click-to-move routed along hex
centres.)

**Client → server `skill` is 5 bytes:** `[uint8 slot][int16 q][int16 r]`, **big-endian**,
where (q, r) is the **absolute** axial cell aimed at (decision #21). Not an offset from the
player: the predicting client and the server can disagree about the player's cell by one,
and an offset would then land a cell off. The server takes the offset from its own position.
A **bare number** (the original JSON form) is still accepted and means the slot with no
aim; anything else, including a buffer under 5 bytes or a slot that is not a whole number
in range, is ignored (`Multiplayer.parseSkill`, `Player.tryExecuteSkill`). The client sends
the cell under the desktop mouse (`src/skills/aim.ts`), or a bare number when the mouse is
off the map, on the HUD, on the player's own cell, or the input is touch. No aim, or an
aim at the caster's own cell, fires along `facing`. Fireball and icicle fly the hex line through the aimed cell, like ranged, for 10 cells. Ranged walks a hex line of cells toward the
aimed cell (see "Every area of effect" under Skills). Breaths snap the aim to one of
six and **hold** it for their lifetime (`SectorArea.fixedDirection`), while an unaimed breath
still follows facing. Dash, StoneWall, Melee and Defend ignore the aim. Mobs aim at their
target's cell (`UseSkillOnTarget`).

**`effect` records are `[int8 type][uint16 id][int8 lifetime / 100]`, plus `[int16 q][int16 r]`
(big-endian) only when the effect was aimed.** The record's length prefix says which: 4 bytes
unaimed, 8 aimed. The cell is where the effect points: the aimed cell for a ranged shot
(type 3), the cone's tip for a breath (types 0 and 1: `rings` cells straight out from the
caster's cell along the held direction, `SectorArea.tipCell`). The tip rather than the raw aim
because the client can place the caster a cell off; one cell sideways at 3 rings turns the
vector under 20 degrees, so snapping from the client's own view of the caster still lands on
the server's direction. **Types 5 and 6 are the fireball and icicle blasts**, always aimed:
their cell is the blast's centre (the struck unit's cell, or the last cell of its line if it
struck nobody). The client can't work that out for itself, because the destroy record carries no
position and its last known position is a tick behind the hit. Effects draw the cells the
server damages; the client's port of the cone and ring logic is `src/vfx/cells.ts`, and
`effectcells.spec.ts` checks it against the server's.

`maxHp` is sent per unit so the client does not have to infer a health bar's scale from the
first hp value it happens to see. **The field table is append-only** — new fields go on the
end of `fieldOrder` (server) and `allFields` (client), and the two must stay identical.

**`hello`** is emitted once on join: `{ tick, map, interest, layers }`. Nothing on the client
may hardcode these — see `src/net/session.ts`. `layers` is every layer's tag, top (01) first;
the client builds one plane per entry when `hello` lands (it precedes the join's first
flush) and labels a portal "LAYER 0N" by its `to`'s position in the list. A `hello` without
`layers` (a server from before three layers) means `[0, -1]`. **Ship the client first**:
an older client hardcodes `[-1, 0, 1]` and has nowhere to draw tag -2.

**Client → server `start_requested` is `{ id, name, finish, robot }`** (`robot` the picked
robot's key; anything not selectable plays Peep; until the lobby, the client sends `?robot=` or
`peep`) (`Multiplayer.parseStart`;
`finish` is the robot's finish as bytes, see `finish` (23), and anything unreadable in it becomes
the default, never a refused join; a client from before finishes sends none). A bare
string, the id alone, is still accepted for one release; drop it after that. The id is the
client's persistent per-browser id: exactly 6 lowercase hex digits (`genRanHex(6)` in the
lobby). The server accepts only `Multiplayer.ID_SHAPE` = `/^[0-9a-f]{6,32}$/` and ignores
anything else, so specs must use hex ids too. **Redis stats are keyed by id, never by name**.
The raw name is cut to `Player.NAME_RAW_MAX` (256 UTF-16 units) first, so a huge name costs
nothing, and then sanitised by `Player.sanitiseName`: NFKC, no control, zero-width, bidi, private-use
or blank-looking characters, no `< > & " '` or backtick, at most 16 code points, and "YOU" is
reserved (every client labels its own robot YOU). An empty result becomes a callsign hashed
from the id (`Player.callsign`, for example `ROOK-42`), so a reconnect keeps it. It travels
in the existing `name` field, NUL-terminated UTF-8.

Each record is a sequence of `[field index][payload]`, indexed into `GameObject.fieldOrder`
(server) / `allFields` (client). **These two tables must stay identical and are
append-only** — an index is a consumed boundary, so never reorder or remove one.
`fieldtable.spec.ts` enforces that they're identical. **A new field index breaks old clients**:
an old client stops parsing a record at an index it doesn't know, and fields are written
in dirty order, not table order, so it can lose a position update in the same record.
Ship the client before, or together with, the server.

`direction` has a serialiser case on the server but is **not** in `fieldOrder`, so
`indexOf` returns -1 and it would encode as key index 255, which the client (with no case
for it) reads as an unknown index and stops parsing the record. It is unreachable because
`dirtyFields.add('direction')` is commented out in `gameobject.ts`. Add it to `fieldOrder`
and `allFields` before ever re-enabling it. (`impulse` had the same, plus a client decoder
case; both went in hex-cells P4 with Dash's decaying velocity boost.)

**`Unit.facing` is the fallback aim and the "behind" reference.**
Aimed skills use the clicked cell (see `skill` above). Without an aim they use `facing`, and
Dash and StoneWall always do. `stop()` zeroes `direction`, so anything reading `direction`
fired at the caster's own feet once they stood still. `facing` is the last non-zero heading
(unit length, East until the unit first moves), kept current by `Unit`'s `direction` setter
and set by `walkPath` and `step` for each segment walked, so a walk ends facing along its last
centre-to-centre step. The client's `LocalPlayer.facingIndex` tracks it the same way, which
is what sends a standing dash the same way on both sides.
On the wire it is field `facing` (index 13): the `World.FACING_INDEX` of the vector, one byte,
0-5, marked dirty only when that index changes, so a unit walking straight sends nothing.
Remote sprites at rest face it.

**`armor` (14) and `maxArmor` (15)** are uint16, like `hp`/`maxHp`, and are sent only by
units that have an armor pool (players today). The client reads a missing field as 0. Damage
goes Defend → armor → hp (`Unit.hit`). The pool refills at the archetype's rate once its delay
has passed since the last hit that did damage (`Unit.refillArmor`). **Don't declare an `armor`
field on `Unit` or any subclass**: it would shadow `GameObject`'s accessor, and armor changes
would silently never be sent. The server typecheck (TS2610) catches it; swc alone does not.

**`archetype` (16)** is a uint8 id, sent in every unit's create and never as a delta: peep 1,
magnet 3 (periscope 2, hopper 4, waddle 5 reserved), grunt 6, boss 7, gunner 8, with 0 meaning never sent. **Ids are append-only**, like field
indices. They live in the byte-mirrored `utils/archetypes.ts`, together with kind, the Hopper
flag, vision and `rangedCells`, the RangedAttack range the client draws a beam at (unknown
id: players 8, mobs 6). The client picks a sprite by id (`src/objects/archetypesprites.ts`) and
falls back to today's sprite for an unknown id. An object that comes into a
connection's range is sent a `create`. A whole record can still arrive in `update` when a
layer change keeps an object the client already holds (`switchLayer`).

**Extraction is a channel, and exits are zones.** A player whose centre is on an exit's cell
counts down that layer's `LAYERS.extractMs` (5 / 7 / 9 s). The check runs each tick at the
top of `Player.update` (`channelExtract`). Stepping off cancels it, and so does any hit that
lowers hp + armor (a hit that Defend floors to 0 doesn't). Finishing calls `player.exit()`,
and an exited player can't be hit. **Nothing is solid since hex-cells P2:** a player walks onto an exit's cell, and a mob never
steps onto one (`World.mobCanEnter`).
`extract.spec.ts` runs the client's real `LocalPlayer` and a server `Player` over the same
routes and asserts identical positions each tick. Change one and that spec will tell you.
**`extractProgress` (19)** is a uint8, 0 when not extracting, else 1–254 as 255ths of the
layer's time. It is sent on change only, to everyone in range, and never in a snapshot.

**`loot32` (20) carries `loot` as a uint32**, capped to that range and rounded down.
`GameObject.WIRE_NAME` maps the `loot` property to it. Index 5 `loot` (uint16) stays in the
table, deprecated and never sent, because indices are append-only. The client still decodes
it for older servers. A uint16 loot over 65,535 threw inside `World.update`, so the tick's
catch skipped `flushAll` and **the whole world froze**, every tick, because loot stayed
dirty. Any uint16/uint8 field fed by an unbounded value can do the same. Audit notes: effect
lifetime is an int8 of ms/100, so a 12.8 s effect would throw; ids are uint16 but recycled a
second after release, and a 200-bot stress run peaked at id 2,610.

**`kills` (21)** is a player's credited kills this run, a uint16 saturated at 65,535, for the
end-of-run card (`run-summary-card`, decision #36). A `GameObject` accessor like `armor` (so
never declare it on a subclass), in `Player.allFieldsOwn` only, incremented by `Player.onKill`
and sent as a delta to every holder, like loot. It counts what `onKill` credits: breath kills
have no attacker and don't count, as they don't in the redis `kills` stat. The frame puts
`update` last, so a kill in the same tick as the player's own destroy never reaches its card.
**Client first**, like every new index. The load bot's and `spans.cjs`'s `WIDTH` tables and
`archetype-bot.mjs` have the row.

**`projectile` (22)** is a uint8 on a `Throwable`'s create only: `Throwable.FIREBALL` 1,
`ICICLE` 2 (client `PROJECTILE` in `objects/throwable.ts`; `arenawire.spec.ts` compares the
two, append-only). The client draws the matching clip; a server from before it sends none and
everything flies as a fireball. **Client first.** The tools' tables have the row. A
**Consumable's create carries `loot`** (as `loot32`, 20) since the same pass, so the client can
size the crystal; no new index, and an older client already decodes it. The client draws a
projectile one tick behind, gliding between its server positions and pointed along the step
(`direction` is not on the wire), hidden until its second position.

**`finish` (23)** is a player's finish (robot-finishes, #41), on every create of a player
(`allFields` and `allFieldsOwn`), never a delta: `[uint8 count = 6]` then `[colour][pattern]`
for head, body and limbs, ids from the mirrored `utils/finishes.ts`. **Counted like
`inventory`**, so a later addition only lengthens it, and `finishFromBytes` reads the first six
bytes, falling back to the default per group for an id it doesn't know. It is the last field of
a player's creates, so an older client (which stops at an index it doesn't know) loses only the
finish (`finishwire.spec.ts`). **Client first**; a server from before it sends none and every
robot is mint. The tools' tables have the row (`-2`, counted).

**`collector` (24)** is a uint16 player id on a pickup's destroy record only, when a player took
it (`GameObject.destroyCollected`; pickup-reach, #42). The client flies the pickup into that unit
if it holds it, else disposes it as before. **Client first**; an older client stops at the index,
after `id`, and drops the pickup as before (`pickupwire.spec.ts`). Tools' tables have the row.

**`item` (17) and `inventory` (18)** belong to usable items. `item` is a uint8 item id on an
`ItemPickup`; `inventory` is `[uint8 slot count][uint8 count per slot]`, with fixed slots
(key 1 = medkit, key 2 = bomb, 3–5 empty). The item table's shared half is the mirrored
`utils/items.ts`. Its server half is `ITEMS` beside `ARCHETYPES` and `LAYERS`, and each row
names a behaviour (`heal`, `bomb`), not an item. **`type` is written as an unsigned byte**,
because `ItemPickup` is type 128. **Client → server `use_item`** has the same bytes as
`skill` (a slot, plus an optional absolute aim cell), inside `guarded`, validated by
`Player.tryUseItem`; a refused use spends nothing. **Effect types 7 (bomb fuse) and 8 (bomb
blast)** go through `Multiplayer.effectAt`, which picks recipients from the effect's cell and
layer, not from the originator. A thrown bomb goes off even if its thrower has died or left
(its fuse timer has no owner), just as a fireball in flight outlives its caster.
`fieldtable.spec.ts` reads the client's `allFields` with a regex that stops at the first
`]`, so a comment inside that array must not contain square brackets.

`maxVelocity` is in `allFieldsOwn` and dirty-tracked, because local prediction cannot run
without it. It is deliberately **not** in `allFields`: remote units are interpolated between
known positions and never need a speed.

`lifetime` is encoded as centiseconds in a **uint16** (`value / 100`), giving a range of
about 65,000 seconds. It was a single signed byte, which silently capped every lifetime at
12.7s — long enough for a 3s fireball, wrong for the 60s timer on dropped loot. Encoding it
raw in milliseconds throws `ERR_OUT_OF_RANGE` for every real value including 1000.

## The grid, and how it is drawn

`Hex.SIZE` is **45 world units, the distance between neighbouring cell centres** (not
centre to corner: a corner is 26 from the centre, the inradius `Hex.RADIUS` 22.5, and one
ring is 39–45 units depending on direction). `utils/hex.ts`, `utils/path.ts` and `utils/archetypes.ts`
are byte-identical in both packages (`mirror.spec.ts` enforces it). It was 35, picked so 140 u/s covered one cell
per 250 ms tick; that coincidence lost to legibility — the player sprite is 50 px and the
game draws at 1:1, so a 35-unit cell was smaller than the character standing on it. Movement
is continuous along the path, so nothing depended on it and no speed changed.

Anything that moves with `Hex.SIZE` should be **derived from it, not written down**:
`Path.WINDOW` (140, the longest hex distance across a 4000-unit map), the path marker's
radii, the eastern-edge cell in `world.spec.ts`. Three separate literals went stale the one
time the cell size moved.

**Entering the last cell of a route is not arriving at it.** `followPath` (server `unit.ts`,
client `localplayer.ts`) only ever re-aims the index (after push-out's shoves until hex-cells P2; now only when a
tick carries a unit past a cell); it caps the index at
the last cell and never ends a route. `walkPath` / `_step` is the only thing that does, and it
finishes exactly on the centre. The two were in the wrong order once and a walk came to rest
about half a cell short of the middle, every time — invisible while a cell was 35 units and a
tick's travel was also 35, because the two crossings then fell in the same tick.

**Arriving does not clear the waypoints, only the path.** The client walks in real time and the
server starts a tick later, so the client always finishes first; clearing the waypoints on
arrival made the next input packet a "stop" that landed on a server still short of the
destination. `LocalPlayer._arrive` keeps the destination, so arriving is no change and sends
nothing (clients before server-cpu-trim repeated it every tick, which `sameCells` made free).
`stop()` stays for a real stop.

**A layer change ends the route, on both sides** (`Unit.changeLayer`, `LocalPlayer.changeLayer`):
set the tag, then `stop()`. The client doesn't predict the hop: it walks to the portal's
centre and waits there. When the tag arrives, a tick or so late, `LocalPlayer.changeLayer`
jumps with no easing to the position that came in the same record (`Game.onObjectUpdated`
reconciles a record's position before its tag, and `reconcile` remembers it), then stops.
The arrival is one cell away, inside the reconcile dead zone, so without the jump it would
be ignored. The client's route doesn't change while it waits, so it sends nothing meanwhile
(an older client repeats the old route, which `sameCells` in `Multiplayer.onPointer` ignores). `extract.spec.ts`'s mirror harness covers it with
the tag 1-3 ticks late. Known gap: a new click in that window is planned on the old layer and
shows as a correction.

`HexTerrain` (`src/objects/hexterrain.ts`) draws the ground as one sprite per cell, pooled,
rebuilt only when the camera's own cell changes. Two things about it are load-bearing:

- **A cell's face is derived from the cell, never drawn at random**, or the ground boils as
  you walk and every re-entry into view reshuffles it.
- **A value-noise field picks the *palette*, and a hash of the cell picks a face within it.**
  Choosing per cell out of one palette was the first build and it looked like static —
  patches are what makes it read as ground. `meta.regions` in `hex.json` fixes the order the
  palettes lie along the field; value noise is centre-heavy, so the middle ones dominate.

**Fog of war is cosmetic** (decision #36, `src/objects/fog.ts`). Cells within the robot's
`vision` rings (the mirrored `utils/archetypes.ts`: peep 8; null = no fog) are visible, cells
seen before on that layer this run are explored, the rest unknown. The ground is tinted per
cell (`HexTerrain.tintOf` / `retint`); `Game.applyFog` sets every object's **`renderable`**
each frame: units, pickups and projectiles only on visible cells, terrain on visible and
explored, portals, exits and your own robot always (#16). `renderable`, not `visible`, because
other code already drives `visible` (a unit that left the interest box, a stale one) and the two
would undo each other. The server still sends everything in its 500-unit box, so a modified
client sees through fog; server-enforced fog would also cut bandwidth and is not decided. The
minimap draws only `renderable` objects, or it would show what fog hides.

**World markers** (`world-markers`, M2, placeholder look). Every unit has a fixed-width
health bar over its head (`ui/elements/unitbar.ts`: 36 px, 60 for a boss; red mobs, blue
players, green for you); it used to be `maxHp` pixels wide. Names, portal "LAYER 0N" and exit
"EXTRACT" labels are plates from `ui/elements/nameplate.ts`, under the thing they name. Red
**threat cells** (`ThreatMarker`) are the union of a disc per boss (FireBreath's 4 rings: it
can turn to any side) and gunner (its 6-cell shot) the player can see; grunts are left out.
The reach is `threatRingsOf` in the pixi-free `vfx/cells.ts`, pinned to the server's skills
by `effectcells.spec.ts`. The route is cyan and ends in a lit hex. Shapes and colours read
in a 720p frame shrunk to 240p; plate text does not.

**A run ends in a card** (`ui/popups/runsummary.ts`, `run-summary-card`): outcome, time, loot
banked or lost, kills (`kills`, 21), deepest layer and robot, from `Game.RUN`. Its PLAY
AGAIN (or Enter / Space) calls `Game.start`; there is no longer a 2 s automatic restart.

**The canvas renders at the screen's density** (`index.ts`: `resolution` = devicePixelRatio
capped at 2, `autoDensity`, re-read on resize). pixi's default of 1 gave a Retina screen a
half-resolution canvas stretched 2x, and everything looked soft. Layout, pointer coordinates
and `renderer.screen` stay in CSS pixels. Headless screenshots need `deviceScaleFactor: 2` to
see the difference.

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
   `Unit.walkPath`, including Dash (`routeBudget` / `_routeBudget`), the route cut at portals
   (`endAtPortal` / `_endAtPortal`) and the facing set for each segment walked; **if one
   changes, the other has to change with it** or prediction starts fighting the authority.
   There is no push-out on either side (hex-cells P2): terrain blocks cells, units don't, and
   routes only cross free cells.
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

**Mobs step cell to cell** (`Unit.step`, hex-cells P2, #31). The AI sets `stepGoal` (a cell
and how near to get) every tick; at each cell centre the mob takes the neighbour nearest the
goal that `World.mobCanEnter` allows (not blocked, not a gate or arrival cell, not held),
ties to the lowest `Hex.DIRECTIONS` index, and stays if none is nearer (`Unit.chooseStep`,
greedy: a single rock on the hex axis stops it dead; BFS is the documented upgrade in a
comment there). A step once started is always finished. **One mob per cell**: a mob holds
the cell it left and the one it enters until it arrives (`World.STEPS`), and its own cell at
rest (`World.mobHolds`, through the `UNITS` index). Players may share cells with each other
and with mobs. Contact damage lands within the archetype's `contact.rings` (1: adjacent or
the same cell, `Mob.touch`), and the chase stops there (`GuardPosition.chaseStop`, or at the
standoff if that is further: the gunner's 5).

`Session` (`src/net/session.ts`) owns every timing constant, and separates what the server
*says* (`tickMs`, from `hello`) from what the connection *delivers* (`arrivalP95`, measured).
Interpolation is timed off the measured value.

**Liveness is not a heartbeat.** Idle units now send nothing at all, so "hasn't updated
recently" no longer means "gone". `Game.stillPresent` treats a silent unit as present if it
is inside the interest radius and absent otherwise. The old per-player 3-byte id heartbeat
is gone; the update header replaced it with a fixed per-connection cost instead of a
per-visible-player one (break-even at about three visible players). Since #35 a unit that
leaves a client's view is destroyed (a destroy without `hp`, which the client hides at once),
so `stillPresent` only matters for a held unit idling in the exit margin.

## Things that are deliberate

- **Several worlds per process, behind a current world** (worlds-per-process, decision #39,
  2026-09-28). Every mutable piece of world state is an instance field of `World` (the lists,
  `UNIT_SOURCES`, the cell indexes, `BLOCKED`, `VOIDS`, `VOID_RUNS`, `STEPS`, `MOVED_BUCKETS`,
  `FINISHED`, `mapSize`), and so are its `Timers` queue (`world.timers`), its id pool
  (`world.ids`: ids are per world) and its `Multiplayer` (`world.multiplayer`). The static
  names (`World.PLAYERS`, `Timers.schedule`, `GameObject.id`, `Multiplayer.Instance`) are
  accessors onto **`World.current`**, so game code and specs didn't change. Static methods and
  constants (`LAYERS`, `TAGS`, `config`, `GATE_SPACING`…) are shared. **`World.run(world, fn)`**
  makes a world current for synchronous work and restores the previous one; `new World()`
  makes itself current (so single-world specs just work), `World.build` doesn't.
  `src/network/worlds.ts` owns the one io server: a run (every `start_requested`, not a
  connection) goes to the fullest world with fewer than `WORLD_CAP` (200) active players, ties
  to the oldest, or a new world; one with no active players for `WORLD_IDLE_MS` (300000) closes,
  never the last. A connection that moves is released completely (`Multiplayer.release`: out of
  the old connection list and every old object's `knownBy`). The loop ticks and flushes each
  world in its own `World.run` and try/catch (`Worlds.tickAll`); every socket handler runs in
  `World.run(itsWorld)` inside `guarded`. **Work outside `World.run` fails loudly**: the server
  sets `World.strict`, so between runs no world is current and `World.X`, `Timers` and new
  objects throw; a world ticked, or a Multiplayer used, while another is current throws a
  `WrongWorldError` (`World.expect`, `Multiplayer.checkWorld`). Both count in `World.wrongWorld`,
  which `worlds.spec.ts` holds at 0 through a two-world run. **After an `await` no world is
  current**: capture what a promise needs first (the stats writes take `redis` before theirs).
  Specs run non-strict: the first `World.X` read before any `new World()` makes a default world
  with no map, which adopts the queue and id pool already in use. A spec's
  `Object.create(World.prototype)` ticks the current world, as before. Shared by every world,
  on purpose: the io server, one Redis client with one error listener (`Multiplayer.shareRedis`),
  the `ThrottledLog`s, `GameObject._scratch`, `Path` scratch, `_terrainRecords` (weak).
  **The client ships first**: the next run on a socket may be another world, and the client
  resets its map, fog and ids per run (`resetForRun` in `net/runmap.ts`, from `Game.start`);
  an older client keeps `Game.BLOCKED` across runs and would route on the old world's stones.
- **Nothing is persisted.** The world lives entirely in memory. Redis holds only cumulative
  `stats-*` hashes. This is why the tick has an error boundary — an uncaught throw would
  otherwise take every in-flight run down with the process. It also rules out serverless,
  edge, and sleep-enabled hosting: a sleep/wake cycle wipes the world.
- **Delayed world work goes through `Timers` (`src/objects/timers.ts`), never `setTimeout`.**
  A `setTimeout` callback runs outside the tick's error boundary. `Timers.run` is called
  first in `World.update`, with a catch per timer. Give a timer the object whose state it
  changes as its owner, so the timer is cancelled when that object dies or exits. Never
  give a cleanup timer an owner that can die before the thing it cleans up. The only
  `setTimeout` left is the game loop's own scheduler in `index.ts`. **Socket handlers
  (`start_requested`, `pointer`, `skill`) run inside `Multiplayer.guarded`**, which catches
  per event. They are applied on arrival, not queued for the tick, on purpose: a skill's
  cooldown is checked against `Date.now()`, and queuing would move that check to tick time
  and change which presses at the end of a cooldown are accepted. A join that throws is
  undone (`onStart`).
- **A dead unit stays findable until the next tick's sweep.** `FIND_IN_CELLS` and the world
  lists still return it, so anything that damages, credits or destroys a unit must check
  `destroyed` first. `Unit.hit` does. A second hit on a corpse used to free its id twice
  and credit a second kill. The cell index keeps it too, until the sweep.
  `NEAREST_IN_CELLS` skips it by default; `FIND_IN_CELLS` and `UNITS_ON` don't.
  So `World.MOBS.length` is not the population: a mob killed during the tick's MOBS pass
  after its own sweep check (a gunner's shot, a boss's breath inside the victim's own update)
  stays as a corpse until the next tick, and `refillLayer` (which counts live mobs) has
  already replaced it. The list holds one more than `LAYERS` on about 1 tick in 100; count
  `!destroyed`. That was the `stepping.spec.ts` "population never filled" (82 vs 81) flake,
  closed in hex-cells P4.
- **Units, pickups and gates are indexed by cell** (`World.UNITS`, `PICKUPS`, `GATES`, and
  `INTEREST` for players by 500-unit bucket; `utils/cellindex.ts`). Server code adds and
  removes through `World.addUnit`/`removeUnitAt`, `World.PICKUPS.push`/`removeAt`/`remove`
  and `World.addObstacle`/`removeObstacleAt`/`removeObstacle`, never on the lists directly.
  A unit refiles itself from the `position`/`tag` setters (`GameObject.placed`). Specs may
  edit the lists directly: the next lookup rebuilds (counted in `rebuilds`;
  `cellindex.spec.ts` asserts a world run through its own paths never rebuilds). The one
  edit the check can't see keeps a list's length and last element, such as replacing a
  middle element in place.
- **Tests that tick a real `new World()` get random exits, portals and mobs.** A player
  standing on an exit extracts after the layer's `extractMs`, a portal moves a player to
  another layer, and a mob never steps onto a gate or an arrival cell (`World.mobCanEnter`). Two test flakes came from this (`c14d74a`, `34835e1`; both
  from a portal moving a mob, which it no longer does). Clear `World.OBSTACLES`/`BLOCKED`/
  `MOBS` after building the world unless the test is about the map, and assert only what
  holds wherever the gates land when it is (`layers.spec.ts`).
- **A stats write ends in `.catch(Multiplayer.logStatsFailure)`, never `void`.** A rejected
  `void` promise is an unhandled rejection, which ends the process, and no try/catch around
  the tick can see it. With Redis down, every disconnect used to kill the server that way.
  Failures log at most one line a minute (`ThrottledLog`).

## Skills

All eight are equipped: Dash, MeleeAttack, RangedAttack, Defend, StoneWall, ThrowFireball,
Throwicicle, IceBreath. **The order of `Player.skills` is a wire contract** — the client sends
the index of the slot pressed and `tryExecuteSkill` indexes straight into the server's array,
so the two lists must stay identical. The HUD bar binds them to `q w e r t y u i`.

**All eight have their own icon since the arena art pass** (2026-09-28; the four that had
none are still in `src/skills/placeholders.ts`, which kept its name), and the shield,
snowflake, flame, muzzle flash, icicle and both blasts are arena sprites. Still missing and
wanted: `player/magic/frame` and `player/shoot/shot` clips (Defend and RangedAttack used to
call them and only logged an error), and every unit (the drop excludes units). A name
missing from every sheet isn't a harmless blank: pixi fetches it as a URL and throws an
uncaught error on every use. `textures.spec.ts` (server) fails on any literal sprite or
animation name the client uses that isn't in one of the five sheets; names picked from a
table (`Consumable.TEXTURES`, `ItemPickup`'s `ART`, the skill icons) are not checked.

**Every area of effect is a set of hex cells, not a radius.** A unit is inside if the cell
under its centre is. `World.FIND_IN_CELLS` covers rings around a cell: melee is 2 rings
around the caster, and the fireball/icicle blast is 1 ring around **the cell of the unit
struck**, or around the last cell of its line if it struck nobody. Breath cones are `World.CONE_CELLS`: the
facing snaps to one of the six `Hex.DIRECTIONS`, and each ring is the three forward
neighbours of the ring before, so ring k has 2k+1 cells. No angle test. **Ranged is a hex
line** (`Hex.line`, mirrored): cube lerp and round from the caster's cell toward the aimed
cell, on to the range in cells (players 8, gunner 6). It hits the first unit on those cells
(`World.FIRST_ON_LINE`), which includes one on the caster's own cell. A fixed nudge makes ties
break the same way on both sides (pinned in `hex.spec.ts`). Aiming at a cell's centre and
testing distance to the segment missed about 29% of targets 6 cells away.

**Projectiles are not solid, and have their own list.** A `Throwable` lives in
`World.PROJECTILES`, not `OBSTACLES`. When it was solid, every fireball exploded on its
caster. **Fireball and icicle step along a 10-cell hex line** (`Throwable.RANGE_CELLS`; the
skill builds it with `RangedAttack.lineOf`: through the aim, or along the hex facing;
hex-cells P3, #34). The front starts `HEAD_START` (8) thirds of a cell out and gains `STEP`
(5) thirds a tick, in integers and not scaled by dt, so it is on line index 4, 6, 7, 9, 10
after ticks 1-5 (at a non-default `TICK_MS` its speed in u/s changes). Each newly crossed
index strikes the first unit, never the owner, on that cell or a neighbour of it
(`SWATH_RINGS` 1), found through `World.UNITS` (`Throwable.findHit`): one on a line cell
before one beside the line, the earliest line cell first, then the lowest id. Reaching index
10 bursts there. Reach is 11 cells in every direction; a unit that leaves the swath before
the front arrives is not hit. Rocks don't stop it. The 1200 ms `lifetime` is still sent, but
nothing ends a projectile by time. `World.updateProjectiles` walks the list backwards and is
the **only** place a projectile is removed. Splicing from inside `explode`, which runs within
the projectile's own update, made the next projectile skip a tick. `OBSTACLES` holds
stones, portals and exits (and held world rocks, `World.isRock`, until the valleys).

**StoneWall is placed behind the caster on purpose**, to block chasers. Do not "fix" it to
the front. It fills the 3 cells directly behind (`StoneWall.cells`: the neighbours at b-1,
b, b+1, b opposite the facing), one stone per cell centre. A cell is skipped if it is off
the map, already blocked, holds a portal or exit, is a portal's arrival cell, has a live unit
on it, or is held by a mob mid-step (`StoneWall.canPlace`): a mob always finishes a step, so a
stone on its next cell would trap it. `World.BLOCKED` maps each cell to its one
blocker, not a count, so two blockers on one cell would let the first to expire unblock
the other's cell. The skip is what makes a stone's unconditional unblock safe.

## Known-unfixed

- **Levels never change.** `setLevel(1)` is called once; `LEVEL_THRESHOLDS` sits commented
  out in `playerstats.ts`, so the per-level damage tables always index level 1.
  Note `Player.setLevel()` zeroes `this.loot` — probably leftover init, but nobody has
  decided whether that is meant to be "spend your haul on power or carry it to the gate".
- **Our client-side teardown is `dispose()`, not `destroy()`.** `destroy()` belongs to PIXI and
  overriding it with a different signature meant PIXI's own cleanup could never run. `dispose()`
  deliberately does *not* chain to `super.destroy()`: effects hold a reference to their target
  for up to a second after it dies, and freeing the container under them throws. Dropping every
  reference — `LOOKUP`, `Game.PORTALS` and the per-type arrays, all done in `onObjectDestroyed` —
  is what actually lets it be collected.
- **AI targets are released when they die.** `GuardPosition` only scans for a new target
  while `owner.target` is null, so a target that dies or extracts used to leave the unit
  permanently blind — wandering, while `UseSkillOnTarget` (which only tests for null) kept
  attacking the corpse. Anything that latches onto a target must clear it the same way.
  **Ranges are rings (#32)**: a player is noticed at `Hex.distance` <= 4 (gunner 6) and kept
  to 5 (gunner 7); the gunner holds at 5. Acquisition takes the nearest live player by rings,
  ties to the lowest id. An idle mob wanders to a free cell centre within 1 ring of home.
  **Being hit by a player also sets the target** (`GuardPosition.provoke`), so a mob can no
  longer be killed from beyond its notice range without reacting. It chases until the
  attacker is beyond max(lose, the rings at the hit + 1), and always switches to whoever
  hit it last. Contact damage lands within the archetype's `contact.rings` (1), see "Mobs step cell to cell"
  under Movement. Breath damage has no attacker attached, so being inside a player's
  cone counts as a hit.
- **A loot pickup banks and does not heal** (decision #5, `usable-items`). It used to do both;
  healing is the medkit's job now. Items are not loot (#12): a medkit or bomb is an
  `ItemPickup` in `World.ITEMS`, never a `Consumable`. **Every robot picks up loot and items
  within `pickupReach` rings: 1 (#42; Magnet 3), null = own cell**, one loot and one item a tick
  (`Player.pickUp`). A taken pickup's destroy names its taker (`collector`, 24), and the client
  flies it into them (`Game.flyToCollector`, 250 ms). Death drops (loot and items) land on free cell centres within
  `World.DROP_RINGS` (2), never on a rock or portal cell (`World.dropCells`).
- **Dropped loot expires after `World.DROPPED_LOOT_LIFETIME` (30s); natural spawns do not.**
  The world's own spawner is bounded by a count, drops were not.
- **Dash is 3 cells of route at 2.5× speed** (#34, `Unit.dash`, `Unit.routeBudget`;
  `DASH_CELLS`, `DASH_MULTIPLIER`), predicted by `LocalPlayer.dash`. Standing, it goes up to 3
  cells along the facing snapped to one of six (`Unit.dashCells`), stopping before a rock,
  stone or the map edge; with no free cell it is refused and the cooldown is not spent. A
  slowed dash still covers 3 cells. It is a distance (`dashLeft`), not a time, so client and
  server cover the same stretch although the server gets the press a tick later; the client's
  reconcile dead zone widens by the dash's 81-unit gain for a moment after it. It replaced a
  decaying velocity boost (`impulse`, `IMPULSE_FRICTION`, both deleted in hex-cells P4) that
  the client could not predict and that could never last less than a tick.
- **`tickLengthMs` is `TICK_MS` in the environment**, default 250, and is sent to the client
  in `hello`. **Do not re-propose tuning it as a latency fix** — git history shows six changes
  in eight days that ended where they started, and the measured tick is healthy: 200
  concurrent players hold 249ms with a 255ms p95. Latency was architectural, not cadence.
