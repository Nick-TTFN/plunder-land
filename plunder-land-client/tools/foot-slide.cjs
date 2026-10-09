#!/usr/bin/env node
/**
 * Foot slide: how far each rig's planted feet slide over the ground at the
 * speeds the game moves it (task anim-sync-review, strand B). A measurement,
 * deterministic, no browser: it evaluates the rigs' own pose code.
 *
 *   node tools/foot-slide.cjs                  # table to stdout, JSON + PNG strips to --out
 *   node tools/foot-slide.cjs --validate       # the synthetic checks only (exit 1 on a failure)
 *   node tools/foot-slide.cjs --out <dir>      # default codex_output/anim-sync-2026-10-09
 *   node tools/foot-slide.cjs --no-png
 *
 * Run from anywhere; it needs `npm ci` in services/battle-royale-server (its
 * ts-node loads the client's TypeScript rigs, as the rig specs do) and in
 * plunder-land-client. A .cjs, not a .ts: the client's tsconfig has rootDir
 * src, so any .ts outside it is a typecheck error (TS6059).
 *
 * What it models (each read from the code, see `constants()`):
 * - Clip clock as the sprites advance it: robots `RobotSprite.update`,
 *   `baseTime += dt * RUN_RATE * (runRate ?? 1) * pace`, pace = speed /
 *   STRIDE_SPEED clamped to [MIN_PACE, maxPace ?? MAX_PACE]; Hopper's loop is
 *   its jump clip's segments (`RobotRig.loops`). NPCs `NpcSprite.update`,
 *   `baseTime += dt * RUN_RATE * pace` on `roles.move`, pace clamped the same
 *   (no per-rig max). Pace is the steady state of `Player/Mob.applyPosition`'s
 *   smoothing at a constant speed.
 * - Rig units to screen px: robots `RobotSprite.SCALE * drawScale`, x times
 *   facing, y up; NPCs `RobotSprite.SCALE * sizeScale`, the package's ground
 *   point (x, y * 0.68 - z), times the Broodling's own draw scale 1.12. Units
 *   stand up (not squashed); a screen offset dy on the ground is a world dy /
 *   TILT (`objects/tilt.ts`). Camera zoom 1 (Game.CONTAINER.scale.x).
 * - Contact: robots Peep, Magnet, Periscope use the rig's own `foot_*.contact`;
 *   Waddle and Hopper have none exported, so a foot is planted while its rig
 *   y is within 1e-6 units of that foot's lowest over the loop (their stance
 *   is exactly flat: Waddle's near foot at 0, its far foot at 5). NPCs use each leg's
 *   own `contact`.
 * - The unit moves at a constant world velocity in a straight line, facing
 *   its motion (robots: facing +1 east, and the last facing kept going
 *   north/south). A planted foot's world velocity is the unit's velocity plus
 *   the foot's velocity in the sprite (clip derivative times clip rate).
 *
 * Output, per rig, speed and direction: slide (mean speed of a planted foot
 * over the ground, u/s and % of ground speed), slip per step (touchdown to
 * lift-off, world units), along (+ foot drifts forward: legs too slow), best
 * rate (the least-squares clip rate that cancels the slide), best runRate
 * (that rate over RUN_RATE * pace) and the slide left at the best rate (a
 * rate can't fix a sweep that isn't parallel to the motion: robots going
 * north/south, NPC diagonals, where the package squashes y by 0.68 and the
 * game reads screen y / TILT).
 *
 * Not modelled: server mob steps and client interpolation (speed is not
 * constant in play), pace smoothing transients and the 250 ms gap rule,
 * `holdGaitOnHit` and any action over the loop, robots walking backwards
 * (the loop plays reversed, symmetric), gear speed changes, Coil slow on NPCs
 * (it slows players only), zoom other than 1.
 */
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const CLIENT = path.resolve(__dirname, '..')
const ROOT = path.resolve(CLIENT, '..')
const SERVER = path.join(ROOT, 'services', 'battle-royale-server')

require(path.join(SERVER, 'node_modules', 'ts-node')).register({ project: path.join(SERVER, 'tsconfig.json'), transpileOnly: true })

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }

// ---------------------------------------------------------------- constants

