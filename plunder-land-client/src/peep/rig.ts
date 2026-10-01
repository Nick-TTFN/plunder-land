import { HULLS } from './hulls'
import { eyeShotPose, shotClips, type ShotEye } from '../robots/eyeshot'

/**
 * Peep's skeletal rig and its seven clips: a TypeScript port of the v16 drop's
 * `tools/rig.mjs` and `tools/legacy-motion.mjs` (codex_output, 2026-10-01),
 * with the Canvas drawing left out, under the eye shot every robot shares
 * (`src/robots/eyeshot.ts`, its `animations.mjs`). Pose in, bone matrices
 * out; `RobotSprite` draws. v16 took the gun away: the far hand is bare, the
 * shot comes from the eye, and aim turns the head, not the arm.
 *
 * **The drop is the authority.** Every number here is copied, not tuned: the
 * rig was validated there (head clearance, planted feet, wrists joined), and
 * `peeprig.spec.ts` (server) checks this port against poses sampled from the
 * original modules (`tools/peep-rig-sync.mjs`). Change a number here only by
 * taking a new drop.
 *
 * Pixi-free so the server's specs can load it.
 *
 * Coordinates are rig units, y up, origin on the ground between the feet,
 * facing right. Angles are degrees, positive counter-clockwise (up). Aim is
 * -60 to +60 relative to the facing; `facing` itself is a mirror applied by the
 * drawer, not here.
 */

const TAU = Math.PI * 2
const DEG = 180 / Math.PI
const MRAD = Math.PI / 180

export interface Bone { x: number, y: number, r: number, sx?: number, sy?: number }
export interface Matrix { a: number, b: number, c: number, d: number, x: number, y: number }
export type Expression = 'open' | 'smile' | 'closed'

export interface EyeBone extends Bone { sx: number, sy: number, expression: Expression }

export interface PoseOptions {
  /** Degrees, clamped to +-60. Positive aims up. */
  aimAngle?: number
  /** Where the eye looks, degrees; follows the aim when absent. */
  lookAngle?: number
  /** 'shoot' runs the eye shot on the clip's own clock (`eyeshot.ts`). */
  expression?: Expression | 'shoot'
  /** 0-1 eyelid closure, on its own clock (`blinkClosure`). */
  blink?: number
  /** Seconds since an eye shot started charging, laid over whatever clip plays (`eyeshot.ts`). */
  eyeShootTime?: number | null
  /** Magnet's magnet, apart from the aim; the others ignore it. */
  magnetAngle?: number
}

export interface Debris { id: string, x: number, y: number, angle: number, grounded: boolean }

export interface AnimationInfo {
  name: ClipName | 'reference'
  time: number
  /** Jump height of the root, for the shadow. */
  height: number
  /** The eye shot's burst at the fire, 0-1 (`ShotEye.flash`). */
  flash: number
  eyeOpacity: number
  detached: boolean
  parts?: Debris[]
}

export type RigState = Record<string, Bone> & {
  eye: EyeBone
  controls: Record<string, unknown>
  animation: AnimationInfo
  /** The eye shot while it shows, else null (`eyeshot.ts`). */
  shootEye?: ShotEye | null
  /** Hopper's spring, rig units from the boot to the head. */
  springLength?: number
}

export interface Pose { state: RigState, matrices: Record<string, Matrix> }

export type ClipName = 'idle' | 'run' | 'shoot' | 'hit' | 'swing' | 'jump' | 'fall_apart'

export interface Clip { duration: number, loop: boolean, events: Array<{ time: number, name: string }> }

/** The body's clips (`legacy-motion.mjs`); its shoot is never played, `CLIPS` has the eye shot's. */
const BODY_CLIPS: Readonly<Record<ClipName | 'reference', Clip>> = {
  idle: { duration: 2.4, loop: true, events: [] },
  run: { duration: 0.6, loop: true, events: [] },
  shoot: { duration: 0.5, loop: false, events: [{ time: 0.05, name: 'fire' }] },
  hit: { duration: 0.6, loop: false, events: [{ time: 0, name: 'hurt' }] },
  swing: { duration: 0.85, loop: false, events: [{ time: 0.30, name: 'melee_hit' }] },
  jump: { duration: 1.2, loop: false, events: [{ time: 0.24, name: 'takeoff' }, { time: 0.86, name: 'land' }] },
  fall_apart: { duration: 2.2, loop: false, events: [{ time: 0.14, name: 'detach' }] },
  reference: { duration: 1, loop: false, events: [] }
}

