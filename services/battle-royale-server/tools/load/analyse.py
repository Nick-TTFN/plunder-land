"""Summarise a ramp: one row per step, from the probe's and the bots' JSON lines.

    python3 analyse.py <dir> [--settle 15] [--json]

<dir> holds steps.log ("<unix seconds> <bot count>" per step, then "<t> end"),
server.jsonl (probe.cjs) and bots.jsonl (loadbot.mjs). The first --settle
seconds of each step are skipped so the join burst doesn't count. Prints a
Markdown table, or one JSON object per step with --json.

Columns: world = mean ms of World.update per tick, and bcast the part of it
spent in Multiplayer.update (every dirty unit x every connection); flush =
Multiplayer.flushAll; cpu = % of one core; per-client and standings are what
one bot receives; egress = per-client x players; join = bytes a bot receives
from connect to its first update (hello + snapshot + create_own), averaged
over joins completed in the step; fails = connect attempts that failed.
"""
import argparse
import json
import statistics as st

ap = argparse.ArgumentParser()
ap.add_argument('dir')
ap.add_argument('--settle', type=int, default=15)
ap.add_argument('--json', action='store_true')
a = ap.parse_args()

steps = [l.split() for l in open(f"{a.dir}/steps.log").read().splitlines() if l.strip()]
srv = [json.loads(l) for l in open(f"{a.dir}/server.jsonl") if l.strip()]
try:
    bots = [json.loads(l) for l in open(f"{a.dir}/bots.jsonl") if l.strip()]
except FileNotFoundError:
    bots = []

rows = []
for i, (t0, label) in enumerate(steps):
    if label == 'end' or i + 1 >= len(steps):
        break
    t0 = int(t0); t1 = int(steps[i + 1][0])
    s = [d for d in srv if t0 + a.settle <= d['t'] / 1000 <= t1]
    b = [d for d in bots if t0 + a.settle <= d['t'] / 1000 <= t1]
    if not s:
        continue
    m = lambda k: round(st.mean(x[k] for x in s), 2)
    mm = lambda k, j: round(st.mean([x[k][j] for x in s if x[k][j] is not None] or [0]), 2)
    mx = lambda k, j: max([x[k][j] for x in s if x[k][j] is not None] or [0])
    # Per-bot bandwidth: weight each process-window by its connected count.
    conn = sum(x['connected'] for x in b) or 1
    bw = sum((x['bytesPerBotPerSec'] or 0) * x['connected'] for x in b) / conn if b else None
    ev = {}
    for x in b:
        for k, v in x['byEventPerBotPerSec'].items():
            ev[k] = ev.get(k, 0) + (v or 0) * x['connected']
    ev = {k: round(v / conn) for k, v in sorted(ev.items(), key=lambda kv: -kv[1])}
    gaps95 = [x['updateGapMs']['p95'] for x in b if x['updateGapMs']['p95']]
    gapsmax = [x['updateGapMs']['max'] for x in b if x['updateGapMs']['max']]
    # joinKB is a mean over one window's completed joins; weight it by them.
    jk = [(x['joinKB'], x['joins']) for x in b if x.get('joinKB') is not None and x['joins']]
    join_kb = round(sum(k * n for k, n in jk) / sum(n for _, n in jk), 1) if jk else None
    deaths = sum(x['deaths'] for x in b)
    windows = len(set(x['t'] // 5000 for x in b)) or 1
    players = round(st.mean(x['players'] for x in s))
    rows.append(dict(
        ccu=label, players=players,
        world_ms=mm('worldMs', 'mean'), world_p95=mm('worldMs', 'p95'), world_max=mx('worldMs', 'max'),
        flush_ms=mm('flushMs', 'mean'), flush_p95=mm('flushMs', 'p95'), flush_max=mx('flushMs', 'max'),
        mpupdate_ms=m('mpUpdateMsPerTick'),
        input_ms_s=m('inputMsPerSec'), inputs_s=m('inputsPerSec'),
        interval_p95=mm('intervalMs', 'p95'), interval_max=mx('intervalMs', 'max'),
        cpu=m('cpuPctOneCore'), elu=m('elu'), gc_ms_s=m('gcMsPerSec'), rss=m('rssMB'),
        admits_s=round(sum(x['admits'] for x in s) / (5 * len(s)), 2),
        admit_ms=round(st.mean([x['admitMsMean'] for x in s if x['admitMsMean']] or [0]), 2),
        bot_Bps=round(bw) if bw else None, events=ev,
        egress_MBps=round(bw * players / 1e6, 2) if bw else None,
        join_kb=join_kb,
        # None for bots from before the retry, which did not count failures.
        connect_fails=sum(x['connectFails'] for x in b) if b and all('connectFails' in x for x in b) else None,
        client_gap_p95=round(st.mean(gaps95)) if gaps95 else None, client_gap_max=max(gapsmax) if gapsmax else None,
        deaths_per_min=round(deaths / (windows * 5) * 60) if b else None,
    ))

if a.json:
    for r in rows:
        print(json.dumps(r))
else:
    dash = lambda v, f='{}': '-' if v is None else f.format(v)
    kb = lambda v: dash(None if v is None else v / 1000, '{:.1f}')
    print('| bots | players | world ms | bcast ms | world p95 | flush ms | tick p95 | cpu % | elu | per-client KB/s | standings KB/s | egress MB/s | join KB | fails | deaths/min |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        print(f"| {r['ccu']} | {r['players']} | {r['world_ms']} | {r['mpupdate_ms']} | {r['world_p95']} | {r['flush_ms']} "
              f"| {r['interval_p95']} | {r['cpu']} | {r['elu']} | {kb(r['bot_Bps'])} | {kb(r['events'].get('standings'))} "
              f"| {dash(r['egress_MBps'])} | {dash(r['join_kb'])} | {dash(r['connect_fails'])} | {dash(r['deaths_per_min'])} |")
