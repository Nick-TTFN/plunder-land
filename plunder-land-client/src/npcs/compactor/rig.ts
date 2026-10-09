import { type Matrix } from '../../peep/rig'
import { type NpcClip, type NpcDrawList, type NpcGait, type NpcImage, type NpcPose, type NpcRig } from '../npcrig'

/**
 * The Compactor (l1-9): a hand port of `tools/rig.mjs`, `tools/rig-core.mjs`
 * and `tools/piston.mjs` in its Codex package
 * (`codex_output/npc-refinements/compactor-v4`, not checked in).
 * **PROVISIONAL**: v4 (the painted piston, the hit and the fall apart) is
 * delivered but not yet approved by Nick (v3 was); a re-sync after his review
 * is expected (`tools/npc-rig-sync.mjs compactor`, `tools/bake-npc-atlas.py
 * compactor`).
 *
 * Four legs on IK under a chassis that never turns, and a piston under it:
 * `fire` is the strike (latch release at 1.15 s, the shoe on the floor at
 * 1.215 s, the `attack` event). `rig-core.mjs` is the packages' shared NPC
 * core; only the Compactor's path through it is ported (four legs, the
 * `compactor` body, the `piston` tool, the `slam` attack), and not its
 * `NpcController` (stateful foot planting: the game plays the stateless
 * clips, as for every rig). `npcrigs.spec.ts` checks the evaluator and every
 * drawn sprite against the package (`compactor.fixtures.json`).
 */

const TAU = Math.PI * 2

/** From `rig/animation-manifest.json`. */
export const CLIPS: Readonly<Record<string, NpcClip>> = Object.freeze({
  idle: { duration: 8.4, loop: true, events: [] },
  run: { duration: 1.35, loop: true, events: [] },
  fire: { duration: 3.6, loop: false, events: [{ time: 1.215, name: 'attack' }] },
  hit: { duration: 0.72, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: { duration: 2.8, loop: false, events: [{ time: 0.12, name: 'detach' }, { time: 2.8, name: 'settled' }] }
})

// --- piston.mjs ---

const STRIKE_DURATION = 3.6
const RELEASE_TIME = 1.15
export const IMPACT_TIME = 1.215
const COG_PITCH_RADIUS = 12.5
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const smooth01 = (n: number): number => { const t = clamp01(n); return t * t * (3 - 2 * t) }
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

const STRIKE_KEYS = [[0, 2], [0.04, -7], [0.085, -7], [0.16, 3.8], [0.25, -1.7], [0.36, 0.65], [0.50, 0]]

function strikeState (seconds: number): { time: number, sole: number, bodyOffset: number, compression: number, phase: string, contact: boolean, windup: number } {
  const t = Math.max(0, Math.min(STRIKE_DURATION, seconds))
  let sole = 10
  let bodyOffset = 0
  let phase = 'Ready'
  if (t < 0.75) { const q = smooth01(t / 0.75); sole = mix(10, 21, q); bodyOffset = -2 * q; phase = 'Compress / preload' } else if (t < RELEASE_TIME) { sole = 21; bodyOffset = -2; phase = 'Latched' } else if (t < IMPACT_TIME) { const q = (t - RELEASE_TIME) / (IMPACT_TIME - RELEASE_TIME); sole = 21 * Math.cos(q * Math.PI / 2); bodyOffset = mix(-2, 2, smooth01(q)); phase = 'Spring release' } else {
    const age = t - IMPACT_TIME
    // Downward reaction, a short held compression, then two diminishing rebounds.
    bodyOffset = 0
    for (let i = 1; i < STRIKE_KEYS.length; i++) if (age < STRIKE_KEYS[i][0]) { const a = STRIKE_KEYS[i - 1]; const b = STRIKE_KEYS[i]; bodyOffset = mix(a[1], b[1], smooth01((age - a[0]) / (b[0] - a[0]))); break }
    if (t < 1.75) { sole = 0; phase = age < 0.085 ? 'Impact / compression' : 'Damped recoil' } else if (t < 3.10) { sole = 10 * smooth01((t - 1.75) / 1.35); phase = 'Slow withdrawal' }
  }
  return { time: t, sole, bodyOffset, compression: Math.max(0, -bodyOffset), phase, contact: sole === 0, windup: t < RELEASE_TIME ? smooth01(t / 0.75) : 1 - smooth01((t - RELEASE_TIME) / 0.065) }
}

export interface PistonState {
  x: number, y: number, sole: number, shoeTop: number, shoeWidth: number, shoeDepth: number, shoeThickness: number
  guideBottom: number, shaftTop: number, shaftBottom: number, extension: number, cogAngle: number, cogCenterZ: number, cogPitchRadius: number
  phase: string, contact: boolean
}

function pistonState (body: { x: number, y: number, z: number }, animation: { name: string, time: number }): PistonState {
  const strike = animation.name === 'fire' ? strikeState(animation.time) : null
  const sole = strike !== null ? strike.sole : 10 + (body.z - 42) * 0.45
  // Rack travel is measured relative to the chassis: recoil rocks the cog even with the shoe pinned.
  const extension = (body.z - 8) - (sole + 10)
  const cogAngle = (14 - extension) / COG_PITCH_RADIUS
  return {
    x: body.x,
    y: body.y + 30,
    sole,
    shoeTop: sole + 10,
    shoeWidth: 58,
    shoeDepth: 32,
    shoeThickness: 10,
    guideBottom: body.z - 8,
    shaftTop: body.z + 2,
    shaftBottom: sole + 8,
    extension,
    cogAngle,
    cogCenterZ: body.z + 2,
    cogPitchRadius: COG_PITCH_RADIUS,
    phase: strike?.phase ?? 'Suspended',
    contact: strike?.contact ?? false
  }
}

// --- rig-core.mjs, the Compactor's profile only ---

const PROFILE = Object.freeze({ legs: 4, body: 'compactor', width: 116, height: 42, kind: 'slam', run: 1.35, power: 1.3 })
const TRIGGER = IMPACT_TIME
const DUTY = 0.79
export const CONFIG = Object.freeze({ tilt: 0.68, bodyHeight: PROFILE.height, upperLength: 48, lowerLength: 70, stride: 20, duty: DUTY, nominalSpeed: 20 / DUTY / PROFILE.run, lift: 12 })

/**
 * The game's gait (decision #52 lane 4, the Crawler's treatment; PROVISIONAL
 * until Nick has seen it), at the package's own stride. The package's walk
 * slid 94% at the chase's 100 u/s (strand B). Its feet already stand at 0.83
 * of the leg's reach at rest and the package's walk takes them to 0.897, so
 * no longer stride stays under the Crawler's 0.9 rule. `gaitClock` derives
 * the rate from that sweep and the size: planted feet at the chase's 100 u/s
 * would need 10.3 steps a second per leg at size 1.78 (size review,
 * 2026-10-09; 18.3 at 1); `maxSteps` holds it at 6, so at chase the feet
 * slide 42% (67% at 1), along the motion only; under 58 u/s, idle wander
 * (30 u/s, 3.1 steps) included, they stay planted. `minPace` and
 * `groundTilt` as the Crawler's.
 */
export const GAIT: NpcGait = Object.freeze({ groundSpeed: CONFIG.nominalSpeed, period: PROFILE.run, maxSteps: 6, minPace: 0.2, groundTilt: CONFIG.tilt })

interface Vec { x: number, y: number }
interface Vec3 { x: number, y: number, z: number }
interface Foot extends Vec3 { contact: boolean }

interface LegDef { id: string, side: number, row: number, phase: number, home: Vec, hip: Vec }

const LEGS: readonly LegDef[] = (() => {
  const out: LegDef[] = []
  for (const side of [-1, 1]) {
    for (const row of [-1, 1]) {
      const index = out.length
      out.push({ id: `leg_${side}_${row}`, side, row, phase: [0, 0.25, 0.5, 0.75][index], home: { x: side * (112), y: row * (72) }, hip: { x: side * (row > 0 ? 57 : 38), y: row * 24 } })
    }
  }
  return out
})()

const rotate = (p: Vec, r: number): Vec => ({ x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) })
interface Layout { heading: number, segments: Array<{ x: number, y: number, r: number }> }
const defaultFrame = (heading = 0): Layout => ({ heading, segments: Array.from({ length: 5 }, (_, i) => ({ ...rotate({ x: 0, y: -42 * i }, heading), r: heading })) })
function placement (l: LegDef, frame: Layout): { home: Vec, hip: Vec } {
  const seg = { x: 0, y: 0, r: frame.heading }
  const h = rotate(l.home, seg.r)
  const hip = rotate(l.hip, seg.r)
  return { home: { x: h.x + seg.x, y: h.y + seg.y }, hip: { x: hip.x + seg.x, y: hip.y + seg.y } }
}

