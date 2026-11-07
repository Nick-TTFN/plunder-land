# Load testing

_Moved verbatim from CLAUDE.md on 2026-10-07. A quoted section name ("Who gets what", "Accounts"…) may live in another file here: CLAUDE.md lists which file holds each topic._

## Server cost per player

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
not simulating. `--frames 0` makes the bots connect as pre-frame clients;
`LOADBOT_ROBOT=<key>` in the environment makes them join as that robot (Peep otherwise, whose
vision is the smallest, so under server fog it is the cheapest viewer). The ramp unsets
`DATABASE_URL`, so its bots get in-memory guest accounts (#48; join size and latency moved
slightly from `57671dc`). **When the ramp's CPU numbers are noisy** (other lanes or apps on
the machine, as on 2026-10-03), compare two builds of the tick with `tools/load/tickbench.cjs`
(in-process, 400 players, no sockets), and say that sending isn't in it. **It is not
deterministic**, whatever its header says ("the same commit gives the same world every run"):
on 2026-10-12 (ice-1) one build of `502b902` gave `avgHolders` 9.6 / 9.8 / 10.3 and `moving`
118 / 102 / 109 across runs, and `tickMsPerTick` 3.58 and 4.10 (14 % apart). Probably the NPCs
on the real `Date.now` (below). So alternate base and new, at least twice each, and treat a
few percent as noise. **Its players cast no skills** (they only walk random routes;
mobs still attack): it measures a player skill's always-on cost (getters and gates read every
tick) but never a player's cast, a chill, a breath area or a thrown projectile.
**What tickbench does not exercise.** Its header says mobs are removed, which is stale: the wipe
(`World.MOBS.length = 0`) runs at construction, before any mob spawns, and `refillLayer` fills
every layer within the first ticks, so the bench does tick mobs. But every player joins on layer
0, so mobs on -1/-2 sit idle, and the bench runs far faster than game time with the real
`Date.now`, so **`Timers`-driven work (cooldowns, fuses, lobs, bursts, releases) barely fires**.
Comparing two builds whose difference is NPC behaviour therefore needs a variant that spreads
the players over the layers and simulates the clock (`Date.now` advanced 250 ms a tick, players
healed each tick so the population stays engaged, effects counted by type). Release L1 did that
as a scratch copy (`l1-10-release.md` in the project memory has the numbers); folding it into
`tickbench.cjs` as options is open. With NPCs that draw from the seeded `Math.random`, two builds
bench different worlds (check `avgHolders`, `moving`, the counts) and part of any difference is
the world, not the cost. **Since #60 it is not production's shape either:** its `new World(4000)`
holds every layer and its players join tag 0, which is now a private layer with the area-scaled
NPC rows on a 4000 map, while a production shared world holds 03-05 and its humans join on 03.
It still compares two builds of the same tick; a variant joining a shared-shaped world (Beck's
scratch `SHARED=1`, private-8) is not committed.
`GEAR=<0-2>` makes every player equip that many max-roll T3 items. **Its world is seeded
through `Math.random`, and the gear caches (`World.refillCaches`, including its
`getUnobstructedPosition`) draw from it**, so a build that adds or moves a draw benches a
different world (49-2: avgHolders 10.1 against 8.6, which read as +9% tick). When comparing across
a change to world building, give the caches their own RNG in both builds and check `avgHolders`
agrees; measured that way 49-2 cost +0.094 ms a tick (+3.1%, accepted by Nick, #49).
**Several worlds** (worlds-per-process): `ramp.sh` passes its environment through, so
`WORLD_CAP=100 tools/load/ramp.sh …` runs 400 bots as 4 worlds. The probe then sums
`World.update` and `flushAll` over one pass of the loop (`Worlds.tickAll`), so "world ms" is
still per tick of the loop, and its counts are summed over the open worlds (`worlds` is the
number open). It reads each world's own lists: with `World.strict` on, a static `World.X`
outside `World.run` throws, which is the point, so anything added to the probe must do the
same. **The probe reads `Worlds.worlds` only** (`counts()`), so since #60 it misses every
private and first-run world: its players and mobs undercount once runs are private (not fixed).

## Private worlds (decision #60)

`tools/load/privatebench.cjs` (`node --expose-gc`; options in its header). **`MODE=real` is the
production path** (private-6): every human starts in a private world of its own through the real
`Worlds` (`Worlds.privates`, `openPrivate`, the private map, `prefill`), with `PRIVATE_BOTS` bots
by the human's layer (a comma list, default the code's `PRIVATE_BOTS_DEFAULT`) and no
`PRIVATE_CAP`; `DESCEND=1` sends every human down a real portal to layer 02 at tick 100 and
counts bots from then on (`maxBots`). Use it without `PRIVATE` and `LAYERS`. A simulated clock
(250 ms a tick) runs bots and NPC timers; humans are healed every tick so no run ends. Prints
ms per tick per human, heap/RSS per human after a GC, `World.build`'s time and the counts. No
sockets, so sending isn't in it. Measured at `1436bb5`'s rows (private-8, Beck's runs, twice each,
`MODE=real N=100,500 MAP=2000`): at 500, 0.0572 ms/tick and 0.071-0.072 MB heap per human; at
100, 0.056 ms and 0.095-0.097 MB.
The old modes, `MODE=private|shared` (`N`, `BOTS`, `MAP`), run with `privateRuns: false`: N
one-human worlds holding every layer (cap 1, bots topping up to `BOTS`) against the same humans
in one shared world. Without `PRIVATE` or `LAYERS`, every world there is a full five-layer
build: an upper bound for a two-layer copy.

`PRIVATE=1` (old modes only) builds every world as a private world: the top two layers held
(`WorldOptions.layers`, so layer 02's down count places pads out of the world) on the shared
`PRIVATE_MAP` (`WorldOptions.map`). Use it without `LAYERS`. The first build generates the map
and is reported apart as `firstBuildMs`; `buildMsPerWorld` covers every later build. Measured
2026-11-06 (private-5, M-series Mac, `MAP=2000 BOTS=4 MOBSCALE=0.25 LOOTSCALE=0.25`, after the
layer 01-02 loot cut): later builds 0.14 ms, the first 15.5-16.7 ms; 0.18-0.21 MB heap per
world; ~0.06 ms/tick per human at N=50 and N=100.

**Where a private world's heap goes:** run privatebench with `SNAPSHOT=<dir>` (it writes
`before-<n>.heapsnapshot` before anyone joins and `after-<n>.heapsnapshot` after the ticks), then
`node tools/load/heapattr.cjs <dir>/before-<n>.heapsnapshot <dir>/after-<n>.heapsnapshot`. It labels
every new node with the `World` field it is first reached from and prints KB per world per field
(`L1`), one class deeper (`L2`), and what no world reaches (`UN`, KB total). Something shared by
every private world (the private map's terrain) is counted once, against whichever world reached
it first, so it shows up amortised. An N=100 after-snapshot is ~30 MB (run 2026-11-07 with
`node --max-old-space-size=6000`; not tried without).
Measured 2026-11-07 (private-10, `MODE=real N=100 MAP=2000`, one run): `BLOCKED` 1.55 KB per world
(56.3 when it was copied per world: Archie's run at `d47fad2` with `MOBSCALE=0.25`, a different
configuration), ~125 KB attributed per world in all.
