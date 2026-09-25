#!/usr/bin/env node
/**
 * archetype-bot: a headless player that records what units look like on the
 * wire, for unit-archetypes' "behaviour unchanged" check (design section 7,
 * step 0(c)). Run it against a server before a change and after, and diff.
 *
 *   node tools/archetype-bot.mjs <serverUrl> [--seconds 60] [--label name]
 *
 * serverUrl is required, deliberately with no default: run it on a server of
 * your own, never a shared one, because it walks a player into grunts until it
 * dies and rejoins. Start that server the moment before the bot to catch the
 * world's first spawns as live creates (that is where the boss's create radius
 * shows); join a settled world to get a full snapshot.
 *
 * It imports the client's own `src/utils/hex.ts`, so it routes with the same
 * maths the game does. That needs Node's native TS type stripping (22.18+ or
 * 23.6+; the baseline was measured on 24.4). Node warns
 * MODULE_TYPELESS_PACKAGE_JSON for the import; it is harmless, and
 * `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` silences it.
 *
 * It records:
 * - create records, by type and by (type, radius, hp, maxHp), split into the
 *   join snapshot and creates that arrive live while it is online;
 * - radius changes that follow a live create (the boss's 30 -> 40 delta);
 * - its own create_own fields;
 * - walking into the nearest grunt (a mob with maxHp 50) on its plane for the
 *   whole run: every hp change, the gap between consecutive -10 hits taken
 *   within 60 of the target (from any grunt: the wire does not say which one
 *   hit, so two grunts at once show as 250/750 ms gaps), and the spacing to the
 *   target while within 60. On death it rejoins as a new player and carries on;
 * - mob speeds, from position deltas between consecutive ticks;
 * - the armor pool (unit-archetypes step 3): every change to its own armor or
 *   hp as one event with both deltas, whether hp ever fell while armor was
 *   left, the refill steps, and the delay from the last damage to the first
 *   refill. A contact hit is -10 in total, from armor, hp or both.
 *
 * Wire format: CLAUDE.md "Wire format". Uses only the client's socket.io-client.
 */
import { register } from 'node:module'
import { io } from 'socket.io-client'

// The client's TS sources import without extensions; let Node find them.
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve (s, c, next) {' +
  '  try { return await next(s, c) } catch (e) {' +
  '    if (s.startsWith(".") && !/\\.\\w+$/.test(s)) return next(s + ".ts", c); throw e } }'
))
const { Hex } = await import(new URL('../src/utils/hex.ts', import.meta.url).href)
const { Vector } = await import(new URL('../src/utils/vector.ts', import.meta.url).href)

// --- arguments ------------------------------------------------------------------

const args = process.argv.slice(2)
let serverUrl
let seconds = 60
let label = 'run'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seconds') seconds = Number(args[++i])
  else if (args[i] === '--label') label = args[++i]
  else serverUrl = args[i]
}
if (serverUrl === undefined) {
  console.error('usage: node tools/archetype-bot.mjs <serverUrl> [--seconds 60] [--label name]')
  process.exit(2)
}

// --- wire -----------------------------------------------------------------------

// Must match the client's allFields (src/game.ts) and the server's fieldOrder.
const FIELDS = ['id', 'type', 'position', 'hp', 'level', 'loot', 'tag', 'to', 'radius',
  'lifetime', 'maxVelocity', 'name', 'maxHp', 'facing', 'armor', 'maxArmor']
const TYPE_NAMES = { 1: 'Obstacle', 2: 'Consumable', 4: 'Player', 8: 'Portal', 16: 'Throwable', 32: 'Mob', 64: 'Exit' }
const MOB = 32
const GRUNT_MAX_HP = 50
const BOSS_MAX_HP = 300

function splitRecords (buffer, start) {
  const records = []
  let offset = start
  while (offset + 2 <= buffer.length) {
    const length = (buffer[offset] << 8) + buffer[offset + 1]
    offset += 2
    if (offset + length > buffer.length) break
    records.push(buffer.subarray(offset, offset + length))
    offset += length
  }
  return records
}

