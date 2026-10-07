# Server invariants

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Things that are deliberate

- **Several worlds per process, behind a current world** (worlds-per-process, decision #39,
  2026-09-28). Every mutable piece of world state is an instance field of `World` (the lists,
  `UNIT_SOURCES`, the cell indexes, `BLOCKED`, `VOIDS`, `VOID_RUNS`, `STEPS`,
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
- **The world is not persisted.** It lives entirely in memory. Redis holds cumulative
  `stats-*` hashes (and the `player-<id>` first days); Postgres holds guest accounts only
  (see Accounts). This is why the tick has an error boundary — an uncaught throw would
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
  `INTEREST` for players by `World.INTEREST_BUCKET` (585-unit) bucket; `utils/cellindex.ts`). Server code adds and
  removes through `World.addUnit`/`removeUnitAt`, `World.PICKUPS.push`/`removeAt`/`remove`
  and `World.addObstacle`/`removeObstacleAt`/`removeObstacle`, never on the lists directly.
  A unit refiles itself from the `position`/`tag` setters (`GameObject.placed`). Specs may
  edit the lists directly: the next lookup rebuilds (counted in `rebuilds`;
  `cellindex.spec.ts` asserts a world run through its own paths never rebuilds). The one
  edit the check can't see keeps a list's length and last element, such as replacing a
  middle element in place. `PICKUPS` files three lists: `CONSUMABLES`, `ITEMS` and `GEAR`.
- **Type 128 is shared by `ItemPickup` and `GearPickup`** (#49): `ObjectType` is a bit mask
  (`typeMask` in `World.FIND_IN_CELLS`) and all 8 bits of the uint8 are taken. The server tells
  them apart with `World.isGear`, the client by whether the create carries `gear` (25) or `item`
  (17). **Gear has its own list, `World.GEAR`, and every place that walks `ITEMS` must decide
  what it does with `GEAR`**: an interest path that misses it never sends gear, and nothing errors
  (the interest specs, plain and framed, and `pickuppass.spec.ts` hold gear to exact held sets).
  The bot brain once read `.kind` off any type-128 pickup and threw inside the tick on gear. A spec
  that lists or clears the world's lists includes `GEAR`.
- **Tests that tick a real `new World()` get random exits, portals and mobs.** A player
  standing on an exit extracts after the layer's `extractMs`, a portal moves a player to
  another layer, and a mob never steps onto a gate or an arrival cell (`World.mobCanEnter`). Two test flakes came from this (`c14d74a`, `34835e1`; both
  from a portal moving a mob, which it no longer does). Clear `World.OBSTACLES`/`BLOCKED`/
  `MOBS` after building the world unless the test is about the map, and assert only what
  holds wherever the gates land when it is (`layers.spec.ts`).
  Three more rules from the 2026-10-03 flake hunt (`a69af95`): a spec that moves a unit by hand
  keeps it on the map (an east step from the last column was clamped back into its own cell); a
  spec that counts bots keeps them alive and in play (`sturdy` in `bots.spec.ts`); a spec that
  checks what a player picked up allows for refilled natural loot and other players taking it.
- **A stats write ends in `.catch(Multiplayer.logStatsFailure)`, never `void`.** A rejected
  `void` promise is an unhandled rejection, which ends the process, and no try/catch around
  the tick can see it. With Redis down, every disconnect used to kill the server that way.
  Failures log at most one line a minute (`ThrottledLog`).
