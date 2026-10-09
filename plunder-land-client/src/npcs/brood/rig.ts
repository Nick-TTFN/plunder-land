import { type Matrix, multiply } from '../../peep/rig'
import { deepClone } from '../clone'
import { cssColour } from '../colour'
import { type NpcClip, type NpcDrawItem, type NpcDrawList, type NpcEllipse, type NpcGait, type NpcPose, type NpcPoseOptions, type NpcRig } from '../npcrig'

/**
 * The Brood (l1-9): a hand port of `rig/brood.mjs` in its Codex package
 * (`codex_output/npc-refinements/brood-v15`, not checked in).
 * **PROVISIONAL**: v15 (the hit, the death from a captured pose and the baked
 * lamp atlases) is delivered but not yet approved by Nick (v14 was); a
 * re-sync after his review is expected (`tools/npc-rig-sync.mjs brood`,
 * `tools/bake-npc-atlas.py brood`).
 *
 * One painted sphere on six legs, its heading fixed. `spawn` is the release:
 * its `spawn` event (0.18 s) is the launch; the package draws no Broodling
 * (`includedBroodlings: false`), so the game's own emerges then. `sample` is
 * the package's pose function, `evaluatePose` its export with the debris, and
 * `draw` its `drawBrood` as a draw list; `npcrigs.spec.ts` checks them against
 * the package (`brood.fixtures.json`).
 *
 * **The lamps are drawn in code**, from the package's own emission
 * (`tools/bake-effects.mjs` `emission`: a glow, the lens lit, its core above
 * 0.6), at the package's quantisation (1/256): its 257-frame PNG atlases, one
 * per lamp, are that function rasterised, and would be about 400 K texels even
 * at game size. The glow is a radial gradient in the package, drawn here as
 * three flat discs (`approx`, not compared); the lens and its core are exact.
 * Its floor shadows are the package's ellipses.
 */

const TAU = Math.PI * 2

/** From `rig/animation-manifest.json` (the death is `fall_apart` there too, an alias). */
export const CLIPS: Readonly<Record<string, NpcClip>> = Object.freeze({
  hit: { duration: 0.72, loop: false, events: [{ name: 'hurt', time: 0 }] },
  idle: { duration: 7.8, loop: true, events: [] },
  move: { duration: 5.2, loop: true, events: [] },
  spawn: { duration: 1.1, loop: false, events: [{ name: 'spawn', time: 0.18 }] },
  death: { duration: 3, loop: false, events: [{ name: 'detach', time: 0.22 }, { name: 'settled', time: 2.6 }] }
})

export const CONFIG = Object.freeze({ tilt: 0.68, period: 1.3, duty: 0.72, stride: 12, lift: 6, seed: 19 })

/**
 * The game's gait (decision #52 lane 4, the Crawler's treatment; PROVISIONAL
 * until Nick has seen it), at the package's own stride. The package's walk
 * slid 91% at the chase's 60 u/s (strand B). Its painted legs stand at 0.93
 * of their reach at rest and the walk takes them to 0.975; the package
 * throws past 1 ('Unreachable leg', from stride 18), and 14-16 would take a
 * knee to 0.984-0.992, straighter than the art goes, so the stride stays.
 * `gaitClock` derives the rate from the sweep and the size. At 2.06 planted
 * feet at the chase's 60 u/s needed 8.1 steps a second per leg, over
 * `maxSteps` 6, so they slid 26%; at 3.2 (size review, 2026-10-09) they
 * need 5.2: planted at chase and idle (2.6 steps), up to 69 u/s. `minPace`
 * and `groundTilt` as the Crawler's.
 */
export const GAIT: NpcGait = Object.freeze({ groundSpeed: CONFIG.stride / CONFIG.duty / CONFIG.period, period: CONFIG.period, maxSteps: 6, minPace: 0.2, groundTilt: CONFIG.tilt })

/** The release's launch, seconds into `spawn` (the clip's `spawn` event). */
export const SPAWN_EVENT = 0.18

interface Vec { x: number, y: number }
interface Vec3 { x: number, y: number, z: number }