// ---------------------------------------------------------------- rig.mjs

const TRAVEL = 24 / 0.38
export const AIM_LIMIT = 60

const wrap = (p: number): number => (p % 1 + 1) % 1

function hermite (a: number, b: number, va: number, vb: number, t: number): number {
  return (2 * t ** 3 - 3 * t * t + 1) * a + (t ** 3 - 2 * t * t + t) * va + (-2 * t ** 3 + 3 * t * t) * b + (t ** 3 - t * t) * vb
}

function foot (p: number): { x: number, y: number, r: number, contact: boolean } {
  p = wrap(p)
  if (p < 0.38) return { x: 12 - TRAVEL * p, y: 0, r: 0, contact: true }
  const q = (p - 0.38) / 0.62
  return {
    x: hermite(-12, 12, -TRAVEL * 0.62, -TRAVEL * 0.62, q),
    y: 12 * Math.sin(Math.PI * q) ** 1.6,
    r: -11 * Math.sin(TAU * q) * Math.sin(Math.PI * q),
    contact: false
  }
}

function bounce (p: number): number {
  const q = wrap(p * 2)
  const keys = [[0, 50, -24], [0.2, 47, 0], [0.78, 53.5, 0], [1, 50, -24]]
  let i = 0
  while (q > keys[i + 1][0]) i++
  const a = keys[i]
  const b = keys[i + 1]
  const dt = b[0] - a[0]
  return hermite(a[1], b[1], a[2] * dt, b[2] * dt, (q - a[0]) / dt)
}

function rotate (x: number, y: number, r: number): { x: number, y: number } {
  r /= DEG
  return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) }
}

function solveLeg (h: { x: number, y: number }, a: { x: number, y: number }, bend: number): { thigh: number, shin: number } {
  const l1 = 16
  const l2 = 16.5
  const dx = a.x - h.x
  const dy = a.y - h.y
  const d = Math.hypot(dx, dy)
  if (d > l1 + l2 - 0.01) throw Error(`Unreachable leg ${d}`)
  const ang = Math.atan2(dy, dx) + bend * Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * Math.max(0.001, d)))))
  const knee = { x: h.x + l1 * Math.cos(ang), y: h.y + l1 * Math.sin(ang) }
  const end = Math.atan2(a.y - knee.y, a.x - knee.x)
  return { thigh: ang * DEG + 90, shin: (end - ang) * DEG }
}

function runState (p: number, reference: boolean): Record<string, Bone> {
  p = wrap(p)
  const body = {
    x: reference ? 0 : 0.65 * Math.sin(TAU * p),
    y: reference ? 50 : bounce(p),
    r: reference ? 0 : -3.4 + 0.9 * Math.sin(2 * TAU * p - 0.4)
  }
  const result: Record<string, Bone> = {
    root: { x: 0, y: 0, r: 0 },
    body,
    head: {
      x: 3 + (reference ? 0 : 0.3 * Math.sin(TAU * p - 0.4)),
      y: 48 + (reference ? 0 : 0.65 * Math.sin(2 * TAU * p - 0.9)),
      r: reference ? 0 : 2.8 - 0.6 * Math.sin(2 * TAU * p - 1.0)
    },
    arm_near: { x: -29, y: 28, r: reference ? 10 : 10 - 16 * Math.cos(TAU * p + 0.18) },
    arm_far: { x: 29, y: 29, r: reference ? 65 : 65 + 2.1 * Math.sin(TAU * p - 0.3) },
    grip: { x: 11.2, y: -20.3, r: 0 },
    grip_tip: { x: 48, y: 0, r: 0 }
  }
  result.grip.r = reference ? -65 : -result.arm_far.r - body.r + 0.5 * Math.sin(2 * TAU * p - 0.5)
  for (const [side, shift, x, plane] of [['near', 0, -29, 0], ['far', 0.5, 27, 6]] as const) {
    const f = reference ? { x: 0, y: 0, r: 0, contact: true } : foot(p + shift)
    const ft = { x: x + f.x, y: plane + f.y, r: f.r, contact: f.contact }
    result['foot_' + side] = ft
    const hip = rotate(side === 'near' ? -19 : 19, side === 'near' ? 0 : 6, body.r)
    hip.x += body.x
    hip.y += body.y
    const ankle = rotate(0, side === 'near' ? 37.4 : 35, ft.r)
    ankle.x += ft.x
    ankle.y += ft.y
    const ik = solveLeg(hip, ankle, side === 'near' ? 1 : -1)
    result['thigh_' + side] = { x: hip.x, y: hip.y, r: ik.thigh }
    result['shin_' + side] = { x: 0, y: -16, r: ik.shin }
  }
  return result
}