const ART = Object.freeze({
  compactor: { w: 476, h: 231 },
  upper: { w: 570, h: 242, start: { x: 76, y: 141 }, end: { x: 505, y: 141 } },
  lower: { w: 653, h: 232, start: { x: 76, y: 123 }, end: { x: 622, y: 207 } },
  joint: { w: 300, h: 305 }
})

const project = (p: Vec3): Vec => ({ x: p.x, y: p.y * CONFIG.tilt - p.z })
const ease = (t: number): number => t * t * (3 - 2 * t)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const angleDelta = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const normalized = (x: number, y: number): Vec => { const d = Math.hypot(x, y); return d > 1e-8 ? { x: x / d, y: y / d } : { x: 0, y: 0 } }
const wrap = (x: number): number => ((x % 1) + 1) % 1
const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x))

function segmentMatrix (start: Vec, end: Vec, shape: { start: Vec, end: Vec }): Matrix {
  const a = shape.start
  const b = shape.end
  const dx = end.x - start.x
  const dy = end.y - start.y
  const sc = Math.hypot(dx, dy) / Math.hypot(b.x - a.x, b.y - a.y)
  const r = Math.atan2(dy, dx) - Math.atan2(b.y - a.y, b.x - a.x)
  const ca = Math.cos(r) * sc
  const si = Math.sin(r) * sc
  return { a: ca, b: si, c: -si, d: ca, x: start.x - ca * a.x + si * a.y, y: start.y - si * a.x - ca * a.y }
}