/** `art` in `brood.mjs` (its `art-meta.mjs`). */
const ART = Object.freeze({
  upper: { w: 510, h: 900, start: { x: 429, y: 148 }, end: { x: 351, y: 775 } },
  lower: { w: 415, h: 811, start: { x: 193, y: 118 }, end: { x: 326, y: 783 }, lamp: [{ x: 297, y: 675 }, { x: 322, y: 672 }, { x: 336, y: 711 }, { x: 309, y: 714 }] },
  joint: { w: 280, h: 275 },
  body: {
    w: 1254,
    h: 1254,
    scale: 0.145,
    pivot: { x: 627, y: 1075 },
    baseline: -29,
    lamps: [
      [{ x: 634, y: 549 }, { x: 654, y: 565 }, { x: 637, y: 593 }, { x: 612, y: 577 }],
      [{ x: 1020, y: 479 }, { x: 1046, y: 500 }, { x: 1034, y: 528 }, { x: 1010, y: 513 }],
      [{ x: 1131, y: 672 }, { x: 1143, y: 673 }, { x: 1138, y: 717 }, { x: 1126, y: 716 }],
      [{ x: 805, y: 866 }, { x: 839, y: 847 }, { x: 852, y: 876 }, { x: 820, y: 896 }],
      [{ x: 288, y: 875 }, { x: 327, y: 889 }, { x: 337, y: 917 }, { x: 297, y: 900 }]
    ],
    sockets: [{ id: 'crown', x: 800, y: 400 }, { id: 'left', x: 365, y: 658 }, { id: 'right', x: 980, y: 730 }]
  }
})

/** Every image the draw list names, with its PNG size (`rig/parts.json`; the lamp atlases are not drawn, see above). */
const ARTS: Readonly<Record<string, { readonly w: number, readonly h: number }>> = Object.freeze({
  body: { w: 1254, h: 1254 },
  upper: { w: 510, h: 900 },
  lower: { w: 415, h: 811 },
  lowerOff: { w: 415, h: 811 },
  lowerDead: { w: 415, h: 811 },
  joint: { w: 280, h: 275 }
})

const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x))
const smooth = (x: number): number => { x = clamp(x); return x * x * (3 - 2 * x) }
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const wrap = (x: number): number => ((x % 1) + 1) % 1
const project = (p: Vec & { z?: number }): Vec => ({ x: p.x, y: p.y * CONFIG.tilt - (p.z ?? 0) })
const len = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

interface LegDef { id: string, index: number, hip: Vec, home: Vec3, phase: number, upper: number, lower: number, bend: number, front: boolean, mirror: boolean }

// Independent painted links, each with one fixed uniform scale. No directional squash.
const NEUTRAL: ReadonlyArray<[string, number[], number[], number[], number]> = [
  ['rear-left', [-50, -88], [-88, -89], [-98, -80], 0],
  ['rear-center', [-6, -108], [-40, -142], [-30, -146], 0.5],
  ['rear-right', [52, -92], [90, -94], [105, -77], 0],
  ['front-left', [-37, -41], [-80, -20], [-100, 55], 0.5],
  ['front-center', [15, -34], [43, 3], [30, 90], 0],
  ['front-right', [46, -42], [88, -19], [110, 43], 0.5]
]

export const LEG_DEFS: readonly LegDef[] = NEUTRAL.map(([id, h, k, f, phase], i) => {
  const hip = { x: h[0], y: h[1] }
  const knee = { x: k[0], y: k[1] }
  const home = { x: f[0], y: f[1], z: 0 }
  const foot = project(home)
  const l: LegDef = { id, index: i, hip, home, phase, upper: len(hip, knee), lower: len(knee, foot), bend: Math.sign((foot.x - hip.x) * (knee.y - hip.y) - (foot.y - hip.y) * (knee.x - hip.x)), front: i >= 3, mirror: id === 'front-right' }
  // Placement only: keep both painted link scales and their rigid lengths.
  if (id === 'front-center') { l.hip.x -= 10; l.home.x -= 25 }
  if (id === 'front-right') {
    // Match the lower-left leg's upright shin/foot orientation by reflection.
    const upperNorm = Math.hypot(43, 21)
    const lowerNorm = Math.hypot(20, 57.4)
    const targetKnee = { x: hip.x + 43 / upperNorm * l.upper, y: hip.y + 21 / upperNorm * l.upper }
    l.home.x = targetKnee.x + 20 / lowerNorm * l.lower
    l.home.y = (targetKnee.y + 57.4 / lowerNorm * l.lower) / CONFIG.tilt
  }
  return l
})

