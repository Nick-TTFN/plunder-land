// What private upper-layer worlds would cost (decision #60: each human gets a
// private copy of layers 1-2, bots top it up, humans meet from layer 3), in
// process, through the real `Worlds`. No sockets: sending isn't in it.
//   node --expose-gc tools/load/privatebench.cjs [dist dir]
//   MODE=private  (default) cap 1: every human opens its own world, topped up
//                 with bots to BOTS (default 8, production's BOT_TARGET).
//   MODE=shared   the same humans in one world (cap 10000), same BOTS target,
//                 so the bots barely matter: the per-human cost of today.
//   N=1,10,50     human counts, one process run each (comma list).
//   MAP=4000      the world's map size (production's default).
//   LAYERS=2      build only the top LAYERS layers (World.LAYERS/TAGS cut
//                 before anything is built). Default: all of today's.
//   MOBSCALE=1    every layer's mob counts times this (rounded, at least 1).
//   SNAPSHOT=dir  write before/after heap snapshots there (for heap breakdowns).
//   LOOTSCALE=1   natural loot, item and gear-cache counts times this (rounded, at least 1).
//   PRIVATE=1     every world is built as a private world (decision #60):
//                 the top two layers held (`WorldOptions.layers`, so layer
//                 02's down count is pads out of the world) on the one shared
//                 private map (`WorldOptions.map`, `PRIVATE_MAP`, private-5):
//                 the first world generates it, every later one takes the
//                 template. Use without LAYERS. (Replaces the SHARE and
//                 TEMPLATES stand-ins of 2026-11-06.)
// Without PRIVATE or LAYERS every world is a full `World.build` with all of
// today's layers refilled, so a private world here also carries layer -2's
// mobs it wouldn't have: an upper bound. Humans join on layer 0 and walk random
// routes; they are healed every tick so no run ends, and `Date.now` is
// advanced 250 ms a tick so bots spawn, think and shoot, and `Timers` fire.
// Prints per N: ms per tick for the whole `tickAll` (mean of the last 300 of
// 400 ticks), that per human, the heap and RSS per human after a GC against
// the process before anyone joined, the mean ms of one `World.build`, and the
// counts (worlds, bots, mobs, humans still in a run).
const path = require('path')
const dist = process.argv[2] ?? path.join(__dirname, '../../dist')
const req = (p) => require(path.join(dist, p))
require(path.join(dist, 'network/multiplayer.js'))
const Worlds = req('network/worlds.js').default
const World = req('objects/world.js').default
const { MemoryAccountStore } = req('db/accounts.js')
const { PRIVATE_MAP } = req('objects/privatemap.js')
const { Hex } = req('utils/hex.js')
const { Vector } = req('utils/vector.js')

let seed = 12345
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
let clock = Date.now()
Date.now = () => clock
const redis = { on () { return this }, hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null, hset: async () => 1 }
const gc = global.gc ?? (() => {})
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const MODE = process.env.MODE ?? 'private'
const BOTS = Number(process.env.BOTS ?? 8)
const MAP = Number(process.env.MAP ?? 4000)
const LAYER_COUNT = Number(process.env.LAYERS ?? World.LAYERS.length)
const MOBSCALE = Number(process.env.MOBSCALE ?? 1)
const LOOTSCALE = Number(process.env.LOOTSCALE ?? 1)
const scaled = (count, by) => Math.max(1, Math.round(count * by))
World.LAYERS = World.LAYERS.slice(0, LAYER_COUNT).map((layer, i) => ({
  ...layer,
  // The last kept layer leads nowhere down (the design's handoff pad, not measured).
  portalsDown: i === LAYER_COUNT - 1 ? 0 : layer.portalsDown,
  mobs: layer.mobs.map((m) => ({ ...m, count: scaled(m.count, MOBSCALE) })),
  naturalLoot: scaled(layer.naturalLoot, LOOTSCALE),
  items: layer.items.map((it) => ({ ...it, count: scaled(it.count, LOOTSCALE) })),
  gear: { ...layer.gear, caches: scaled(layer.gear.caches, LOOTSCALE) }
}))
World.TAGS = World.LAYERS.map((layer) => layer.tag)
// World.build's own time, every world this run opens (the join's spike).
let buildMs = 0; let builds = 0
const originalBuild = World.build
const PRIVATE = process.env.PRIVATE === '1'
const PRIVATE_TAGS = World.TAGS.slice(0, 2)
// The first build on the private map generates it (seeded); the rest take it. Timed apart.
let firstBuildMs
World.build = function (size, options = {}) {
  const at = performance.now()
  const generating = PRIVATE && PRIVATE_MAP.template === undefined
  try {
    return originalBuild.call(this, size, PRIVATE ? { ...options, layers: PRIVATE_TAGS, map: PRIVATE_MAP } : options)
  } finally {
    const ms = performance.now() - at
    if (generating) firstBuildMs = ms
    else { buildMs += ms; builds++ }
  }
}