function solveLeg (hip: Vec3, foot: Vec3): Vec3 & { reach: number } {
  const dx = foot.x - hip.x
  const dy = foot.y - hip.y
  const dz = foot.z - hip.z
  const actual = Math.hypot(dx, dy, dz)
  const d = Math.max(0.001, Math.min(CONFIG.upperLength + CONFIG.lowerLength - 0.001, actual))
  const ux = dx / actual
  const uy = dy / actual
  const uz = dz / actual
  const horizontal = Math.max(0.001, Math.hypot(dx, dy))
  const nx = -uz * dx / horizontal
  const ny = -uz * dy / horizontal
  const nz = horizontal / actual
  const a = (CONFIG.upperLength ** 2 - CONFIG.lowerLength ** 2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, CONFIG.upperLength ** 2 - a * a))
  return { x: hip.x + ux * a + nx * h, y: hip.y + uy * a + ny * h, z: hip.z + uz * a + nz * h, reach: actual }
}

const windowPulse = (t: number, start: number, end: number): number => t > start && t < end ? Math.sin(Math.PI * (t - start) / (end - start)) ** 2 : 0

export interface Presence {
  x: number, y: number, z: number, pitch: number, roll: number, sensorX: number, sensorY: number, focus: number, glow: number
  idleTime?: number, idleWeight?: number, expression?: number, attack?: number, charge?: number, dead?: boolean
}

interface Performance { idleTime?: number, idleWeight?: number, phase?: number, speed?: number, velocity?: Vec, expression?: number }

function presencePose (time: number, { idleTime = time, idleWeight = 1, phase = 0, speed = 0, velocity = { x: 0, y: 0 }, expression = 1 }: Performance = {}): Presence {
  const t = wrap(idleTime / CLIPS.idle.duration) * CLIPS.idle.duration
  const breathe = Math.sin(TAU * t / 2.8)
  const inspect = windowPulse(t, 1.35, 4.8)
  const settle = windowPulse(t, 6.35, 8.15)
  const right = windowPulse(t, 1.8, 3.1)
  const left = windowPulse(t, 3.15, 4.65)
  const weight = windowPulse(t, 4.75, 6.45)
  const amount = Math.max(0, Math.min(1.5, expression))
  const w = idleWeight * amount * 0.24
  const effort = Math.min(1, speed / CONFIG.nominalSpeed)
  const runWeight = 1 - idleWeight
  return {
    x: w * (2.8 * Math.sin(TAU * t / 8.4) + 2.2 * (right - left) - 3.2 * weight) + runWeight * amount * velocity.x / CONFIG.nominalSpeed * 0.9,
    y: w * (1.4 * Math.sin(TAU * t / 4.2) - 1.8 * inspect),
    z: idleWeight * 0.65 * breathe + w * (1.6 * breathe + 4.4 * inspect - 3.6 * settle) + runWeight * (1 + amount * 0.75) * Math.sin(TAU * phase * 2) * effort,
    pitch: w * (0.035 * inspect - 0.028 * settle),
    roll: w * (0.028 * (right - left) - 0.025 * weight),
    sensorX: w * (2.2 * (right - left)) + runWeight * amount * velocity.x / CONFIG.nominalSpeed * 1.2,
    sensorY: w * (-1.15 * inspect) + runWeight * amount * velocity.y / CONFIG.nominalSpeed * 0.7,
    focus: 1 - 0.8 * w * windowPulse(t, 6.8, 7.2),
    glow: 0.7 + 0.3 * Math.sin(TAU * time / 2.8) + w * 0.35 * inspect,
    idleTime: t,
    idleWeight,
    expression: amount
  }
}

export interface CompactorLeg extends LegDef {
  hip: Vec3
  knee: Vec3 & { reach: number }
  foot: Foot
  contact: boolean
  screen: { hip: Vec, knee: Vec, foot: Vec }
}

interface Region {
  name: string
  bone: string
  art?: string
  leg?: string
  depth?: string
  clip?: { x: number, y: number, w: number, h: number }
  sensor?: unknown
  custom?: string
  data?: unknown
  pivot?: Vec
  flat?: boolean
}

export interface Sprite {
  id: string
  art: string
  matrix: Matrix
  clip?: { x: number, y: number, w: number, h: number }
  assembly: string
  opacity: number
  effect?: boolean
}

/** The package's whole pose: `evaluate()`'s return. Only `state` is compared field by field; the sprites through what they draw. */
export interface CompactorPose {
  state: CompactorState
  matrices: Record<string, Matrix>
  regions: Region[]
  sprites?: Sprite[]
}

export interface CompactorState {
  root: { x: number, y: number, r: number }
  body: { x: number, y: number, z: number, r: number, pitch: number, roll: number }
  layout: Layout
  presence: Presence
  animation: { name: string, time: number, phase: number }
  legs: CompactorLeg[]
  parts: Array<{ id: string, pivot: Vec, height: number, radius: number }>
  controls: { bodyRotation: number, speed: number }
  turret: { angle: number, center: Vec3, tip: Vec3, muzzle: Vec }
  piston: PistonState
  aim: Vec
  effects?: Record<string, unknown> | null
  position?: Vec
  hit?: { returnClip: string, phaseFrozen: boolean, judder: number }
  death?: { time: number, bodyPieces: number, legPieces: number, settled: boolean, assemblies: unknown[], cogAngle?: number }
}

const SENSOR = Object.freeze({ x: 0.499, y: 0.442, rx: 0.035, ry: 0.069 })

interface PoseExtras { presenceOverride?: Presence, layout?: Layout, aimAngle?: number, velocity?: Vec, expression?: number }

