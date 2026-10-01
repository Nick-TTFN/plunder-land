import { HULLS } from './hulls'
import { eyeShotPose, shotClips } from '../robots/eyeshot'
import {
  type AnimationInfo, type Bone, type ClipName, type Debris, type EyeBone, type Matrix, type Pose,
  type PoseOptions, type Region, type RigState, type Expression, blinkClosure, multiply, regionMatrix
} from '../peep/rig'

export { blinkClosure, regionMatrix }

/**
 * Periscope's skeletal rig and its seven clips: a TypeScript port of the v3
 * drop's `tools/rig.mjs` and `tools/legacy-motion.mjs`
 * (`codex_output/periscope-animations-v3`, 2026-10-01; its body is v1's with
 * the gun taken out), with the Canvas drawing left out, like Peep's and
 * Magnet's, whose types and region maths it shares, under the eye shot every
 * robot shares (`src/robots/eyeshot.ts`).
 *
 * **The drop is the authority.** Every number is copied, not tuned;
 * `robotrigs.spec.ts` (server) checks this port against poses sampled from
 * the drop's own modules (`tools/peep-rig-sync.mjs periscope`).
 *
 * Periscope differs in anatomy: a sensor head on a two-section neck that leans
 * back to look up, and legs that bend at a short knee. Its gun on a side mount
 * went in v3; the swing is now the chassis's weight and the sensor's
 * follow-through (`eyeshot.ts`). Its eye lives in the sensor's own space
 * (`eyeMatrix`), a 16 x 29 image, not in Peep's head-art pixels.
 */

const TAU = 2 * Math.PI
const DEG = Math.PI / 180

