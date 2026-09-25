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
cd plunder-land-client        && npm run typecheck   # 33 errors — see baseline below
cd services/battle-royale-server && npm run typecheck # must stay at 0
cd services/battle-royale-server && npm test          # node --test via ts-node
```

The server's `tsconfig` excludes `*.spec.ts`, so **specs run but are never typechecked**. A
type error in a spec only shows up if ts-node trips over it at run time.

**Unit stats live in one table**, `src/archetypes/archetypes.ts` (peep, grunt, boss, and the
robots and gunner to come): body, HP, speed, loot, contact damage, kill-stat keys, skills
with per-archetype overrides, and AI routines with their parameters. There is no `Boss`
class. `src/archetypes/baseline.spec.ts` pins the pre-refactor behaviour; change it only on
purpose. `plunder-land-client/tools/archetype-bot.mjs <server-url>` records what a real
join sees on the wire (Node 22.18+).

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

- 9 strictness nits that predate 2026-09-24, listed by file so they can be recognised:
  `game.ts` (four "possibly undefined", around `onObjectDestroyed` and the end of the file),
  `skills/dash.ts` (one), `skills/skill.ts` (`uiTexture` not initialised),
  `ui/elements/progressbar.ts` (`_timeoutId` not initialised). (The two implicit `any`
  parameters in `vfx/meleeattack.effect.ts` went when that file was rewritten.)

Anything **outside** these three groups is a new regression. The count is 33 (measured
2026-09-25: the Defend effect's `Point` anchor went with its rewrite); compare the sorted
error list, not just the count, before
dismissing.

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

**Client → server `pointer` is the route's waypoint cells:** `[uint8 count][int16 q][int16 r]
× count[uint16 seq]`, big-endian. It is sampled once per server tick, not per pointer event.
The server ignores a buffer shorter than its own count says (`Multiplayer.onPointer`). (It
was a 4-byte direction before click-to-move routed along hex centres.)

**Client → server `skill` is 5 bytes:** `[uint8 slot][int16 q][int16 r]`, **big-endian**,
where (q, r) is the **absolute** axial cell aimed at (decision #21). Not an offset from the
player: the predicting client and the server can disagree about the player's cell by one,
and an offset would then land a cell off. The server takes the offset from its own position.
A **bare number** (the original JSON form) is still accepted and means the slot with no
aim; anything else, including a buffer under 5 bytes or a slot that is not a whole number
in range, is ignored (`Multiplayer.parseSkill`, `Player.tryExecuteSkill`). The client sends
the cell under the desktop mouse (`src/skills/aim.ts`), or a bare number when the mouse is
off the map, on the HUD, on the player's own cell, or the input is touch. No aim, or an
aim at the caster's own cell, fires along `facing`. Fireball and icicle fly toward the aimed
cell's centre at any angle and on to their range. Ranged walks a hex line of cells toward the
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
their cell is the blast's centre (the struck unit's cell, or the projectile's own cell on
expiry). The client can't work that out for itself, because the destroy record carries no
position and its last known position is a tick behind the hit. Effects draw the cells the
server damages; the client's port of the cone and ring logic is `src/vfx/cells.ts`, and
`effectcells.spec.ts` checks it against the server's.

`maxHp` is sent per unit so the client does not have to infer a health bar's scale from the
first hp value it happens to see. **The field table is append-only** — new fields go on the
end of `fieldOrder` (server) and `allFields` (client), and the two must stay identical.

**`hello`** is emitted once on join: `{ tick, map, interest }`. Nothing on the client may
hardcode these — see `src/net/session.ts`.

Each record is a sequence of `[field index][payload]`, indexed into `GameObject.fieldOrder`
(server) / `allFields` (client). **These two tables must stay identical and are
append-only** — an index is a consumed boundary, so never reorder or remove one.
`fieldtable.spec.ts` enforces that they're identical. **A new field index breaks old clients**:
an old client stops parsing a record at an index it doesn't know, and fields are written
in dirty order, not table order, so it can lose a position update in the same record.
Ship the client before, or together with, the server.

`direction` and `impulse` have serialiser cases on both sides but are **not** in
`fieldOrder`, so `indexOf` returns -1 and they would encode as key index 255. They are
currently unreachable because `dirtyFields.add('direction')` / `('impulse')` are commented
out in `gameobject.ts`. Add them to `fieldOrder` before ever re-enabling those.

**`Unit.facing` is the fallback aim and the "behind" reference.**
Aimed skills use the clicked cell (see `skill` above). Without an aim they use `facing`, and
Dash and StoneWall always do. `stop()` zeroes `direction`, so anything reading `direction`
fired at the caster's own feet once they stood still. `facing` is the last non-zero direction
(unit length, East until the unit first moves), kept current by `Unit`'s `direction` setter.
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
grunt 6, boss 7, gunner 8, with 0 meaning never sent. **Ids are append-only**, like field
indices. They live in the byte-mirrored `utils/archetypes.ts`, together with kind, the Hopper
flag and vision. The client picks a sprite by id (`src/objects/archetypesprites.ts`) and
falls back to today's sprite for an unknown id. An object that comes back into a
connection's range is re-sent whole in `update`, so a full record can arrive there too.

`maxVelocity` is in `allFieldsOwn` and dirty-tracked, because local prediction cannot run
without it. It is deliberately **not** in `allFields`: remote units are interpolated between
known positions and never need a speed.

`lifetime` is encoded as centiseconds in a **uint16** (`value / 100`), giving a range of
about 65,000 seconds. It was a single signed byte, which silently capped every lifetime at
12.7s — long enough for a 3s fireball, wrong for the 60s timer on dropped loot. Encoding it
raw in milliseconds throws `ERR_OUT_OF_RANGE` for every real value including 1000.

## The grid, and how it is drawn

`Hex.SIZE` is **45 world units** and `utils/hex.ts`, `utils/path.ts` and `utils/archetypes.ts`
are byte-identical in both packages (`mirror.spec.ts` enforces it). It was 35, picked so 140 u/s covered one cell
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

- **One world per process.** `World.PLAYERS`, `MOBS`, `OBSTACLES`, `PROJECTILES`, `CONSUMABLES`,
  `AREA_EFFECT`, `TAGS`, `mapSize`, `config` are all `static`, and `Multiplayer.Instance`
  is a static singleton. No rooms, no world reset without a restart, and multi-region means
  separate non-communicating worlds. Converting these to instance state is the one genuinely
  structural change the codebase would need for concurrent rooms.
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
  and credit a second kill.
- **Tests that tick a real `new World()` get random exits, portals and mobs.** An exit
  extracts a player, and a portal moves a unit to the other plane. Two test flakes came
  from this (`c14d74a`, `34835e1`). Clear `World.OBSTACLES`/`BLOCKED`/`MOBS` after
  building the world unless the test is about the map.
- **A stats write ends in `.catch(Multiplayer.logStatsFailure)`, never `void`.** A rejected
  `void` promise is an unhandled rejection, which ends the process, and no try/catch around
  the tick can see it. With Redis down, every disconnect used to kill the server that way.
  Failures log at most one line a minute (`ThrottledLog`).

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
Also a **shield** (Defend) and a **snowflake** (IceBreath): both are drawn with `Graphics`
for now, because the sprite names they used were never in the atlas. A name missing from the
atlas isn't a harmless blank: pixi fetches it as a URL and throws an uncaught error on every
use. `textures.spec.ts` (server) fails on any literal sprite or animation name the client
uses that isn't in `atlas.json`/`hex.json`.

**Every area of effect is a set of hex cells, not a radius.** A unit is inside if the cell
under its centre is. `World.FIND_IN_CELLS` covers rings around a cell: melee is 2 rings
around the caster, and the fireball/icicle blast is 1 ring around **the cell of the unit
struck** (or the projectile's own cell if it expires). Centring a distance blast on the
projectile missed the unit it had just hit, because a projectile's 50-unit collider sets
it off before the target is inside a 70-unit blast. Breath cones are `World.CONE_CELLS`: the
facing snaps to one of the six `Hex.DIRECTIONS`, and each ring is the three forward
neighbours of the ring before, so ring k has 2k+1 cells. No angle test. **Ranged is a hex
line** (`Hex.line`, mirrored): cube lerp and round from the caster's cell toward the aimed
cell, on to the range in cells (players 8, gunner 6). It hits the first unit on those cells
(`World.FIRST_ON_LINE`), which includes one on the caster's own cell. A fixed nudge makes ties
break the same way on both sides (pinned in `hex.spec.ts`). Aiming at a cell's centre and
testing distance to the segment missed about 29% of targets 6 cells away.

**Projectiles are not solid, and have their own list.** A `Throwable` lives in
`World.PROJECTILES`, not `OBSTACLES`, so nothing pushes out of it. It does its own hit test
after moving, and that test never matches its owner. When it was solid, every fireball
exploded on its caster. `World.updateProjectiles` walks the list backwards and is the
**only** place a projectile is removed. Splicing from inside `explode`, which runs within
the projectile's own update, made the next projectile skip a tick. `OBSTACLES` holds only
solid things, which is what the 300-obstacle rock refill counts.

**StoneWall is placed behind the caster on purpose**, to block chasers. Do not "fix" it to
the front. It fills the 3 cells directly behind (`StoneWall.cells`: the neighbours at b-1,
b, b+1, b opposite the facing), one stone per cell centre. A cell is skipped if it is off
the map, already blocked, holds a portal or exit, or has a unit on it. `World.BLOCKED` is a
Set, not a count, so two blockers on one cell would let the first to expire unblock the
other's cell. The skip is what makes a stone's unconditional unblock safe.

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
