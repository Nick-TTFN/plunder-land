// Attribute a heap's growth to `World` fields: every node new in the `after`
// snapshot (by id, absent from `before`) is labelled with the World field it is
// first reached from, by a multi-source BFS from every new World, and summed per
// field, per world (KB). Written for private worlds (private-10).
//   node tools/load/heapattr.cjs before.heapsnapshot after.heapsnapshot
// Snapshots: privatebench with SNAPSHOT=<dir> writes before-<n> (before anyone
// joins) and after-<n> (after the ticks); see docs/load-testing.md.
// L1 lines are per World field, L2 lines go one class deeper (CLASSES), UN lines
// are new nodes no World reaches (compiled code and the like), in KB total.
// Something shared by many worlds (the private map's terrain) is labelled with
// the field of whichever world the BFS reached it from first, so it shows up
// amortised over the worlds.
const fs = require('fs')
const [beforeP, afterP, nWorldsArg] = process.argv.slice(2)
function load (p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  return j
}
function ids (j) {
  const nf = j.snapshot.meta.node_fields.length; const idI = j.snapshot.meta.node_fields.indexOf('id')
  const s = new Set(); for (let i = 0; i < j.nodes.length; i += nf) s.add(j.nodes[i + idI]); return s
}
const before = ids(load(beforeP))
const j = load(afterP)
const nf = j.snapshot.meta.node_fields.length
const ef = j.snapshot.meta.edge_fields.length
const NF = j.snapshot.meta.node_fields; const EF = j.snapshot.meta.edge_fields
const tI = NF.indexOf('type'), nI = NF.indexOf('name'), idI = NF.indexOf('id'), szI = NF.indexOf('self_size'), ecI = NF.indexOf('edge_count')
const etI = EF.indexOf('type'), enI = EF.indexOf('name_or_index'), toI = EF.indexOf('to_node')
const ntypes = j.snapshot.meta.node_types[0]; const etypes = j.snapshot.meta.edge_types[0]
const N = j.nodes.length / nf
const firstEdge = new Uint32Array(N + 1)
for (let i = 0, e = 0; i < N; i++) { firstEdge[i] = e; e += j.nodes[i * nf + ecI] * ef } ; firstEdge[N] = j.edges.length
const S = j.strings
const name = (i) => S[j.nodes[i * nf + nI]]
const type = (i) => ntypes[j.nodes[i * nf + tI]]
const isNew = (i) => !before.has(j.nodes[i * nf + idI])
const size = (i) => j.nodes[i * nf + szI]
const label = new Array(N)
let totalNew = 0
for (let i = 0; i < N; i++) if (isNew(i)) totalNew += size(i)
const worlds = []
for (let i = 0; i < N; i++) if (type(i) === 'object' && name(i) === 'World' && isNew(i)) worlds.push(i)
console.log('worlds', worlds.length, 'new bytes', totalNew)
const CLASSES = new Set(['Mob', 'Player', 'Consumable', 'ItemPickup', 'GearPickup', 'Portal', 'Exit', 'HandoffGate', 'Obstacle', 'CellIndex', 'Multiplayer', 'Timers', 'Bot', 'Brain', 'CellOverlay'])
let q = []
for (const w of worlds) { label[w] = 'World(self)' }
for (const w of worlds) {
  for (let e = firstEdge[w]; e < firstEdge[w + 1]; e += ef) {
    const et = etypes[j.edges[e + etI]]; if (et === 'weak' || et === 'hidden' && false) continue
    const to = j.edges[e + toI] / nf
    const nm = et === 'element' || et === 'hidden' ? '#' : S[j.edges[e + enI]]
    if (label[to] !== undefined || !isNew(to)) continue
    label[to] = nm; q.push(to)
  }
}
while (q.length) {
  const next = []
  for (const n of q) {
    const lab = label[n]
    const cls = type(n) === 'object' && CLASSES.has(name(n)) && !lab.includes('/') ? name(n) : null
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += ef) {
      const et = etypes[j.edges[e + etI]]; if (et === 'weak') continue
      const to = j.edges[e + toI] / nf
      if (label[to] !== undefined || !isNew(to)) continue
      if (type(to) === 'object' && name(to) === 'World') continue
      let l = lab
      if (cls) l = lab + '/' + cls + '.' + (et === 'property' ? S[j.edges[e + enI]] : et)
      label[to] = l; next.push(to)
    }
  }
  q = next
}
const agg = new Map(); let attributed = 0
for (let i = 0; i < N; i++) { if (label[i] !== undefined && isNew(i)) { agg.set(label[i], (agg.get(label[i]) ?? 0) + size(i)); attributed += size(i) } }
const W = worlds.length
const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k)
const lvl1 = new Map(); for (const [k, v] of agg) { const a = k.split('/')[0]; lvl1.set(a, (lvl1.get(a) ?? 0) + v) }
console.log('attributed per world KB', (attributed / W / 1024).toFixed(1), 'unattributed per world KB', ((totalNew - attributed) / W / 1024).toFixed(1))
for (const [k, v] of top(lvl1, 40)) console.log('L1', k.padEnd(28), (v / W / 1024).toFixed(2))
for (const [k, v] of top(agg, 60)) console.log('L2', k.padEnd(50), (v / W / 1024).toFixed(2))
// unattributed by constructor name
const un = new Map(); for (let i = 0; i < N; i++) if (isNew(i) && label[i] === undefined) { const k = type(i) + ':' + name(i).slice(0, 40); un.set(k, (un.get(k) ?? 0) + size(i)) }
for (const [k, v] of top(un, 25)) console.log('UN', k.padEnd(50), (v / 1024).toFixed(1), 'KB total')