/** The body's clips (`legacy-motion.mjs`); its shoot is never played, `CLIPS` has the eye shot's. */
const BODY_CLIPS: Readonly<Record<ClipName | 'reference', { duration: number, loop: boolean, events: Array<{ time: number, name: string }> }>> = {
  reference: { duration: 1, loop: false, events: [] },
  idle: { duration: 2.4, loop: true, events: [] },
  run: { duration: 38 / 60, loop: true, events: [] },
  shoot: { duration: 0.55, loop: false, events: [{ time: 0.05, name: 'fire' }] },
  swing: { duration: 1, loop: false, events: [{ time: 0.38, name: 'melee_hit' }] },
  jump: { duration: 1.3, loop: false, events: [{ time: 0.26, name: 'takeoff' }, { time: 0.90, name: 'land' }] },
  hit: { duration: 0.65, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: { duration: 2.4, loop: false, events: [{ time: 0.16, name: 'detach' }] }
}

// ---------------------------------------------------------------- rig.mjs

export function clampAngle (x: number = 0): number {
  return Math.max(-60, Math.min(60, Number.isFinite(x) ? x : 0))
}

function smooth (x: number): number {
  x = Math.max(0, Math.min(1, x))
  return x * x * (3 - 2 * x)
}

function rotate (x: number, y: number, r: number): { x: number, y: number } {
  return { x: x * Math.cos(r * DEG) - y * Math.sin(r * DEG), y: x * Math.sin(r * DEG) + y * Math.cos(r * DEG) }
}

const LENS = { x: 67, y: 16.5 }
const NECK_BASE = { x: -3, y: 26 }
const MOUNT = { x: 25, y: -16 }
const GRIP = { x: 6, y: 0 }
const GRIP_TIP = { x: 38, y: 0 }

/** Parent before child: `matrices` walks this in order. */
export const BONE_PARENTS: Readonly<Record<string, string | null>> = {
  root: null,
  body: 'root',
  neck_lower: 'body',
  neck_upper: 'neck_lower',
  sensor: 'neck_upper',
  eye: 'sensor',
  thigh_far: 'root',
  shin_far: 'thigh_far',
  foot_far: 'root',
  thigh_near: 'root',
  shin_near: 'thigh_near',
  foot_near: 'root',
  // The drop deletes mount, grip and grip_tip (the gun) and adds these,
  // which `eyeshot.ts` places itself.
  eye_muzzle: 'sensor',
  muzzle: 'sensor'
}

function hermite (a: number, b: number, va: number, vb: number, t: number): number {
  return (2 * t ** 3 - 3 * t * t + 1) * a + (t ** 3 - 2 * t * t + t) * va + (-2 * t ** 3 + 3 * t * t) * b + (t ** 3 - t * t) * vb
}

function foot (p: number): { x: number, y: number, r: number, contact: boolean } {
  p = (p % 1 + 1) % 1
  if (p < 0.42) return { x: 8 - 16 * p / 0.42, y: 0, r: 0, contact: true }
  const t = (p - 0.42) / 0.58
  return {
    x: hermite(-8, 8, -16 / 0.42 * 0.58, -16 / 0.42 * 0.58, t),
    y: 8 * Math.sin(Math.PI * t) ** 1.6,
    r: -8 * Math.sin(TAU * t) * Math.sin(Math.PI * t),
    contact: false
  }
}

function poseLegs (st: RigState): void {
  for (const [side, hipX, hipY, ankleY] of [['near', -17, -27, 30.4], ['far', 12, -31, 28.5]] as const) {
    const hip = rotate(hipX, hipY, st.body.r)
    hip.x += st.body.x
    hip.y += st.body.y
    const f = st['foot_' + side]
    const ankle = rotate(0, ankleY, f.r)
    ankle.x += f.x
    ankle.y += f.y
    const dx = ankle.x - hip.x
    const dy = ankle.y - hip.y
    const d = Math.hypot(dx, dy)
    const l = 13
    if (d > 26 + 1e-6) throw Error('Unreachable ' + side + ' leg ' + d)
    const a = Math.atan2(dy, dx) + (side === 'near' ? 1 : -1) * Math.acos(Math.min(1, d / (2 * l)))
    const k = { x: hip.x + l * Math.cos(a), y: hip.y + l * Math.sin(a) }
    st['thigh_' + side] = { x: hip.x, y: hip.y, r: a / DEG + 90 }
    st['shin_' + side] = { x: 0, y: -l, r: (Math.atan2(ankle.y - k.y, ankle.x - k.x) - a) / DEG }
  }
}

function poseUpper (st: RigState, options: PoseOptions = {}, phase = 0, moving = false): void {
  const aim = clampAngle(options.aimAngle)
  const look = clampAngle(options.lookAngle ?? aim)
  const p = TAU * phase
  const up = smooth(Math.max(0, look) / 60)
  const lower = 16 * up - look * 0.025 + (moving ? 1.5 * Math.sin(p - 0.35) : 0)
  const upper = -32 + 26 * up + look * 0.045 + (moving ? -2 * Math.sin(p - 0.65) : 0)
  st.neck_lower = { ...NECK_BASE, r: lower }
  st.neck_upper = { x: 0, y: 38, r: upper }
  const pitch = 0.6 * look + 18 * up + (moving ? 0.8 * Math.sin(p - 0.85) : 0)
  st.sensor = { x: 0, y: 38, r: pitch - st.body.r - lower - upper }
  st.eye = {
    x: LENS.x + 0.4 * look / 60,
    y: LENS.y - 1.2 * look / 60,
    r: 0,
    sx: 1 - 0.06 * Math.abs(look / 60),
    sy: (1 - 0.94 * Math.max(0, Math.min(1, options.blink ?? 0))),
    expression: (options.expression as Expression | undefined) ?? 'open'
  }
  st.mount = { ...MOUNT, r: aim - st.body.r }
  st.grip = { ...GRIP, r: 0 }
  st.grip_tip = { ...GRIP_TIP, r: 0 }
  st.controls = { aimAngle: aim, lookAngle: look, sensorPitch: pitch, headTilt: pitch }
}

function state (p = 0, reference = false, options: PoseOptions = {}): RigState {
  p = (p % 1 + 1) % 1
  const st = {
    root: { x: 0, y: 0, r: 0 },
    body: {
      x: reference ? 0 : 0.5 * Math.sin(TAU * p),
      y: reference ? 80 : 77 - 1.0 * Math.cos(TAU * 2 * p),
      r: reference ? 0 : -2 + 0.6 * Math.sin(TAU * 2 * p)
    }
  } as unknown as RigState
  for (const [side, shift, x, plane] of [['near', 0, -22, 0], ['far', 0.5, 22, 5]] as const) {
    const f = reference ? { x: 0, y: 0, r: 0, contact: true } : foot(p + shift)
    st['foot_' + side] = { x: x + f.x, y: plane + f.y, r: f.r, contact: f.contact } as Bone
  }
  poseLegs(st)
  poseUpper(st, options, p, !reference)
  return st
}

function at (name: string, bone: string, art: string, w: number, h: number, px = 0.5, py = 0.5, extra: Partial<Region> = {}): Region {
  return { name, bone, art, w, h, x: (0.5 - px) * w, y: (py - 0.5) * h, r: 0, sx: 1, sy: 1, ...extra }
}

/** Every drawn part, back to front. `art` names a frame in `periscope.json`. */
export const REGIONS: readonly Region[] = [
  at('thigh_far', 'thigh_far', 'thigh', 12, 19, 0.5, 0.16),
  at('shin_far', 'shin_far', 'shin', 11, 19, 0.5, 0.16),
  at('boot_far', 'foot_far', 'boot_far', 46, 35.5, 0.5, 1),
  at('thigh_near', 'thigh_near', 'thigh', 13, 19, 0.5, 0.16),
  at('shin_near', 'shin_near', 'shin', 12, 19, 0.5, 0.16),
  at('boot_near', 'foot_near', 'boot_near', 50, 38.4, 0.5, 1),
  at('neck_lower', 'neck_lower', 'neck', 21, 47, 0.5, 0.91),
  at('neck_upper', 'neck_upper', 'neck', 21, 47, 0.5, 0.91),
  at('chassis', 'body', 'chassis', 64, 70),
  at('sensor', 'sensor', 'sensor', 105, 54, 0.24, 0.88),
  at('eye', 'eye', 'eye_open', 16, 29, 0.5, 0.5, { kind: 'eye' }),
  at('reflection', 'sensor', 'reflection', 3.7, 4.6, 0.5, 0.5, { x: 70, y: 27 })
]

/** The eye image's size in sensor units, as the drop draws it. */
export const EYE_SIZE = { w: 16, h: 29 }

/**
 * The eye's matrix, for an image centred on the origin `EYE_SIZE` units big:
 * the drop draws it in the sensor's space, at the eye's place, scaled by it
 * (y flipped), and squashed to a slit when closed. The drop also clips it to
 * the lens ellipse; that mask is left out, as Peep's visor mask is.
 */
export function eyeMatrix (m: Record<string, Matrix>, eye: EyeBone): Matrix {
  const k = eye.expression === 'closed' ? 0.07 : 1
  return multiply(m.sensor, { a: eye.sx, b: 0, c: 0, d: -eye.sy * k, x: eye.x, y: eye.y })
}

export function matrices (st: RigState): Record<string, Matrix> {
  const m: Record<string, Matrix> = {}
  for (const name in BONE_PARENTS) {
    const parent = BONE_PARENTS[name]
    const b = st[name]
    if (b === undefined) continue
    const r = b.r * DEG
    const a = Math.cos(r) * (b.sx ?? 1)
    const c = -Math.sin(r) * (b.sy ?? 1)
    const bb = Math.sin(r) * (b.sx ?? 1)
    const d = Math.cos(r) * (b.sy ?? 1)
    if (parent === null) {
      m[name] = { a, b: bb, c, d, x: b.x, y: b.y }
    } else {
      const p = m[parent]
      m[name] = { a: p.a * a + p.c * bb, b: p.b * a + p.d * bb, c: p.a * c + p.c * d, d: p.b * c + p.d * d, x: p.a * b.x + p.c * b.y + p.x, y: p.b * b.x + p.d * b.y + p.y }
    }
  }
  return m
}

// --------------------------------------------------------- animations.mjs

const MRAD = Math.PI / 180
const MTWO = Math.PI * 2
const motionClamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x))
const motionSmooth = (x: number): number => {
  x = motionClamp(x)
  return x * x * (3 - 2 * x)
}
const motionPoint = (m: Matrix, x: number, y: number): { x: number, y: number } => ({ x: m.a * x + m.c * y + m.x, y: m.b * x + m.d * y + m.y })

