import { HULLS } from './hulls'
import {
  type AnimationInfo, type Bone, type ClipName, type Clip, type Debris, type Matrix, type Pose,
  type PoseOptions, type Region, type RigState, type Expression, blinkClosure, regionMatrix, multiply
} from '../peep/rig'
import { eyeShotPose, shotClips } from '../robots/eyeshot'

export { blinkClosure, regionMatrix }

/**
 * Hopper's skeletal rig and its seven clips: a TypeScript port of the v2
 * drop's `tools/rig.mjs` and `tools/legacy-motion.mjs`
 * (`codex_output/hopper-animations-v2`, 2026-10-01), under the eye shot every
 * robot shares (`src/robots/eyeshot.ts`), with the Canvas drawing left out
 * but for the spring, which the drop draws as strokes, not art
 * (`SPRING_STROKES`, `springPoints`).
 *
 * **The drop is the authority.** Every number is copied, not tuned;
 * `robotrigs.spec.ts` (server) checks this port against poses sampled from the
 * drop's own modules (`tools/peep-rig-sync.mjs hopper`).
 *
 * A head on a coiled spring on one boot: it hops to move, and strikes with the
 * spring. Its eye sits in the head's own space, `EYE_SIZE` big (`eyeMatrix`).
 * Locked in the lobby and not selectable.
 */

const TAU = Math.PI * 2
const RAD = Math.PI / 180