const s8 = (b) => (b > 127 ? b - 256 : b)

/** Mirrors Game.deserialiseBinary. Throws on an unknown index, which the client only warns about. */
function decode (buffer) {
  const data = {}
  let o = 0
  while (o < buffer.length) {
    const key = FIELDS[buffer[o++]]
    if (key === undefined) throw new Error(`unknown field index ${buffer[o - 1]}`)
    switch (key) {
      case 'id': case 'hp': case 'loot': case 'maxHp': case 'armor': case 'maxArmor':
        data[key] = (buffer[o++] << 8) + buffer[o++]; break
      case 'type': case 'level': case 'radius': case 'facing':
        data[key] = buffer[o++]; break
      case 'position':
        data[key] = { x: (buffer[o++] << 8) + buffer[o++], y: (buffer[o++] << 8) + buffer[o++] }; break
      case 'tag': case 'to':
        data[key] = s8(buffer[o++]); break
      case 'lifetime':
        data[key] = ((buffer[o++] << 8) + buffer[o++]) * 100; break
      case 'maxVelocity':
        data[key] = buffer[o++] * 10; break
      case 'name': {
        let s = ''
        while (o < buffer.length) { const c = buffer[o++]; if (c === 0) break; s += String.fromCharCode(c) }
        data[key] = s; break
      }
    }
  }
  return data
}

const toBuf = (raw) => (raw instanceof Uint8Array ? raw : new Uint8Array(raw))

// --- state and results ------------------------------------------------------------

const count = (map, key) => { map[key] = (map[key] ?? 0) + 1 }
const sorted = (map) => Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]))

const results = {
  label,
  server: serverUrl,
  seconds,
  hello: null,
  joins: 0,
  deaths: 0,
  snapshot: { byType: {}, byTypeRadiusHpMaxHp: {} },
  live: { byType: {}, byTypeRadiusHpMaxHp: {} },
  liveMobRadiusChanges: {},
  createOwn: [],
  hpDeltas: [],
  contactHitGapsMs: {},
  spacingWhileTouching: {},
  mobSpeeds: { idleOrChase: {}, touchingPlayer: {} },
  effectsByType: {},
  planeChanges: 0,
  pointersSent: 0,
  gruntsTargeted: 0,
  firstContactAt: null,
  unknownFieldErrors: 0,
  // The armor pool (step 3).
  ownChanges: [],
  hpFellWithArmorLeft: 0,
  refillStepHistogram: {},
  refillDelayMs: {},
  mobCreatesWithArmor: 0
}
let lastDamageTick
let refilledSinceDamage = true

let objects = new Map()
let ownId
let tickMs = 250
let lastTick = 0
let seq = 1
let snapshotTaken = false
let targetId
let lastContactHitTick
const started = Date.now()
const deadline = started + seconds * 1000
let socket
let finished = false

function histKey (d) {
  return `${TYPE_NAMES[d.type] ?? d.type} r=${d.radius} hp=${d.hp} maxHp=${d.maxHp}`
}

function me () { return objects.get(ownId) }

