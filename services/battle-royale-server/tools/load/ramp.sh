#!/usr/bin/env bash
# Ramp a crowd of bots against a private server and print the cost per step.
#
#   tools/load/ramp.sh [--steps "0 100 400"] [--step-secs 45] [--settle 15]
#                      [--warmup 45] [--port 8100] [--redis-port 6399] [--out DIR]
#                      [--batch 50] [--spread-ms 10000] [--cpu-prof] [--no-build]
#
# Builds the server, starts it from dist/ with probe.cjs preloaded on --port,
# with Redis pointed at --redis-port (which must be dead: stats writes fail and
# are logged, which is the point), and adds bots in processes of --batch until
# each step's count is reached. --warmup seconds pass between the server
# starting and step one, so the world has filled (450 loot pickups take ~38 s).
# Every process it starts is stopped by PID on exit, including on Ctrl-C. It
# never pattern-kills, so other lanes' servers and bots are safe. Ports 6379
# and 8000 are refused: they are Nick's stack.
#
# Output (in --out, default a fresh temp dir): server.jsonl (probe), bots.jsonl
# (bots), steps.log, botcpu.log, server.log, bots.err, and a .cpuprofile with
# --cpu-prof. The table at the end is analyse.py over that folder.
set -eo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$(cd "$HERE/../.." && pwd)"

STEPS="0 100 400"; STEP_SECS=45; SETTLE=15; WARMUP=45; PORT=8100; REDIS_PORT=6399
OUT=""; BATCH=50; SPREAD_MS=10000; CPU_PROF=0; BUILD=1

usage () { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --steps) STEPS="$2"; shift 2 ;;
    --step-secs) STEP_SECS="$2"; shift 2 ;;
    --settle) SETTLE="$2"; shift 2 ;;
    --warmup) WARMUP="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --redis-port) REDIS_PORT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --batch) BATCH="$2"; shift 2 ;;
    --spread-ms) SPREAD_MS="$2"; shift 2 ;;
    --cpu-prof) CPU_PROF=1; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "ramp: unknown argument $1" >&2; usage 2 ;;
  esac
done

die () { echo "ramp: $*" >&2; exit 1; }
listening () { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

for p in "$PORT" "$REDIS_PORT"; do
  case "$p" in 6379|8000) die "port $p belongs to the local dev stack; pick another" ;; esac
done
listening "$PORT" && die "port $PORT is already in use"
listening "$REDIS_PORT" && die "--redis-port $REDIS_PORT has a listener; it must be a dead port"
[ "$SETTLE" -lt "$STEP_SECS" ] || die "--settle ($SETTLE) must be shorter than --step-secs ($STEP_SECS)"
prev=-1
for t in $STEPS; do
  [ "$t" -ge "$prev" ] || die "--steps must not decrease (the ramp only adds bots)"
  prev=$t
done
[ -d "$SERVER/../../plunder-land-client/node_modules/socket.io-client" ] || [ -n "$LOADBOT_CLIENT_DIR" ] \
  || die "socket.io-client is not installed: run npm ci in plunder-land-client (see README.md)"

[ -n "$OUT" ] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/plunder-load.XXXXXX")"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
: > "$OUT/server.jsonl"; : > "$OUT/bots.jsonl"; : > "$OUT/steps.log"; : > "$OUT/botcpu.log"
echo "ramp: output in $OUT"

if [ "$BUILD" = 1 ]; then (cd "$SERVER" && npm run build >/dev/null) || die "server build failed"; fi
[ -f "$SERVER/dist/index.js" ] || die "no $SERVER/dist/index.js; drop --no-build"

SERVER_PID=""
BOT_PIDS=()
cleanup () {
  trap - EXIT INT TERM
  for pid in ${BOT_PIDS[@]+"${BOT_PIDS[@]}"}; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in ${BOT_PIDS[@]+"${BOT_PIDS[@]}"}; do wait "$pid" 2>/dev/null || true; done
  if [ -n "$SERVER_PID" ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

PROF=()
[ "$CPU_PROF" = 1 ] && PROF=(--cpu-prof --cpu-prof-dir "$OUT")
# cwd is $OUT so dotenv finds no .env: the environment below is the whole config.
(cd "$OUT" && exec env PORT="$PORT" REDIS_HOST=127.0.0.1 REDIS_PORT="$REDIS_PORT" \
  PROBE_DIST="$SERVER/dist" PROBE_OUT="$OUT/server.jsonl" \
  node -r "$HERE/probe.cjs" ${PROF[@]+"${PROF[@]}"} "$SERVER/dist/index.js") > "$OUT/server.log" 2>&1 &
SERVER_PID=$!
echo "ramp: server pid $SERVER_PID on :$PORT (redis -> dead :$REDIS_PORT)"
for _ in $(seq 100); do
  curl -sf "http://127.0.0.1:$PORT/healthcheck" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || die "server exited; see $OUT/server.log"
  sleep 0.1
done
curl -sf "http://127.0.0.1:$PORT/healthcheck" >/dev/null 2>&1 || die "server never answered /healthcheck"

echo "ramp: warming the world up for ${WARMUP}s"
sleep "$WARMUP"
kill -0 "$SERVER_PID" 2>/dev/null || die "server died during warmup; see $OUT/server.log"

current=0
for target in $STEPS; do
  while [ "$current" -lt "$target" ]; do
    n=$(( target - current < BATCH ? target - current : BATCH ))
    node "$HERE/loadbot.mjs" "http://127.0.0.1:$PORT" "$n" "p${current}_" "$OUT/bots.jsonl" "$SPREAD_MS" >> "$OUT/bots.err" 2>&1 &
    BOT_PIDS+=("$!")
    current=$(( current + n ))
  done
  echo "$(date +%s) $target" >> "$OUT/steps.log"
  echo "ramp: step $target bots for ${STEP_SECS}s"
  sleep "$STEP_SECS"
  kill -0 "$SERVER_PID" 2>/dev/null || die "server died during step $target; see $OUT/server.log"
  if [ ${#BOT_PIDS[@]} -gt 0 ]; then
    ps -o pcpu= -p "$(IFS=,; echo "${BOT_PIDS[*]}")" | awk -v t="$target" '{s+=$1; n++} END {print t, n, s}' >> "$OUT/botcpu.log"
  fi
done
echo "$(date +%s) end" >> "$OUT/steps.log"
cleanup

python3 "$HERE/analyse.py" "$OUT" --settle "$SETTLE"