/** Numbers from the client's pixi modules, which node can't load: parsed from their source and checked. */
function constants () {
  const sprite = fs.readFileSync(path.join(CLIENT, 'src/robots/robotsprite.ts'), 'utf8')
  const num = (re) => {
    const m = sprite.match(re)
    if (m === null) throw Error(`robotsprite.ts no longer matches ${re}: update foot-slide.cjs`)
    return Number(m[1])
  }
  const tilt = fs.readFileSync(path.join(CLIENT, 'src/objects/tilt.ts'), 'utf8')
  if (!/ROW_SCREEN = Math\.round\(ROW \* 0\.93\)/.test(tilt) || !/TILT = ROW_SCREEN \/ ROW/.test(tilt)) throw Error('tilt.ts changed: update foot-slide.cjs')
  const npc = fs.readFileSync(path.join(CLIENT, 'src/npcs/npcsprite.ts'), 'utf8')
  if (!/this\.baseTime \+= this\.moving \? dt \* gaitClock\(this\.npc, this\.pace, this\.stretch, RobotSprite\) : dt/.test(npc)) throw Error('NpcSprite.update changed: update foot-slide.cjs')
  if (!/gaitDirection\(this\.npc\.gait, x, y, TILT\)/.test(npc) || !/gaitPace\(this\.npc\.gait, pace, RobotSprite\.MIN_PACE, RobotSprite\.MAX_PACE\)/.test(npc)) throw Error('NpcSprite.setDirection/setPace changed: update foot-slide.cjs')
  if (!/RobotSprite\.RUN_RATE \* \(this\.character\.runRate \?\? 1\) \* this\.pace/.test(sprite)) throw Error('RobotSprite.update changed: update foot-slide.cjs')
  const { Hex } = require(path.join(CLIENT, 'src/utils/hex.ts'))
  const row = Hex.SIZE * Math.sqrt(3) / 2
  const { PEEP_RIG } = require(path.join(CLIENT, 'src/robots/robotrig.ts'))
  const peepHeight = num(/static readonly PEEP_HEIGHT = ([\d.]+)/)
  return {
    RUN_RATE: num(/static readonly RUN_RATE = ([\d.]+)/),
    STRIDE_SPEED: num(/static readonly STRIDE_SPEED = ([\d.]+)/),
    MIN_PACE: num(/static readonly MIN_PACE = ([\d.]+)/),
    MAX_PACE: num(/static readonly MAX_PACE = ([\d.]+)/),
    SCALE: peepHeight / PEEP_RIG.referenceUnits,
    TILT: Math.round(row * 0.93) / row,
    HEX: Hex.SIZE,
    PACKAGE_TILT: 0.68,
    BROODLING_DRAW: 1.12
  }
}

/** Speeds from the server's own tables. */
function speeds () {
  require(path.join(SERVER, 'src/network/multiplayer.ts'))
  const { ARCHETYPES } = require(path.join(SERVER, 'src/archetypes/archetypes.ts'))
  const { Unit } = require(path.join(SERVER, 'src/objects/unit.ts'))
  const coil = ARCHETYPES.coil.routines.find((r) => r.kind === 'coilField')
  const guard = (key) => ARCHETYPES[key].routines.find((r) => r.kind === 'guard')
  const out = { robots: {}, npcs: {}, dash: Unit.DASH_MULTIPLIER, slow: coil.slow }
  for (const key of ['peep', 'periscope', 'magnet', 'hopper', 'waddle']) out.robots[key] = ARCHETYPES[key].speed
  for (const key of ['crawler', 'compactor', 'kiln', 'coil', 'reactor', 'brood', 'broodling']) {
    const g = guard(key)
    out.npcs[key] = { chase: g.chaseSpeed, idle: g.idleSpeed }
  }
  return out
}

// ---------------------------------------------------------------- adapters

/**
 * A rig as the measurement sees it: `rate(speed)` clip seconds per second,
 * and `feet(clipTime, dir)`: each foot's offset from the unit's ground point
 * in world units, and whether it is planted.
 */