/** The body's clips (`legacy-motion.mjs`); its shoot is never played, `CLIPS` has the eye shot's. */
const BODY_CLIPS: Readonly<Record<ClipName | 'reference', Clip>> = {
  reference: { duration: 1, loop: false, events: [] },
  idle: { duration: 2.4, loop: true, events: [] },
  run: { duration: 0.7, loop: true, events: [] },
  shoot: { duration: 0.6, loop: false, events: [{ time: 0.10, name: 'fire' }] },
  swing: { duration: 1.05, loop: false, events: [{ time: 0.39, name: 'melee_hit' }] },
  jump: { duration: 1.4, loop: false, events: [{ time: 0.25, name: 'takeoff' }, { time: 1, name: 'land' }] },
  hit: { duration: 0.7, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: { duration: 2.4, loop: false, events: [{ time: 0.16, name: 'detach' }] }
}

export function clampAngle (x: number = 0): number {
  return Math.max(-60, Math.min(60, Number.isFinite(x) ? x : 0))
}

function strideCurve (a: number, b: number, v: number, t: number): number {
  return (2 * t * t * t - 3 * t * t + 1) * a + (t * t * t - 2 * t * t + t) * v + (-2 * t * t * t + 3 * t * t) * b + (t * t * t - t * t) * v
}

function smooth (x: number): number {
  x = Math.max(0, Math.min(1, x))
  return x * x * (3 - 2 * x)
}

function rotate (x: number, y: number, r: number): { x: number, y: number } {
  return { x: x * Math.cos(r * RAD) - y * Math.sin(r * RAD), y: x * Math.sin(r * RAD) + y * Math.cos(r * RAD) }
}

/** After the drop's deletes: `grip`/`grip_tip` gone, `eye_muzzle`/`muzzle` on the head (`eyeshot.ts` places them). */
export const BONE_PARENTS: Readonly<Record<string, string | null>> = {
  root: null,
  foot: 'root',
  spring: 'root',
  head: 'root',
  eye: 'head',
  eye_muzzle: 'head',
  muzzle: 'head'
}

/** The spring, from the boot's ankle to the head; also re-solved after a recoil. */
function poseLegs (st: RigState): void {
  const top = { x: st.head.x, y: st.head.y }
  const ankle = rotate(0, 31, st.foot.r)
  const bottom = { x: st.foot.x + ankle.x, y: st.foot.y + ankle.y }
  const dx = top.x - bottom.x
  const dy = top.y - bottom.y
  st.spring = { x: bottom.x, y: bottom.y, r: -Math.atan2(dx, dy) / RAD }
  st.springLength = Math.hypot(dx, dy)
}

function poseUpper (st: RigState, options: PoseOptions = {}): void {
  const aim = clampAngle(options.aimAngle)
  const look = clampAngle(options.lookAngle ?? aim)
  st.head.r += look * 0.5 + 6 * smooth(Math.max(0, look) / 60)
  st.eye = {
    x: 32 + look / 60 * 2,
    y: 43 + look / 60 * 3,
    r: 0,
    sx: 1 - 0.06 * Math.abs(look / 60),
    sy: 1 - 0.94 * Math.max(0, Math.min(1, options.blink ?? 0)),
    expression: (options.expression as Expression | undefined) ?? 'open'
  }
  st.grip = { x: 47, y: 41, r: aim - st.head.r }
  st.grip_tip = { x: 0, y: 0, r: 0 }
  st.controls = { aimAngle: aim, lookAngle: look, sensorPitch: st.head.r, headTilt: st.head.r }
}

function state (p = 0, reference = false, options: PoseOptions = {}): RigState {
  p = (p % 1 + 1) % 1
  const hop = reference ? 0 : Math.max(0, Math.sin(TAU * p))
  const compression = reference ? 0 : 8 * Math.sin(TAU * p + 0.25)
  const st = {
    root: { x: 0, y: 0, r: 0 },
    foot: {
      x: reference ? 0 : p < 0.5 ? strideCurve(-8, 8, -16, p / 0.5) : 8 - 16 * (p - 0.5) / 0.5,
      y: hop * 13,
      r: reference ? 0 : -5 * Math.sin(TAU * p) * hop
    },
    head: { x: reference ? 0 : 4 * Math.sin(TAU * p), y: 102 + hop * 13 - compression, r: reference ? 0 : 3 * Math.sin(TAU * p - 0.4) }
  } as unknown as RigState
  poseLegs(st)
  poseUpper(st, options)
  return st
}

function at (name: string, bone: string, art: string, w: number, h: number, px = 0.5, py = 0.5, extra: Partial<Region> = {}): Region {
  return { name, bone, art, w, h, x: (0.5 - px) * w, y: (py - 0.5) * h, r: 0, sx: 1, sy: 1, ...extra }
}

/** Every drawn part, back to front. The spring is strokes (`SPRING_STROKES`), not its art. */
export const REGIONS: readonly Region[] = [
  at('boot', 'foot', 'boot_near', 70, 47, 0.5, 1),
  at('spring', 'spring', 'spring', 32, 84, 0.5, 80 / 84, { kind: 'spring' }),
  at('head', 'head', 'head', 112, 101, 0.5, 0.91),
  at('eye', 'eye', 'eye_open', 38, 52, 0.5, 0.5, { kind: 'eye' })
]

export const EYE_SIZE = { w: 38, h: 52 }

/**
 * The reference pose's height, rig units: the top of the head's box, 193.9
 * (from the fixtures), not measured from the art's alpha as Peep's 245.5 was.
 */
export const REFERENCE_UNITS = 193.91

/**
 * The eye's matrix, for an image centred on the origin `EYE_SIZE` units big:
 * in the head's space, at the eye's place, scaled by it (y flipped), squashed
 * to a slit when closed. The drop clips it to the lens; that mask is left out,
 * as the other robots' are.
 */
export function eyeMatrix (m: Record<string, Matrix>, eye: Bone & { expression?: Expression }): Matrix {
  const k = eye.expression === 'closed' ? 0.07 : 1
  return multiply(m.head, { a: eye.sx ?? 1, b: 0, c: 0, d: -(eye.sy ?? 1) * k, x: eye.x, y: eye.y })
}

/** The drop's `drawSpring`: the same coil stroked three times, dark to light, in the spring bone's space. */
export const SPRING_STROKES: ReadonlyArray<{ width: number, color: number }> = [
  { width: 7, color: 0x060e17 },
  { width: 4.7, color: 0x435263 },
  { width: 1.6, color: 0xa3bdc8 }
]

/** The coil's points for a spring `length` long: 4 turns, 192 steps, flat x/y pairs. */
export function springPoints (length = 66): number[] {
  const turns = 4
  const steps = 192
  const out: number[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    out.push(12 * Math.sin(t * turns * TAU), t * length + 3 * (Math.cos(t * turns * TAU) - 1))
  }
  return out
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
  const st = state(0, true, { aimAngle: 0, lookAngle: 0 })
  let height = 0
  const flash = 0
  let squeeze = 0
  if (name === 'idle') {
    const a = MTWO * t / 2.4
    st.head.y += 2 * Math.sin(a)
    st.head.x = 1.2 * Math.sin(a)
    st.head.r = 0.7 * Math.sin(a)
  }
  if (name === 'hit') {
    const k = motionKeys(t, [[0, 0], [0.06, 1], [0.17, 0.7], [0.31, -0.22], [0.46, 0.08], [0.7, 0]])
    st.head.x = -12 * k
    st.head.y -= 16 * Math.max(k, 0)
    st.head.r = 9 * k
    squeeze = motionKeys(t, [[0, 0], [0.05, 1], [0.18, 1], [0.34, 0], [0.7, 0]])
  }
  if (name === 'swing') {
    st.head.x = motionKeys(t, [[0, 0], [0.23, -14], [0.28, -14], [0.39, 34], [0.47, 29], [0.68, -6], [0.84, 2], [1.05, 0]])
    st.head.y += motionKeys(t, [[0, 0], [0.23, -18], [0.39, -9], [0.50, -13], [0.72, 4], [1.05, 0]])
    st.head.r = motionKeys(t, [[0, 0], [0.23, 13], [0.39, -20], [0.52, -15], [0.77, 3], [1.05, 0]])
  }
  if (name === 'jump') {
    const a = motionClamp((t - 0.25) / 0.75)
    height = t > 0.25 && t < 1 ? 66 * 4 * a * (1 - a) : 0
    st.root.y = height
    st.head.y += motionKeys(t, [[0, 0], [0.17, -26], [0.25, 10], [0.40, 13], [0.72, 1], [1, 0], [1.07, -22], [1.22, 5], [1.4, 0]])
    st.head.r = motionKeys(t, [[0, 0], [0.17, 4], [0.35, -5], [0.8, -2], [1.08, 5], [1.4, 0]])
  }
  if (name === 'fall_apart') {
    const f = motionSmooth(t / 0.16)
    st.head.r = 7 * f
    squeeze = 0.8 * f
  }
  poseLegs(st)
  poseUpper(st, options)
  st.eye.sy *= 1 - 0.94 * squeeze
  st.animation = { name, time: t, height, flash, eyeOpacity: 1, detached: false }
  return st
}

interface DebrisGroup { id: string, bones: string[], vx: number, vy: number, spin: number, bounce: number, floor: number, gravity?: number }

export const DEBRIS_GROUPS: readonly DebrisGroup[] = [
  { id: 'head', bones: ['head', 'eye'], vx: 42, vy: 52, spin: 115, bounce: 0.15, floor: 1 },
  { id: 'spring', bones: ['spring'], vx: -58, vy: 92, spin: -185, bounce: 0.30, floor: 1 },
  { id: 'boot', bones: ['foot'], vx: -24, vy: 20, spin: -50, bounce: 0.12, floor: 0 }
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
  const animation: AnimationInfo = { name: 'fall_apart', time: t, height: 0, flash: 0, eyeOpacity: Math.max(0, 1 - (t - 0.16) / 0.20) * 0.6, detached: true, parts }
  st.animation = animation
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

const HOPPER_BODY = Object.freeze({
  id: 'hopper' as const,
  clips: BODY_CLIPS,
  pose: bodyPose,
  matrices,
  regions: REGIONS,
  muzzleParent: 'head',
  poseLegs
})

/** The pose of `name` at `seconds` into it, eye shot and all. */
export function animationPose (name: ClipName | 'reference', seconds: number, options: PoseOptions = {}): Pose {
  return eyeShotPose(HOPPER_BODY, CLIPS, name, seconds, options)
}