export function kneeFor (h: Vec, f: Vec, l: LegDef): Vec {
  const dx = f.x - h.x
  const dy = f.y - h.y
  const d = Math.hypot(dx, dy)
  if (d >= l.upper + l.lower || d <= Math.abs(l.upper - l.lower)) throw Error(`Unreachable leg ${l.id} (${d})`)
  const along = (l.upper * l.upper - l.lower * l.lower + d * d) / (2 * d)
  const b = Math.sqrt(Math.max(0, l.upper * l.upper - along * along)) * l.bend
  return { x: h.x + dx / d * along - dy / d * b, y: h.y + dy / d * along + dx / d * b }
}

const hash = (a: number, b = 0): number => {
  let v = (a * 374761393 + b * 668265263) | 0
  v = (v ^ (v >>> 13)) * 1274126177
  return ((v ^ (v >>> 16)) >>> 0) / 4294967295
}

export function twinkle (id: number, time: number, seed: number = CONFIG.seed): number {
  const period = 2.1 + hash(id + seed, 3) * 1.5
  const t = Math.max(0, time) + hash(id, seed) * period
  const k = Math.floor(t / period)
  let pulse = 0
  for (let n = k - 1; n <= k; n++) {
    const a = hash(id + seed * 13, n * 7 + 71)
    if (a < 0.28) continue
    const start = n * period + hash(id + 11, n + seed) * period * 0.67
    const duration = 0.2 + hash(id + 29, n + seed) * 0.64
    const u = (t - start) / duration
    if (u > 0 && u < 1) pulse = Math.max(pulse, Math.sin(u * Math.PI) ** 2 * (0.50 + 0.45 * a))
  }
  return 0.08 + pulse
}

interface Body { x: number, lift: number, angle: number }

function bodyPoint (p: Vec, body: Body): Vec {
  const co = Math.cos(body.angle)
  const si = Math.sin(body.angle)
  const dy = p.y + 85
  return { x: p.x * co - dy * si + body.x, y: p.x * si + dy * co - 85 - body.lift }
}

function bodySourcePoint (p: Vec, body: Body): Vec {
  return bodyPoint({ x: (p.x - ART.body.pivot.x) * ART.body.scale, y: (p.y - ART.body.pivot.y) * ART.body.scale + ART.body.baseline }, body)
}

export interface BroodLeg extends LegDef {
  knee: Vec
  foot: Vec
  worldFoot: Vec3
  contact: boolean
}

interface SegmentMatrix extends Matrix { scale: number, angle: number }

export interface BroodDebris {
  type: 'body' | 'leg'
  part?: 'upper' | 'lower'
  body?: Body
  m?: SegmentMatrix
  center: Vec
  motion: { x: number, y?: number, groundY: number, angle?: number, settled?: boolean }
  id: number
}

/** The package's pose (`sample`), with the debris (`evaluatePose`). */
export interface BroodState {
  clip: string
  time: number
  clock: number
  seed: number
  body: Body
  legs: BroodLeg[]
  lights: number[]
  flash: number
  position: Vec
  direction: Vec
  speed: number
  sockets: Array<{ id: string, screen: Vec }>
  dead: boolean
  settled: boolean
  hit?: { sourceClip: string, sourceTime: number, sourceClock: number, duration: number, complete: boolean, rock: number, lightGate: number }
  deathSource?: BroodState
  debris?: BroodDebris[]
}

export interface BroodOptions {
  direction?: Vec
  seed?: number
  clock?: number
  fromPose?: BroodState | null
  sourceClip?: string
  sourceTime?: number
}