function mem () {
  gc(); gc()
  const m = process.memoryUsage()
  return { heapMB: m.heapUsed / 2 ** 20, rssMB: m.rss / 2 ** 20 }
}

async function run (n) {
  const store = new MemoryAccountStore()
  const worlds = new Worlds({ tickLengthMs: 250, cap: MODE === 'private' ? 1 : 10000, idleMs: 3_600_000, redis, accounts: store, bots: BOTS, mapSize: MAP })
  const tick = () => { clock += 250; worlds.tickAll(250) }
  const before = mem()
  // SNAPSHOT=<dir>: heap snapshots before anyone joins and after the ticks (ids are stable between them).
  const snap = (name) => { if (process.env.SNAPSHOT) { gc(); gc(); require('v8').writeHeapSnapshot(path.join(process.env.SNAPSHOT, `${name}-${n}.heapsnapshot`)) } }
  snap('before')
  const clients = []
  buildMs = 0; builds = 0
  for (let i = 0; i < n; i++) {
    const { token } = await store.create()
    const h = {}
    const socket = { id: 's' + i, handshake: { query: { frames: '1' }, auth: { token } }, on: (e, cb) => { h[e] = cb }, emit: () => true, conn: { write: () => {}, close: () => {} } }
    const connection = worlds.onConnection(socket)
    await settle()
    h.start_requested({ name: 'p' + i })
    await settle()
    if (connection.player === undefined) throw new Error(`client ${i} got no player`)
    clients.push(connection)
  }
  const open = [...worlds.worlds]
  const heal = () => {
    for (const connection of clients) {
      const player = connection.player
      if (player === undefined || player.destroyed || player.exited) continue
      player.hp = player.maxHp
    }
  }
  const walk = () => {
    for (const connection of clients) {
      const player = connection.player
      if (player === undefined || player.destroyed || player.exited || Math.random() >= 0.05) continue
      const world = worlds.worldFor(connection)
      World.run(world, () => {
        const c = player.cell
        const q = c.x + Math.floor(Math.random() * 17) - 8
        const r = c.y + Math.floor(Math.random() * 17) - 8
        if (Hex.onMap(q, r, World.mapSize) && !World.isBlocked(q, r, player.tag)) player.setWaypoints([new Vector(q, r)])
      })
    }
  }
  let total = 0
  for (let t = 0; t < 400; t++) {
    walk()
    for (const w of open) World.run(w, heal)
    const at = performance.now()
    tick()
    if (t >= 100) total += performance.now() - at
  }
  const after = mem()
  snap('after')
  let bots = 0; let mobs = 0; let inRun = 0
  for (const w of worlds.worlds) {
    World.run(w, () => {
      bots += World.PLAYERS.filter((p) => p.bot !== undefined && !p.destroyed && !p.exited).length
      mobs += World.MOBS.filter((m) => !m.destroyed).length
    })
  }
  for (const c of clients) if (c.player !== undefined && !c.player.destroyed && !c.player.exited) inRun++
  const ms = total / 300
  return {
    mode: MODE,
    map: MAP,
    layers: LAYER_COUNT,
    mobScale: MOBSCALE,
    lootScale: LOOTSCALE,
    private: PRIVATE,
    botTarget: BOTS,
    n,
    worlds: worlds.worlds.length,
    tickMs: +ms.toFixed(3),
    msPerHuman: +(ms / n).toFixed(4),
    heapMBPerHuman: +((after.heapMB - before.heapMB) / n).toFixed(3),
    rssMBPerHuman: +((after.rssMB - before.rssMB) / n).toFixed(3),
    rssMB: +after.rssMB.toFixed(1),
    buildMsPerWorld: +(buildMs / Math.max(1, builds)).toFixed(2),
    // PRIVATE: the one build that generated the private map (first N of the process only).
    firstBuildMs: firstBuildMs === undefined ? undefined : +firstBuildMs.toFixed(2),
    bots,
    mobs,
    humansInRun: inRun
  }
}

;(async () => {
  const sizes = (process.env.N ?? '1,10,50').split(',').map(Number)
  for (const n of sizes) console.log(JSON.stringify(await run(n)))
  process.exit(0)
})()
