// A crowd of headless players for load testing. One process runs `count` bots.
//   node loadbot.mjs <url> <count> <prefix> <outFile> [joinSpreadMs]
// Each bot: joins with a hex id, sends its route when it changes (as the client
// does since server-cpu-trim; LOADBOT_POINTER=tick re-sends it every tick, as
// older clients did), picks a new destination 2-8 cells away every 3-7 s, presses a random
// skill aimed at a nearby cell every ~2 s, throws a bomb now and then, and
// rejoins on death or extraction. A connect that fails is retried with
// exponential backoff (0.5 s doubling to 10 s, jittered), so a saturated server
// shows up as `connectFails`, not as bots that silently never play.
// Writes one JSON line of traffic stats per 5 s window to outFile.
// LOADBOT_FRAMES=0 connects as a client from before one-frame-per-tick.
//
// Dependencies, resolved from this file's location, never from the cwd:
// - socket.io-client from the client package (`plunder-land-client`, which
//   depends on it; the server package does not). Run `npm ci` there first.
//   LOADBOT_CLIENT_DIR overrides the directory it is resolved from.
// - Hex and Vector from this server's own build (`dist/utils`), so run
//   `npm run build` first (ramp.sh does). `utils/hex.ts` is byte-identical in
//   both packages (mirror.spec.ts), so this is the grid the client uses.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '../..')
const CLIENT = path.resolve(process.env.LOADBOT_CLIENT_DIR ?? path.join(SERVER, '../../plunder-land-client'))

function load (dir, id, hint) {
  try {
    return createRequire(path.join(dir, 'package.json'))(id)
  } catch (e) {
    console.error(`loadbot: cannot load ${id} from ${dir}: ${e.message}\n${hint}`)
    process.exit(2)
  }
}
const { io } = load(CLIENT, 'socket.io-client', `Run \`npm ci\` in ${CLIENT}, or set LOADBOT_CLIENT_DIR.`)
const parser = load(CLIENT, 'socket.io-parser', `Run \`npm ci\` in ${CLIENT}, or set LOADBOT_CLIENT_DIR.`)

// One frame per tick (LOADBOT_FRAMES, default 1, as the game client asks):
// the same decoding as the client's src/net/framedparser.ts, which is
// TypeScript and can't be loaded here. Sections are split back into the
// events below, so the rest of the bot doesn't know the difference. With 0
// the bot connects as an older client and gets one socket.io event per kind.
const FRAMES = (process.env.LOADBOT_FRAMES ?? '1') === '1'
const POINTER_EVERY_TICK = process.env.LOADBOT_POINTER === 'tick'
const KINDS = { 1: 'create', 2: 'create_own', 3: 'effect', 4: 'destroy', 5: 'standings', 6: 'update' }
function unpackFrame (b) {
  if (b.length < 9 || b[0] !== 1) return undefined
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const events = []; let update
  let at = 9
  while (at + 5 <= b.length) {
    const kind = b[at]; const len = view.getUint32(at + 1); const start = at + 5
    if (start + len > b.length) break
    at = start + len
    if (KINDS[kind] === 'update') update = b.subarray(start, start + len)
    else if (KINDS[kind] !== undefined) events.push([KINDS[kind], b.slice(start, start + len).buffer])
  }
  const packet = new Uint8Array(8 + (update?.length ?? 0))
  packet.set(b.subarray(1, 9), 0); if (update) packet.set(update, 8)
  events.push(['update', packet.buffer])
  return events
}
class FramedDecoder extends parser.Decoder {
  constructor () {
    super(); this.framed = false
    this.on('decoded', (p) => { if (p.type === parser.PacketType.EVENT && p.data?.[0] === 'hello') this.framed = p.data[1]?.frames === 1 })
  }
  add (obj) {
    if (!this.framed || typeof obj === 'string') return super.add(obj)
    const b = obj instanceof ArrayBuffer ? new Uint8Array(obj) : new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength)
    for (const data of unpackFrame(b) ?? []) this.emitReserved('decoded', { type: parser.PacketType.EVENT, nsp: '/', data })
  }
  destroy () { this.framed = false; super.destroy() }
}
const FRAMED_OPTS = FRAMES ? { parser: { Encoder: parser.Encoder, Decoder: FramedDecoder }, query: { frames: '1' } } : {}
const { Hex } = load(SERVER, './dist/utils/hex.js', `Run \`npm run build\` in ${SERVER}.`)
const { Vector } = load(SERVER, './dist/utils/vector.js', `Run \`npm run build\` in ${SERVER}.`)