/** The package's `sample`. */
export function sample (clip = 'idle', time = 0, options: BroodOptions = {}): BroodState {
  const { direction = { x: 0, y: 1 }, seed = CONFIG.seed, clock = time, fromPose = null, sourceClip = 'idle', sourceTime = 0 } = options
  if (clip === 'death' && fromPose !== null) return deathFromPose(time, fromPose)
  if (clip === 'hit') return hitPose(time, { fromPose, sourceClip, sourceTime, direction, seed, clock: options.clock ?? sourceTime })
  if (CLIPS[clip] === undefined) throw Error('Unknown clip ' + clip)
  const t = Math.max(0, time)
  const moving = clip === 'move'
  const n = Math.hypot(direction.x, direction.y) || 1
  const dir = { x: direction.x / n, y: direction.y / n }
  const speed = moving ? CONFIG.stride / (CONFIG.duty * CONFIG.period) : 0
  let lift = 0.5 * Math.sin(clock * TAU / 3.9)
  let angle = 0.003 * Math.sin(clock * TAU / 7.8)
  let x = 0
  let flash = 0
  if (moving) { lift = 0.65 * Math.sin(t * TAU / CONFIG.period * 2); angle = 0.0035 * Math.sin(t * TAU / CONFIG.period) }
  if (clip === 'spawn') {
    const engage = smooth(t / 0.1)
    const rest = smooth((t - 0.6) / 0.35)
    lift *= 1 - engage * (1 - rest)
    angle *= 1 - engage * (1 - rest)
    if (t < 0.12) lift -= 2.2 * smooth(t / 0.12)
    else if (t < 0.2) lift = mix(-2.2, 3.7, smooth((t - 0.12) / 0.08))
    else if (t < 0.7) lift += 3.7 * Math.exp(-7 * (t - 0.2)) * Math.cos((t - 0.2) * 16) * (1 - smooth((t - 0.48) / 0.22))
    x = 0.55 * Math.sin(t * 24) * smooth(t / 0.12) * (1 - smooth((t - 0.3) / 0.25))
    flash = smooth(t / 0.1) * (1 - smooth((t - 0.32) / 0.43))
  }
  if (clip === 'death') { lift = -4 * smooth(t / 0.22); angle = -0.025 * smooth(t / 0.22) }
  const body: Body = { x, lift, angle }
  const legs = LEG_DEFS.map((l): BroodLeg => {
    const phase = wrap(t / CONFIG.period + l.phase)
    const contact = !moving || phase < CONFIG.duty
    const q = contact ? phase / CONFIG.duty : (phase - CONFIG.duty) / (1 - CONFIG.duty)
    const offset = moving ? (contact ? CONFIG.stride * (0.5 - q) : CONFIG.stride * (smooth(q) - 0.5)) : 0
    const worldFoot = { x: l.home.x + dir.x * offset, y: l.home.y + dir.y * offset, z: moving && !contact ? CONFIG.lift * Math.sin(Math.PI * q) ** 2 : 0 }
    const foot = project(worldFoot)
    const hip = bodyPoint(l.hip, body)
    const knee = kneeFor(hip, foot, l)
    return { ...l, hip, knee, foot, worldFoot, phase, contact }
  })
  const lights = Array.from({ length: 11 }, (_, i) => {
    if (clip === 'death') return twinkle(i, clock, seed) * (1 - smooth((t - 0.06) / 0.18))
    return mix(twinkle(i, clock, seed), 1, flash)
  })
  if (clip === 'death' && t >= 0.22) Object.assign(body, deathBodyMotion(t))
  const sockets = ART.body.sockets.map((s) => ({ id: s.id, screen: bodySourcePoint(s, body) }))
  return { clip, time: t, clock, seed, body, legs, lights, flash, position: { x: dir.x * speed * t, y: dir.y * speed * t }, direction: dir, speed, sockets, dead: clip === 'death' && t >= 0.22, settled: clip === 'death' && t >= 2.6 }
}