function robotAdapter (key, rig, C) {
  const ppu = C.SCALE * rig.drawScale
  const loop = rig.loops?.run
  const loopTime = (seconds) => {
    if (loop === undefined) return seconds
    const segments = loop.segments ?? [[0, rig.clips[loop.clip].duration]]
    const total = segments.reduce((s, [a, b]) => s + b - a, 0)
    let u = ((seconds % total) + total) % total
    for (const [a, b] of segments) { if (u < b - a) return a + u; u -= b - a }
    return segments[segments.length - 1][1]
  }
  const clip = loop?.clip ?? 'run'
  const bones = Object.keys(rig.animationPose(clip, 0, {}).matrices).filter((b) => /^foot(_|$)/.test(b))
  // Each foot's ground: its lowest rig y over the loop (a far foot stands on a higher plane: Waddle's 5, Peep's 6).
  const period = loop === undefined ? rig.clips.run.duration : (loop.segments ?? [[0, rig.clips[loop.clip].duration]]).reduce((s, [a, b]) => s + b - a, 0)
  const floor = Object.fromEntries(bones.map((b) => [b, Infinity]))
  for (let i = 0; i < 2000; i++) {
    const m = rig.animationPose(clip, loopTime(period * i / 2000), {}).matrices
    for (const b of bones) floor[b] = Math.min(floor[b], m[b].y)
  }
  return {
    key,
    kind: 'robot',
    period,
    pace: (speed) => Math.min(rig.maxPace ?? C.MAX_PACE, Math.max(C.MIN_PACE, speed / C.STRIDE_SPEED)),
    rate (speed) { return C.RUN_RATE * (rig.runRate ?? 1) * this.pace(speed) },
    rateNoRunRate (speed) { return C.RUN_RATE * this.pace(speed) },
    contactSource: bones.every((b) => rig.animationPose(clip, 0, {}).state[b].contact !== undefined) ? 'rig foot_*.contact' : 'foot rig y within 1e-6 of its lowest (no contact flag)',
    feet (t, dir) {
      const pose = rig.animationPose(clip, loopTime(t), {})
      // Facing follows horizontal motion; straight north/south keeps +1.
      const facing = dir.x < -1e-9 ? -1 : 1
      return bones.map((b) => {
        const m = pose.matrices[b]
        const c = pose.state[b].contact
        return { id: b, x: facing * ppu * m.x, y: -ppu * m.y / C.TILT, contact: c !== undefined ? c : m.y < floor[b] + 1e-6 }
      })
    }
  }
}

function npcAdapter (key, rig, C, drawScale = 1) {
  const ppu = C.SCALE * rig.sizeScale * drawScale
  const legsOf = (pose) => pose.state.legs ?? pose.state.state.legs
  const { gaitClock, gaitDirection, gaitPace } = require(path.join(CLIENT, 'src/npcs/npcrig.ts'))
  return {
    key,
    kind: 'npc',
    period: rig.clips[rig.roles.move].duration,
    pace: (speed) => gaitPace(rig.gait, speed / C.STRIDE_SPEED, C.MIN_PACE, C.MAX_PACE),
    // A rig's own gait (`NpcGait`, lanes 3 and 4) as `NpcSprite` reads it: `gaitClock` (its rate from stride and size, its step cap), pace floor and the direction's stretch.
    rate (speed, dir = DIRS.E) { return gaitClock(rig, this.pace(speed), gaitDirection(rig.gait, dir.x, dir.y, C.TILT).stretch, C) },
    rateNoRunRate (speed, dir = DIRS.E) { return C.RUN_RATE * gaitDirection(rig.gait, dir.x, dir.y, C.TILT).stretch * this.pace(speed) },
    contactSource: 'rig leg.contact',
    feet (t, dir) {
      const d = gaitDirection(rig.gait, dir.x, dir.y, C.TILT)
      const pose = rig.pose(rig.roles.move, t, { x: d.x, y: d.y }, undefined, undefined, { clock: t })
      return legsOf(pose).map((l, i) => {
        const g = l.worldFoot ?? l.foot
        return { id: String(l.id ?? i), x: ppu * g.x, y: ppu * (g.y * C.PACKAGE_TILT - (g.z ?? 0)) / C.TILT, contact: l.contact === true }
      })
    }
  }
}

// ---------------------------------------------------------------- measure

