// A deterministic, in-process tick benchmark: no sockets, no bots, no other
// processes competing for the CPU, so a change of a few percent shows up.
//   node tools/load/tickbench.cjs [dist dir]      (N=400 players by default)
// Seeds Math.random, joins N players on fake framed sockets, walks them on
// random routes for 400 ticks with mobs removed, and prints mean ms per tick
// for Multiplayer.update and for the whole tick (world update + flush) over
// the last 300. The same commit gives the same world every run (avgHolders,
// moving and callsPerTick repeat exactly), so a changed count means changed
// behaviour, not noise. Within a run of three, times agree to about 3%.
//
// The ramp (ramp.sh) measures a real server under real sockets, but its
// per-function times read about 5x higher than this at the same density:
// the server shares the machine with the bot processes. Use the ramp for CPU
// per player and bandwidth, and this for comparing two builds of the tick.
const path = require('path')
const dist = process.argv[2] ?? path.join(__dirname, "../../dist")
const req = (p) => require(path.join(dist, p))
const Multiplayer = req('network/multiplayer.js').default
const World = req('objects/world.js').default
const { Vector } = req('utils/vector.js')
const { Hex } = req('utils/hex.js')
let seed = 12345
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const redis = { on () { return this }, hincrby: async () => 1 }
const mp = new Multiplayer(250, redis)
const world = new World(4000)
World.MOBS.length = 0
const N = Number(process.env.N ?? 400)
const players = []
for (let i = 0; i < N; i++) {
  const h = {}
  const socket = { id: 's' + i, handshake: { query: { frames: '1' } }, on: (e, cb) => { h[e] = cb }, emit: () => true, conn: { write: () => {} } }
  mp.onConnect(socket)
  h.start_requested({ id: (0xabc000 + i).toString(16), name: 'b' + i })
  players.push(World.PLAYERS[World.PLAYERS.length - 1])
}
let upd = 0; let calls = 0
const orig = Multiplayer.prototype.update
Multiplayer.prototype.update = function (o) { const t = performance.now(); try { return orig.call(this, o) } finally { upd += performance.now() - t; calls++ } }
const t0 = performance.now()
for (let tick = 0; tick < 400; tick++) {
  for (const p of players) {
    if (p.destroyed || p.exited) continue
    if (Math.random() < 0.05) {
      const c = p.cell; const tq = c.x + Math.floor(Math.random() * 17) - 8; const tr = c.y + Math.floor(Math.random() * 17) - 8
      if (Hex.onMap(tq, tr, World.mapSize) && !World.isBlocked(tq, tr, p.tag)) p.setWaypoints([new Vector(tq, tr)])
    }
  }
  if (tick === 100) { upd = 0; calls = 0 }
  world.update(0.25)
  mp.flushAll(tick, 250)
}
const kb = players.filter((p) => !p.destroyed).map((p) => p.knownBy.size); const moving = players.filter((p) => p.path.length > 0).length
console.log(JSON.stringify({ avgHolders: +(kb.reduce((a, b) => a + b, 0) / kb.length).toFixed(1), moving, players: World.PLAYERS.length, bcastMsPerTick: +(upd / 300).toFixed(3), callsPerTick: +(calls / 300).toFixed(0), wallMsPerTick: +((performance.now() - t0) / 400).toFixed(2) }))