/** The package's `segmentMatrix`: reflects the art about the hip-to-knee (knee-to-foot) axis when `mirror`. */
export function segmentMatrix (a: Vec, b: Vec, shape: { start: Vec, end: Vec }, mirror = false): SegmentMatrix {
  const ax = shape.end.x - shape.start.x
  const ay = shape.end.y - shape.start.y
  const al = Math.hypot(ax, ay)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dl = Math.hypot(dx, dy)
  const s = dl / al
  const ux = ax / al
  const uy = ay / al
  const tx = dx / dl
  const ty = dy / dl
  const sign = mirror ? -1 : 1
  const A = s * (tx * ux + sign * ty * uy)
  const B = s * (ty * ux - sign * tx * uy)
  const C = s * (tx * uy - sign * ty * ux)
  const D = s * (ty * uy + sign * tx * ux)
  return { a: A, b: B, c: C, d: D, x: a.x - A * shape.start.x - C * shape.start.y, y: a.y - B * shape.start.x - D * shape.start.y, scale: s, angle: Math.atan2(dy, dx) - Math.atan2(ay, ax) }
}

/** One intact shell: short drop, tiny impact bounce, then a restrained roll. */
export function deathBodyMotion (time: number): Body {
  const t = Math.max(0, time - 0.22)
  const fall = clamp(t / 0.48)
  const roll = smooth((t - 0.48) / 0.78)
  const bounce = t >= 0.48 && t < 0.78 ? 1.5 * Math.sin(Math.PI * (t - 0.48) / 0.30) : 0
  return { x: 7 * roll, lift: -4 - 28 * fall * fall + bounce, angle: -0.025 + 0.10 * roll }
}

function particle (start: Vec, id: number, t: number): BroodDebris['motion'] {
  const groundY = start.y * 0.13
  const z0 = CONFIG.tilt * groundY - start.y
  const vz = 12 + hash(id, 31) * 35
  const g = 280
  const hit = (vz + Math.sqrt(vz * vz + 2 * g * Math.max(z0, 1))) / g
  const elapsed = Math.max(0, t)
  const bounceV = Math.sqrt(vz * vz + 2 * g * Math.max(z0, 1)) * 0.14
  const bounceDuration = 2 * bounceV / g
  const settle = hit + bounceDuration
  let z: number
  if (elapsed < hit) z = z0 + vz * elapsed - g * elapsed * elapsed / 2
  else if (elapsed < settle) { const b = elapsed - hit; z = bounceV * b - g * b * b / 2 } else z = 0
  const a = hash(id, 79) * TAU
  const vx = Math.cos(a) * (20 + hash(id, 46) * 50)
  const vy = Math.sin(a) * (17 + hash(id, 64) * 37)
  const flight = Math.min(elapsed, hit)
  const after = Math.max(0, Math.min(elapsed, settle) - hit)
  const travel = flight + (1 - Math.exp(-8 * after)) / 8
  return { x: start.x + vx * travel, y: (groundY + vy * travel) * CONFIG.tilt - Math.max(0, z), groundY: (groundY + vy * travel) * CONFIG.tilt, angle: (hash(id, 72) - 0.5) * 5 * Math.min(elapsed, settle), settled: elapsed >= settle }
}

/** The package's `deathParts`: the shell and twelve links, in the order drawn. */
export function deathParts (p: BroodState): BroodDebris[] {
  const atBreak = p.deathSource !== undefined ? deathFromPose(0.22, p.deathSource) : sample('death', 0.22, { seed: p.seed, clock: 0.22 })
  const t = p.time - 0.22
  const out: BroodDebris[] = []
  const body = p.deathSource !== undefined ? p.body : deathBodyMotion(p.time)
  out.push({ type: 'body', body, center: { x: 0, y: -81 }, motion: { x: body.x, groundY: 3 }, id: 0 })
  for (const l of atBreak.legs) {
    for (const [j, part, a, b] of [[0, 'upper', l.hip, l.knee], [1, 'lower', l.knee, l.foot]] as const) {
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const id = 20 + l.index * 2 + j
      out.push({ type: 'leg', part, m: segmentMatrix(a, b, ART[part], l.mirror), center, motion: particle(center, id, t), id })
    }
  }
  const blend = smooth(t / 0.55)
  const order = (d: BroodDebris): number => d.type === 'body' ? d.center.y : (d.id < 26 ? -220 : 150)
  return out.sort((a, b) => mix(order(a), a.motion.groundY, blend) - mix(order(b), b.motion.groundY, blend))
}