const DIRS = { E: { x: 1, y: 0 }, W: { x: -1, y: 0 }, N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, NE: { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, SE: { x: Math.SQRT1_2, y: Math.SQRT1_2 } }

/**
 * One rig at one speed and direction: over two whole loop periods of clip
 * time, sampled at `steps` points, each planted foot's world velocity
 * v + rate * dS/dc (S the foot's offset, c clip time; the derivative is
 * central, h 1e-4 clip s, only where the foot is planted on both sides).
 */
function measure (a, speed, dir, rate = a.rate(speed, dir), steps = 2400) {
  const span = 2 * a.period
  const dc = span / steps
  const h = 1e-4
  const vg = { x: speed * dir.x, y: speed * dir.y }
  let n = 0; let sum = 0; let sumAlong = 0; let max = 0
  let uu = 0; let gu = 0
  let planted = 0
  const footfalls = new Map()
  const down = new Map()
  let slipSum = 0; let slips = 0
  // The loop repeats over `span`, so the samples are cyclic: the first is compared with the last.
  let prev = a.feet((steps - 1) * dc, dir)
  for (let i = 0; i < steps; i++) {
    const c = i * dc
    const now = a.feet(c, dir)
    const lo = a.feet(c - h, dir)
    const hi = a.feet(c + h, dir)
    const t = c / rate
    for (let f = 0; f < now.length; f++) {
      const at = { x: vg.x * t + now[f].x, y: vg.y * t + now[f].y }
      if (now[f].contact) planted++
      if (now[f].contact && !prev[f].contact) {
        footfalls.set(f, (footfalls.get(f) ?? 0) + 1)
        down.set(f, at)
      }
      if (!now[f].contact && prev[f].contact && down.has(f)) {
        const from = down.get(f)
        const p = { x: vg.x * (t - dc / rate) + prev[f].x, y: vg.y * (t - dc / rate) + prev[f].y }
        slipSum += Math.hypot(p.x - from.x, p.y - from.y)
        slips++
        down.delete(f)
      }
      if (!(now[f].contact && lo[f].contact && hi[f].contact)) continue
      const u = { x: (hi[f].x - lo[f].x) / (2 * h), y: (hi[f].y - lo[f].y) / (2 * h) }
      const w = { x: vg.x + rate * u.x, y: vg.y + rate * u.y }
      const s = Math.hypot(w.x, w.y)
      n++; sum += s; max = Math.max(max, s)
      sumAlong += w.x * dir.x + w.y * dir.y
      uu += u.x * u.x + u.y * u.y
      gu += vg.x * u.x + vg.y * u.y
    }
    prev = now
  }
  const feet = prev.length
  const realSpan = span / rate
  const falls = [...footfalls.values()].reduce((s, x) => s + x, 0)
  const contactShare = planted / (steps * feet)
  // Least squares over planted samples: the clip rate that best cancels v.
  const best = uu > 0 ? -gu / uu : 0
  const footCycles = (footfalls.get(0) ?? 0)
  return {
    speed,
    rate,
    pace: a.pace(speed),
    feet,
    slide: n > 0 ? sum / n : NaN,
    slidePct: n > 0 && speed > 0 ? 100 * sum / n / speed : NaN,
    slideMax: max,
    /** Mean planted velocity along the motion: + the foot drifts forward (legs too slow), - backwards (too fast). */
    along: n > 0 ? sumAlong / n : NaN,
    cadence: falls / realSpan,
    cycle: footCycles > 0 ? realSpan / footCycles : NaN,
    stride: footCycles > 0 ? speed * realSpan / footCycles : NaN,
    /** How far a planted foot moves over the ground from touchdown to lift-off, world units (whole contacts only). */
    slipPerStep: slips > 0 ? slipSum / slips : NaN,
    bestRate: best,
    contactShare,
    samples: n
  }
}

/** Slide at the least-squares rate, to show what a pure rate change can and can't fix. */
function residual (a, speed, dir) {
  const m = measure(a, speed, dir)
  if (!(m.bestRate > 0)) return { ...m, residual: NaN }
  const r = measure(a, speed, dir, m.bestRate)
  return { ...m, residual: r.slide, residualPct: r.slidePct }
}

// ---------------------------------------------------------------- synthetic rigs (validation)

/**
 * Synthetic NPC rig: two legs on a 0.5 s loop, planted for 0.6 of it, the
 * foot sweeping back along the direction at `sweep` package units per clip
 * second. `NpcRig`'s shape, through the same adapter as the real ones.
 */
function syntheticNpc (sweep, sizeScale = 1) {
  const P = 0.5; const duty = 0.6
  const span = sweep * P * duty
  return {
    key: 'synthetic', sizeScale, clips: { move: { duration: P, loop: true, events: [] } }, roles: { move: 'move' },
    pose (clip, t, dir) {
      const d = Math.hypot(dir.x, dir.y) || 1
      const ux = dir.x / d; const uy = dir.y / d
      const legs = [0, 0.5].map((shift, i) => {
        const p = (((t / P + shift) % 1) + 1) % 1
        const contact = p < duty
        const q = contact ? p / duty : (p - duty) / (1 - duty)
        const s = contact ? span * (0.5 - q) : span * (q - 0.5)
        return { id: i, foot: { x: (i === 0 ? -20 : 20) + ux * s, y: uy * s, z: contact ? 0 : 3 * Math.sin(Math.PI * q) }, contact }
      })
      return { clip, time: t, state: { legs } }
    }
  }
}

/** Synthetic robot rig: side view, one foot, y up, planted (y 0) for 0.5 of a 0.6 s loop. */
function syntheticRobot (sweep) {
  const P = 0.6; const duty = 0.5
  const span = sweep * P * duty
  const pose = (name, t) => {
    const p = (((t / P) % 1) + 1) % 1
    const contact = p < duty
    const q = contact ? p / duty : (p - duty) / (1 - duty)
    const x = contact ? span * (0.5 - q) : span * (q - 0.5)
    const y = contact ? 0 : 6 * Math.sin(Math.PI * q)
    return { state: { foot: { x, y, r: 0 } }, matrices: { foot: { a: 1, b: 0, c: 0, d: 1, x, y } } }
  }
  return { drawScale: 1, clips: { run: { duration: P } }, animationPose: pose }
}

function validate (C) {
  const results = []
  const check = (name, got, want, tol) => {
    const ok = Math.abs(got - want) <= tol
    results.push({ name, got, want, tol, ok })
  }
  const v = 100
  const pace = v / C.STRIDE_SPEED
  // NPC: a sweep that exactly cancels v east, in package units per clip second.
  const ppu = C.SCALE
  const still = v / (C.RUN_RATE * pace * ppu)
  const npc = npcAdapter('synthetic', syntheticNpc(still), C)
  check('npc planted foot, sweep = ground speed, east: slide u/s', measure(npc, v, DIRS.E).slide, 0, 1e-3)
  check('npc same, west: slide u/s', measure(npc, v, DIRS.W).slide, 0, 1e-3)
  check('npc same, east: best rate / game rate', measure(npc, v, DIRS.E).bestRate / npc.rate(v), 1, 1e-6)
  // North: the package squashes ground y by 0.68 and the game reads screen y / TILT.
  check('npc same, north: slide % = 1 - 0.68/TILT', measure(npc, v, DIRS.N).slidePct, 100 * (1 - C.PACKAGE_TILT / C.TILT), 1e-3)
  const fast = npcAdapter('synthetic', syntheticNpc(2 * still), C)
  check('npc cadence doubled, east: slide % = 100 (feet skate back at v)', measure(fast, v, DIRS.E).slidePct, 100, 1e-3)
  check('npc cadence doubled, east: along = -v', measure(fast, v, DIRS.E).along, -v, 1e-3)
  check('npc cadence doubled: best rate = half the game rate', measure(fast, v, DIRS.E).bestRate / fast.rate(v), 0.5, 1e-6)
  const sized = npcAdapter('synthetic', syntheticNpc(still / 2, 2), C)
  check('npc sizeScale 2, half the sweep: slide u/s', measure(sized, v, DIRS.E).slide, 0, 1e-3)
  check('npc stride = v * cycle', measure(npc, v, DIRS.E).stride, v * 0.5 / npc.rate(v), 1e-6)
  check('npc cadence (2 feet) = 2 / cycle', measure(npc, v, DIRS.E).cadence, 2 * npc.rate(v) / 0.5, 1e-6)
  // Robots: the same in the robot path (y up, facing, drawScale).
  const rstill = v / (C.RUN_RATE * pace * C.SCALE)
  const robot = robotAdapter('synthetic', syntheticRobot(rstill), C)
  check('robot planted foot, east: slide u/s', measure(robot, v, DIRS.E).slide, 0, 1e-3)
  check('robot planted foot, west (facing -1): slide u/s', measure(robot, v, DIRS.W).slide, 0, 1e-3)
  check('robot side view going north: slide % (foot sweeps across, ground goes up)', measure(robot, v, DIRS.N).slidePct, 100 * Math.SQRT2, 1e-3)
  const rfast = robotAdapter('synthetic', syntheticRobot(2 * rstill), C)
  check('robot cadence doubled, east: slide %', measure(rfast, v, DIRS.E).slidePct, 100, 1e-3)
  // Pace clamps: at 30 u/s pace is MIN_PACE 0.5 (not 0.214), so the sweep is 0.5/0.214 too fast.
  check('npc tuned for 100 u/s, at 30 u/s (pace clamped to MIN_PACE): along = 30 - MIN_PACE * STRIDE_SPEED', measure(npc, 30, DIRS.E).along, 30 - C.MIN_PACE * C.STRIDE_SPEED, 1e-3)
  check('npc planted foot: slip per step', measure(npc, v, DIRS.E).slipPerStep, 0, 1e-3)
  check('npc cadence doubled: slip per step = v * planted time', measure(fast, v, DIRS.E).slipPerStep, v * 0.6 * 0.5 / fast.rate(v), 0.5)
  return results
}

// ---------------------------------------------------------------- PNG

function crcTable () {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
}
const CRC = crcTable()
function crc32 (buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

class Raster {
  constructor (w, h, bg) {
    this.w = w; this.h = h
    this.px = new Float32Array(w * h * 3)
    for (let i = 0; i < w * h; i++) { this.px[i * 3] = bg[0]; this.px[i * 3 + 1] = bg[1]; this.px[i * 3 + 2] = bg[2] }
  }

  blend (x, y, rgb, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return
    const i = (y * this.w + x) * 3
    for (let k = 0; k < 3; k++) this.px[i + k] += (rgb[k] - this.px[i + k]) * Math.min(1, a)
  }

  disc (cx, cy, r, rgb, a = 1) {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        this.blend(x, y, rgb, a * Math.max(0, Math.min(1, r + 0.5 - d)))
      }
    }
  }

  ring (cx, cy, r, width, rgb, a = 1) {
    for (let y = Math.floor(cy - r - width); y <= cy + r + width; y++) {
      for (let x = Math.floor(cx - r - width); x <= cx + r + width; x++) {
        const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r)
        this.blend(x, y, rgb, a * Math.max(0, Math.min(1, width / 2 + 0.5 - d)))
      }
    }
  }

  line (x0, y0, x1, y1, width, rgb, a = 1) {
    const minX = Math.floor(Math.min(x0, x1) - width); const maxX = Math.ceil(Math.max(x0, x1) + width)
    const minY = Math.floor(Math.min(y0, y1) - width); const maxY = Math.ceil(Math.max(y0, y1) + width)
    const dx = x1 - x0; const dy = y1 - y0; const L2 = dx * dx + dy * dy || 1e-9
    for (let y = Math.max(0, minY); y <= Math.min(this.h - 1, maxY); y++) {
      for (let x = Math.max(0, minX); x <= Math.min(this.w - 1, maxX); x++) {
        const px = x + 0.5; const py = y + 0.5
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L2))
        const d = Math.hypot(px - x0 - t * dx, py - y0 - t * dy)
        this.blend(x, y, rgb, a * Math.max(0, Math.min(1, width / 2 + 0.5 - d)))
      }
    }
  }

  /** Rasters side by side ('h') or one above the other ('v'), 8 px apart. */
  static stack (list, how) {
    const gap = 8
    const W = how === 'h' ? list.reduce((s, r) => s + r.w, 0) + gap * (list.length - 1) : Math.max(...list.map((r) => r.w))
    const H = how === 'v' ? list.reduce((s, r) => s + r.h, 0) + gap * (list.length - 1) : Math.max(...list.map((r) => r.h))
    const out = new Raster(W, H, [8, 8, 8])
    let ox = 0; let oy = 0
    for (const r of list) {
      for (let y = 0; y < r.h; y++) out.px.set(r.px.subarray(y * r.w * 3, (y + 1) * r.w * 3), ((oy + y) * W + ox) * 3)
      if (how === 'h') ox += r.w + gap; else oy += r.h + gap
    }
    return out
  }

  png () {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h)
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0
      for (let x = 0; x < this.w * 3; x++) raw[y * (this.w * 3 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(this.px[y * this.w * 3 + x])))
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 2
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  }
}

