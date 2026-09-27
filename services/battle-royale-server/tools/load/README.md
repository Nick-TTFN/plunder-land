# Load harness

Measures what the server costs per connected player: a private server with a
timing probe preloaded, a ramp of headless bots, and a table per step. Every
scale change proves itself against the baseline below.

## Run it

```
cd plunder-land-client           && npm ci        # the bots use its socket.io-client
cd services/battle-royale-server && npm ci
cd services/battle-royale-server && tools/load/ramp.sh --steps "0 100 400" --step-secs 30
```

That builds the server, starts it from `dist/` on port 8100 with Redis pointed
at the dead port 6399, waits 45 s for the world to fill, adds bots in
processes of 50, and prints the table. It takes about 2.5 minutes. Options:
`--steps`, `--step-secs` (45), `--settle` (15, skipped at the start of each
step so the join burst doesn't count), `--warmup` (45), `--port`,
`--redis-port`, `--out` (default a new temp dir), `--batch`, `--spread-ms`
(10000, how long one process takes to join all its bots), `--cpu-prof`,
`--no-build`, `--detail 1|2` (per-function timings, below). `ramp.sh --help` prints them.

**Rules.** Never use ports 6379 or 8000 (the local dev stack; the script refuses
them). Give each parallel lane its own `--port` and `--redis-port`. The script
stops the server and every bot process **by PID** on exit or Ctrl-C and never
pattern-kills, so other lanes' processes are safe. If you run the pieces by
hand, do the same.

## The pieces

| File | What it is |
|---|---|
| `ramp.sh` | The one command. Writes `steps.log`, `server.jsonl`, `bots.jsonl`, `botcpu.log`, `server.log`, `bots.err` into `--out`. |
| `probe.cjs` | `node -r probe.cjs dist/index.js`, with `PROBE_DIST` (the `dist/` folder) and `PROBE_OUT` set. Wraps `World.update`, `Multiplayer.flushAll`, `update`, `admit` and the input handlers without touching the source, and writes one JSON line per 5 s. Costs about 4% of busy time. |
| `loadbot.mjs` | `node loadbot.mjs <url> <count> <prefix> <outFile> [joinSpreadMs]`. One process, `count` bots. Each re-sends its route every tick (as the client does), re-routes 2-8 cells away every 3-7 s, presses a random aimed skill every ~2 s, sometimes uses an item, and rejoins on death or extraction. A failed connect is retried with backoff (0.5 s doubling to 10 s) and counted as `connectFails`. |
| `analyse.py` | `python3 analyse.py <dir> [--settle 15] [--json]`. The table. |
| `spans.cjs` | Loaded by `probe.cjs` when `PROBE_DETAIL` is 1 or 2 (`ramp.sh --detail`). Wraps about 75 named server functions in stack-nested spans (calls, inclusive and self ms per tick), counts socket.io emits and bytes, and counts TCP socket writes (`net.Socket` `_write`/`_writev`, one syscall each). Level 2 adds tiny per-candidate helpers, for call counts only. The wrapper cost is calibrated at start (about 35 ns a call on an M4 Max) and printed as `overhead`; at 400 players it is under 1 ms a tick. A name it can't find is logged as `probe: not wrapped`, so a rename shows up instead of silently reading zero. |
| `spans.py` | `python3 spans.py <dir> [--settle 15] [--step N] [--top 40]`. Per step: the CPU budget (tick, input handlers, GC, and the rest, which is mostly socket.io/ws sending; main-thread ELU; kernel time), socket writes and emits per tick, then the functions by self time. |
| `tickbench.cjs` | `node tickbench.cjs [dist]`. Deterministic in-process tick benchmark: seeded, 400 players on fake sockets, no bots competing for the CPU. Prints `Multiplayer.update` and whole-tick ms. Same commit, same world every run, so compare two builds of the tick with this; the ramp's per-function times read ~5x higher on a shared machine. |
| `prof.py` | `python3 prof.py <dir or .cpuprofile>`. Top self time and inclusive server time from `ramp.sh --cpu-prof`. |

`loadbot.mjs` resolves its dependencies from its own location, never the cwd:
`socket.io-client` from `plunder-land-client` (the server package doesn't
depend on it; `LOADBOT_CLIENT_DIR` overrides the folder), and `Hex`/`Vector`
from this server's `dist/utils`, which is why it needs a build. Its field-width
table (`WIDTH`) mirrors `fieldOrder` up to index 21 (`kills`); **add a row
when a field is appended**, or the bots stop finding their own position and
stand still.

## Reading the table

- **world ms**: mean `World.update` per tick. **bcast ms**: the part of it in
  `Multiplayer.update` (every dirty unit against every connection).
  **flush ms**: `Multiplayer.flushAll`. **tick p95**: the loop's interval.
- **cpu %**: of one core, server process only. **elu**: event-loop use; 1.0 is
  saturation. ELU is meaningless under `--cpu-prof` (it read 0.9 at 0 players).
- **per-client / standings KB/s**: received by one bot. **egress MB/s** =
  per-client x players.
- **join KB**: what a bot receives from connect to its first `update` (hello,
  the whole-world `create`, `create_own`). Checked against an independent
  socket: 19.0 vs 19.1 KB at 1 player. It is `-` in a step where no join
  completed after the settle.
- **fails**: connect attempts that failed. Non-zero means the server is
  refusing new connections, i.e. saturated.

## Noise: compare runs back to back

Within one run the 5 s windows usually agree to within about 10% (the worst
step seen ran from 13 to 20 ms), but four runs of the
same commit on the same M4 Max gave, in world ms:

| run | 100 bots | 400 bots |
|---|---|---|
| baseline (0/50/.../1000, 45 s) | 13.6 | 60.2 |
| 0/100/400, 30 s, no warmup | 7.5 | 54.9 |
| 0/50/100/200/400, 45 s, no warmup | 16.1 | 70.5 |
| 0/100/400, 30 s, 45 s warmup (the documented command) | 18.2 | 66.3 |

World state doesn't explain it: obstacles at 400 were 648 to 671, mobs 81-82,
players 396-397. The cause is unmeasured (other load on the machine, or which
cores macOS gave the process, are guesses). Bandwidth is steady: per-client
KB/s agreed within 5% across all four. So to judge a change in tick time, run
the old commit and the change back to back on the same machine, at least twice
each, with the same arguments. At 400 bots a difference under about 20% from
one pair of runs is not a result; at 100 bots even a 2x difference isn't.

Without `--warmup` step 0 starts in a half-filled world (237 to 322 of 450
loot pickups) and reads about 0.4 ms instead of about 2.

## Baseline, 2026-09-25 (`29e82fa`)

M4 Max, Node 24.4.1, steps of 45 s, first 15 s skipped, 81 mobs. The raw data
is not committed; it is in Claude memory at `tasks/load-harness/` and this is
`analyse.py` over it.

| bots | players | world ms | bcast ms | flush ms | tick p95 | cpu % | elu | per-client KB/s | standings KB/s | egress MB/s | join KB |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 2.35 | 0.03 | 0.01 | 251.8 | 1.0 | 0.01 | - | - | - | - |
| 50 | 50 | 10.26 | 1.55 | 1.31 | 256.1 | 6.6 | 0.07 | 1.4 | 0.8 | 0.07 | 21.8 |
| 100 | 100 | 13.57 | 2.90 | 1.12 | 251.9 | 8.2 | 0.08 | 2.6 | 1.6 | 0.26 | 25.0 |
| 200 | 199 | 33.64 | 9.69 | 2.78 | 254.9 | 18.3 | 0.19 | 5.1 | 3.2 | 1.02 | 31.1 |
| 400 | 396 | 60.19 | 23.79 | 6.52 | 252.1 | 37.3 | 0.37 | 11.1 | 6.9 | 4.38 | 42.8 |
| 600 | 588 | 123.59 | 55.12 | 12.45 | 252.6 | 75.8 | 0.74 | 17.5 | 10.8 | 10.31 | 54.1 |
| 800 | 684 | 168.26 | 76.79 | 15.94 | 263.4 | 104.4 | 1.00 | 20.9 | 12.2 | 14.29 | 61.5 |
| 1000 | 684 | 170.85 | 77.88 | 16.39 | 266.4 | 103.6 | 1.00 | 20.7 | 12.4 | 14.19 | 62.1 |

One core saturates at about 684 players; about 300 of the 1000 bots never held
a connection. Those bots did not retry a failed connect; these do, so a
saturated step now shows up in **fails**.

A repeat of the same commit with this harness, same shape (0/50/100/200/400,
45 s, before `--warmup` existed) gave 0.38 / 3.77 / 16.05 / 36.84 / 70.47 world
ms and 1.4 / 2.5 / 5.2 / 10.9 KB/s per client: bandwidth reproduces, tick time
is inside the noise above.

**Bot caveats.** Bots all start on layer 01 and rarely go down (denser than
real play), cast StoneWall freely (obstacles grow from 450 to about 650 at
400 bots, which lengthens every scan), and die far more often than people.
Localhost network. The server container runs Node 18, not 24.

## server-cpu-trim, 2026-09-26: paired against `9d2a23b`

M4 Max, Node 24.4.1, `--steps "0 200 400" --step-secs 40 --warmup 45`, rounds run
A, C1, C0, A, C1, C0 back to back. A = `9d2a23b` (ES5 build, one socket.io event per
kind). C = the change (ES2022 build, allocation-free serialiser and packing, outbox
on the connection, one frame per tick for clients that ask). C1 = framed bots, C0 =
bots connecting as older clients (`--frames 0`), which isolates everything but the
frames. CPU per player-second = cpu % x 10 / players.

| | 200: world ms | 200: CPU ms/player-s | 400: world ms | 400: flush ms | 400: CPU % | 400: CPU ms/player-s |
|---|---|---|---|---|---|---|
| A run 1 / 2 | 10.8 / 13.0 | 0.60 / 0.65 | 21.7 / 22.8 | 6.9 / 7.0 | 20.7 / 21.1 | 0.52 / 0.53 |
| C1 run 1 / 2 | 7.7 / 9.2 | 0.41 / 0.44 | 14.0 / 15.4 | 5.0 / 4.9 | 12.2 / 13.4 | 0.31 / 0.34 |
| C0 run 1 / 2 | 8.3 / 9.5 | 0.55 / 0.57 | 14.7 / 19.7 | 6.1 / 7.8 | 17.6 / 20.6 | 0.44 / 0.52 |

Per-client bandwidth unchanged (2.25-2.43 KB/s at 400), no connect failures, client
update gap p95 256-274 ms in every run.

## server-cpu-trim round 2, 2026-09-26: paired against `c3f7f63`

Route sent only on change, pickup pass skips pickups nobody moved near,
broadcast loop without the WeakMap and with inlined box tests, timers skip
the scan until something is due, terrain records cached, gate checks cached
per cell, standings only when changed. B = `c3f7f63` with bots re-sending
their route every tick (the old client); N = the change with bots sending on
change (the new client); Nt = the change with old-client bots.

| | 200: CPU ms/player-s | 400: world ms | 400: CPU % | 400: CPU ms/player-s | 400: inputs/s |
|---|---|---|---|---|---|
| B run 1 / 2 | 0.43 / 0.42 | 15.5 / 14.2 | 13.2 / 12.8 | 0.33 / 0.32 | 1770 |
| N run 1 / 2 | 0.35 / 0.37 | 11.8 / 13.3 | 10.5 / 10.9 | 0.27 / 0.28 | 280 |
| Nt run 1 / 2 | 0.42 / 0.42 | 12.8 / 12.0 | 12.2 / 11.8 | 0.31 / 0.30 | 1780 |

`tickbench.cjs`, three runs each: Multiplayer.update 1.87-1.94 -> 1.37-1.40 ms per
tick, whole tick 2.73-2.85 -> 2.29-2.33. Bandwidth unchanged; standings barely
moved (200 -> 186 B/s), because the bots' board changes nearly every second.