/** The package's `hitPose`: from an idle or move pose, the gait and the lamp clock paused. */
export function hitPose (time: number, { fromPose = null, sourceClip = 'idle', sourceTime = 0, direction = { x: 0, y: 1 }, seed = CONFIG.seed, clock = sourceTime }: BroodOptions = {}): BroodState {
  const base = fromPose ?? sample(sourceClip, sourceTime, { direction, seed, clock })
  if (!['idle', 'move'].includes(base.clip)) throw Error('Hit supports idle and move only; queue during spawn.')
  const t = clamp(time, 0, 0.72)
  const p = deepClone(base)
  const keys = [[0, 0], [0.085, 1], [0.21, -0.38], [0.36, 0.17], [0.52, -0.045], [0.72, 0]]
  let rock = 0
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) { const [a, x] = keys[i - 1]; const [b, y] = keys[i]; rock = mix(x, y, smooth((t - a) / (b - a))); break }
  }
  p.clip = 'hit'
  p.time = Math.max(0, time)
  p.speed = 0
  p.body.angle += 0.045 * rock
  p.body.lift -= 2.7 * rock
  p.legs = p.legs.map((l, i) => { const hip = bodyPoint(LEG_DEFS[i].hip, p.body); return { ...l, hip, knee: kneeFor(hip, l.foot, l) } })
  const gate = t < 0.045 ? 1 - smooth(t / 0.045) : t < 0.13 ? 0 : t < 0.18 ? 0.32 * smooth((t - 0.13) / 0.05) : t < 0.23 ? 0.32 * (1 - smooth((t - 0.18) / 0.05)) : smooth((t - 0.23) / 0.24)
  p.lights = base.lights.map((v) => v * gate)
  p.sockets = ART.body.sockets.map((s) => ({ id: s.id, screen: bodySourcePoint(s, p.body) }))
  p.hit = { sourceClip: base.clip, sourceTime: base.time, sourceClock: base.clock, duration: 0.72, complete: t === 0.72, rock, lightGate: gate }
  return p
}

/** The package's `deathFromPose` (opt-in, provisional in v15): the death from a captured live pose. */
export function deathFromPose (time: number, source: BroodState): BroodState {
  if (source.dead) throw Error('Capture a live pose for death')
  const t = Math.max(0, time)
  const p = deepClone(source)
  const u = smooth(t / 0.22)
  p.clip = 'death'
  p.time = t
  p.speed = 0
  p.dead = t >= 0.22
  p.settled = t >= 2.6
  p.deathSource = deepClone(source)
  p.body = { x: source.body.x, lift: source.body.lift - 4 * u, angle: source.body.angle - 0.025 * u }
  const breakBody = { x: source.body.x, lift: source.body.lift - 4, angle: source.body.angle - 0.025 }
  p.legs = p.legs.map((l, i) => { const hip = bodyPoint(LEG_DEFS[i].hip, t >= 0.22 ? breakBody : p.body); return { ...l, hip, knee: kneeFor(hip, l.foot, l) } })
  p.lights = source.lights.map((v) => v * (1 - smooth((t - 0.06) / 0.18)))
  if (t >= 0.22) {
    const d = deathBodyMotion(t)
    p.body = { x: source.body.x + d.x, lift: source.body.lift + d.lift, angle: source.body.angle + d.angle }
  }
  p.sockets = ART.body.sockets.map((s) => ({ id: s.id, screen: bodySourcePoint(s, p.body) }))
  return p
}

/** The package's `evaluatePose`: `sample` with its debris. */
export function evaluatePose (clip: string, time: number, options: BroodOptions = {}): BroodState {
  const p = sample(clip, time, options)
  return { ...p, debris: p.dead ? deathParts(p) : [] }
}

// --- drawBrood ---