const HEAD = { neckPivot: { x: 0, y: 45 }, aimFollow: 0.5, upwardClearance: { start: 30, end: 60, degrees: 5 } }
const FOREARM = { x: (157 / 265 - 0.33) * 29, y: (0.2 - 200 / 310) * 35 }
const WRIST_FROM_GRIP = rotate(FOREARM.x - 11.2, FOREARM.y + 20.3, 65)
const FOREARM_LENGTH = Math.hypot(FOREARM.x, FOREARM.y)
const FOREARM_AXIS = Math.atan2(FOREARM.y, FOREARM.x) * DEG

/**
 * Each bone and its parent, in an order where a parent precedes its children.
 * The drop deletes `grip_tip` (the old muzzle) and adds `eye_muzzle` and
 * `muzzle` on the head, which `eyeshot.ts` places itself.
 */
export const BONE_PARENTS: Readonly<Record<string, string | null>> = {
  root: null,
  body: 'root',
  neck: 'body',
  head: 'neck',
  eye: 'head',
  thigh_far: 'root',
  shin_far: 'thigh_far',
  foot_far: 'root',
  arm_far: 'body',
  forearm_far: 'arm_far',
  hand_far: 'forearm_far',
  grip: 'hand_far',
  thigh_near: 'root',
  shin_near: 'thigh_near',
  foot_near: 'root',
  arm_near: 'body',
  eye_muzzle: 'head',
  muzzle: 'head'
}

export function clampAngle (a: number = 0): number {
  return Math.max(-AIM_LIMIT, Math.min(AIM_LIMIT, Number.isFinite(a) ? a : 0))
}

export function headTiltForAim (angle: number = 0): number {
  const aim = clampAngle(angle)
  const clearance = HEAD.upwardClearance
  const t = Math.max(0, Math.min(1, (aim - clearance.start) / (clearance.end - clearance.start)))
  return aim * HEAD.aimFollow + clearance.degrees * t * t * (3 - 2 * t)
}

/** Eyelid closure 0-1, `seconds` after a blink started; 0 once it is over (0.16 s). */
export function blinkClosure (seconds: number): number {
  if (seconds < 0 || seconds >= 0.16) return 0
  const smooth = (x: number): number => x * x * (3 - 2 * x)
  if (seconds < 0.045) return smooth(seconds / 0.045)
  if (seconds < 0.075) return 1
  return 1 - smooth((seconds - 0.075) / 0.085)
}

