// A deterministic, in-process tick benchmark: no sockets, no bots, no other
// processes competing for the CPU, so a change of a few percent shows up.
//   node tools/load/tickbench.cjs [dist dir]      (N=400 players by default)
// Seeds Math.random, joins N players on fake framed sockets, walks them on
// random routes for 400 ticks with mobs removed, and prints mean ms per tick
// for Multiplayer.update and for the whole tick (world update + flush) over
// the last 300. The same commit gives the same world every run (avgHolders,
// moving and callsPerTick repeat exactly), so a changed count means changed
// behaviour, not noise. Within a run of three, times agree to about 3%.
//   ROBOT=<key>  every player joins as that robot (peep, periscope, magnet,
//                hopper, waddle); ROBOT=mix cycles through all five. Default:
//                none sent, so Peep, as before the option existed.
//   GEAR=<n>     every player equips n (0-2) max-roll T3 skill items before
//                the first tick (decision #49, 49-2): Fireball with damage and
//                hp, Icicle with speed and armor, at q 1000, so stats are at
//                their caps. A build without `Player.equipGear` (before 49-1)
//                equips nothing: `gearApplied` says how many took.
// kbPerClientTick is the mean framed bytes written per player per tick over
// the same last 300 ticks (uncompressed: the fake socket has no deflate), and
// periscopeKbPerTick the same for the Periscopes alone (null without any).
// tickMsPerTick is world update + flush; pickupPassMsPerTick is World.pickupPass
// inclusive, pickupPassSelfMsPerTick the same less its Multiplayer.update
// calls (pickupPassCallsPerTick of them), all over the same last 300 ticks.
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
const ROBOTS = ['peep', 'periscope', 'magnet', 'hopper', 'waddle']
const robotOf = (i) => process.env.ROBOT === 'mix' ? ROBOTS[i % ROBOTS.length] : process.env.ROBOT
const players = []
const written = new Array(N).fill(0)
let counting = false
for (let i = 0; i < N; i++) {
  const h = {}
  const write = (data) => { if (counting) written[i] += data.length ?? data.byteLength ?? 0 }
  const socket = { id: 's' + i, handshake: { query: { frames: '1' } }, on: (e, cb) => { h[e] = cb }, emit: () => true, conn: { write } }
  mp.onConnect(socket)
  const start = { id: (0xabc000 + i).toString(16), name: 'b' + i }
  if (robotOf(i) !== undefined) start.robot = robotOf(i)
  h.start_requested(start)
  players.push(World.PLAYERS[World.PLAYERS.length - 1])
}
const GEAR = Math.max(0, Math.min(2, Number(process.env.GEAR ?? 0)))
const GEAR_ITEMS = [
  { tier: 3, skill: 6, rolls: [{ stat: 4, q: 1000 }, { stat: 1, q: 1000 }] },
  { tier: 3, skill: 7, rolls: [{ stat: 3, q: 1000 }, { stat: 2, q: 1000 }] }
]
let gearApplied = 0
for (const p of players) {
  if (typeof p.equipGear !== 'function') break
  for (let s = 0; s < GEAR; s++) if (p.equipGear(s, GEAR_ITEMS[s])) gearApplied++
}
let upd = 0; let calls = 0
const orig = Multiplayer.prototype.update
let inPass = false; let passUpd = 0; let passCalls = 0
Multiplayer.prototype.update = function (o) {
  const t = performance.now()
  try { return orig.call(this, o) } finally {
    const d = performance.now() - t; upd += d; calls++
    if (inPass) { passUpd += d; passCalls++ }
  }
}
// World.pickupPass, inclusive and self (inclusive less its Multiplayer.update calls).
let pass = 0; let tickMs = 0
const origPass = World.pickupPass
World.pickupPass = function (dt) { const t = performance.now(); inPass = true; try { return origPass.call(this, dt) } finally { inPass = false; pass += performance.now() - t } }
const t0 = performance.now()
for (let tick = 0; tick < 400; tick++) {
  for (const p of players) {
    if (p.destroyed || p.exited) continue
    if (Math.random() < 0.05) {
      const c = p.cell; const tq = c.x + Math.floor(Math.random() * 17) - 8; const tr = c.y + Math.floor(Math.random() * 17) - 8
      if (Hex.onMap(tq, tr, World.mapSize) && !World.isBlocked(tq, tr, p.tag)) p.setWaypoints([new Vector(tq, tr)])
    }
  }
  if (tick === 100) { upd = 0; calls = 0; pass = 0; passUpd = 0; passCalls = 0; tickMs = 0; counting = true }
  const t = performance.now()
  world.update(0.25)
  mp.flushAll(tick, 250)
  tickMs += performance.now() - t
}
const kbOf = (list) => list.length === 0 ? null : +(list.reduce((a, i) => a + written[i], 0) / list.length / 300 / 1024).toFixed(3)
const all = players.map((_, i) => i)
const scopes = all.filter((i) => players[i].archetype.key === 'periscope')
const kb = players.filter((p) => !p.destroyed).map((p) => p.knownBy.size); const moving = players.filter((p) => p.path.length > 0).length
console.log(JSON.stringify({ avgHolders: +(kb.reduce((a, b) => a + b, 0) / kb.length).toFixed(1), moving, players: World.PLAYERS.length, bcastMsPerTick: +(upd / 300).toFixed(3), callsPerTick: +(calls / 300).toFixed(0), wallMsPerTick: +((performance.now() - t0) / 400).toFixed(2), robot: process.env.ROBOT ?? 'peep', gear: GEAR, gearApplied, tickMsPerTick: +(tickMs / 300).toFixed(3), pickupPassMsPerTick: +(pass / 300).toFixed(3), pickupPassSelfMsPerTick: +((pass - passUpd) / 300).toFixed(3), pickupPassCallsPerTick: +(passCalls / 300).toFixed(0), kbPerClientTick: kbOf(all), periscopeKbPerTick: kbOf(scopes) }))