const translate = (x: number, y: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, x, y })
const rotation = (r: number): Matrix => ({ a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), x: 0, y: 0 })
const apply = (m: Matrix, x: number, y: number): number[] => [m.a * x + m.c * y + m.x, m.b * x + m.d * y + m.y]

/** The lamp polygons (`tools/bake-effects.mjs`): `light0`-`light4` on the body art, `light5` on each lower leg's. */
const LAMPS: ReadonlyArray<readonly Vec[]> = [...ART.body.lamps, ART.lower.lamp]

/**
 * A lamp lit at the atlas frame the package picks (`emission`:
 * `round(clamp(intensity) * 256)`, nothing at 0), as the bake draws that
 * frame: a glow (a radial gradient there: three flat discs here, `approx`),
 * the lens, and above 0.6 its core, through `m` (the art's pixels to rig units).
 */
function lamp (out: NpcDrawItem[], m: Matrix, index: number, intensity: number): void {
  const n = Math.round(clamp(intensity) * 256)
  if (n === 0) return
  const i = n / 256
  const ps = LAMPS[index]
  const cx = ps.reduce((a, p) => a + p.x, 0) / ps.length
  const cy = ps.reduce((a, p) => a + p.y, 0) / ps.length
  const r = Math.max(...ps.map((p) => Math.hypot(p.x - cx, p.y - cy)))
  for (const k of [1, 0.66, 0.33]) {
    const points: number[] = []
    for (let s = 0; s < 16; s++) points.push(...apply(m, cx + Math.cos(s * TAU / 16) * r * 2.3 * k, cy + Math.sin(s * TAU / 16) * r * 2.3 * k))
    out.push({ kind: 'polygon', points, color: 0xff9e41, alpha: i * 0.33 / 3, approx: true })
  }
  out.push({ kind: 'polygon', points: ps.flatMap((p) => apply(m, p.x, p.y)), color: (255 << 16) | (Math.round(172 + 64 * i) << 8) | Math.round(76 + 91 * i), alpha: i * 0.97 })
  if (i > 0.6) out.push({ kind: 'polygon', points: ps.flatMap((p) => apply(m, p.x + (cx - p.x) * 0.25, p.y + (cy - p.y) * 0.25)), color: 0xfff8c2, alpha: (i - 0.6) * 1.6 })
}

function bodyMatrix (body: Body): Matrix {
  const s = ART.body.scale
  const m = multiply(multiply(translate(body.x, -85 - body.lift), rotation(body.angle)), translate(0, 85))
  return multiply(m, { a: s, b: 0, c: 0, d: s, x: -ART.body.pivot.x * s, y: ART.body.baseline - ART.body.pivot.y * s })
}

function drawBody (out: NpcDrawItem[], body: Body, lights: readonly number[]): void {
  const m = bodyMatrix(body)
  out.push({ kind: 'image', art: 'body', m })
  for (let i = 0; i < ART.body.lamps.length; i++) lamp(out, m, i, lights[i])
}

function drawLeg (out: NpcDrawItem[], l: BroodLeg, lights: readonly number[]): void {
  for (const [id, a, b] of [['upper', l.hip, l.knee], ['lower', l.knee, l.foot]] as const) {
    const m = segmentMatrix(a, b, ART[id], l.mirror)
    out.push({ kind: 'image', art: id, m })
    if (id === 'lower') {
      out.push({ kind: 'image', art: 'lowerOff', m })
      lamp(out, m, 5, lights[l.index + 5])
    }
  }
  const r = 6
  const joint = (p: Vec): Matrix => ({ a: r * 2 / ART.joint.w, b: 0, c: 0, d: r * 2 / ART.joint.h, x: p.x - r, y: p.y - r })
  out.push({ kind: 'image', art: 'joint', m: joint(l.hip) })
  out.push({ kind: 'image', art: 'joint', m: joint(l.knee) })
}

function shadow (x: number, y: number, rx: number, ry: number, css: string): NpcEllipse {
  const { color, alpha } = cssColour(css)
  return { kind: 'ellipse', x, y, rx: Math.max(0.01, rx), ry: Math.max(0.01, ry), color, alpha }
}