function state (p: number, reference: boolean, options: PoseOptions): RigState {
  const st = runState(p, reference) as RigState
  const body = st.body
  const oldArm = st.arm_far
  const aim = clampAngle(options.aimAngle)
  const look = clampAngle(options.lookAngle ?? aim)
  const headTilt = headTiltForAim(look)
  const neck = HEAD.neckPivot
  st.neck = { x: neck.x, y: neck.y, r: headTilt }
  st.head = { ...st.head, x: st.head.x - neck.x, y: st.head.y - neck.y }
  const shoulder = rotate(oldArm.x, oldArm.y, body.r)
  shoulder.x += body.x
  shoulder.y += body.y
  const restGrip = rotate(11.2, -20.3, body.r + oldArm.r + aim)
  const grip = { x: shoulder.x + restGrip.x, y: shoulder.y + restGrip.y }
  const offset = rotate(WRIST_FROM_GRIP.x, WRIST_FROM_GRIP.y, aim)
  const wrist = { x: grip.x + offset.x, y: grip.y + offset.y }
  const dx = wrist.x - shoulder.x
  const dy = wrist.y - shoulder.y
  const d = Math.hypot(dx, dy)
  const shellR = Math.atan2(dy, dx) * DEG - FOREARM_AXIS
  const shellScale = d / FOREARM_LENGTH
  st.arm_far = { x: oldArm.x, y: oldArm.y, r: shellR - body.r, sx: shellScale, sy: shellScale }
  st.forearm_far = { x: 0, y: 0, r: 0 }
  st.hand_far = { x: FOREARM.x, y: FOREARM.y, r: aim - shellR, sx: 1 / shellScale, sy: 1 / shellScale }
  st.grip = { x: -WRIST_FROM_GRIP.x, y: -WRIST_FROM_GRIP.y, r: 0 }
  const t = look / 60
  const dxEye = 10 * t - 6 * t * t
  const dyEye = -30.5 * t + 5.5 * t * t
  st.eye = {
    x: 3 + ((356 + dxEye) / 428 - 0.5) * 178,
    y: 68 + (0.5 - (211 + dyEye) / 388) * 159,
    r: 0,
    sx: 1 - 0.08 * Math.abs(t),
    sy: (1 - 0.20 * Math.abs(t)) * (1 - 0.93 * Math.max(0, Math.min(1, options.blink ?? 0))),
    expression: (options.expression as Expression | undefined) ?? 'open'
  }
  st.controls = { aimAngle: aim, lookAngle: look, headTilt, grip, wrist, shoulder, shellScale }
  return st
}

export function matrices (st: RigState): Record<string, Matrix> {
  const m: Record<string, Matrix> = {}
  for (const [name, parent] of Object.entries(BONE_PARENTS)) {
    const b = st[name]
    if (b === undefined) continue
    const r = b.r / DEG
    const a = Math.cos(r) * (b.sx ?? 1)
    const c = -Math.sin(r) * (b.sy ?? 1)
    const bb = Math.sin(r) * (b.sx ?? 1)
    const d = Math.cos(r) * (b.sy ?? 1)
    if (parent === null) m[name] = { a, b: bb, c, d, x: b.x, y: b.y }
    else {
      const p = m[parent]
      m[name] = {
        a: p.a * a + p.c * bb,
        b: p.b * a + p.d * bb,
        c: p.a * c + p.c * d,
        d: p.b * c + p.d * d,
        x: p.a * b.x + p.c * b.y + p.x,
        y: p.b * b.x + p.d * b.y + p.y
      }
    }
  }
  return m
}

export interface Region {
  name: string
  bone: string
  /** Frame name in `peep.json`, without the `peep/` prefix. */
  art: string
  /** Size in rig units, whatever the texture's size. */
  w: number
  h: number
  x: number
  y: number
  r: number
  sx: number
  sy: number
  kind?: 'eye' | 'spring'
}

function at (name: string, bone: string, art: string, w: number, h: number, px = 0.5, py = 0.5, extra: Partial<Region> = {}): Region {
  return { name, bone, art, w, h, x: (0.5 - px) * w, y: (py - 0.5) * h, r: 0, sx: 1, sy: 1, ...extra }
}

