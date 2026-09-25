// Preloaded into the server under test (node -r probe.cjs dist/index.js).
// Wraps the tick's phases in timers without touching the source, and writes one
// JSON line per window to $PROBE_OUT. $PROBE_DIST is the server's dist/ folder.
// The probe itself costs about 4% of busy time.
const path = require('path')
const fs = require('fs')
const { performance, PerformanceObserver } = require('perf_hooks')

const dist = process.env.PROBE_DIST
let World, Multiplayer
const out = process.env.PROBE_OUT
const WINDOW_MS = Number(process.env.PROBE_WINDOW_MS ?? 5000)

const now = () => Number(process.hrtime.bigint()) / 1e6
let acc = fresh()
function fresh () {
  return { world: [], flush: [], interval: [], mpUpdateMs: 0, mpUpdateCalls: 0, inputMs: 0, inputs: 0, admitMs: 0, admits: 0, gcMs: 0, gcCount: 0, emits: 0, emitBytes: 0 }
}

function wrap (proto, name, onDone) {
  const orig = proto[name]
  proto[name] = function (...args) {
    const t = now()
    try { return orig.apply(this, args) } finally { onDone(now() - t) }
  }
}

setImmediate(() => {
Multiplayer = require(path.join(dist, 'network/multiplayer.js')).default
World = require(path.join(dist, 'objects/world.js')).default
let lastTickAt
wrap(World.prototype, 'update', (ms) => { acc.world.push(ms) })
const origUpdate = World.prototype.update
World.prototype.update = function (...a) {
  const t = now()
  if (lastTickAt !== undefined) acc.interval.push(t - lastTickAt)
  lastTickAt = t
  return origUpdate.apply(this, a)
}
wrap(Multiplayer.prototype, 'flushAll', (ms) => { acc.flush.push(ms) })
wrap(Multiplayer.prototype, 'update', (ms) => { acc.mpUpdateMs += ms; acc.mpUpdateCalls++ })
for (const n of ['onPointer', 'onSkill', 'onUseItem']) wrap(Multiplayer.prototype, n, (ms) => { acc.inputMs += ms; acc.inputs++ })
wrap(Multiplayer.prototype, 'admit', (ms) => { acc.admitMs += ms; acc.admits++ })

})

new PerformanceObserver((list) => {
  for (const e of list.getEntries()) { acc.gcMs += e.duration; acc.gcCount++ }
}).observe({ entryTypes: ['gc'] })

const pct = (arr, p) => {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)
}
const mean = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null

let elu = performance.eventLoopUtilization()
let cpu = process.cpuUsage()
let at = Date.now()
setInterval(() => {
  const e2 = performance.eventLoopUtilization(elu)
  const c2 = process.cpuUsage(cpu)
  const wall = Date.now() - at
  elu = performance.eventLoopUtilization(); cpu = process.cpuUsage(); at = Date.now()
  const a = acc; acc = fresh()
  const ticks = a.world.length || 1
  const line = {
    t: Date.now(),
    players: World.PLAYERS.length,
    mobs: World.MOBS.length,
    obstacles: World.OBSTACLES.length,
    consumables: World.CONSUMABLES.length,
    ticks: a.world.length,
    worldMs: { mean: mean(a.world), p95: pct(a.world, 0.95), max: pct(a.world, 1) },
    flushMs: { mean: mean(a.flush), p95: pct(a.flush, 0.95), max: pct(a.flush, 1) },
    tickTotalMeanMs: +((mean(a.world) ?? 0) + (mean(a.flush) ?? 0)).toFixed(2),
    intervalMs: { mean: mean(a.interval), p95: pct(a.interval, 0.95), max: pct(a.interval, 1) },
    mpUpdateMsPerTick: +(a.mpUpdateMs / ticks).toFixed(2),
    inputMsPerSec: +(a.inputMs / (wall / 1000)).toFixed(2),
    inputsPerSec: +(a.inputs / (wall / 1000)).toFixed(0),
    admits: a.admits,
    admitMsMean: a.admits ? +(a.admitMs / a.admits).toFixed(2) : null,
    gcMsPerSec: +(a.gcMs / (wall / 1000)).toFixed(2),
    elu: +e2.utilization.toFixed(3),
    cpuPctOneCore: +(((c2.user + c2.system) / 1000) / wall * 100).toFixed(1),
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(0),
    heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(0)
  }
  fs.appendFileSync(out, JSON.stringify(line) + '\n')
}, WINDOW_MS).unref()
// Exit through process.exit so `--cpu-prof` writes its profile. ramp.sh stops
// the server with SIGTERM, by PID.
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
