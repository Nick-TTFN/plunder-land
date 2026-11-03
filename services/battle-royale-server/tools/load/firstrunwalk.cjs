// How long a first run takes to the pad (decision #58, retest-5; Dez's target
// 45-60 s), walked by a scripted client through the real `Worlds`, in game
// time: the clock (`Date.now`, which cooldowns, timers and the mobs' holds
// read) moves 250 ms a tick, however fast the loop runs.
//   node tools/load/firstrunwalk.cjs [dist dir]     (RUNS=5 by default)
// The script plays it plainly, as a player who knows what to do: walks the
// strip's centreline; whenever a live mob is within the ranged reach (6
// cells), stands and presses Ranged at its cell every tick (the cooldown
// decides when a shot goes); never dashes. Prints per run the seconds to the
// handoff, the seconds at each kill, the hp left (floored at 1) and the loot
// carried; then the mean. A measurement of this script, not of a person: a
// new player wanders, a skilled one dashes.
const path = require('path')
const dist = process.argv[2] ?? path.join(__dirname, '../../dist')
const req = (p) => require(path.join(dist, p))
require(path.join(dist, 'network/multiplayer.js'))
const Worlds = req('network/worlds.js').default
const World = req('objects/world.js').default
const { MemoryAccountStore } = req('db/accounts.js')
const { Hex } = req('utils/hex.js')
const { FIRST_RUN, firstRunStrip } = req('firstrun/scenario.js')
const { SKILL_INFO: SKILLS } = req('utils/skills.js')

let now = Date.parse('2026-11-03T12:00:00.000Z')
Date.now = () => now
const redis = { on () { return this }, hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null }
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const RANGE = 6
const TICK_MS = 250

async function once (seed) {
  let s = seed
  Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
  const store = new MemoryAccountStore()
  const worlds = new Worlds({ tickLengthMs: TICK_MS, cap: 200, idleMs: 300_000, redis, accounts: store, bots: 0, now: () => now })
  const { token } = await store.create()
  const h = {}
  const events = []
  const socket = { id: 's', handshake: { query: { frames: '1' }, auth: { token } }, on: (e, cb) => { h[e] = cb }, emit: (e) => { events.push(e); return true }, conn: { write: () => {}, close: () => {} } }
  const connection = worlds.onConnection(socket)
  await settle()
  h.start_requested({ name: 'walk', firstRun: true })
  await settle()
  const world = worlds.worldFor(connection)
  if (world === undefined || !world.firstRun) throw new Error('no first run')
  const player = connection.player
  const slot = player.skillIds.indexOf(SKILLS.ranged.id)
  if (slot < 0) throw new Error('no Ranged in the start kit')
  const { line } = firstRunStrip()
  const startedAt = now
  const kills = []
  let lastWaypoint = -1
  for (let tick = 0; tick < 4 * 300; tick++) {
    if (events.includes('handoff')) {
      return { seconds: (now - startedAt) / 1000, kills, hp: player.hp, loot: player.loot }
    }
    World.run(world, () => {
      const here = player.cell
      let target
      for (const mob of World.MOBS) {
        if (mob.destroyed) continue
        const d = Hex.distance(here, mob.cell)
        if (d <= RANGE && (target === undefined || d < target.d)) target = { mob, d }
      }
      if (target !== undefined) {
        if (player.path.length > 0) { player.setWaypoints([]); lastWaypoint = -1 }
        const before = target.mob.hp
        player.tryExecuteSkill(slot, target.mob.cell)
        if (target.mob.destroyed && before > 0) kills.push({ key: target.mob.archetype.key, at: (now - startedAt) / 1000 })
      } else {
        // The next centreline cell 4 on from the nearest one, or the pad.
        let nearest = 0
        for (let i = 0; i < line.length; i++) if (Hex.distance(here, line[i]) < Hex.distance(here, line[nearest])) nearest = i
        const next = Math.min(line.length - 1, nearest + 4)
        if (next !== lastWaypoint || player.path.length === 0) {
          player.setWaypoints([line[next]])
          lastWaypoint = next
        }
      }
    })
    now += TICK_MS
    worlds.tickAll(TICK_MS)
    await settle()
  }
  throw new Error('never reached the pad in 300 s')
}

;(async () => {
  const runs = Number(process.env.RUNS ?? 5)
  const seconds = []
  for (let r = 0; r < runs; r++) {
    const result = await once(1000 + r)
    seconds.push(result.seconds)
    console.log(JSON.stringify(result))
  }
  console.log(JSON.stringify({ meanSeconds: +(seconds.reduce((a, b) => a + b, 0) / seconds.length).toFixed(2), padAt: FIRST_RUN.padAt }))
  process.exit(0)
})()
