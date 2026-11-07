# World, layers and map generation

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

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
(depth is `-tag`). Deeper is richer and more dangerous (decisions #3, #16, #26). **Layers 01 and 02 pay almost
nothing** (#60's loot cut, 2026-11-06): 10 natural pickups worth 2-4 each and NPC drops at a
tenth of the old ×1 / ×1.75, so real loot, XP from loot and season credit start on layer 03,
where humans meet. **Every
per-layer number lives in one table, `LAYERS` in `src/archetypes/archetypes.ts`**: tag, loot
multiplier (×0.1 / ×0.175 / ×3 on natural pickups and on every mob's loot, not on what a dead
player drops), the void share (1/3 each, the valleys), natural loot cap (10 / 10 / 150, death drops
uncapped), portals up and down, exits (4 each, #10) and the mobs kept alive: the NPC roster (#51, L1; `docs/npcs.md`),
Crawler packs and single NPCs per layer, built by `npcPopulation` from `NPC_NUMBERS.layers`.
**The NPC rows of layers 01 and 02 are area-scaled for the private map** (2000, a quarter of the
shared 4000's area; #60 addendum 2026-11-07, Dez's `ideas/private-layers-numbers.md` section 1):
01 one Crawler pack and one Compactor (~3.9 mobs alive), 02 two packs (Coil escort 0.6), two
Compactors, a Kiln and a Reactor (~11). Their gates, items and caches still have the shared
map's counts (task private-8). The rows are read wherever a world holds those layers: private
worlds in production, and a shared world holding every layer only when `privateRuns` is
`false` (specs, and the load tools' old modes), which then runs them sparse on a 4000 map. A
first-run world never refills from them.
`World.refillLayer` tops each entry up every tick, at most one spawn (or one whole pack) per
entry per tick; **a pack entry counts live packs, a single entry counts live mobs with no
pack** (`packsAlive`), so a pack is replaced only when all its members are dead. The layer tags reach the client in `hello.layers`; **the client
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
portal, exit and spawn hazard (an epic or legendary NPC, `World.isSpawnHazard`: Reactor,
Brood, and the retired boss), and from other mobs when possible (`World.spawnCell`); distances
are from a unit's centre cell, so a Reactor's or Brood's 7-cell body is 2 rings from the edge
(`docs/npcs.md`, "Bodies"), and such a body spawns only where all 7 cells are free (`spawnMob`,
`World.mobFits`). A fully random spawn
put about 1 join in 250 close enough to an exit to leave within a second. Bots join on any
layer (`docs/bots-and-spectate.md`); a first run's handoff joins layer 01 with clearance 6 (below).
The airborne plane,
its clouds and the half-alpha "ground seen from above" are gone; only the player's own layer
is drawn.

## First-run worlds

**A new account's first run is a private mini world, ending in one teleport into layer 01 of a
shared world** (decision #58; built in tasks retest-3/4/5). Who gets one, energy and the account
flag: `docs/accounts.md`, "First run". The `Worlds` side (its own list, every reader of `worlds`):
`docs/server-invariants.md`, "First-run worlds". Wire: `docs/wire-format.md` (`handoff`).

- **A real `World` per first run**, built `World.build(FIRST_RUN.mapSize, { firstRun: true })`:
  the constructor returns before any carving (no valleys, portals, exits or walls), `World.update`
  skips `refillLayer` and mobs drop no gear (`createGearFrom` skipped). `World.TAGS` and `LAYERS`
  are unchanged, so `hello.layers` is the usual three and the player stands on the first; making
  `LAYERS` per world was rejected (24 readers in 13 files). The map is sent in `hello.map` as for
  any world, so the client takes the small map as it takes a new world.
- **The content is `firstrun/scenario.ts` (`FIRST_RUN`, `buildFirstRun`)**, Dez's strip
  (`ideas/retest-onboarding.md` section 4): a 1200-unit map; a centreline from (3,4), 12 cells
  east then 13 south-east (26 cells, indices 0-25, bent at 12); everything within 2 rings of it
  is ground (5 wide) and every other cell of layer 01 is void through `VOIDS`/`VOID_RUNS`, so
  `hello.voids` carries it and the client routes as on any map. Beats: the start with nothing in
  reach; three rocks (archetype 16, `docs/npcs.md`, "Rock") at index 7 and two at 8 beside the line,
  beyond a robot's vision and shot (6); a real Crawler at 16 (7+ rings from every rock, outside its notice of 5, so the rocks are
  a safe beat; `scenario.spec.ts` checks every rock against both NPCs' notice + 1); a real
  Compactor at 21; the pad at 25.
  Mobs guard the cell they were placed on; loot is the layer's multiplier as `placeMob` gives it,
  rocks exactly 3. A Periscope (vision 10) sees the rocks from the start; new accounts can only
  pick Peep. Dez's "glint" at the edge of vision has no art and is left out.
- **Fixed start:** `World.spawn` (humans only, read by `createPlayer`).
- **HP floors at 1** there (`Unit.hpFloor()`, 0, read in `Unit.hit`; `Player.hpFloor()` is 1 in a
  first-run world), so nobody dies in it. `Player.onKill` writes no Redis kill stats and
  `addLoot` sends no `first_loot` there.
- **The pad is a `HandoffGate`** (`firstrun/gate.ts`): a `Portal` (wire type 8) to its own layer
  (`to === tag`), flagged `handoff`. Every portal rule already treats `to === tag` as leading
  nowhere (`World.portalOn`, `World.isArrival`, `gateKeepOut`, the client's `_stopsOn`), so it hops
  nobody, ends no route and is no arrival cell; the client labels it LAYER 01, where it leads.
  `Player.update` calls `World.handoff` when a human stands on a handoff gate in a world that has
  a `handoff` set (`Player.onHandoffGate`; only first-run worlds set one today; never for a bot);
  `Worlds` hands off after the tick. An exit pad was rejected: its
  channel and EXTRACTING cues say the player is leaving.
- **The handoff's join** lands on layer 01 at a normal random spawn cell with **mob clearance 6**
  (`HANDOFF_CLEARANCE`, `network/worlds.ts`) for that spawn only: `World.spawnCell(tag, clearance =
  SPAWN_CLEARANCE)` takes it as a parameter, and every other join keeps 3.
- **Measured (retest-4, this Mac):** with the strip's 5 mobs, 50 concurrent first runs cost
  0.232 ms a tick in all, 0.0047 ms per first-run player (a shared-world player is ~0.0083 ms in
  tickbench), heap ~0.10 MB and RSS ~0.21-0.25 MB per first run. `tools/load/firstrunbench.cjs`.
  Beck's scripted perfect walker (`tools/load/firstrunwalk.cjs`) reaches the pad in ~14 s against
  Dez's 45-60 s target (open for Dez).
- **Tutorial hint:** while `Session.firstRun` (`hello.firstRun`) and auto-aim has a target (the
  first rock onwards), the ranged skill card pulses an accent outline, only while it's ready
  (`HUD.update`, `SkillCard.setHint`). Gone after the handoff.
- **Known:** an AFK player in a first-run world can't die and nothing idles it out: the world
  stays open for the tab's life, counts toward `FIRST_RUN_CAP` and holds a drain for the full
  `DRAIN_MAX_MS`. An idle limit is Nick's call (retest-4 review).

## Partial worlds

**A world can hold only some of the layers** (decision #60, task private-1, 2026-11-06;
mechanism only: no world is built this way until private-6). `World.build(size, { layers })`
takes the tags it holds (`WorldOptions.layers`; an empty list or an unknown tag throws); left
out, it holds every layer, and such a world is unchanged (a seeded comparison of hello bytes,
gates and mob counts against the commit before was identical).

- **`World.TAGS` and `LAYERS` stay global.** A layer's position in `World.TAGS` is read by
  `botLayer` (the `BOT_SKILL` row), `deepest_layer` and the XP depth term, and by the client's
  layer numbers, labels and tints from `hello.layers`; with the global list a shared world
  starting at tag -2 still calls it layer 03 everywhere. `hello.layers` is every tag in every world.
- **An unheld layer is built empty:** no valleys, walls, gates, mobs, loot, items or caches
  (`World.update` refills only held layers, through `World.holds`, because specs tick an
  `Object.create(World.prototype)` world that never ran the constructor). Humans join, and a
  bot with no layer or an unheld one lands, on `World.topLayer`, the first held layer.
- **Pads out of the world.** A held layer's portal count into an unheld layer places
  `HandoffGate`s with the real `to` (`World.placeGate`, same spacing and clearance; the unheld
  side is trivially clear): down counts always, up counts only with `padsUp` (default off).
  On the wire a pad is a portal, labelled with the layer it names. **`World.portalOn` skips a
  pad** (or `Player.hopPortal` would drop the player onto an empty layer) and **`World.padOn`
  finds one** (always undefined in a world holding every layer). Routes end on a pad on both
  sides: `Player.stopsOn` is `portalOn || padOn`, matching the client's `_stopsOn` (any portal
  to another tag). A human standing on one calls `World.handoff`.
- **Bots never take a pad:** `robotAllowedOn` requires a held layer, and `routeLeavesRange`
  checks `padOn` too, so a route that would end on a pad halts.
- **`hello.voids` for an unheld layer is one all-void run** `[0, cells]`
  (`World.unheldRuns`), so a client routes nowhere there; `walls` is `[]` for it. A held
  layer's runs are as before.
- **The client still builds an unheld layer, and that is deliberate** (task private-2,
  measured 2026-11-06): its plane, an empty terrain and empty walls (6 display objects), alpha
  0 and never drawn, since nobody stands on it. Per unheld layer at map 4000: about 150 KB of
  heap (its all-void Set) and about 2.4 ms of `onHello` on a 4x-CPU-throttled phone emulation
  (0.8 ms desktop), against a phone hello of about 120 ms. Skipping it would thread
  placeholders through every reader of the parallel `layers`/`terrains`/`walls` arrays for
  that. Re-measure before proposing it again if maps grow past 4000 or a world leaves many
  more layers unheld. The planes are rebuilt at every world's hello (`Game.resetRun` drops
  them on a handoff too), not once per session.
- **Open (private-6):** the client ignores input on a pad until its tag changes
  (`LocalPlayer.awaitingHop`), so a refused or delayed handoff would leave the player stuck on it.

## The private map

**Every private world is built on one map** (decision #60, task private-5, 2026-11-06; mechanism
only until private-6 builds private worlds): `World.build(size, { layers, map: PRIVATE_MAP })`
(`src/objects/privatemap.ts`, `WorldOptions.map`).
- **Seeded, so it is the same in every process and across deploys.** The first private world a
  process builds runs the ordinary generation (`carveValleys`, `placeGate`, `placeWalls`) with
  `seeded(PRIVATE_MAP_SEED)` (mulberry32, integer math only) instead of `Math.random`, so the map
  neither depends on nor shifts the world's other draws. It leaves a template on the map:
  valleys, walls, run encodings, static blocked cells, and gate sites in placement order. Every
  later private world takes it (~0.15 ms, against ~16 ms for the generating build).
- **Shared read-only.** The `VOIDS`, `WALLS`, `VOID_RUNS` and `WALL_RUNS` entries are the
  template's own objects in every private world: `FrozenSet`s whose `add`/`delete`/`clear` throw,
  and frozen arrays, which throw on write in the server's strict-mode output. So is the terrain in
  `BLOCKED` (private-10): the template holds each layer's void and wall cells once as a
  `FrozenCells` (a Map whose `set`/`delete`/`clear` throw), and each later world's `BLOCKED` layer
  is a `CellOverlay` on it: reads check the world's own entries (made on its first stone or rock),
  then the base; writes go to its own entries; **a write to a base cell throws**, through
  `World.block`/`unblock` or directly, because only an obstacle is ever unblocked and none may
  stand on void or a wall. `privateblocked.spec.ts` covers the sharing, the throws, a StoneWall
  and a bomb in a private world, and plain Maps everywhere else (shared and default worlds, and
  the world that generated the map, which keeps the `BLOCKED` it built). `BLOCKED` went from 56.3
  to 1.55 KB a private world (heapattr, `docs/load-testing.md`).
- **Per world:** `BLOCKED`'s own entries (its stones and rocks, over the shared terrain), new
  portal, exit and pad objects at the template's sites (own ids), and every NPC, pickup, item and
  cache (`refillLayer`, at random as in any world).
- **One map, one key:** size, held tags and `padsUp`. A world on `PRIVATE_MAP` that asks for
  anything else throws. The holder keeps its one template for the life of the process (~110 KB at
  map 2000, estimated), on purpose.
- **A new map is a release.** A changed seed, a changed generator (`valleys.ts`, `walls.ts`,
  `World.placeGate`, `getUnobstructedPosition`) or a changed `LAYERS` row the map reads
  (`voidShare`, `wallShare`, gate counts) changes the map for every player. `privatemap.spec.ts`
  pins its `DIGEST` (hello voids and walls plus gate sites); update it only on purpose. Today the
  map uses today's gate counts (28 gates); private-8's rows will change it. The key does not
  include the `LAYERS` rows, so code that edits `LAYERS` after the first build gets the old map.
- A world built with `firstRun` or `empty` ignores `map`.

## Map generation

**The valleys replaced world rocks** (`src/objects/valleys.ts`, tile art pass 2026-09-27).
About a third of each layer (`LAYERS.voidShare`) is void: winding chasms from ridged value
noise, void specks under 12 cells filled back in, free scraps under 30 cells filled, and every
other cut-off region joined to the rest by a one-cell bridge carved across the shortest stretch
of void, so each layer's ground is one walkable region (`valleys.spec.ts`). Carved once per
layer in the `World` constructor, before the gates, at random (every server start is a new
map, ~30 ms a layer; except the private map, below); void cells are in `World.BLOCKED` with a null blocker and in
`World.VOIDS`. They are not objects: they reach the client as **`hello.voids`**, per layer in
`layers` order, alternating free/void run lengths over `Hex.mapCells(map)` (mirrored in
`utils/hex.ts`, a consumed order), decoded by `Session.decodeRuns` into `Game.VOIDS`, which
routing (`Game.isBlocked`) and the ground (always unknown void) read. Additive: an older client
routes into valleys and gets corrected, so **ship the client first**. No world rock is placed
any more (`World.isRock` still tells StoneWall stones apart for the bomb). **Known gap:** mobs
still step greedily (`Unit.chooseStep`) and stall on valley edges; real mob pathing was
deferred on 2026-09-27.

**Walls inside the islands** (decision #44, 2026-10-01; built 2026-10-02: generation, wire,
routing, drawing, Hopper through them; shot blocking deferred). `src/objects/walls.ts` (server) puts straight runs of 2-5 cells on the ground the
valleys leave, `LAYERS.wallShare` of it (0.06, provisional), after the gates so they keep out of
`World.gateKeepOut`; segments never touch, and one that would cut the ground apart or need a detour of
more than `DETOUR_RINGS` (10) is refused (`walls.spec.ts`). About 5 ms a layer; a whole-layer flood fill
per segment was 140. Wall cells are in `World.BLOCKED` with a null blocker, like void, so mobs, spawns,
drops and StoneWall avoid them with no other change, and in `World.WALLS` for what will treat them
differently. **Mobs keep greedy stepping and may stall on a wall; accepted** (Nick: mobs are noise in a
PvP free-for-all). They reach the client as **`hello.walls`**, run lengths like `hello.voids`
(additive; client first), into `Game.WALLS` (`RunMap.walls`, blocked for routing), and are drawn by
`src/objects/walls.ts` (client) from the ground's own art (Nick: "use same tiles and wall drop offs"):
per cell, the face its ground cell wears (`HexTerrain.faceOf`) lifted `Walls.HEIGHT` 11 px (60% of the
first 18, Nick), a faint white over it (`Walls.HIGHLIGHT`, so it reads lighter than the floor; a tint can
only darken), the edge drop-offs (`fade_left`/`fade_right`) hung under it at full strength, and its hex
swept along `shadowOffset` as its shadow;
sorted by `y` with the units at the cell's north boundary (at its centre, a Hopper stepping off northwards was drawn behind the wall it still stood on), shown and tinted by the fog every frame. **Hopper walks through walls
and StoneWall stones and may stop on them** (step 2, 2026-10-02): `Unit.blocks` (server; route planning
and the standing dash) stops a unit whose archetype `passesObstacles` only at void and the map edge
(`World.isVoid`), mirrored by the client's `Game.blocksLocal`, which `LocalPlayer` routes with
(`extract.spec.ts`'s Hopper tests, one a client/server mirror). A robot on a wall cell is drawn raised by
`Walls.HEIGHT`, eased over `Player.LIFT_MS` (80 ms). **Walls don't stop shots**: step 3 of #44 is
deferred (Nick, 2026-10-02: "shots stopped maybe not needed for now"), so ranged, fireball and icicle
still fly through walls as they did through rocks.

## Known-unfixed

- **Levels never change.** `setLevel(1)` is called once; `LEVEL_THRESHOLDS` sits commented
  out in `playerstats.ts`, so the per-level damage tables always index level 1.
  Note `Player.setLevel()` zeroes `this.loot` — probably leftover init, but nobody has
  decided whether that is meant to be "spend your haul on power or carry it to the gate".
  Account levels (#48 step 3) are separate and do change; `Unit.level` stays 1.
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
  **Ranges are rings (#32)**: each archetype's guard has `acquire`/`lose`/`standoff` in rings
  (the NPCs' in `NPC_NUMBERS`, `docs/npcs.md`; the retired grunt noticed at 4, kept to 5). Acquisition takes the nearest live player by rings,
  ties to the lowest id. An idle mob wanders to a free cell centre within 1 ring of home.
  **Being hit by a player also sets the target** (`GuardPosition.provoke`), so a mob can no
  longer be killed from beyond its notice range without reacting. It chases until the
  attacker is beyond max(lose, the rings at the hit + 1), and always switches to whoever
  hit it last. A pack's members are provoked together (#51). Contact damage lands within the archetype's `contact.rings` (1), see "Mobs step cell to cell"
  under Movement. Breath damage has no attacker attached, so being inside a player's
  cone counts as a hit.
- **A loot pickup banks and does not heal** (decision #5, `usable-items`). It used to do both;
  healing is the medkit's job now. Items are not loot (#12): a medkit or bomb is an
  `ItemPickup` in `World.ITEMS`, never a `Consumable`. **Every robot picks up loot and items
  within `pickupReach` rings: 1 (#42; Magnet 3), null = own cell**, one loot and one item a tick
  (`Player.pickUp`). A taken pickup's destroy names its taker (`collector`, 24), and the client
  flies it into them (`Game.flyToCollector`, 250 ms). Death drops (loot and items) land on free cell centres within
  `World.DROP_RINGS` (2), never on a rock or portal cell (`World.dropCells`). Gear (#49) is
  picked up the same way, one gear pickup a tick, and dropped on death with the rest.
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