/** `composePose` for the Compactor: legs on IK, the body, the piston. */
function composePose (name: string, time: number, feet: Foot[], phase = 0, speed = 0, performance: PoseExtras = {}): CompactorPose {
  const presence = performance.presenceOverride ?? presencePose(time, { idleWeight: name === 'idle' ? 1 : 0, phase, speed, velocity: performance.velocity, expression: performance.expression })
  const layout = performance.layout ?? defaultFrame()
  const bodyZ = CONFIG.bodyHeight + presence.z
  const state: CompactorState = {
    root: { x: 0, y: 0, r: layout.heading },
    body: { x: presence.x, y: presence.y, z: bodyZ, r: layout.heading, pitch: presence.pitch, roll: presence.roll },
    layout,
    presence,
    animation: { name, time, phase },
    legs: [],
    parts: [],
    controls: { bodyRotation: layout.heading, speed }
  } as unknown as CompactorState
  const matrices: Record<string, Matrix> = {}
  const regions: Region[] = []
  LEGS.forEach((l, i) => {
    const loc = placement(l, layout)
    const hip = { x: loc.hip.x + presence.x, y: loc.hip.y + presence.y, z: bodyZ - 3 + 0 + l.hip.y * presence.pitch + l.hip.x * presence.roll }
    const foot = feet[i]
    const knee = solveLeg(hip, foot)
    const hp = project(hip)
    const kp = project(knee)
    const fp = project(foot)
    matrices[l.id + '_upper'] = segmentMatrix(hp, kp, ART.upper); matrices[l.id + '_lower'] = segmentMatrix(kp, fp, ART.lower); matrices[l.id + '_joint'] = { a: 15 / ART.joint.w, b: 0, c: 0, d: 15 / ART.joint.h, x: kp.x - 7.5, y: kp.y - 7.5 }
    state.legs.push({ ...l, hip, knee, foot: { ...foot }, contact: foot.contact, screen: { hip: hp, knee: kp, foot: fp } })
  })
  const front = state.legs.filter((l) => l.row > 0)
  const rear = state.legs.filter((l) => l.row < 0)
  for (const l of rear) for (const part of ['upper', 'lower', 'joint']) regions.push({ name: l.id + '_' + part, bone: l.id + '_' + part, art: part, leg: l.id, depth: 'rear' })
  for (const l of front) regions.push({ name: l.id + '_root', bone: l.id + '_upper', art: 'upper', leg: l.id, depth: 'root', clip: { x: 136, y: 0, w: 434, h: 242 } })
  const center = { x: presence.x, y: presence.y, z: bodyZ }
  {
    // The body: not flat (it stands up), so roll shears and pitch squashes it.
    const shape = ART.compactor
    const sc = PROFILE.width / shape.w
    const co = Math.cos(0)
    const at = project(center)
    const a = sc * co
    const b = sc * (-presence.roll)
    const c = 0
    const d = sc * (1) * (1 - presence.pitch * 0.5)
    matrices.body = { a, b, c, d, x: at.x - a * shape.w * 0.5 - c * shape.h * 0.5, y: at.y - b * shape.w * 0.5 - d * shape.h * 0.5 }
    regions.push({ name: 'body', bone: 'body', art: 'compactor', pivot: { x: 0.5, y: 0.5 }, flat: false, sensor: SENSOR })
    state.parts.push({ id: 'body', pivot: at, height: center.z, radius: PROFILE.width * 0.35 })
  }
  for (const l of front) {
    const h = l.screen.hip
    matrices[l.id + '_socket'] = { a: 13 / ART.joint.w, b: 0, c: 0, d: 13 / ART.joint.h, x: h.x - 6.5, y: h.y - 6.5 }
    regions.push({ name: l.id + '_socket', bone: l.id + '_socket', art: 'joint', leg: l.id, depth: 'socket' })
    for (const part of ['lower', 'joint']) regions.push({ name: l.id + '_' + part, bone: l.id + '_' + part, art: part, leg: l.id, depth: 'front' })
  }
  const aimAngle = performance.aimAngle ?? -Math.PI / 4
  const idleScan = name === 'idle' ? 0.24 * (windowPulse(presence.idleTime ?? 0, 1.8, 3.1) - windowPulse(presence.idleTime ?? 0, 3.15, 4.65)) : 0
  const angle = aimAngle + idleScan
  const weaponCenter = { x: center.x, y: center.y, z: bodyZ + 23 }
  const tip = { x: weaponCenter.x + Math.cos(angle) * 43, y: weaponCenter.y + Math.sin(angle) * 43, z: weaponCenter.z }
  state.turret = { angle, center: weaponCenter, tip, muzzle: project(tip) }
  state.piston = pistonState(state.body, state.animation)
  // The piston is drawn from its state (`spritePose`): an empty bone.
  matrices.piston = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }
  regions.push({ name: 'piston', bone: 'piston', custom: 'refinedPiston', data: { at: center } })
  state.parts.push({ id: 'piston', pivot: project(center), height: center.z, radius: 17 })
  state.aim = { x: Math.cos(angle), y: Math.sin(angle) }
  return { state, matrices, regions }
}

function pulseCore (t: number, peak: number, end: number): number { return t <= 0 || t >= end ? 0 : t < peak ? ease(t / peak) : 1 - ease((t - peak) / (end - peak)) }

