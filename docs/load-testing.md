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
(deterministic, in-process, 400 players, no sockets), and say that sending isn't in it.
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
same.