function motionKeys (t: number, keys: Array<[number, number]>): number {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [a, v] = keys[i - 1]
      const [b, w] = keys[i]
      return v + (w - v) * motionSmooth((t - a) / (b - a))
    }
  }
  return keys[keys.length - 1][1]
}

function bodyClipTime (name: ClipName | 'reference', t: number): number {
  const c = BODY_CLIPS[name]
  t = Number.isFinite(t) ? t : 0
  return c.loop ? ((t % c.duration) + c.duration) % c.duration : motionClamp(t, 0, c.duration)
}

function standingPose (name: ClipName, t: number, options: PoseOptions): RigState {
  const st = state(0, true, options)
  let neck = 0
  let head = 0
  let gun = 0
  let height = 0
  const flash = 0
  let squeeze = 0
  if (name === 'idle') {
    const a = MTWO * t / BODY_CLIPS.idle.duration
    st.body.y += 0.45 * Math.sin(a)
    st.body.r = 0.3 * Math.sin(a)
    neck = 0.6 * (Math.sin(a - 0.3) + Math.sin(0.3))
    head = -0.25 * Math.sin(a)
  }
  if (name === 'swing') {
    const wind = motionKeys(t, [[0, 0], [0.24, 1], [0.29, 1], [0.40, -1], [0.49, -0.85], [0.72, 0.12], [1, 0]])
    st.body.x = -3.5 * wind
    st.body.y -= 3 * Math.abs(wind)
    st.body.r = 4 * wind
    gun = motionKeys(t, [[0, 0], [0.24, 38], [0.29, 38], [0.40, -43], [0.49, -38], [0.72, 6], [1, 0]])
    neck = motionKeys(t, [[0, 0], [0.27, 4], [0.44, -7], [0.60, -3], [0.82, 1], [1, 0]])
    head = -neck * 0.6
  }
  if (name === 'hit') {
    const k = motionKeys(t, [[0, 0], [0.055, 1], [0.13, 0.8], [0.27, -0.12], [0.43, 0.035], [0.65, 0]])
    st.body.x = -3 * k
    st.body.y -= 2.5 * Math.max(k, 0)
    st.body.r = 4 * k
    neck = motionKeys(t, [[0, 0], [0.035, 0], [0.12, 8], [0.25, 3], [0.37, -1.5], [0.52, 0.4], [0.65, 0]])
    head = -neck * 0.5
    gun = -10 * k
    squeeze = motionKeys(t, [[0, 0], [0.04, 1], [0.14, 1], [0.28, 0], [0.65, 0]])
  }
  if (name === 'jump') {
    const air = motionClamp((t - 0.26) / 0.64)
    const tuck = t > 0.26 && t < 0.90 ? Math.sin(Math.PI * air) : 0
    height = t > 0.26 && t < 0.90 ? 42 * 4 * air * (1 - air) : 0
    st.root.y = height
    st.body.y += motionKeys(t, [[0, 0], [0.18, -5], [0.26, 0], [0.90, 0], [0.97, -5], [1.1, -1], [1.3, 0]]) - 2 * tuck
    st.foot_near.y += 3 * tuck
    st.foot_far.y += 3 * tuck
    neck = motionKeys(t, [[0, 0], [0.18, 5], [0.34, -5], [0.65, -2], [0.90, 0], [1, 6], [1.14, -1], [1.3, 0]])
    head = -neck * 0.7
    gun = 8 * tuck
  }
  if (name === 'fall_apart') {
    const f = motionSmooth(t / 0.16)
    st.body.x = -2 * f
    st.body.y -= 2 * f
    st.body.r = 3 * f
    neck = 4 * f
    squeeze = 0.7 * f
  }
  poseLegs(st)
  poseUpper(st, options)
  st.neck_lower.r += neck * 0.4
  st.neck_upper.r += neck * 0.6
  st.sensor.r += head - neck
  st.mount.r += gun
  st.eye.sy *= 1 - 0.94 * squeeze
  st.animation = { name, time: t, height, flash, eyeOpacity: 1, detached: false }
  return st
}