export interface CompactorOptions {
  directionX?: number
  directionY?: number
  aimX?: number
  aimY?: number
  expression?: number
  basePose?: CompactorPose
}

/** The slam's presence: the body follows the stroke (`strikeState`). */
function firePresence (t: number, base: CompactorPose, options: CompactorOptions): { p: Presence, effects: Record<string, unknown>, aim: Vec } {
  const aim = normalized(options.aimX ?? 1, options.aimY ?? -0.5)
  const neutral = presencePose(0)
  const p: Presence = { ...neutral }
  const fade = 1 - ease(clamp(t / 0.22))
  for (const k of ['x', 'y', 'z', 'pitch', 'roll', 'sensorX', 'sensorY', 'focus', 'glow'] as const) p[k] = lerp(neutral[k], base.state.presence[k] ?? neutral[k], fade)
  const duration = CLIPS.fire.duration
  let effects: Record<string, unknown> = { aim, charge: 0, hit: 0 }
  p.attack = 0; p.charge = 0
  const charge = pulseCore(t, TRIGGER * 0.75, TRIGGER + 0.22)
  const impact = pulseCore(t - TRIGGER, 0.06, 0.48)
  const recovery = windowPulse(t, TRIGGER + 0.35, duration - 0.05)
  p.charge = charge; p.attack = impact
  p.z += (-4.3 * charge - 3 * impact + 1.5 * recovery) * ((0.75 + 0.25 * clamp(options.expression ?? 1, 0, 1.5)) * PROFILE.power)
  p.focus -= 0.4 * charge; p.glow += charge * 0.8
  const stroke = strikeState(t)
  p.x = 0; p.y = 0; p.z = stroke.bodyOffset; p.pitch = 0; p.roll = 0; p.attack = 0; p.charge = stroke.windup; p.focus = 1; p.glow = 0.8 + 0.15 * stroke.windup
  effects = { ...effects, charge, impact, attackTime: t - TRIGGER, kind: PROFILE.kind }
  p.focus = clamp(p.focus, 0.06, 1.2)
  return { p, effects, aim }
}

/** The core's `actionPose('fire', ...)`. */
function firePose (seconds: number, options: CompactorOptions): CompactorPose {
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, CLIPS.fire.duration)
  const base = options.basePose ?? coreAnimationPose('idle', 0, options)
  const { p, effects, aim } = firePresence(t, base, options)
  const settle = ease(clamp(t / 0.14))
  const feet = base.state.legs.map((l) => ({ ...l.foot, z: l.foot.z * (1 - settle), contact: l.foot.contact || settle === 1 }))
  const initial = base.state.turret.angle
  const target = Math.atan2(aim.y, aim.x)
  const angle = initial + angleDelta(initial, target) * ease(clamp(t / 0.28))
  const pose = composePose('fire', t, feet, 0, 0, { presenceOverride: p, aimAngle: angle, layout: base.state.layout })
  effects.muzzle = pose.state.turret.muzzle; effects.aim = { x: Math.cos(angle), y: Math.sin(angle) }
  pose.state.effects = effects; pose.state.aim = effects.aim as Vec
  return pose
}

/** The core's stateless `animationPose`: idle, run along `directionX/Y`, or the strike. */
function coreAnimationPose (name: string, seconds: number, options: CompactorOptions = {}): CompactorPose {
  if (name === 'fire') return firePose(seconds, options)
  const clip = CLIPS[name]
  if (clip === undefined) throw Error('Unknown NPC clip: ' + name)
  const t = clip.loop ? wrap(seconds / clip.duration) * clip.duration : seconds
  const dir = normalized(options.directionX ?? 0, options.directionY ?? 1)
  const phase = t / CLIPS.run.duration
  const layout = defaultFrame(0)
  // The idle's toe lift (`idleGesture`) starts at 100 s, past the loop: never in a clip.
  const feet = LEGS.map((l): Foot => {
    const home = placement(l, layout).home
    if (name !== 'run') return { ...home, z: 0, contact: true }
    const p = wrap(phase + l.phase)
    const contact = p < CONFIG.duty
    let s: number
    let z = 0
    if (contact) s = CONFIG.stride / 2 - CONFIG.stride * p / CONFIG.duty
    else { const q = (p - CONFIG.duty) / (1 - CONFIG.duty); s = lerp(-CONFIG.stride / 2, CONFIG.stride / 2, ease(q)); z = CONFIG.lift * Math.sin(Math.PI * q) ** 2 }
    return { x: home.x + dir.x * s, y: home.y + dir.y * s, z, contact }
  })
  return composePose(name, t, feet, phase, name === 'run' ? CONFIG.nominalSpeed : 0, { layout, aimAngle: Math.atan2(options.aimY ?? -1, options.aimX ?? 1), expression: options.expression ?? 1, velocity: { x: dir.x * CONFIG.nominalSpeed, y: dir.y * CONFIG.nominalSpeed } })
}

// --- rig.mjs (v4): the sprites, the hit and the fall apart ---