const FOOT_COLOURS = [[230, 80, 60], [60, 160, 230], [240, 190, 40], [90, 200, 110], [190, 100, 220], [240, 130, 190]]

/**
 * A strip of the rig walking at `speed` along `dir` for `seconds`, seen as on
 * screen (world y drawn at y * TILT), `zoom` px per world unit, over the hex
 * grid. Every 1/60 s each foot is a dot where it is on the ground: bright
 * while planted, faint in the air; a planted run of dots is joined, so its
 * length is the slide of that step. A ring marks the touchdown, a cross the
 * lift-off. Grey ticks: the unit's ground point every 0.1 s.
 */
function strip (a, speed, dir, rate, seconds, zoom, C) {
  const fps = 60
  const frames = Math.round(seconds * fps)
  const track = []
  for (let i = 0; i <= frames; i++) {
    const t = i / fps
    const p = { x: speed * dir.x * t, y: speed * dir.y * t }
    track.push({ t, p, feet: a.feet(rate * t, dir).map((f) => ({ ...f, x: p.x + f.x, y: p.y + f.y })) })
  }
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
  for (const s of track) for (const q of [s.p, ...s.feet]) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y * C.TILT); maxY = Math.max(maxY, q.y * C.TILT) }
  const pad = 40
  const W = Math.ceil((maxX - minX) * zoom + 2 * pad)
  const H = Math.ceil((maxY - minY) * zoom + 2 * pad)
  const R = new Raster(W, H, [24, 28, 34])
  const sx = (x) => (x - minX) * zoom + pad
  const sy = (y) => (y * C.TILT - minY) * zoom + pad
  // Hex grid (pointy top, `Hex.toPosition`), drawn squashed by TILT as the ground is.
  const size = C.HEX; const rowH = size * Math.sqrt(3) / 2; const rad = size / Math.sqrt(3)
  const r0 = Math.floor((minY / C.TILT - pad / zoom) / rowH) - 1; const r1 = Math.ceil((maxY / C.TILT + pad / zoom) / rowH) + 1
  for (let r = r0; r <= r1; r++) {
    const q0 = Math.floor((minX - pad / zoom) / size - r / 2) - 1; const q1 = Math.ceil((maxX + pad / zoom) / size - r / 2) + 1
    for (let q = q0; q <= q1; q++) {
      const cx = size * (q + r / 2); const cy = rowH * r
      for (let k = 0; k < 6; k++) {
        const a0 = (Math.PI / 3) * k + Math.PI / 6; const a1 = a0 + Math.PI / 3
        R.line(sx(cx + rad * Math.cos(a0)), sy(cy + rad * Math.sin(a0)), sx(cx + rad * Math.cos(a1)), sy(cy + rad * Math.sin(a1)), 1, [70, 80, 92])
      }
    }
  }
  R.line(sx(track[0].p.x), sy(track[0].p.y), sx(track[frames].p.x), sy(track[frames].p.y), 1, [120, 120, 120], 0.6)
  for (let i = 0; i <= frames; i += 6) R.disc(sx(track[i].p.x), sy(track[i].p.y), 1.5, [150, 150, 150])
  const nFeet = track[0].feet.length
  for (let f = 0; f < nFeet; f++) {
    const col = FOOT_COLOURS[f % FOOT_COLOURS.length]
    for (let i = 0; i <= frames; i++) {
      const cur = track[i].feet[f]
      const before = i > 0 ? track[i - 1].feet[f] : undefined
      if (!cur.contact) { R.disc(sx(cur.x), sy(cur.y), 1, col, 0.25); continue }
      if (before?.contact) R.line(sx(before.x), sy(before.y), sx(cur.x), sy(cur.y), 2.5, col)
      else R.ring(sx(cur.x), sy(cur.y), 4, 1.5, col)
      R.disc(sx(cur.x), sy(cur.y), 1.8, col)
      const next = i < frames ? track[i + 1].feet[f] : undefined
      if (next !== undefined && !next.contact) {
        R.line(sx(cur.x) - 4, sy(cur.y) - 4, sx(cur.x) + 4, sy(cur.y) + 4, 1.5, col)
        R.line(sx(cur.x) - 4, sy(cur.y) + 4, sx(cur.x) + 4, sy(cur.y) - 4, 1.5, col)
      }
    }
  }
  return R
}