const [url, countArg, prefix, outFile, spreadArg] = process.argv.slice(2)
if (outFile === undefined || !(Number(countArg) > 0)) {
  console.error('usage: node loadbot.mjs <url> <count> <prefix> <outFile> [joinSpreadMs]')
  process.exit(2)
}
const COUNT = Number(countArg)
const SPREAD = Number(spreadArg ?? 5000)
const WINDOW_MS = 5000

// Only what we need to find our own position: id (0), position (2).
function ownPosition (rec, ownId) {
  // Records we care about start with id; walk just far enough.
  if (rec[0] !== 0) return undefined
  const id = (rec[1] << 8) + rec[2]
  if (id !== ownId) return undefined
  // Scan for field 2 at a record boundary we can trust: position is usually next or near.
  // Decode properly for the fields that precede it in practice.
  let o = 3
  while (o < rec.length) {
    const k = rec[o++]
    if (k === 2) return { x: (rec[o] << 8) + rec[o + 1], y: (rec[o + 2] << 8) + rec[o + 3] }
    const w = WIDTH[k]
    if (w === undefined) return undefined
    if (w === -1) { while (o < rec.length && rec[o++] !== 0); continue }
    if (w === -2) { o += 1 + rec[o]; continue }
    o += w
  }
  return undefined
}
// Payload widths by field index (CLAUDE.md wire format); -1 NUL string, -2 counted.
const WIDTH = { 0: 2, 1: 1, 2: 4, 3: 2, 4: 1, 5: 2, 6: 1, 7: 1, 8: 1, 9: 2, 10: 1, 11: -1, 12: 2, 13: 1, 14: 2, 15: 2, 16: 1, 17: 1, 18: -2, 19: 1, 20: 4, 21: 2, 22: 1, 23: -2, 24: 2 }

function splitRecords (b, start) {
  const recs = []
  let o = start
  while (o + 2 <= b.length) {
    const len = (b[o] << 8) + b[o + 1]; o += 2
    if (o + len > b.length) break
    recs.push(b.subarray(o, o + len)); o += len
  }
  return recs
}

const stats = fresh()
function fresh () { return { bytes: {}, msgs: {}, joins: 0, connectFails: 0, deaths: 0, gaps: [], joinBytes: [] } }
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
const rand = (a, b) => a + Math.random() * (b - a)