/** Every drawn part, back to front. */
export const REGIONS: readonly Region[] = [
  at('thigh_far', 'thigh_far', 'thigh', 15, 23, 0.5, 0.15),
  at('shin_far', 'shin_far', 'shin', 14, 23, 0.5, 0.15),
  at('boot_far', 'foot_far', 'boot_far', 57, 44, 0.5, 1),
  at('forearm_far', 'forearm_far', 'forearm_far', 29, 35, 0.33, 0.20),
  at('thigh_near', 'thigh_near', 'thigh', 16, 23, 0.5, 0.15),
  at('shin_near', 'shin_near', 'shin', 15, 24, 0.5, 0.15),
  at('boot_near', 'foot_near', 'boot_near', 62, 47, 0.5, 1),
  at('torso', 'body', 'torso', 76, 68, 0.5, 0.5, { y: 18 }),
  at('arm_near', 'arm_near', 'arm_near', 28, 39, 0.32, 0.19, { x: -5.04, sx: -1 }),
  at('head', 'head', 'head', 178, 159, 0.5, 1, { x: 3, y: 68 }),
  at('eye', 'eye', 'eye_open', 144 / 428 * 178, 198 / 388 * 159, 0.5, 0.5, { kind: 'eye' }),
  at('visor_reflection', 'head', 'visor_reflection', 178, 159, 0.5, 0.5, { x: 3, y: 68 }),
  at('hand_far', 'grip', 'hand_far', 29, 35, 0.5, 0.5, { ...rotate(4.93 - 11.2, -10.5 + 20.3, 65), r: 65 })
]

/**
 * The matrix that maps a region's image, centred on the origin and `w` x `h`
 * units, into rig space (y up): what `drawPose` builds with ctx.transform,
 * translate, rotate and scale(sx, -sy) before its drawImage.
 */
export function regionMatrix (bone: Matrix, r: Region): Matrix {
  const rad = r.r * MRAD
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // translate(r.x, r.y) . rotate(r.r) . scale(r.sx, -r.sy)
  const la = cos * r.sx
  const lb = sin * r.sx
  const lc = sin * r.sy
  const ld = -cos * r.sy
  return multiply(bone, { a: la, b: lb, c: lc, d: ld, x: r.x, y: r.y })
}

/**
 * The eye's matrix, for an image centred on the origin in the head art's
 * pixels (144 x 198): the drop draws it in head space, not on its own bone.
 */
export function eyeMatrix (head: Matrix, eye: EyeBone): Matrix {
  const sx = 178 / 428
  const sy = -159 / 388
  const px = (eye.x + 86) * 428 / 178
  const py = (147.5 - eye.y) * 388 / 159
  const esy = eye.sy * (eye.expression === 'closed' ? 0.07 : 1)
  // translate(-86, 147.5) . scale(sx, sy) . translate(px, py) . scale(eye.sx, esy)
  return multiply(head, { a: sx * eye.sx, b: 0, c: 0, d: sy * esy, x: -86 + sx * px, y: 147.5 + sy * py })
}

export function multiply (p: Matrix, q: Matrix): Matrix {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    x: p.a * q.x + p.c * q.y + p.x,
    y: p.b * q.x + p.d * q.y + p.y
  }
}

// ---------------------------------------------------------- animations.mjs

const motionClamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x))
const motionSmooth = (x: number): number => {
  x = motionClamp(x)
  return x * x * (3 - 2 * x)
}
const motionRotate = (x: number, y: number, a: number): { x: number, y: number } => ({
  x: x * Math.cos(a * MRAD) - y * Math.sin(a * MRAD),
  y: x * Math.sin(a * MRAD) + y * Math.cos(a * MRAD)
})
const motionPoint = (m: Matrix, x: number, y: number): { x: number, y: number } => ({ x: m.a * x + m.c * y + m.x, y: m.b * x + m.d * y + m.y })

function motionKeys (t: number, keys: Array<[number, number]>): number {
  if (t <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [a, v] = keys[i - 1]
      const [b, w] = keys[i]
      const s = motionSmooth((t - a) / (b - a))
      return v + (w - v) * s
    }
  }
  return keys[keys.length - 1][1]
}

/** A body clip's local time: looping clips wrap, one-shots clamp to their end. */
function bodyClipTime (name: ClipName | 'reference', seconds: number): number {
  const clip = BODY_CLIPS[name]
  const t = Number.isFinite(seconds) ? seconds : 0
  return clip.loop ? ((t % clip.duration) + clip.duration) % clip.duration : motionClamp(t, 0, clip.duration)
}

