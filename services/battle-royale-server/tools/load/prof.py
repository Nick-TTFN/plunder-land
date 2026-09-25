"""Top self and inclusive time from a V8 .cpuprofile (ramp.sh --cpu-prof).

    python3 prof.py <file.cpuprofile | dir containing one>

Inclusive time counts only frames from the server's dist/, once per sample.
"""
import collections
import glob
import json
import os
import sys

arg = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
if os.path.isdir(arg):
    found = sorted(glob.glob(os.path.join(arg, '*.cpuprofile')))
    if not found:
        sys.exit(f'no .cpuprofile in {arg}')
    arg = found[-1]
p = json.load(open(arg))
nodes = {n['id']: n for n in p['nodes']}
parent = {}
for n in p['nodes']:
    for c in n.get('children', []): parent[c] = n['id']
# Sample durations
dt = collections.Counter()
deltas = p['timeDeltas']; samples = p['samples']
for i, s in enumerate(samples):
    dt[s] += deltas[i + 1] if i + 1 < len(deltas) else 0
total = sum(dt.values())
def name(n):
    cf = n['callFrame']; f = cf['url'].split('/dist/')[-1].split('/node_modules/')[-1]
    return f"{cf['functionName'] or '(anon)'} {f}:{cf['lineNumber'] + 1}"
selft = collections.Counter()
for nid, t in dt.items(): selft[name(nodes[nid])] += t
print(f"{arg}: total sampled {total/1e6:.1f}s")
print("--- top self time")
for k, v in selft.most_common(35): print(f"{v/total*100:5.1f}%  {k}")
# Inclusive time for chosen function names (count each sample once per name)
incl = collections.Counter()
for nid, t in dt.items():
    seen = set(); x = nid
    while x is not None:
        fn = nodes[x]['callFrame']['functionName']; u = nodes[x]['callFrame']['url']
        key = fn + ' ' + u.split('/dist/')[-1] if '/dist/' in u else None
        if key and key not in seen: incl[key] += t; seen.add(key)
        x = parent.get(x)
print("--- inclusive (server code)")
for k, v in incl.most_common(45): print(f"{v/total*100:5.1f}%  {k}")
