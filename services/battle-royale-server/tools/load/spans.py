"""Where each step's CPU went, from a ramp run with --detail 1 or 2.

    python3 spans.py <dir> [--settle 15] [--top 40] [--step N]

Per step: a CPU budget (whole process, in ms of CPU per wall second, split
into the tick, the input handlers, GC and everything else, which is mostly
socket.io and ws encoding, writing and reading), then the wrapped functions by
self time per tick. Self = inclusive minus the wrapped functions it called, so
the self column adds up to the wrapped part of the tick without double
counting. us/call is inclusive. `overhead` is the probe's own estimated cost
per tick (calls x the calibrated wrapper cost), already inside every number.
"""
import argparse
import json
import statistics as st

ap = argparse.ArgumentParser()
ap.add_argument('dir')
ap.add_argument('--settle', type=int, default=15)
ap.add_argument('--top', type=int, default=40)
ap.add_argument('--step', type=str, default=None, help='only this step (bot count)')
a = ap.parse_args()

steps = [l.split() for l in open(f"{a.dir}/steps.log").read().splitlines() if l.strip()]
srv = [json.loads(l) for l in open(f"{a.dir}/server.jsonl") if l.strip()]

for i, (t0, label) in enumerate(steps):
    if label == 'end' or i + 1 >= len(steps):
        break
    if a.step is not None and label != a.step:
        continue
    t0 = int(t0); t1 = int(steps[i + 1][0])
    s = [d for d in srv if t0 + a.settle <= d['t'] / 1000 <= t1 and 'spans' in d]
    if not s:
        continue
    players = round(st.mean(x['players'] for x in s))
    m = lambda f: st.mean(f(x) for x in s)
    world = m(lambda x: x['worldMs']['mean'] or 0)
    flush = m(lambda x: x['flushMs']['mean'] or 0)
    ticks_s = m(lambda x: x['ticks']) / 5
    cpu = m(lambda x: x['cpuPctOneCore']) * 10          # ms of CPU per wall second
    tick = (world + flush) * ticks_s
    inputs = m(lambda x: x['inputMsPerSec'])
    gc = m(lambda x: x['gcMsPerSec'])
    other = cpu - tick - inputs - gc
    print(f"\n## {label} bots, {players} players ({len(s)} windows)")
    print(f"CPU {cpu:.0f} ms/s ({cpu / 10:.1f}% of a core), {cpu / max(players, 1):.3f} ms/s per player")
    print(f"  tick (world {world:.2f} + flush {flush:.2f} ms) x {ticks_s:.2f}/s = {tick:.0f} ms/s")
    print(f"  input handlers {inputs:.0f} ms/s, GC {gc:.0f} ms/s (GC can overlap the others)")
    print(f"  rest (socket.io / ws / timers / http) {other:.0f} ms/s")
    elu = m(lambda x: x['elu']) * 1000
    sys_ = m(lambda x: x.get('cpuSysPct', 0)) * 10
    print(f"  main thread busy (ELU) {elu:.0f} ms/s; kernel (sys) {sys_:.0f} ms/s of the CPU")
    if 'sockWritesPerTick' in s[0]:
        print(f"  socket writes {m(lambda x: x['sockWritesPerTick']):.0f}/tick "
              f"({m(lambda x: x['sockWritevsPerTick']):.0f} of them writev), one syscall each")
    print(f"  emits {m(lambda x: x['emitsPerTick']):.0f}/tick ({m(lambda x: x['emitsOutsideTickPerTick']):.0f} outside it), "
          f"{m(lambda x: x['emitKBPerTick']):.0f} KB/tick; probe overhead ~{m(lambda x: x['overheadMs']):.2f} ms/tick "
          f"({s[0]['wrapNs']} ns/call)")

    if 'wirePerTick' in s[0]:
        keys = {k for x in s for k in x['wirePerTick']}
        conns = max(players, 1)
        tot = {k: (st.mean(x['wirePerTick'].get(k, [0, 0])[0] for x in s), st.mean(x['wirePerTick'].get(k, [0, 0])[1] for x in s)) for k in keys}
        allb = sum(b for _, b in tot.values()) or 1
        print(f"| wire (framed clients) | records/tick | B/s per client | share |")
        print(f"|---|---|---|---|")
        for k, (n, b) in sorted(tot.items(), key=lambda kv: -kv[1][1])[:20]:
            print(f"| {k} | {n:.1f} | {b * ticks_s / conns:.0f} | {b / allb * 100:.1f}% |")
        fk = {k for x in s for k in x['updateFieldBytesPerTick']}
        ft = {k: st.mean(x['updateFieldBytesPerTick'].get(k, 0) for x in s) for k in fk}
        fall = sum(ft.values()) or 1
        print('update bytes by field: ' + ', '.join(f"{k} {v / fall * 100:.0f}%" for k, v in sorted(ft.items(), key=lambda kv: -kv[1])))

    names = {}
    for x in s:
        for k in x['spans']:
            names[k] = True
    rows = []
    for k in names:
        vals = [x['spans'].get(k, {'calls': 0, 'incl': 0, 'self': 0}) for x in s]
        calls = st.mean(v['calls'] for v in vals)
        incl = st.mean(v['incl'] for v in vals)
        self_ = st.mean(v['self'] for v in vals)
        rows.append((k, calls, incl, self_))
    rows.sort(key=lambda r: -r[3])
    print(f"| function | calls/tick | self ms/tick | incl ms/tick | us/call |")
    print(f"|---|---|---|---|---|")
    for k, calls, incl, self_ in rows[:a.top]:
        per = incl / calls * 1000 if calls else 0
        print(f"| {k} | {calls:.1f} | {self_:.3f} | {incl:.3f} | {per:.1f} |")