function poseLegs (st: RigState): void {
  for (const [side, x, plane] of [['near', -29, 0], ['far', 27, 6]] as const) {
    void x
    const f = st['foot_' + side]
    const hip = motionRotate(side === 'near' ? -19 : 19, plane, st.body.r)
    hip.x += st.body.x
    hip.y += st.body.y
    const ankle = motionRotate(0, side === 'near' ? 37.4 : 35, f.r)
    ankle.x += f.x
    ankle.y += f.y
    const dx = ankle.x - hip.x
    const dy = ankle.y - hip.y
    const d = Math.hypot(dx, dy)
    const l1 = 16
    const l2 = 16.5
    if (d > l1 + l2 + 1e-6) throw Error(`Animation leg unreachable: ${side} ${d}`)
    const c = motionClamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * Math.max(d, 0.001)), -1, 1)
    const angle = Math.atan2(dy, dx) + (side === 'near' ? 1 : -1) * Math.acos(c)
    const knee = { x: hip.x + l1 * Math.cos(angle), y: hip.y + l1 * Math.sin(angle) }
    st['thigh_' + side] = { x: hip.x, y: hip.y, r: angle / MRAD + 90 }
    st['shin_' + side] = { x: 0, y: -16, r: (Math.atan2(ankle.y - knee.y, ankle.x - knee.x) - angle) / MRAD }
  }
}

function poseArm (st: RigState, heading: number, arc: number = heading): void {
  const relativeR = 65 + arc
  const worldR = st.body.r + relativeR
  st.arm_far = { x: 29, y: 29, r: relativeR, sx: 1, sy: 1 }
  st.forearm_far = { x: 0, y: 0, r: 0 }
  st.hand_far = { x: FOREARM.x, y: FOREARM.y, r: heading - worldR, sx: 1, sy: 1 }
  const a = motionRotate(29, 29, st.body.r)
  const w = motionRotate(FOREARM.x, FOREARM.y, worldR)
  const shoulder = { x: a.x + st.body.x, y: a.y + st.body.y }
  const wrist = { x: shoulder.x + w.x, y: shoulder.y + w.y }
  const o = motionRotate(st.grip.x, st.grip.y, heading)
  st.controls = { ...st.controls, aimAngle: heading, shoulder, wrist, grip: { x: wrist.x + o.x, y: wrist.y + o.y }, shellScale: 1 }
}