/** Every part's PNG size and pivot, and pixels per rig unit where not the body's matrices, from `rig/parts.json`. */
export const PARTS: Readonly<Record<string, { readonly w: number, readonly h: number, readonly px: number, readonly py: number, readonly pixelScale?: number }>> = Object.freeze({
  compactor: { w: 476, h: 231, px: 238, py: 115.5 },
  upper: { w: 570, h: 242, px: 76, py: 141 },
  lower: { w: 653, h: 232, px: 76, py: 123 },
  joint: { w: 300, h: 305, px: 150, py: 152.5 },
  shoe: { w: 512, h: 320, px: 256, py: 200, pixelScale: 8 },
  shaft: { w: 128, h: 640, px: 64, py: 600, pixelScale: 8 },
  cog: { w: 320, h: 320, px: 160, py: 160, pixelScale: 8 },
  'cog-back': { w: 320, h: 320, px: 160, py: 160, pixelScale: 8 },
  bearing: { w: 288, h: 288, px: 144, py: 144, pixelScale: 8 },
  'sensor-base': { w: 40, h: 40, px: 20, py: 20 },
  'sensor-lit': { w: 40, h: 40, px: 20, py: 20 },
  'sensor-off': { w: 40, h: 40, px: 20, py: 20 },
  'shoe-shadow': { w: 512, h: 256, px: 256, py: 128, pixelScale: 8 },
  shadow: { w: 128, h: 64, px: 64, py: 32 }
})

const smooth = (n: number): number => { const t = clamp(n); return t * t * (3 - 2 * t) }
const mul = (a: Matrix, b: Matrix): Matrix => ({ a: a.a * b.a + a.c * b.b, b: a.b * b.a + a.d * b.b, c: a.a * b.c + a.c * b.d, d: a.b * b.c + a.d * b.d, x: a.a * b.x + a.c * b.y + a.x, y: a.b * b.x + a.d * b.y + a.y })
const mat = (x: number, y: number, r = 0, s = 1): Matrix => ({ a: Math.cos(r) * s, b: Math.sin(r) * s, c: -Math.sin(r) * s, d: Math.cos(r) * s, x, y })
/** As the package's `clone`: a JSON copy (undefined members dropped). */
const jsonClone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T

function bitmap (id: string, art: string, x: number, y: number, r = 0, assembly = id): Sprite {
  const d = PARTS[art]
  const m = mat(x, y, r, 1 / (d.pixelScale ?? 1))
  m.x -= m.a * d.px + m.c * d.py; m.y -= m.b * d.px + m.d * d.py
  return { id, art, matrix: m, assembly, opacity: 1 }
}

function shadow (id: string, x: number, y: number, w: number, h: number, opacity: number, art = 'shadow'): Sprite {
  return { id, art, matrix: { a: w / PARTS[art].w, b: 0, c: 0, d: h / PARTS[art].h, x: x - w / 2, y: y - h / 2 }, assembly: 'ground', opacity, effect: true }
}

/** The package's `spritePose`: the ordered bitmaps a pose draws (shadows, legs, body and sensor, piston). */
function spritePose (pose: CompactorPose): CompactorPose {
  const sprites: Sprite[] = []
  sprites.push(shadow('body-shadow', 0, 3, 116 * 1.44, 78, 0.23))
  for (const l of pose.state.legs) sprites.push(shadow(l.id + '-shadow', l.foot.x, l.foot.y * 0.68, 12, 6, l.contact ? 0.25 : 0.10))
  const ps = pose.state.piston
  if (ps !== undefined) { const spread = ps.sole * 0.14; sprites.push(shadow('piston-shadow', ps.x, ps.y * 0.68, 64 * (58 + spread) / 58, 32 * (32 + spread) / 32, 0.16 + 0.38 * (1 - clamp(ps.sole / 21)), 'shoe-shadow')) }
  for (const region of pose.regions) {
    if (region.custom !== undefined) continue
    const assembly = region.leg !== undefined ? (region.depth === 'socket' ? 'body' : region.leg + (region.art === 'upper' ? '_upper' : '_lower')) : 'body'
    const sprite: Sprite = { id: region.name, art: region.art!, matrix: { ...pose.matrices[region.bone] }, assembly, opacity: 1 }
    if (region.clip !== undefined) sprite.clip = region.clip
    sprites.push(sprite)
    if (region.sensor !== undefined && region.sensor !== null) {
      const m = pose.matrices[region.bone]
      const p = pose.state.presence
      const at = { x: 0.499 * 476, y: 0.442 * 231 }
      sprites.push({ id: 'sensor-base', art: p.dead === true ? 'sensor-off' : 'sensor-base', matrix: mul(m, mat(at.x - 20, at.y - 20)), assembly: 'body', opacity: 1 })
      if (p.dead !== true) {
        const lm = { a: 1, b: 0, c: 0, d: p.focus ?? 1, x: at.x + (p.sensorX ?? 0) * 2 - 20, y: at.y + (p.sensorY ?? 0) * 2 - 20 * (p.focus ?? 1) }
        sprites.push({ id: 'sensor-lit', art: 'sensor-lit', matrix: mul(m, lm), assembly: 'body', opacity: 1 })
      }
    }
  }
  const p = pose.state.piston
  if (p !== undefined) {
    const yy = p.y * 0.68
    sprites.push(bitmap('shoe', 'shoe', p.x, yy - p.sole, 0, 'piston'))
    const shaft = bitmap('shaft', 'shaft', p.x, yy - p.shaftBottom, 0, 'piston')
    // Fixed 1/8 scale: the crop slides along a 70-unit shaft, never stretching it.
    const top = clamp((75 - (p.shaftTop - p.shaftBottom) - 3.06) * 8, 0, 640)
    shaft.clip = { x: 0, y: top, w: 128, h: 640 - top }
    sprites.push(shaft)
    sprites.push(bitmap('bearing', 'bearing', p.x, yy - p.cogCenterZ, 0, 'body'))
    sprites.push(bitmap('cog-back', 'cog-back', p.x, yy - p.cogCenterZ + 2.1, p.cogAngle, 'body'))
    sprites.push(bitmap('cog', 'cog', p.x, yy - p.cogCenterZ, p.cogAngle, 'body'))
  }
  return { ...pose, sprites }
}

