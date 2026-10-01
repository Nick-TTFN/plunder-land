import { HULLS } from './hulls'
import {
  type Bone, type ClipName, type Clip, type Debris, type Matrix, type Pose,
  type PoseOptions, type Region, type RigState, type Expression, blinkClosure, regionMatrix, multiply
} from '../peep/rig'
import { eyeShotPose, shotClips } from '../robots/eyeshot'

export { blinkClosure, regionMatrix }

/**
 * Waddle's skeletal rig and its seven clips: a TypeScript port of the v2
 * drop's `tools/rig.mjs` and `tools/legacy-motion.mjs`
 * (`codex_output/waddle-animations-v2`, 2026-10-01), under the eye shot every
 * robot shares (`src/robots/eyeshot.ts`), with the Canvas drawing left out.
 *
 * **The drop is the authority.** Every number is copied, not tuned;
 * `robotrigs.spec.ts` (server) checks this port against poses sampled from the
 * drop's own modules (`tools/peep-rig-sync.mjs waddle`).
 *
 * A round shell on two short legs, a flipper each side, and two eyes in the
 * shell's own space (`eyeMatrix`, each `EYE_SIZE` big). The flipper strikes;
 * the shot comes from between the eyes. Locked in the lobby and not selectable.
 */

const TAU = Math.PI * 2
const RAD = Math.PI / 180