// ---------------------------------------------------------------- main

function main () {
  const C = constants()
  const checks = validate(C)
  const failed = checks.filter((c) => !c.ok)
  if (flag('--validate')) {
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: got ${c.got.toFixed(6)}, want ${c.want.toFixed(6)} +/- ${c.tol}`)
    process.exit(failed.length > 0 ? 1 : 0)
  }
  if (failed.length > 0) throw Error('synthetic checks failed; run with --validate')

  const S = speeds()
  const { ROBOT_RIGS } = require(path.join(CLIENT, 'src/robots/robotrig.ts'))
  const { NPC_RIGS } = require(path.join(CLIENT, 'src/npcs/npcrig.ts'))
  const rigs = []
  for (const key of ['peep', 'periscope', 'magnet', 'hopper', 'waddle']) {
    const base = S.robots[key]
    rigs.push({ a: robotAdapter(key, ROBOT_RIGS[key], C), speeds: [['base', base], ['dash', base * S.dash], ['coil-slowed', base * S.slow]] })
  }
  for (const key of ['crawler', 'compactor', 'kiln', 'coil', 'reactor', 'brood', 'broodling']) {
    rigs.push({ a: npcAdapter(key, NPC_RIGS[key], C, key === 'broodling' ? C.BROODLING_DRAW : 1), speeds: [['chase', S.npcs[key].chase], ['idle', S.npcs[key].idle]] })
  }

  const out = path.resolve(option('--out', path.join(CLIENT, 'codex_output/anim-sync-2026-10-09')))
  fs.mkdirSync(out, { recursive: true })
  const rows = []
  const f1 = (x) => Number.isFinite(x) ? x.toFixed(1) : '-'
  const f2 = (x) => Number.isFinite(x) ? x.toFixed(2) : '-'
  console.log('rig\tspeed\tu/s\tpace\tclip rate\tdir\tcadence steps/s\tstride u\tslide u/s\tslide %\tslip/step u\talong u/s\tbest rate\tbest runRate\tresidual %\tcontact from')
  for (const { a, speeds: list } of rigs) {
    for (const [label, speed] of list) {
      for (const d of ['E', 'W', 'N', 'S', 'NE', 'SE']) {
        const m = residual(a, speed, DIRS[d])
        // The runRate (robots' `RobotRig.runRate`, or an NPC one) that makes the best rate at this pace.
        const bestRunRate = m.bestRate / a.rateNoRunRate(speed, DIRS[d])
        const row = { rig: a.key, kind: a.kind, label, dir: d, ...m, bestRunRate, contactSource: a.contactSource }
        rows.push(row)
        console.log([a.key, label, f1(speed), f2(m.pace), f2(m.rate), d, f2(m.cadence), f1(m.stride), f1(m.slide), f1(m.slidePct), f1(m.slipPerStep), f1(m.along), f2(m.bestRate), f2(bestRunRate), f1(m.residualPct), a.contactSource].join('\t'))
      }
    }
  }
  fs.writeFileSync(path.join(out, 'foot-slide.json'), JSON.stringify({ constants: C, speeds: S, checks, rows }, null, 1))

  if (!flag('--no-png')) {
    const made = []
    const html = ['<!doctype html><meta charset="utf-8"><title>Foot slide</title><style>body{background:#111;color:#ddd;font:14px system-ui;margin:16px}img{display:block;margin:4px 0 18px;max-width:100%;image-rendering:pixelated}</style>',
      '<h1>Foot slide strips</h1><p>Generated by plunder-land-client/tools/foot-slide.cjs. World seen as on screen (y squashed by TILT) over the hex grid. Each foot a colour; bright joined dots: planted, every 1/60 s (the joined length is the slide of that step); ring: touchdown; cross: lift-off; faint dots: in the air. Grey ticks: the unit every 0.1 s. E strips: top as the game plays it, bottom at the clip rate that best cancels the slide (where one exists). N/S: north left, south right.</p>']
    for (const { a, speeds: list } of rigs) {
      const speed = list[0][1]
      const zoom = a.kind === 'robot' ? 5 : 3
      const seconds = Math.max(1.2, Math.min(3, 2.2 * a.period / a.rate(speed)))
      const best = measure(a, speed, DIRS.E).bestRate
      const east = [strip(a, speed, DIRS.E, a.rate(speed), seconds, zoom, C)]
      if (best > 0) east.push(strip(a, speed, DIRS.E, best, seconds, zoom, C))
      const files = [[`${a.key}-E.png`, Raster.stack(east, 'v')], [`${a.key}-NS.png`, Raster.stack(['N', 'S'].map((d) => strip(a, speed, DIRS[d], a.rate(speed, DIRS[d]), seconds, zoom, C)), 'h')]]
      const row = (d) => rows.find((r) => r.rig === a.key && r.label === list[0][0] && r.dir === d)
      html.push(`<h2>${a.key}: ${list[0][0]} ${speed} u/s, clip rate ${a.rate(speed).toFixed(2)}</h2><p>E: slide ${row('E').slidePct.toFixed(0)}% (${row('E').slipPerStep.toFixed(1)} u per step); best rate ${best.toFixed(2)}. N: slide ${row('N').slidePct.toFixed(0)}%.</p>`)
      for (const [name, raster] of files) {
        fs.writeFileSync(path.join(out, name), raster.png())
        made.push(path.join(out, name))
        html.push(`<img src="${name}" alt="${name}">`)
      }
    }
    fs.writeFileSync(path.join(out, 'index.html'), html.join('\n'))
    console.error(`wrote ${made.length} PNGs and foot-slide.json to ${out}`)
  }
}

if (require.main === module) main()
module.exports = { constants, speeds, robotAdapter, npcAdapter, measure, residual, strip, Raster, DIRS, FOOT_COLOURS }