interface DebrisGroup { id: string, bones: string[], vx: number, vy: number, spin: number, bounce: number, floor: number, gravity?: number }

export const DEBRIS_GROUPS: readonly DebrisGroup[] = [
  { id: 'sensor', bones: ['sensor', 'eye'], vx: -48, vy: 32, spin: -95, bounce: 0.15, floor: 2 },
  { id: 'chassis', bones: ['body'], vx: 22, vy: 36, spin: 90, bounce: 0.14, floor: 1 },
  { id: 'neck_lower', bones: ['neck_lower'], vx: -54, vy: 65, spin: -190, bounce: 0.20, floor: 1 },
  { id: 'neck_upper', bones: ['neck_upper'], vx: 60, vy: 48, spin: 170, bounce: 0.18, floor: 2 },
  { id: 'thigh_near', bones: ['thigh_near'], vx: -80, vy: 95, spin: -230, bounce: 0.2, floor: 0 },
  { id: 'shin_near', bones: ['shin_near'], vx: -95, vy: 65, spin: 220, bounce: 0.2, floor: 0 },
  { id: 'thigh_far', bones: ['thigh_far'], vx: 65, vy: 90, spin: 230, bounce: 0.2, floor: 3 },
  { id: 'shin_far', bones: ['shin_far'], vx: 85, vy: 55, spin: -220, bounce: 0.18, floor: 3 },
  { id: 'boot_near', bones: ['foot_near'], vx: -30, vy: 20, spin: -65, bounce: 0.12, floor: 0 },
  { id: 'boot_far', bones: ['foot_far'], vx: 32, vy: 24, spin: 75, bounce: 0.12, floor: 5 }
]