/** The body's clips (`legacy-motion.mjs`); its shoot is never played, `CLIPS` has the eye shot's. */
const BODY_CLIPS: Readonly<Record<ClipName | 'reference', Clip>> = {
  reference: { duration: 1, loop: false, events: [] },
  idle: { duration: 2.8, loop: true, events: [] },
  run: { duration: 0.9, loop: true, events: [] },
  shoot: { duration: 0.6, loop: false, events: [{ time: 0.06, name: 'fire' }] },
  swing: { duration: 1.1, loop: false, events: [{ time: 0.43, name: 'melee_hit' }] },
  jump: { duration: 1.4, loop: false, events: [{ time: 0.32, name: 'takeoff' }, { time: 0.98, name: 'land' }] },
  hit: { duration: 0.75, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: { duration: 2.6, loop: false, events: [{ time: 0.16, name: 'detach' }] }
}

export function clampAngle (x: number = 0): number {
  return Math.max(-60, Math.min(60, Number.isFinite(x) ? x : 0))
}

function strideCurve (a: number, b: number, v: number, t: number): number {
  return (2 * t * t * t - 3 * t * t + 1) * a + (t * t * t - 2 * t * t + t) * v + (-2 * t * t * t + 3 * t * t) * b + (t * t * t - t * t) * v
}

function rotate (x: number, y: number, r: number): { x: number, y: number } {
  return { x: x * Math.cos(r * RAD) - y * Math.sin(r * RAD), y: x * Math.sin(r * RAD) + y * Math.cos(r * RAD) }
}

const SHOULDER = { x: -54, y: 3 }
const GRIP = { x: -25, y: -20 }
const GRIP_TIP = { x: 30, y: 0 }

/** After the drop's deletes: `grip`/`grip_tip` gone, `eye_muzzle`/`muzzle` on the shell (`eyeshot.ts` places them). */
export const BONE_PARENTS: Readonly<Record<string, string | null>> = {
  root: null,
  body: 'root',
  thigh_far: 'root',
  shin_far: 'thigh_far',
  foot_far: 'root',
  flipper_far: 'body',
  thigh_near: 'root',
  shin_near: 'thigh_near',
  foot_near: 'root',
  flipper_near: 'body',
  eye_left: 'body',
  eye_right: 'body',
  eye_muzzle: 'body',
  muzzle: 'body'
}

/** Two-bone legs, equal halves, from the shell's hips to the ankles. */
function poseLegs (st: RigState): void {
  for (const [side, hx, hy, ay] of [['near', -39, -61, 32], ['far', 39, -57, 30]] as const) {
    const h = rotate(hx, hy, st.body.r)
    h.x += st.body.x
    h.y += st.body.y
    const f = st['foot_' + side]
    const a = rotate(0, ay, f.r)
    a.x += f.x
    a.y += f.y
    const dx = a.x - h.x
    const dy = a.y - h.y
    const d = Math.hypot(dx, dy)
    const l = 15
    if (d > 30 + 1e-6) throw Error(`Unreachable ${side} leg ${d}`)
    const r = Math.atan2(dy, dx) + (side === 'near' ? 1 : -1) * Math.acos(Math.min(1, d / (2 * l)))
    const k = { x: h.x + l * Math.cos(r), y: h.y + l * Math.sin(r) }
    st['thigh_' + side] = { x: h.x, y: h.y, r: r / RAD + 90 }
    st['shin_' + side] = { x: 0, y: -l, r: (Math.atan2(a.y - k.y, a.x - k.x) - r) / RAD }
  }
}

function poseUpper (st: RigState, options: PoseOptions = {}, p = 0, moving = false): void {
  const aim = clampAngle(options.aimAngle)
  const look = clampAngle(options.lookAngle ?? aim)
  st.flipper_near = { ...SHOULDER, r: -aim * 0.55 + (moving ? 5 * Math.sin(TAU * p) : 0) }
  st.flipper_far = { x: 62, y: -8, r: moving ? -10 * Math.sin(TAU * p) : 0 }
  st.grip = { ...GRIP, r: aim - st.body.r - st.flipper_near.r }
  st.grip_tip = { ...GRIP_TIP, r: 0 }
  for (const [id, x] of [['left', 23], ['right', 40]] as const) {
    st['eye_' + id] = {
      x: x + look / 60 * 1.5,
      y: 35 + look / 60 * 9,
      r: 0,
      sx: 1,
      sy: 1 - 0.94 * Math.max(0, Math.min(1, options.blink ?? 0)),
      expression: (options.expression as Expression | undefined) ?? 'open'
    } as Bone
  }
  st.controls = { aimAngle: aim, lookAngle: look, sensorPitch: 0, headTilt: 0 }
}

function state (p = 0, reference = false, options: PoseOptions = {}): RigState {
  p = (p % 1 + 1) % 1
  const st = {
    root: { x: 0, y: 0, r: 0 },
    body: { x: reference ? 0 : 2 * Math.sin(TAU * p), y: reference ? 112 : 110 - 1.5 * Math.cos(TAU * 2 * p), r: reference ? 0 : 2 * Math.sin(TAU * p) }
  } as unknown as RigState
  for (const [side, shift, x, y] of [['near', 0, -42, 0], ['far', 0.5, 42, 5]] as const) {
    const q = (p + shift) % 1
    const stance = q < 0.58
    const t = (q - 0.58) / 0.42
    st['foot_' + side] = {
      x: x + (reference ? 0 : stance ? 8 - 16 * q / 0.58 : strideCurve(-8, 8, -16 / 0.58 * 0.42, t)),
      y: y + (reference || stance ? 0 : 7 * Math.sin(Math.PI * t)),
      r: 0
    }
  }
  poseLegs(st)
  poseUpper(st, options, p, !reference)
  return st
}

function at (name: string, bone: string, art: string, w: number, h: number, px = 0.5, py = 0.5, extra: Partial<Region> = {}): Region {
  return { name, bone, art, w, h, x: (0.5 - px) * w, y: (py - 0.5) * h, r: 0, sx: 1, sy: 1, ...extra }
}

/** Every drawn part, back to front. */
export const REGIONS: readonly Region[] = [
  at('thigh_far', 'thigh_far', 'thigh', 16, 22, 0.5, 0.16),
  at('shin_far', 'shin_far', 'shin', 15, 22, 0.5, 0.16),
  at('boot_far', 'foot_far', 'boot_far', 60, 42, 0.5, 1),
  at('flipper_far', 'flipper_far', 'flipper', 66, 57, 0.84, 0.28, { sx: -1, x: 22.44 }),
  at('thigh_near', 'thigh_near', 'thigh', 17, 23, 0.5, 0.16),
  at('shin_near', 'shin_near', 'shin', 16, 23, 0.5, 0.16),
  at('boot_near', 'foot_near', 'boot_near', 66, 46, 0.5, 1),
  at('shell', 'body', 'shell', 144, 156),
  at('flipper_near', 'flipper_near', 'flipper', 66, 57, 0.84, 0.28),
  at('eye_left', 'eye_left', 'eye_open', 22, 36, 0.5, 0.5, { kind: 'eye' }),
  at('eye_right', 'eye_right', 'eye_open', 22, 36, 0.5, 0.5, { kind: 'eye' })
]

export const EYE_SIZE = { w: 22, h: 36 }

/**
 * The reference pose's height, rig units: the top of the shell's box, 190
 * (from the fixtures), not measured from the art's alpha as Peep's 245.5 was.
 */
export const REFERENCE_UNITS = 190

/**
 * An eye's matrix, for an image centred on the origin `EYE_SIZE` units big:
 * in the shell's space (not on the eye's own bone), at the eye's place,
 * scaled by it (y flipped), squashed to a slit when closed. The drop clips
 * both to the lens; that mask is left out, as the other robots' are.
 */
export function eyeMatrix (m: Record<string, Matrix>, eye: Bone & { expression?: Expression }): Matrix {
  const k = eye.expression === 'closed' ? 0.07 : 1
  return multiply(m.body, { a: eye.sx ?? 1, b: 0, c: 0, d: -(eye.sy ?? 1) * k, x: eye.x, y: eye.y })
}

export function matrices (st: RigState): Record<string, Matrix> {
  const m: Record<string, Matrix> = {}
  for (const [n, parent] of Object.entries(BONE_PARENTS)) {
    const b = st[n]
    if (b === undefined) continue
    const r = b.r * RAD
    const a = Math.cos(r) * (b.sx ?? 1)
    const c = -Math.sin(r) * (b.sy ?? 1)
    const bb = Math.sin(r) * (b.sx ?? 1)
    const d = Math.cos(r) * (b.sy ?? 1)
    if (parent === null) m[n] = { a, b: bb, c, d, x: b.x, y: b.y }
    else {
      const p = m[parent]
      m[n] = { a: p.a * a + p.c * bb, b: p.b * a + p.d * bb, c: p.a * c + p.c * d, d: p.b * c + p.d * d, x: p.a * b.x + p.c * b.y + p.x, y: p.b * b.x + p.d * b.y + p.y }
    }
  }
  return m
}

// ---------------------------------------------------------- legacy-motion.mjs

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
  let height = 0
  const flash = 0
  let squeeze = 0
  let arm = 0
  let far = 0
  if (name === 'idle') {
    const a = MTWO * t / 2.8
    st.body.x = 0.5 * Math.sin(a)
    st.body.y += 0.5 * Math.sin(a)
    st.body.r = 0.6 * Math.sin(a)
    far = 2 * (Math.sin(a - 0.3) + Math.sin(0.3))
  }
  if (name === 'hit') {
    const k = motionKeys(t, [[0, 0], [0.065, 1], [0.18, 0.75], [0.34, -0.13], [0.51, 0.04], [0.75, 0]])
    st.body.x = -4 * k
    st.body.y -= 4 * Math.max(k, 0)
    st.body.r = 4 * k
    arm = -10 * k
    far = 8 * k
    squeeze = motionKeys(t, [[0, 0], [0.05, 1], [0.18, 1], [0.34, 0], [0.75, 0]])
  }
  if (name === 'swing') {
    const k = motionKeys(t, [[0, 0], [0.28, 1], [0.33, 1], [0.45, -1], [0.56, -0.8], [0.82, 0.1], [1.1, 0]])
    st.body.x = -5 * k
    st.body.y -= 4 * Math.abs(k)
    st.body.r = 4 * k
    arm = 35 * k
    far = -12 * k
  }
  if (name === 'jump') {
    const a = motionClamp((t - 0.32) / 0.66)
    const tuck = t > 0.32 && t < 0.98 ? Math.sin(Math.PI * a) : 0
    height = t > 0.32 && t < 0.98 ? 32 * 4 * a * (1 - a) : 0
    st.root.y = height
    st.body.y += motionKeys(t, [[0, 0], [0.23, -8], [0.32, 0], [0.98, 0], [1.055, -8], [1.23, -1], [1.4, 0]]) - 2 * tuck
    st.foot_near.y += 3 * tuck
    st.foot_far.y += 3 * tuck
    arm = -12 * tuck
    far = 16 * tuck
  }
  if (name === 'fall_apart') {
    const f = motionSmooth(t / 0.16)
    st.body.y -= 3 * f
    st.body.r = 3 * f
    arm = -7 * f
    far = 7 * f
    squeeze = 0.75 * f
  }
  poseLegs(st)
  poseUpper(st, options)
  st.flipper_near.r -= arm
  st.grip.r += 2 * arm
  st.flipper_far.r += far
  for (const key of ['eye_left', 'eye_right']) st[key].sy = (st[key].sy ?? 1) * (1 - 0.94 * squeeze)
  st.animation = { name, time: t, height, flash, eyeOpacity: 1, detached: false }
  return st
}