function standingPose (name: ClipName, t: number, options: PoseOptions): RigState {
  const st = state(0, true, options)
  const aim = clampAngle(options.aimAngle)
  let heading = aim
  let armArc = aim
  let eyeOpacity = 1
  let flash = 0
  let height = 0
  if (name === 'idle') {
    const p = TAU * t / CLIPS.idle.duration
    st.body.x = 0.65 * Math.sin(p)
    st.body.y += 0.8 * Math.sin(p)
    st.body.r = 0.55 * Math.sin(p)
    st.head.y += 0.35 * (Math.sin(p - 0.45) + Math.sin(0.45))
    st.head.r = -0.35 * Math.sin(p)
    st.arm_near.r += 1.8 * Math.sin(p - 0.2) + 1.8 * Math.sin(0.2)
  }
  if (name === 'hit') {
    const flinch = motionKeys(t, [[0, 0], [0.055, 1], [0.115, 0.86], [0.245, -0.12], [0.36, 0.06], [0.6, 0]])
    const headLag = motionKeys(t, [[0, 0], [0.025, 0], [0.09, 1], [0.15, 0.85], [0.30, -0.12], [0.43, 0.05], [0.6, 0]])
    const squeeze = motionKeys(t, [[0, 0], [0.025, 0.35], [0.055, 1], [0.115, 1], [0.21, 0], [0.6, 0]])
    st.body.x = -5.2 * flinch
    st.body.y -= 2.1 * Math.max(0, flinch)
    st.body.r = 7.5 * flinch
    st.head.r = 4 * headLag
    st.head.y -= 0.35 * headLag
    st.arm_near.r -= 15 * flinch
    heading = clampAngle(aim - 6 * flinch)
    armArc = aim - 12 * flinch
    st.eye.sy *= 1 - 0.94 * squeeze
  }
  if (name === 'swing') {
    const sweep = motionKeys(t, [[0, 0], [0.20, 72], [0.235, 72], [0.345, -58], [0.42, -60], [0.57, -29], [0.73, 4], [0.85, 0]])
    const lean = motionKeys(t, [[0, 0], [0.215, 11], [0.345, -12], [0.43, -10], [0.62, -2], [0.73, 1], [0.85, 0]])
    st.body.x = motionKeys(t, [[0, 0], [0.215, -4.5], [0.345, 9.5], [0.46, 7], [0.69, -0.7], [0.85, 0]])
    st.body.y += motionKeys(t, [[0, 0], [0.215, -2.7], [0.345, -2], [0.50, -1.2], [0.85, 0]])
    st.body.r = lean
    st.arm_near.r += motionKeys(t, [[0, 0], [0.215, -35], [0.345, 38], [0.50, 23], [0.70, -4], [0.85, 0]])
    heading = motionClamp(aim + sweep, -60, 75)
    armArc = heading
    st.head.r = motionKeys(t, [[0, 0], [0.215, -2.5], [0.345, 4.5], [0.46, 3.2], [0.62, -0.7], [0.85, 0]])
  }
  if (name === 'jump') {
    const launch = 0.24
    const land = 0.86
    const air = motionClamp((t - launch) / (land - launch))
    const tuck = t > launch && t < land ? Math.sin(Math.PI * air) : 0
    height = t > launch && t < land ? 48 * 4 * air * (1 - air) : 0
    const crouch = motionKeys(t, [[0, 0], [0.16, -6], [0.24, 0], [0.86, 0], [0.93, -6], [1.04, -1.5], [1.2, 0]])
    st.root.y = height
    st.body.y += crouch + 1.7 * tuck
    st.body.r = motionKeys(t, [[0, 0], [0.16, 2], [0.24, -2], [0.50, 1], [0.86, -2], [0.94, 2], [1.2, 0]])
    st.foot_near.x -= 5 * tuck
    st.foot_near.y += 4 * tuck
    st.foot_near.r = -10 * tuck
    st.foot_far.x += 4 * tuck
    st.foot_far.y += 3 * tuck
    st.foot_far.r = 8 * tuck
    st.arm_near.r += motionKeys(t, [[0, 0], [0.16, -9], [0.28, 20], [0.60, 12], [0.86, 0], [0.95, -5], [1.2, 0]])
    st.head.y += 0.7 * tuck
    st.head.r = motionKeys(t, [[0, 0], [0.24, 1], [0.50, -1], [0.86, 1], [1.2, 0]])
  }
  if (name === 'fall_apart') {
    const hit = motionSmooth(t / 0.14)
    st.body.x = -2.5 * hit
    st.body.y -= 1.2 * hit
    st.body.r = 4.5 * hit
    st.head.r = 2.5 * hit
    st.arm_near.r -= 8 * hit
    armArc = aim - 5 * hit
    st.eye.sy *= 1 - 0.78 * hit
    eyeOpacity = 1 - 0.25 * hit
  }
  poseLegs(st)
  poseArm(st, heading, armArc)
  st.neck.r = headTiltForAim(options.lookAngle ?? options.aimAngle)
  if (name === 'shoot' || name === 'swing') {
    // Continue the neck-led turn during the larger action arc, with a smooth
    // clearance bias above +60. Counter forward torso lean when aiming high.
    // Inert as of v16, as in the drop: `eyeshot.ts` sets Peep's neck from the
    // look afterwards, and the body is posed at aim 0. Kept so a diff against
    // the drop's `legacy-motion.mjs` stays clean.
    const extra = Math.max(0, heading - 60)
    st.neck.r += extra * 0.5 + 6 * motionSmooth(extra / 15)
    st.neck.r += Math.max(0, -st.body.r) * motionSmooth((heading - 25) / 35)
  }
  st.controls.headTilt = st.neck.r
  st.animation = { name, time: t, height, flash, eyeOpacity, detached: false }
  return st
}

interface DebrisGroup { id: string, bones: string[], vx: number, vy: number, spin: number, bounce: number, floor: number }