function motionSupport (points: ReadonlyArray<readonly number[]>, angle: number): number {
  const c = Math.cos(angle * MRAD)
  const s = Math.sin(angle * MRAD)
  let low = Infinity
  for (const [x, y] of points) low = Math.min(low, s * x + c * y)
  return -low
}

function simulatePiece (group: DebrisGroup, points: ReadonlyArray<readonly number[]>, origin: { x: number, y: number }, startAngle: number, seconds: number): Debris {
  let x = origin.x
  let y = origin.y
  let angle = startAngle
  let vx = group.vx
  let vy = group.vy
  let spin = group.spin
  let grounded = false
  let left = seconds
  while (left > 1e-8) {
    const dt = Math.min(1 / 240, left)
    left -= dt
    if (!grounded) vy -= (group.gravity ?? 680) * dt
    x += vx * dt
    y += vy * dt
    angle += spin * dt
    const floor = group.floor + motionSupport(points, angle)
    if (y <= floor) {
      y = floor
      if (!grounded && vy < -24) {
        vy = -vy * group.bounce
        vx *= 0.55
        spin *= 0.5
      } else {
        grounded = true
        vy = 0
      }
    }
    if (grounded) {
      vx *= Math.exp(-10 * dt)
      spin *= Math.exp(-13 * dt)
      y = group.floor + motionSupport(points, angle)
    }
  }
  return { id: group.id, x, y, angle, grounded }
}

function detachedPose (t: number, options: PoseOptions): Pose {
  const st = standingPose('fall_apart', 0.16, options)
  const rest = matrices(st)
  const m = { ...rest }
  const parts: Debris[] = []
  for (const group of DEBRIS_GROUPS) {
    const geometry = HULLS[group.id]
    const bone = rest[group.bones[0]]
    const origin = motionPoint(bone, geometry.center[0], geometry.center[1])
    const startAngle = Math.atan2(bone.b, bone.a) / MRAD
    const sx = Math.hypot(bone.a, bone.b)
    const sy = Math.hypot(bone.c, bone.d)
    const points = geometry.points.map(([x, y]) => [x * sx, y * sy])
    const p = simulatePiece(group, points, origin, startAngle, t - 0.16)
    const delta = (p.angle - startAngle) * MRAD
    const c = Math.cos(delta)
    const s = Math.sin(delta)
    for (const name of group.bones) {
      const b = rest[name]
      const dx = b.x - origin.x
      const dy = b.y - origin.y
      m[name] = { a: c * b.a - s * b.b, b: s * b.a + c * b.b, c: c * b.c - s * b.d, d: s * b.c + c * b.d, x: p.x + c * dx - s * dy, y: p.y + s * dx + c * dy }
    }
    parts.push(p)
  }
  const animation: AnimationInfo = { name: 'fall_apart', time: t, height: 0, flash: 0, eyeOpacity: Math.max(0, 1 - (t - 0.16) / 0.20) * 0.6, detached: true, parts }
  st.animation = animation
  return { state: st, matrices: m }
}

/** The pose of `name` at `seconds` into it. */
function bodyPose (name: ClipName | 'reference', seconds: number, options: PoseOptions = {}): Pose {
  const t = bodyClipTime(name, seconds)
  if (name === 'run' || name === 'reference') {
    const st = state(name === 'run' ? t / BODY_CLIPS.run.duration : 0, name === 'reference', options)
    st.animation = { name, time: t, height: 0, flash: 0, eyeOpacity: 1, detached: false }
    return { state: st, matrices: matrices(st) }
  }
  if (name === 'fall_apart' && t > 0.16) return detachedPose(t, options)
  const st = standingPose(name, t, options)
  return { state: st, matrices: matrices(st) }
}

/** The clips as played: the body's, and the eye shot's `shoot`. */
export const CLIPS = shotClips(BODY_CLIPS)

const PERISCOPE_BODY = Object.freeze({
  id: 'periscope' as const,
  clips: BODY_CLIPS,
  pose: bodyPose,
  matrices,
  regions: REGIONS,
  muzzleParent: 'sensor'
})

/** The pose of `name` at `seconds` into it, eye shot and all. */
export function animationPose (name: ClipName | 'reference', seconds: number, options: PoseOptions = {}): Pose {
  return eyeShotPose(PERISCOPE_BODY, CLIPS, name, seconds, options)
}