interface DebrisGroup { id: string, bones: string[], vx: number, vy: number, spin: number, bounce: number, floor: number, gravity?: number }

export const DEBRIS_GROUPS: readonly DebrisGroup[] = [
  { id: 'shell', bones: ['body', 'eye_left', 'eye_right'], vx: 14, vy: 25, spin: 52, bounce: 0.08, floor: 1, gravity: 800 },
  { id: 'flipper_near', bones: ['flipper_near'], vx: -85, vy: 94, spin: -170, bounce: 0.18, floor: 0 },
  { id: 'flipper_far', bones: ['flipper_far'], vx: 90, vy: 100, spin: 190, bounce: 0.18, floor: 3 },
  { id: 'thigh_near', bones: ['thigh_near'], vx: -48, vy: 80, spin: -190, bounce: 0.18, floor: 0 },
  { id: 'shin_near', bones: ['shin_near'], vx: -63, vy: 60, spin: 220, bounce: 0.18, floor: 0 },
  { id: 'thigh_far', bones: ['thigh_far'], vx: 46, vy: 80, spin: 190, bounce: 0.18, floor: 3 },
  { id: 'shin_far', bones: ['shin_far'], vx: 62, vy: 60, spin: -200, bounce: 0.18, floor: 3 },
  { id: 'boot_near', bones: ['foot_near'], vx: -27, vy: 18, spin: -50, bounce: 0.1, floor: 0 },
  { id: 'boot_far', bones: ['foot_far'], vx: 28, vy: 22, spin: 60, bounce: 0.1, floor: 4 }
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
    // The hull at the bone's own scale.
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
  st.animation = { name: 'fall_apart', time: t, height: 0, flash: 0, eyeOpacity: Math.max(0, 1 - (t - 0.16) / 0.20) * 0.6, detached: true, parts }
  return { state: st, matrices: m }
}

/** The body's pose: `legacy-motion.mjs`'s `animationPose`. */
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

const WADDLE_BODY = Object.freeze({
  id: 'waddle' as const,
  clips: BODY_CLIPS,
  pose: bodyPose,
  matrices,
  regions: REGIONS,
  muzzleParent: 'body',
  poseLegs
})

/** The pose of `name` at `seconds` into it, eye shot and all. */
export function animationPose (name: ClipName | 'reference', seconds: number, options: PoseOptions = {}): Pose {
  return eyeShotPose(WADDLE_BODY, CLIPS, name, seconds, options)
}