export const DEBRIS_GROUPS: readonly DebrisGroup[] = [
  { id: 'head', bones: ['head', 'eye'], vx: -90, vy: 55, spin: -115, bounce: 0.22, floor: 2 },
  { id: 'torso', bones: ['body', 'neck'], vx: 42, vy: 42, spin: 125, bounce: 0.20, floor: 2 },
  { id: 'arm_near', bones: ['arm_near'], vx: -190, vy: 110, spin: -310, bounce: 0.28, floor: 0 },
  { id: 'forearm_far', bones: ['arm_far', 'forearm_far'], vx: 80, vy: 145, spin: 280, bounce: 0.25, floor: 5 },
  { id: 'hand_far', bones: ['grip', 'hand_far'], vx: 95, vy: 115, spin: 250, bounce: 0.18, floor: 1 },
  { id: 'thigh_near', bones: ['thigh_near'], vx: -53, vy: 125, spin: -280, bounce: 0.24, floor: 0 },
  { id: 'shin_near', bones: ['shin_near'], vx: -78, vy: 85, spin: 310, bounce: 0.23, floor: 0 },
  { id: 'thigh_far', bones: ['thigh_far'], vx: 49, vy: 100, spin: 290, bounce: 0.22, floor: 5 },
  { id: 'shin_far', bones: ['shin_far'], vx: 69, vy: 72, spin: -270, bounce: 0.20, floor: 5 },
  { id: 'boot_near', bones: ['foot_near'], vx: -27, vy: 18, spin: -72, bounce: 0.13, floor: 0 },
  { id: 'boot_far', bones: ['foot_far'], vx: 29, vy: 23, spin: 85, bounce: 0.14, floor: 6 }
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
    if (!grounded) vy -= 680 * dt
    x += vx * dt
    y += vy * dt
    angle += spin * dt
    const floor = group.floor + motionSupport(points, angle)
    if (y <= floor) {
      y = floor
      if (!grounded && vy < -24) {
        vy = -vy * group.bounce
        vx *= 0.57
        spin *= 0.52
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
  const st = standingPose('fall_apart', 0.14, options)
  const rest = matrices(st)
  const m = { ...rest }
  const parts: Debris[] = []
  for (const group of DEBRIS_GROUPS) {
    const geometry = HULLS[group.id]
    const bone = rest[group.bones[0]]
    const origin = motionPoint(bone, geometry.center[0], geometry.center[1])
    const startAngle = Math.atan2(bone.b, bone.a) / MRAD
    const p = simulatePiece(group, geometry.points, origin, startAngle, t - 0.14)
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
  st.animation = { name: 'fall_apart', time: t, height: 0, flash: 0, eyeOpacity: Math.max(0, 1 - (t - 0.14) / 0.20) * 0.6, detached: true, parts }
  return { state: st, matrices: m }
}

/** The body's pose: `legacy-motion.mjs`'s `animationPose`. */
function bodyPose (name: ClipName | 'reference', seconds: number, options: PoseOptions = {}): Pose {
  const t = bodyClipTime(name, seconds)
  if (name === 'run' || name === 'reference') {
    const st = state(name === 'run' ? t / 0.6 : 0, name === 'reference', options)
    st.animation = { name, time: t, height: 0, flash: 0, eyeOpacity: 1, detached: false }
    return { state: st, matrices: matrices(st) }
  }
  if (name === 'fall_apart' && t > 0.14) return detachedPose(t, options)
  const st = standingPose(name, t, options)
  return { state: st, matrices: matrices(st) }
}

/** The clips as played: the body's, and the eye shot's `shoot`. */
export const CLIPS = shotClips(BODY_CLIPS)

/** The pose of `name` at `seconds` into it, eye shot and all. */
export function animationPose (name: ClipName | 'reference', seconds: number, options: PoseOptions = {}): Pose {
  return eyeShotPose(PEEP_BODY, CLIPS, name, seconds, options)
}

const PEEP_BODY = Object.freeze({
  id: 'peep' as const,
  clips: BODY_CLIPS,
  pose: bodyPose,
  matrices,
  regions: REGIONS,
  muzzleParent: 'head',
  headTiltForAim
})