class Bot {
  constructor (i) { this.i = i; this.failedConnects = 0; this.join() }
  join () {
    if (this.stopped) return
    this.ownId = undefined; this.pos = undefined; this.route = []; this.seq = 1; this.sentRoute = undefined
    this.nextRouteAt = 0; this.nextSkillAt = Date.now() + rand(500, 3000); this.lastUpdateAt = undefined
    this.joinBytes = 0; this.joinDone = false
    const s = this.socket = io(url, { transports: ['websocket'], reconnection: false, forceNew: true, ...FRAMED_OPTS })
    const tally = (ev, raw) => {
      const n = raw?.byteLength ?? raw?.length ?? JSON.stringify(raw).length
      stats.bytes[ev] = (stats.bytes[ev] ?? 0) + n
      stats.msgs[ev] = (stats.msgs[ev] ?? 0) + 1
      if (!this.joinDone) this.joinBytes += n
    }
    s.on('connect', () => { this.failedConnects = 0; stats.joins++; s.emit('start_requested', { id: hex(8), name: `${prefix}${this.i}` }) })
    // With `reconnection: false` a failed connect is final for that socket, and
    // nothing else fires: without this the bot was simply gone for the run.
    s.on('connect_error', () => {
      stats.connectFails++
      s.removeAllListeners(); s.disconnect()
      const backoff = Math.min(10000, 500 * 2 ** this.failedConnects++) * rand(0.5, 1.5)
      if (!this.stopped) setTimeout(() => this.join(), backoff)
    })
    s.on('hello', (h) => tally('hello', h))
    s.on('create', (raw) => tally('create', raw))
    s.on('effect', (raw) => tally('effect', raw))
    s.on('standings', (raw) => tally('standings', raw))
    s.on('create_own', (raw) => {
      tally('create_own', raw)
      const b = new Uint8Array(raw)
      for (const r of splitRecords(b, 0)) { if (r[0] === 0) { this.ownId = (r[1] << 8) + r[2]; const p = ownPosition(r, this.ownId); if (p) this.pos = p } }
    })
    s.on('update', (raw) => {
      tally('update', raw)
      // A join is complete at the first update after our own create: the
      // server sends hello, create (the whole world), create_own and then
      // update in one flush, so this is the snapshot's size. Keying on
      // create_own rather than on "first update" keeps it right if that order
      // ever changes. The stat is per window, so it is null in any window where
      // no join completed (steady state), which is not a bug.
      if (!this.joinDone && this.ownId !== undefined) { this.joinDone = true; stats.joinBytes.push(this.joinBytes) }
      const t = Date.now()
      if (this.lastUpdateAt !== undefined) stats.gaps.push(t - this.lastUpdateAt)
      this.lastUpdateAt = t
      const b = new Uint8Array(raw)
      if (this.ownId !== undefined) for (const r of splitRecords(b, 8)) { const p = ownPosition(r, this.ownId); if (p) this.pos = p }
      this.act(t)
    })
    s.on('destroy', (raw) => {
      tally('destroy', raw)
      const b = new Uint8Array(raw)
      for (const r of splitRecords(b, 0)) if (r[0] === 0 && ((r[1] << 8) + r[2]) === this.ownId) { stats.deaths++; this.restart(); return }
    })
    s.on('disconnect', () => { if (!this.stopped) setTimeout(() => this.restartIfDead(), 500) })
  }
  restartIfDead () { if (this.socket.disconnected && !this.stopped) this.restart() }
  restart () {
    this.socket.removeAllListeners(); this.socket.disconnect()
    if (!this.stopped) setTimeout(() => this.join(), rand(300, 1500))
  }
  cellNear (maxRings) {
    const c = Hex.toCell(new Vector(this.pos.x, this.pos.y))
    const dq = Math.round(rand(-maxRings, maxRings)); const dr = Math.round(rand(-maxRings, maxRings))
    return { q: c.x + dq, r: c.y + dr }
  }
  act (t) {
    if (this.pos === undefined) return
    if (t >= this.nextRouteAt) { this.route = [this.cellNear(8)]; this.nextRouteAt = t + rand(3000, 7000) }
    // The client sends its route when it changes; older clients every tick.
    const key = this.route.map((c) => `${c.q},${c.r}`).join(';')
    if (POINTER_EVERY_TICK || key !== this.sentRoute) {
      this.sentRoute = key
      const b = Buffer.alloc(1 + 4 * this.route.length + 2)
      b.writeUInt8(this.route.length, 0)
      this.route.forEach((c, k) => { b.writeInt16BE(c.q, 1 + 4 * k); b.writeInt16BE(c.r, 3 + 4 * k) })
      b.writeUInt16BE(this.seq, b.length - 2)
      this.seq = (this.seq + 1) & 0xffff || 1
      this.socket.emit('pointer', b)
    }
    if (t >= this.nextSkillAt) {
      const c = this.cellNear(6)
      const s = Buffer.alloc(5)
      s.writeUInt8(Math.floor(Math.random() * 8), 0); s.writeInt16BE(c.q, 1); s.writeInt16BE(c.r, 3)
      this.socket.emit('skill', s)
      if (Math.random() < 0.1) { const u = Buffer.from(s); u.writeUInt8(Math.random() < 0.5 ? 0 : 1, 0); this.socket.emit('use_item', u) }
      this.nextSkillAt = t + rand(1500, 2500)
    }
  }
}

const bots = []
for (let i = 0; i < COUNT; i++) setTimeout(() => bots.push(new Bot(i)), (SPREAD * i) / COUNT)

setInterval(() => {
  const s = { ...stats }; Object.assign(stats, fresh())
  const gaps = s.gaps.sort((a, b) => a - b)
  const p = (q) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] : null
  const connected = bots.filter((b) => b.socket.connected).length; const withPos = bots.filter((b) => b.pos !== undefined).length
  const total = Object.values(s.bytes).reduce((a, b) => a + b, 0)
  fs.appendFileSync(outFile, JSON.stringify({
    t: Date.now(), prefix, bots: COUNT, connected, withPos, joins: s.joins, connectFails: s.connectFails, deaths: s.deaths,
    bytesPerBotPerSec: connected ? Math.round(total / connected / (WINDOW_MS / 1000)) : null,
    byEventPerBotPerSec: Object.fromEntries(Object.entries(s.bytes).map(([k, v]) => [k, connected ? Math.round(v / connected / (WINDOW_MS / 1000)) : null])),
    updateGapMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: p(1) },
    joinKB: s.joinBytes.length ? +(s.joinBytes.reduce((a, b) => a + b, 0) / s.joinBytes.length / 1024).toFixed(1) : null
  }) + '\n')
}, WINDOW_MS)

function stop () { for (const b of bots) { b.stopped = true; b.socket.disconnect() } setTimeout(() => process.exit(0), 200) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
