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
(depth is `-tag`). Deeper is richer and more dangerous (decisions #3, #16, #26). **Every
per-layer number lives in one table, `LAYERS` in `src/archetypes/archetypes.ts`**: tag, loot
multiplier (×1 / ×1.75 / ×3 on natural pickups and on every mob's loot, not on what a dead
player drops), the void share (1/3 each, the valleys), natural loot cap (150 each, death drops
uncapped), portals up and down, exits (4 each, #10) and the mobs kept alive: the NPC roster (#51, L1; `docs/npcs.md`),
Crawler packs and single NPCs per layer, built by `npcPopulation` from `NPC_NUMBERS.layers`.
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
put about 1 join in 250 close enough to an exit to leave within a second. The airborne plane,
its clouds and the half-alpha "ground seen from above" are gone; only the player's own layer
is drawn.

## Map generation

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
