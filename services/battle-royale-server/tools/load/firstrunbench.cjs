// What private first-run worlds cost (decision #58, retest-4), in process,
// through the real `Worlds`: N clients on new accounts start with
// `firstRun: true`, each gets its own first-run world, and they walk to and
// fro on its map (never onto the pad) for 400 ticks.
//   node --expose-gc tools/load/firstrunbench.cjs [dist dir]   (N=1,10,50 by default)
//   N=10       one size only
// Prints, per N: the first-run worlds' own ms per tick (each one's update
// and flush, timed inside `tickAll`, summed over the N, mean of the last 300
// ticks), that per first-run player, and the heap and RSS after a GC, per
// first run, against the same process before they opened. Compare the
// per-player ms with tickbench's tickMsPerTick / players for a shared-world
// player. (A difference of whole tickAll times was tried first: the idle
// shared world's mobs make it noisier than the first runs' whole cost.)
const path = require('path')
const dist = process.argv[2] ?? path.join(__dirname, '../../dist')
const req = (p) => require(path.join(dist, p))
require(path.join(dist, 'network/multiplayer.js'))
const Worlds = req('network/worlds.js').default
const World = req('objects/world.js').default
const { MemoryAccountStore } = req('db/accounts.js')
const { Hex } = req('utils/hex.js')
const { Vector } = req('utils/vector.js')
const { FIRST_RUN } = req('firstrun/scenario.js')

let seed = 12345
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const redis = { on () { return this }, hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null }
const gc = global.gc ?? (() => {})
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }

function mem () {
  gc(); gc()
  const m = process.memoryUsage()
  return { heapMB: m.heapUsed / 2 ** 20, rssMB: m.rss / 2 ** 20 }
}

/** Each first-run world's update and flush, timed; the mean ms per tick over the last 300, all worlds summed. */
function time (worlds, ticks, walk) {
  let total = 0
  let counting = false
  for (const world of worlds.firstRuns) {
    for (const [obj, key] of [[world, 'update'], [world.multiplayer, 'flushAll']]) {
      const original = obj[key]
      obj[key] = function (...args) {
        const at = process.hrtime.bigint()
        try {
          return original.apply(this, args)
        } finally {
          if (counting) total += Number(process.hrtime.bigint() - at) / 1e6
        }
      }
    }
  }
  for (let t = 0; t < ticks; t++) {
    walk(t)
    counting = t >= ticks - 300
    worlds.tickAll(250)
  }
  return total / 300
}

async function run (n) {
  const store = new MemoryAccountStore()
  const worlds = new Worlds({ tickLengthMs: 250, cap: 200, idleMs: 300_000, redis, accounts: store, bots: 0, firstRunCap: 1000 })
  for (let t = 0; t < 100; t++) worlds.tickAll(250)
  const before = mem()
  const clients = []
  for (let i = 0; i < n; i++) {
    const { token } = await store.create()
    const h = {}
    const socket = { id: 's' + i, handshake: { query: { frames: '1' }, auth: { token } }, on: (e, cb) => { h[e] = cb }, emit: () => true, conn: { write: () => {}, close: () => {} } }
    const connection = worlds.onConnection(socket)
    await settle()
    h.start_requested({ name: 'f' + i, firstRun: true })
    await settle()
    clients.push(connection)
  }
  if (worlds.firstRuns.length !== n) throw new Error(`${worlds.firstRuns.length} first-run worlds for ${n} clients`)
  const start = new Vector(FIRST_RUN.start.q, FIRST_RUN.start.r)
  const walk = (t) => {
    if (t % 12 !== 0) return
    for (const connection of clients) {
      const world = worlds.worldFor(connection)
      const player = connection.player
      // Short of the pad (gateAt): to and fro between the start and 3 cells east.
      World.run(world, () => { player.setWaypoints([new Vector(start.x + ((t / 12) % 2 === 0 ? 3 : 0), start.y)]) })
    }
  }
  const firstRunMs = time(worlds, 400, walk)
  const after = mem()
  if (worlds.firstRuns.length !== n) throw new Error('a first run ended during the measurement')
  return {
    n,
    firstRunMsPerTick: +firstRunMs.toFixed(4),
    msPerFirstRunPlayer: +(firstRunMs / n).toFixed(4),
    heapMBPerFirstRun: +((after.heapMB - before.heapMB) / n).toFixed(3),
    rssMBPerFirstRun: +((after.rssMB - before.rssMB) / n).toFixed(3),
    rssMB: +after.rssMB.toFixed(1)
  }
}

;(async () => {
  const sizes = process.env.N !== undefined ? [Number(process.env.N)] : [1, 10, 50]
  for (const n of sizes) console.log(JSON.stringify(await run(n)))
  process.exit(0)
})()