/** The package's `drawBrood` at 0,0 and scale 1 (no contacts, no cutaway), as a draw list. */
export function draw (p: BroodState): NpcDrawList {
  const ground: NpcEllipse[] = []
  const items: NpcDrawItem[] = []
  if (p.dead) {
    const debris = p.debris ?? deathParts(p)
    for (const d of debris) ground.push(shadow(d.motion.x, d.motion.groundY + 3, d.type === 'body' ? 76 : 9, d.type === 'body' ? 36 : 4, '#06101b44'))
    for (const d of debris) {
      if (d.type === 'body') { drawBody(items, d.body!, p.lights); continue }
      const at = multiply(multiply(translate(d.motion.x, d.motion.y!), rotation(d.motion.angle!)), translate(-d.center.x, -d.center.y))
      const m = multiply(at, d.m!)
      items.push({ kind: 'image', art: d.part!, m })
      if (d.part === 'lower') items.push({ kind: 'image', art: 'lowerDead', m })
    }
    return { ground, items }
  }
  ground.push(shadow(0, 3, 83, 46, '#07132055'))
  for (const l of p.legs) {
    const f = project({ ...l.worldFoot, z: 0 })
    ground.push(shadow(f.x, f.y + 2, 7, 3, l.contact ? '#07101c55' : '#07101c22'))
  }
  for (const l of p.legs.filter((l) => !l.front)) drawLeg(items, l, p.lights)
  // Foreground legs start at the lower sockets and lie in front of the torso.
  drawBody(items, p.body, p.lights)
  for (const l of p.legs.filter((l) => l.front)) drawLeg(items, l, p.lights)
  return { ground, items }
}

/** The rig units from the ground to the top of the sphere's art at rest (`bodyMatrix` with no lift). */
const REFERENCE_UNITS = ART.body.pivot.y * ART.body.scale - ART.body.baseline

export const BROOD_RIG: NpcRig = Object.freeze({
  key: 'brood' as const,
  clips: CLIPS,
  // Nick, 2026-10-07: 206% of its own rig (ideas/npc-roster.md; the package's reviewGameScale 0.824 is 0.4 x 2.06).
  // Nick, 2026-10-09 (size review): 2.06 -> 3.2; the gait follows (`gaitClock`); the sheet is re-baked at it (`bake-npc-atlas.py`).
  sizeScale: 3.2,
  referenceUnits: REFERENCE_UNITS,
  deathHolds: true,
  gait: GAIT,
  roles: Object.freeze({
    idle: 'idle',
    move: 'move',
    // The release (effect 19), started on its `spawn` event, the launch, so
    // the Broodling's emerge (played on the same effect) starts with it. The
    // package queues a hit during it; hits are an overlay here (#52).
    attack: Object.freeze({ clip: 'spawn', event: SPAWN_EVENT }),
    hit: 'hit',
    // From the pose shown (the package's captured death, opt-in in v15), a release's included.
    death: Object.freeze({ clip: 'death', from: 0, fromAction: true })
  }),
  pose: (clip: string, seconds: number, direction: Vec, _aim?: Vec, from?: NpcPose, options?: NpcPoseOptions): NpcPose => {
    const clock = options?.clock
    const base = from?.state as BroodState | undefined
    let state: BroodState
    if (clip === 'hit') {
      // From idle or move only (`NpcSprite` refuses a hit over the release); never throw in a frame.
      const source = base !== undefined && (base.clip === 'idle' || base.clip === 'move') ? base : sample('idle', 0, { clock })
      state = hitPose(seconds, { fromPose: source })
    } else if (clip === 'death') {
      // A hit's pose is captured with the rest; a pose never drawn, or a dead one, takes the package's default.
      state = evaluatePose('death', seconds, base !== undefined && !base.dead ? { fromPose: base } : {})
    } else {
      state = sample(clip, seconds, clip === 'move' ? { direction, clock } : { clock })
    }
    return { clip, time: seconds, state }
  },
  draw: (p: NpcPose): NpcDrawList => draw(p.state as BroodState),
  arts: ARTS
})