function delta (pivot: Vec, dx: number, dy: number, r: number): Matrix {
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { a: c, b: s, c: -s, d: c, x: pivot.x + dx - c * pivot.x + s * pivot.y, y: pivot.y + dy - s * pivot.x - c * pivot.y }
}
function pulse (t: number, peak: number, end: number): number { return t <= 0 || t >= end ? 0 : t < peak ? smooth(t / peak) : 1 - smooth((t - peak) / (end - peak)) }

/** v4's hit: the chassis compresses and springs back, the shaft judders; the feet and root held. Exactly the source at 0 and 0.72 s. */
function hit (time: number, base: CompactorPose): CompactorPose {
  const t = clamp(time, 0, 0.72)
  if (t === 0 || t === 0.72) { const p = jsonClone(base); p.state.animation = { name: 'hit', time: t, phase: 0 }; return spritePose(p) }
  const k = pulse(t, 0.07, 0.38)
  const spring = pulse(t - 0.18, 0.09, 0.40)
  const judder = Math.sin(t * 83) * pulse(t, 0.045, 0.31) * 1.55
  const p: Presence = { ...base.state.presence }
  p.x -= 3.8 * k; p.z += -7 * k + 2.3 * spring; p.roll -= 0.025 * k; p.pitch += 0.025 * k
  const pose = composePose('hit', t, base.state.legs.map((l) => ({ ...l.foot })), base.state.animation.phase, 0, { presenceOverride: p, aimAngle: base.state.turret.angle, layout: base.state.layout })
  pose.state.root = { ...base.state.root }
  if (base.state.position !== undefined) pose.state.position = { ...base.state.position }
  const b = base.state.piston
  const ps = pose.state.piston
  ps.sole = b.sole + judder; ps.shoeTop = ps.sole + 10; ps.shaftBottom = ps.sole + 8; ps.extension = (pose.state.body.z - 8) - (ps.sole + 10); ps.cogAngle = (14 - ps.extension) / 12.5; ps.phase = 'Hit / shaft judder'; ps.contact = false
  pose.state.effects = null; pose.state.hit = { returnClip: base.state.animation.name, phaseFrozen: true, judder }
  return spritePose(pose)
}

interface Assembly { id: string, pivot: Vec, release: number, dx: number, drop: number, rotation: number, heavy: boolean }

/** v4's fall apart: the piston drops whole, the body drops and tilts, each leg breaks at hip and knee. Held at 2.8 s. */
function death (time: number, base: CompactorPose): CompactorPose {
  const t = clamp(time, 0, 2.8)
  const out = jsonClone(spritePose(base))
  const state = out.state
  state.animation = { name: 'fall_apart', time: t, phase: 0 }; state.effects = null
  const source = base.state
  const assemblies: Assembly[] = []
  assemblies.push({ id: 'body', pivot: { x: source.body.x, y: source.body.y * 0.68 - source.body.z }, release: 0.18, dx: -9, drop: source.body.z - 22, rotation: -0.085, heavy: true })
  assemblies.push({ id: 'piston', pivot: { x: source.piston.x, y: source.piston.y * 0.68 - source.piston.sole }, release: 0.12, dx: 0, drop: source.piston.sole, rotation: 0, heavy: true })
  source.legs.forEach((l, i) => {
    for (const type of ['upper', 'lower']) {
      const upper = type === 'upper'
      const pivot = upper ? l.screen.hip : l.screen.knee
      const end = upper ? l.screen.knee : l.screen.foot
      const target = Math.atan2(l.row * (upper ? 0.30 : 0.16), l.side)
      const initial = Math.atan2(end.y - pivot.y, end.x - pivot.x)
      const rotation = Math.atan2(Math.sin(target - initial), Math.cos(target - initial))
      // Rigid pieces turn about their joint; the drop puts the endpoint turned furthest down on the floor.
      const rx = end.x - pivot.x
      const ry = end.y - pivot.y
      const turnedY = Math.sin(rotation) * rx + Math.cos(rotation) * ry
      const ground = (upper ? (l.hip.y + l.knee.y) / 2 : (l.knee.y + l.foot.y) / 2) * 0.68 + l.row * 8
      assemblies.push({ id: l.id + '_' + type, pivot, release: 0.14 + i * 0.035, dx: l.side * (l.row < 0 ? (upper ? 40 : 60) : (upper ? 18 : 32)), drop: ground - pivot.y - Math.max(0, turnedY) - 3, rotation, heavy: false })
    }
  })
  const died: NonNullable<CompactorState['death']> = { time: t, bodyPieces: 1, legPieces: 8, settled: t === 2.8, assemblies: [] }
  state.death = died
  for (const a of assemblies) {
    const u = Math.max(0, t - a.release)
    const span = a.heavy ? 0.57 : 0.76
    const q = smooth(u / span)
    const tail = u > span ? u - span : 0
    const bounce = tail > 0 && tail < 0.58 ? Math.abs(Math.sin(tail * Math.PI * 3.4)) * Math.exp(-tail * 6) * (a.heavy ? 2.2 : 3.2) : 0
    const settle = smooth(u / (2.8 - a.release))
    const dx = a.dx * q + (a.heavy ? 0 : a.dx * 0.08 * settle)
    const dy = a.drop * q - bounce
    const r = a.rotation * q
    const d = delta(a.pivot, dx, dy, r)
    for (const s of out.sprites!) if (s.assembly === a.id) { s.matrix = mul(d, s.matrix); if (t > a.release && s.art === 'upper') delete s.clip }
    died.assemblies.push({ ...a, transform: d, translation: { x: dx, y: dy }, angle: r, settled: t === 2.8 })
  }
  const power = 1 - smooth(t / 0.15)
  for (const s of out.sprites!) if (s.effect === true && s.id !== 'body-shadow' && s.id !== 'piston-shadow') s.opacity *= 1 - smooth(t / 0.5)
  for (const s of out.sprites!) if (s.id === 'sensor-lit') s.opacity = power; else if (s.id === 'sensor-base') s.art = t > 0 ? 'sensor-off' : s.art
  state.presence = { ...state.presence, dead: t > 0, glow: source.presence.glow * power }; died.cogAngle = source.piston.cogAngle
  return out
}