function dist (a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

function nearest (predicate) {
  const self = me()
  if (self === undefined) return undefined
  let best
  let bestD = Infinity
  for (const obj of objects.values()) {
    if (obj.id === ownId || obj.tag !== self.tag || !predicate(obj)) continue
    const d = dist(obj.position, self.position)
    if (d < bestD) { bestD = d; best = obj }
  }
  return best
}

function onCreate (raw) {
  const records = splitRecords(toBuf(raw), 0)
  const bucket = snapshotTaken ? results.live : results.snapshot
  // Histograms count the first life only: a rejoin's snapshot is the same
  // world counted again. Later lives still track every object for steering.
  const counting = results.joins === 1
  for (const r of records) {
    let d
    try { d = decode(r) } catch { results.unknownFieldErrors++; continue }
    if (d.type === MOB && (d.armor !== undefined || d.maxArmor !== undefined)) results.mobCreatesWithArmor++
    if (counting) {
      count(bucket.byType, TYPE_NAMES[d.type] ?? d.type)
      count(bucket.byTypeRadiusHpMaxHp, histKey(d))
    }
    objects.set(d.id, { ...d, createdLive: snapshotTaken })
  }
  snapshotTaken = true
}

function onCreateOwn (raw) {
  for (const r of splitRecords(toBuf(raw), 0)) {
    const d = decode(r)
    ownId = d.id
    objects.set(d.id, { ...d })
    results.createOwn.push(d)
  }
}

function onUpdate (raw) {
  const buffer = toBuf(raw)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const tick = view.getUint32(0)
  for (const r of splitRecords(buffer, 8)) {
    let d
    try { d = decode(r) } catch { results.unknownFieldErrors++; continue }
    const obj = objects.get(d.id)
    if (obj === undefined) { objects.set(d.id, { ...d }); continue }

    if (d.radius !== undefined && obj.createdLive && obj.type === MOB && d.radius !== obj.radius) {
      count(results.liveMobRadiusChanges, `${obj.radius} -> ${d.radius} (maxHp ${obj.maxHp})`)
    }
    if (d.id === ownId && d.tag !== undefined && d.tag !== obj.tag) results.planeChanges++

    if (d.id === ownId && d.hp !== undefined && d.hp !== obj.hp) {
      const target = objects.get(targetId)
      const boss = nearest((o) => o.type === MOB && o.maxHp === BOSS_MAX_HP)
      const pos = d.position ?? obj.position
      const delta = d.hp - obj.hp
      results.hpDeltas.push({
        t: +((Date.now() - started) / 1000).toFixed(2),
        tick,
        delta,
        hp: d.hp,
        toGrunt: target ? Math.round(dist(target.position, pos)) : null,
        toBoss: boss ? Math.round(dist(boss.position, pos)) : null
      })
    }

    // The pool: armor and hp as one event, since a hit may take from either.
    const armorChanged = d.id === ownId && d.armor !== undefined && d.armor !== obj.armor
    const hpChanged = d.id === ownId && d.hp !== undefined && d.hp !== obj.hp
    if (armorChanged || hpChanged) {
      const target = objects.get(targetId)
      const pos = d.position ?? obj.position
      const dArmor = (d.armor ?? obj.armor ?? 0) - (obj.armor ?? 0)
      const dHp = (d.hp ?? obj.hp) - obj.hp
      const armor = d.armor ?? obj.armor
      results.ownChanges.push({
        t: +((Date.now() - started) / 1000).toFixed(2),
        tick,
        dArmor,
        dHp,
        armor,
        hp: d.hp ?? obj.hp,
        toGrunt: target ? Math.round(dist(target.position, pos)) : null
      })
      if (dHp < 0 && armor > 0) results.hpFellWithArmorLeft++
      if (dArmor < 0 || dHp < 0) {
        lastDamageTick = tick
        refilledSinceDamage = false
      } else if (dArmor > 0) {
        count(results.refillStepHistogram, dArmor)
        if (!refilledSinceDamage && lastDamageTick !== undefined) {
          count(results.refillDelayMs, (tick - lastDamageTick) * tickMs)
          refilledSinceDamage = true
        }
      }
      if (dArmor + dHp === -10 && target && dist(target.position, pos) < 60) {
        if (lastContactHitTick !== undefined) count(results.contactHitGapsMs, (tick - lastContactHitTick) * tickMs)
        lastContactHitTick = tick
      }
    }

    if (obj.type === MOB && d.position !== undefined && obj.lastTick === tick - 1) {
      const speed = dist(d.position, obj.position) / (tickMs / 1000)
      const self = me()
      const touching = self !== undefined && dist(d.position, self.position) < obj.radius + (self.radius ?? 14) + 10
      const bucket = touching ? results.mobSpeeds.touchingPlayer : results.mobSpeeds.idleOrChase
      count(bucket, `${obj.maxHp === BOSS_MAX_HP ? 'boss' : 'grunt'} ${Math.round(speed / 5) * 5}`)
    }
    if (d.position !== undefined) obj.lastTick = tick
    Object.assign(obj, d)
  }
  lastTick = tick
  steer()
}

function onDestroy (raw) {
  for (const r of splitRecords(toBuf(raw), 0)) {
    let d
    try { d = decode(r) } catch { continue }
    if (d.id === ownId) {
      results.deaths++
      rejoin()
      return
    }
    objects.delete(d.id)
  }
}

function onEffect (raw) {
  for (const r of splitRecords(toBuf(raw), 0)) count(results.effectsByType, r[0])
}

/** Walk at the nearest grunt: one waypoint, its cell, re-sent every tick. */
function steer () {
  const self = me()
  if (self === undefined) return
  let target = objects.get(targetId)
  if (target === undefined || target.tag !== self.tag) {
    target = nearest((o) => o.type === MOB && o.maxHp === GRUNT_MAX_HP)
    targetId = target?.id
    if (target !== undefined) results.gruntsTargeted++
    lastContactHitTick = undefined
  }
  if (target === undefined) return

  const spacing = dist(target.position, self.position)
  if (spacing < 60) {
    count(results.spacingWhileTouching, Math.round(spacing))
    if (results.firstContactAt === null) results.firstContactAt = +((Date.now() - started) / 1000).toFixed(2)
  }

  const cell = Hex.toCell(new Vector(target.position.x, target.position.y))
  const buf = Buffer.alloc(1 + 4 + 2)
  buf.writeUInt8(1, 0)
  buf.writeInt16BE(cell.x, 1)
  buf.writeInt16BE(cell.y, 3)
  buf.writeUInt16BE(seq, 5)
  seq = (seq + 1) & 0xffff || 1
  socket.emit('pointer', buf)
  results.pointersSent++
}

function join () {
  objects = new Map()
  ownId = undefined
  targetId = undefined
  snapshotTaken = false
  lastContactHitTick = undefined
  lastDamageTick = undefined
  refilledSinceDamage = true
  // A fresh socket per life: the server accepts one start_requested per connection.
  socket = io(serverUrl, { transports: ['websocket'], reconnectionDelay: 100, reconnectionDelayMax: 200 })
  socket.on('connect', () => {
    results.joins++
    socket.emit('start_requested', `archetype-bot-${label}-${results.joins}`)
  })
  socket.on('hello', (h) => { results.hello = h; tickMs = h.tick })
  socket.on('create', onCreate)
  socket.on('create_own', onCreateOwn)
  socket.on('update', onUpdate)
  socket.on('destroy', onDestroy)
  socket.on('effect', onEffect)
}

function rejoin () {
  socket.removeAllListeners()
  socket.disconnect()
  if (Date.now() < deadline) setTimeout(join, 300)
}

function finish () {
  if (finished) return
  finished = true
  socket?.removeAllListeners()
  socket?.disconnect()

  const deltas = {}
  for (const h of results.hpDeltas) count(deltas, h.delta)
  const out = {
    ...results,
    snapshot: { byType: sorted(results.snapshot.byType), byTypeRadiusHpMaxHp: sorted(results.snapshot.byTypeRadiusHpMaxHp) },
    live: { byType: sorted(results.live.byType), byTypeRadiusHpMaxHp: sorted(results.live.byTypeRadiusHpMaxHp) },
    hpDeltaHistogram: deltas,
    spacingWhileTouching: results.spacingWhileTouching,
    mobSpeeds: { idleOrChase: sorted(results.mobSpeeds.idleOrChase), touchingPlayer: sorted(results.mobSpeeds.touchingPlayer) },
    lastTick
  }
  console.log(JSON.stringify(out, null, 1))
  process.exit(0)
}

join()
setTimeout(finish, seconds * 1000 + 500)