/**
 * The package's `evaluate(name, time, options)`: idle, run (along
 * `directionX/Y`), fire (from `basePose`, aimed at `aimX/Y`), and hit and
 * fall_apart from `basePose` (the idle's first pose without one). A hit
 * during the strike is refused, as the package's.
 */
export function animationPose (name: string, time: number, options: CompactorOptions = {}): CompactorPose {
  if (name === 'hit' || name === 'fall_apart') {
    const base = options.basePose ?? coreAnimationPose('idle', 0, {})
    if (name === 'hit' && base.state.animation.name === 'fire') throw Error('Hit during fire is unsupported; defer hit until strike completes.')
    return name === 'hit' ? hit(time, base) : death(time, base)
  }
  return spritePose(coreAnimationPose(name, time, options))
}

/** The package's `drawPose` as a draw list: every sprite in order but the invisible, the shadows `contact`. */
export function draw (pose: CompactorPose): NpcDrawList {
  const items: NpcImage[] = []
  for (const s of (pose.sprites ?? spritePose(pose).sprites!)) {
    if (s.opacity === 0) continue
    items.push({ kind: 'image', art: s.art, m: s.matrix, clip: s.clip, alpha: s.opacity, contact: s.effect === true ? true : undefined })
  }
  return { ground: [], items }
}

/** The rig units from the ground to the top of the idle pose's highest image. */
const REFERENCE_UNITS = (() => {
  let top = 0
  for (const item of draw(animationPose('idle', 0)).items) {
    if (item.kind !== 'image' || item.contact === true) continue
    const { w, h } = PARTS[item.art]
    const m = item.m
    for (const [u, v] of [[0, 0], [w, 0], [0, h], [w, h]]) top = Math.min(top, m.b * u + m.d * v + m.y)
  }
  return -top
})()

export const COMPACTOR_RIG: NpcRig = Object.freeze({
  key: 'compactor' as const,
  clips: CLIPS,
  // Nick, 2026-10-07: 100% of its own rig (ideas/npc-roster.md; the package's gameScale).
  // Nick, 2026-10-09 (size review): 1 -> 1.78; the gait follows (`gaitClock`); the sheet is re-baked at it (`bake-npc-atlas.py`).
  sizeScale: 1.78,
  referenceUnits: REFERENCE_UNITS,
  deathHolds: true,
  gait: GAIT,
  roles: Object.freeze({
    idle: 'idle',
    move: 'run',
    // The strike (effect 14), started so its `attack` event, the shoe on the
    // floor, lands on the server's impact (`impactMs` after the cast). The
    // package has no hit over it; hits are an overlay (#52).
    attack: Object.freeze({ clip: 'fire', event: IMPACT_TIME }),
    hit: 'hit',
    // It falls apart from whatever it shows, any stage of the strike included.
    death: Object.freeze({ clip: 'fall_apart', from: 0, fromAction: true })
  }),
  pose: (clip: string, seconds: number, direction: { x: number, y: number }, aim?: { x: number, y: number }, from?: NpcPose): NpcPose => {
    let base = from?.state as CompactorPose | undefined
    // The package refuses a hit over the strike; `NpcSprite` never asks for one, but never throw in a frame.
    if (clip === 'hit' && base?.state.animation.name === 'fire') base = undefined
    const options: CompactorOptions = clip === 'run'
      ? { directionX: direction.x, directionY: direction.y }
      : clip === 'fire' ? { basePose: base, aimX: aim?.x, aimY: aim?.y } : { basePose: base }
    return { clip, time: seconds, state: animationPose(clip, seconds, options) }
  },
  draw: (p: NpcPose): NpcDrawList => draw(p.state as CompactorPose),
  arts: Object.freeze(Object.fromEntries(Object.entries(PARTS).map(([k, v]) => [k, Object.freeze({ w: v.w, h: v.h })])))
})
