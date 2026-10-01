import { HULLS } from './hulls'
import {
  type AnimationInfo, type Bone, type ClipName, type Debris, type Matrix, type Pose,
  type PoseOptions, type Region, type RigState, blinkClosure, regionMatrix, eyeMatrix
} from '../peep/rig'

export { blinkClosure, regionMatrix, eyeMatrix }

/**
 * Magnet's skeletal rig and its seven clips: a TypeScript port of the v2 drop's
 * `tools/rig.mjs` and `tools/animations.mjs` (`codex_output/magnet-animations-v2`,
 * 2026-09-30), with the Canvas drawing left out, like Peep's (`src/peep/rig.ts`,
 * whose types, region and eye maths it shares: the drop keeps Peep's head art
 * and conventions).
 *
 * **The drop is the authority.** Every number is copied, not tuned;
 * `magnetrig.spec.ts` (server) checks this port against poses sampled from the
 * drop's own modules (`tools/peep-rig-sync.mjs magnet`).
 *
 * Magnet differs from Peep in anatomy: the gun is on the near arm (aim origin
 * the near shoulder, 95 up), the far arm carries the magnet, which follows 30%
 * of the aim unless given its own (`magnetAngle`), and swings for melee. Its
 * head is Peep's at 0.72 on a lower neck.
 */

const TAU = Math.PI * 2
const DEG = 180 / Math.PI
const MRAD = Math.PI / 180

export interface MagnetPoseOptions extends PoseOptions {
  /** The magnet's own target, degrees, clamped to -26..30; 30% of the aim when absent. */
  magnetAngle?: number
}

export const CLIPS: Readonly<Record<ClipName | 'reference', { duration: number, loop: boolean, events: Array<{ time: number, name: string }> }>> = {
  idle: { duration: 2.4, loop: true, events: [] },
  run: { duration: 0.7, loop: true, events: [] },
  shoot: { duration: 0.5, loop: false, events: [{ time: 0.05, name: 'fire' }] },
  hit: { duration: 0.65, loop: false, events: [{ time: 0, name: 'hurt' }] },
  swing: { duration: 1.1, loop: false, events: [{ time: 0.42, name: 'melee_hit' }] },
  jump: { duration: 1.3, loop: false, events: [{ time: 0.26, name: 'takeoff' }, { time: 0.90, name: 'land' }] },
  fall_apart: { duration: 2.4, loop: false, events: [{ time: 0.16, name: 'detach' }] },
  reference: { duration: 1, loop: false, events: [] }
}

// ---------------------------------------------------------------- rig.mjs

const TRAVEL = 24 / 0.40

const wrap = (p: number): number => (p % 1 + 1) % 1

function rotate (x: number, y: number, r: number): { x: number, y: number } {
  return { x: x * Math.cos(r / DEG) - y * Math.sin(r / DEG), y: x * Math.sin(r / DEG) + y * Math.cos(r / DEG) }
}

function smooth (x: number): number {
  x = Math.max(0, Math.min(1, x))
  return x * x * (3 - 2 * x)
}

function hermite (a: number, b: number, va: number, vb: number, t: number): number {
  return (2 * t ** 3 - 3 * t * t + 1) * a + (t ** 3 - 2 * t * t + t) * va + (-2 * t ** 3 + 3 * t * t) * b + (t ** 3 - t * t) * vb
}

function foot (p: number): { x: number, y: number, r: number, contact: boolean } {
  p = wrap(p)
  if (p < 0.40) return { x: 12 - TRAVEL * p, y: 0, r: 0, contact: true }
  const q = (p - 0.40) / 0.60
  return {
    x: hermite(-12, 12, -TRAVEL * 0.60, -TRAVEL * 0.60, q),
    y: 11 * Math.sin(Math.PI * q) ** 1.6,
    r: -10 * Math.sin(TAU * q) * Math.sin(Math.PI * q),
    contact: false
  }
}

export function clampAngle (a: number = 0): number {
  return Math.max(-60, Math.min(60, Number.isFinite(a) ? a : 0))
}

const HEAD = { neckPivot: { x: 0, y: 55 }, scale: 0.72 }
const FOREARM = { x: (157 / 265 - 0.33) * 29, y: (0.2 - 200 / 310) * 35 }
const NEAR = { socket: { x: -34, y: 28 }, scale: 1, restAngle: -20 }
const FAR = { socket: { x: 36, y: 35 }, scale: 1.5, restAngle: 65 }
const MAGNET_PIVOT = { x: 0.111, y: 0.455 }
const GUN_SCALE = 0.76

/** Parent before child: `matrices` walks this in order. */
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
  magnet: 'forearm_far',
  magnet_tip: 'magnet',
  thigh_near: 'root',
  shin_near: 'thigh_near',
  foot_near: 'root',
  arm_near: 'body',
  forearm_near: 'arm_near',
  hand_near: 'forearm_near',
  weapon: 'hand_near',
  muzzle: 'weapon'
}

export function headTiltForAim (a: number = 0): number {
  const aim = clampAngle(a)
  return aim * 0.35 + 3 * smooth((aim - 30) / 30)
}

function poseLegs (st: RigState): void {
  for (const [side, plane] of [['near', 0], ['far', 6]] as const) {
    const f = st['foot_' + side]
    const hip = rotate(side === 'near' ? -20 : 20, plane, st.body.r)
    hip.x += st.body.x
    hip.y += st.body.y
    const ankle = rotate(0, side === 'near' ? 37.4 : 35, f.r)
    ankle.x += f.x
    ankle.y += f.y
    const dx = ankle.x - hip.x
    const dy = ankle.y - hip.y
    const d = Math.hypot(dx, dy)
    const l1 = 22
    const l2 = 22
    if (d > l1 + l2 + 1e-6) throw Error('Magnet leg unreachable: ' + side + ' ' + d)
    const c = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * Math.max(d, 0.001))))
    const a = Math.atan2(dy, dx) + (side === 'near' ? 1 : -1) * Math.acos(c)
    const k = { x: hip.x + l1 * Math.cos(a), y: hip.y + l1 * Math.sin(a) }
    st['thigh_' + side] = { x: hip.x, y: hip.y, r: a * DEG + 90 }
    st['shin_' + side] = { x: 0, y: -l1, r: (Math.atan2(ankle.y - k.y, ankle.x - k.x) - a) * DEG }
  }
}

function poseAttachments (st: RigState, heading: number, magnetHeading: number, nearOffset = 0, farOffset = 0): void {
  magnetHeading = Math.max(-26, Math.min(36, magnetHeading))
  const nr = NEAR.restAngle + clampAngle(heading) * 0.35 + nearOffset
  const fr = FAR.restAngle + magnetHeading + farOffset
  st.arm_near = { ...NEAR.socket, r: nr, sx: NEAR.scale, sy: NEAR.scale }
  st.forearm_near = { x: 0, y: 0, r: 0 }
  st.hand_near = { x: (0.66 - 0.32) * 28, y: (0.19 - 0.82) * 39, r: heading - st.body.r - nr, sx: 1 / NEAR.scale, sy: 1 / NEAR.scale }
  st.weapon = { x: 4, y: 0, r: 0 }
  st.muzzle = { x: 48 * GUN_SCALE, y: 0, r: 0 }
  st.arm_far = { ...FAR.socket, r: fr, sx: FAR.scale, sy: FAR.scale }
  st.forearm_far = { x: 0, y: 0, r: 0 }
  st.magnet = { x: FOREARM.x, y: FOREARM.y, r: magnetHeading - st.body.r - fr, sx: 1 / FAR.scale, sy: 1 / FAR.scale }
  st.magnet_tip = { x: 92, y: 0, r: 0 }
  const headAim = headTiltForAim(heading)
  const clearanceNeed = (-10 + 0.7 * magnetHeading) - headAim
  // The raised magnet must also clear a head looking down at an independent gun target.
  const clearance = Math.max(0, clearanceNeed) * smooth(clearanceNeed / 6)
  st.neck = { ...HEAD.neckPivot, r: headAim + clearance + 14 * smooth((magnetHeading - 15) / 23) }
  st.controls = { ...st.controls, aimAngle: heading, magnetAngle: magnetHeading, headTilt: st.neck.r }
}

function state (p: number, reference: boolean, options: MagnetPoseOptions): RigState {
  p = wrap(p)
  const aim = clampAngle(options.aimAngle)
  const look = clampAngle(options.lookAngle ?? aim)
  const t = look / 60
  const st = {
    root: { x: 0, y: 0, r: 0 },
    body: {
      x: reference ? 0 : 0.7 * Math.sin(TAU * p),
      y: reference ? 67 : 67 - 2.6 * Math.cos(TAU * 2 * p),
      r: reference ? 0 : -3.2 + 0.8 * Math.sin(TAU * 2 * p - 0.3)
    },
    head: {
      x: 3,
      y: 3 + (reference ? 0 : 0.6 * Math.sin(TAU * 2 * p - 0.7)),
      r: reference ? 0 : 2 - 0.8 * Math.sin(TAU * 2 * p - 0.8),
      sx: HEAD.scale,
      sy: HEAD.scale
    }
  } as unknown as RigState
  st.eye = {
    x: 3 + ((356 + 10 * t - 6 * t * t) / 428 - 0.5) * 178,
    y: 68 + (0.5 - (211 - 30.5 * t + 5.5 * t * t) / 388) * 159,
    r: 0,
    sx: 1 - 0.08 * Math.abs(t),
    sy: (1 - 0.20 * Math.abs(t)) * (1 - 0.93 * Math.max(0, Math.min(1, options.blink ?? 0))),
    expression: options.expression ?? 'open'
  }
  for (const [side, shift, x, plane] of [['near', 0, -31, 0], ['far', 0.5, 30, 6]] as const) {
    const f = reference ? { x: 0, y: 0, r: 0, contact: true } : foot(p + shift)
    st['foot_' + side] = { x: x + f.x, y: plane + f.y, r: f.r, contact: f.contact } as Bone
  }
  st.controls = { lookAngle: look }
  poseLegs(st)
  const mag = options.magnetAngle === undefined ? aim * 0.3 : Math.max(-26, Math.min(30, options.magnetAngle))
  poseAttachments(st, aim, mag + (reference ? 0 : 2.2 * Math.sin(TAU * p - 0.3)), reference ? 0 : 6 * Math.cos(TAU * p + 0.2))
  return st
}

function at (name: string, bone: string, art: string, w: number, h: number, px = 0.5, py = 0.5, extra: Partial<Region> = {}): Region {
  return { name, bone, art, w, h, x: (0.5 - px) * w, y: (py - 0.5) * h, r: 0, sx: 1, sy: 1, ...extra }
}

/** Every drawn part, back to front. `art` names a frame in `magnet.json`. */
export const REGIONS: readonly Region[] = [
  at('thigh_far', 'thigh_far', 'thigh', 16, 29, 0.5, 0.15),
  at('shin_far', 'shin_far', 'shin', 15, 29, 0.5, 0.15),
  at('boot_far', 'foot_far', 'boot_far', 57, 44, 0.5, 1),
  at('forearm_far', 'forearm_far', 'forearm_far', 29, 35, 0.33, 0.20),
  at('magnet', 'magnet', 'magnet', 108, 96, MAGNET_PIVOT.x, MAGNET_PIVOT.y),
  at('thigh_near', 'thigh_near', 'thigh', 17, 29, 0.5, 0.15),
  at('shin_near', 'shin_near', 'shin', 16, 30, 0.5, 0.15),
  at('boot_near', 'foot_near', 'boot_near', 62, 47, 0.5, 1),
  at('torso', 'body', 'torso', 80, 77, 0.5, 0.5, { y: 21 }),
  at('arm_near', 'forearm_near', 'arm_near', 28, 39, 0.32, 0.19),
  at('blaster', 'weapon', 'blaster', 55 * GUN_SCALE, 30 * GUN_SCALE, 0.12, 0.48),
  at('head', 'head', 'head', 178, 159, 0.5, 1, { x: 3, y: 68 }),
  at('eye', 'eye', 'eye_open', 144 / 428 * 178, 198 / 388 * 159, 0.5, 0.5, { kind: 'eye' }),
  at('visor_reflection', 'head', 'visor_reflection', 178, 159, 0.5, 0.5, { x: 3, y: 68 })
]

export function matrices (st: RigState): Record<string, Matrix> {
  const m: Record<string, Matrix> = {}
  for (const name in BONE_PARENTS) {
    const parent = BONE_PARENTS[name]
    const b = st[name]
    const r = b.r / DEG
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

export function clipTime (name: ClipName | 'reference', seconds: number): number {
  const clip = CLIPS[name]
  const t = Number.isFinite(seconds) ? seconds : 0
  return clip.loop ? ((t % clip.duration) + clip.duration) % clip.duration : motionClamp(t, 0, clip.duration)
}

function standingPose (name: ClipName, t: number, options: MagnetPoseOptions): RigState {
  const st = state(0, true, options)
  const aim = clampAngle(options.aimAngle)
  const magAim = options.magnetAngle === undefined ? aim * 0.3 : motionClamp(options.magnetAngle, -26, 30)
  let heading = aim
  let magHeading = magAim
  let nearOffset = 0
  let farOffset = 0
  let flash = 0
  let height = 0
  let eyeOpacity = 1
  if (name === 'idle') {
    const p = TAU * t / CLIPS.idle.duration
    st.body.x = 0.65 * Math.sin(p)
    st.body.y += 0.8 * Math.sin(p) + 0.12 * Math.sin(2 * p)
    st.body.r = 0.7 * Math.sin(p)
    st.head.y += 0.45 * (Math.sin(p - 0.5) + Math.sin(0.5))
    st.head.r = -0.6 * (Math.sin(p - 0.2) + Math.sin(0.2))
    nearOffset = 2.1 * Math.sin(p)
    magHeading += 1.8 * (Math.sin(p - 0.6) + Math.sin(0.6))
  }
  if (name === 'shoot') {
    // Fast recoil, then a delayed response from the head and heavy attachment.
    const kick = motionKeys(t, [[0, 0], [0.05, 0], [0.087, 1], [0.125, 0.84], [0.205, 0.24], [0.29, -0.12], [0.38, 0.035], [0.5, 0]])
    const lag = motionKeys(t, [[0, 0], [0.07, 0], [0.145, 1], [0.24, 0.42], [0.34, -0.10], [0.43, 0.025], [0.5, 0]])
    st.body.x = -6.8 * Math.cos(aim * MRAD) * kick
    st.body.y -= 2.2 * Math.max(0, kick)
    st.body.r = 9 * Math.cos(aim * MRAD) * kick
    st.head.r = 4 * lag
    heading = motionClamp(aim + 8 * kick, -60, 68)
    nearOffset = -14 * kick
    magHeading -= 5.2 * lag
    farOffset = -2.5 * kick
    flash = t >= 0.05 && t < 0.115 ? Math.pow(1 - (t - 0.05) / 0.065, 0.6) : 0
  }
  if (name === 'hit') {
    const flinch = motionKeys(t, [[0, 0], [0.05, 1], [0.105, 0.88], [0.21, 0.25], [0.31, -0.12], [0.44, 0.035], [0.65, 0]])
    const lag = motionKeys(t, [[0, 0], [0.025, 0], [0.115, 1], [0.18, 0.8], [0.34, -0.12], [0.49, 0.04], [0.65, 0]])
    const squeeze = motionKeys(t, [[0, 0], [0.045, 1], [0.145, 1], [0.26, 0], [0.65, 0]])
    st.body.x = -5.8 * flinch
    st.body.y -= 2.6 * Math.max(0, flinch)
    st.body.r = 8 * flinch
    st.head.r = 4.5 * lag
    heading = clampAngle(aim - 6 * flinch)
    nearOffset = -14 * flinch
    magHeading -= 6 * lag
    st.eye.sy *= 1 - 0.94 * squeeze
  }
  if (name === 'swing') {
    // A held wind-up makes the short downswing readable; the magnet settles last.
    const sweep = motionKeys(t, [[0, 0], [0.27, 34], [0.31, 34], [0.455, -27], [0.51, -28], [0.73, -12], [0.91, 3], [1.1, 0]])
    st.body.x = motionKeys(t, [[0, 0], [0.27, -5.5], [0.445, 8.2], [0.52, 6], [0.84, -0.6], [1.1, 0]])
    st.body.y += motionKeys(t, [[0, 0], [0.27, -3], [0.445, -1.7], [0.64, -1], [1.1, 0]])
    st.body.r = motionKeys(t, [[0, 0], [0.27, 8], [0.445, -9], [0.56, -6], [0.87, 1.2], [1.1, 0]])
    st.head.r = motionKeys(t, [[0, 0], [0.27, -2.3], [0.475, 4.5], [0.66, 2], [0.93, -0.6], [1.1, 0]])
    magHeading = motionClamp(magAim + sweep, -26, 36)
    nearOffset = motionKeys(t, [[0, 0], [0.27, -18], [0.455, 21], [0.71, 8], [1.1, 0]])
  }
  if (name === 'jump') {
    const launch = 0.26
    const land = 0.90
    const air = motionClamp((t - launch) / (land - launch))
    const tuck = t > launch && t < land ? Math.sin(Math.PI * air) : 0
    height = t > launch && t < land ? 46 * 4 * air * (1 - air) : 0
    st.root.y = height
    st.body.y += motionKeys(t, [[0, 0], [0.175, -7], [0.26, 0], [0.90, 0], [0.975, -7], [1.095, -1.5], [1.3, 0]]) + tuck
    st.body.r = motionKeys(t, [[0, 0], [0.175, 3], [0.275, -3], [0.57, 1], [0.90, -2], [0.975, 3.5], [1.3, 0]])
    st.foot_near.x -= 5 * tuck
    st.foot_near.y += 5 * tuck
    st.foot_near.r = -11 * tuck
    st.foot_far.x += 4 * tuck
    st.foot_far.y += 4 * tuck
    st.foot_far.r = 9 * tuck
    magHeading += motionKeys(t, [[0, 0], [0.20, -4], [0.36, 8], [0.69, 4], [0.90, -3], [1.07, 1.2], [1.3, 0]])
    nearOffset = motionKeys(t, [[0, 0], [0.175, -9], [0.35, 15], [0.72, 7], [0.975, -6], [1.3, 0]])
    st.head.r = motionKeys(t, [[0, 0], [0.20, 1.1], [0.36, -2], [0.75, -0.8], [0.995, 2.4], [1.12, -0.5], [1.3, 0]])
  }
  if (name === 'fall_apart') {
    const f = motionSmooth(t / 0.16)
    st.body.x = -3.2 * f
    st.body.y -= 1.7 * f
    st.body.r = 4.5 * f
    st.head.r = 2.4 * f
    nearOffset = -8 * f
    magHeading -= 3 * f
    st.eye.sy *= 1 - 0.78 * f
    eyeOpacity = 1 - 0.25 * f
  }
  poseLegs(st)
  poseAttachments(st, heading, magHeading, nearOffset, farOffset)
  st.animation = { name, time: t, height, flash, eyeOpacity, detached: false }
  return st
}

interface DebrisGroup { id: string, bones: string[], vx: number, vy: number, spin: number, bounce: number, floor: number, gravity?: number }

export const DEBRIS_GROUPS: readonly DebrisGroup[] = [
  { id: 'head', bones: ['head', 'eye'], vx: -65, vy: 60, spin: -110, bounce: 0.20, floor: 2 },
  { id: 'torso', bones: ['body', 'neck'], vx: 30, vy: 43, spin: 115, bounce: 0.18, floor: 2 },
  { id: 'arm_near', bones: ['arm_near', 'forearm_near', 'hand_near'], vx: -150, vy: 110, spin: -260, bounce: 0.22, floor: 0 },
  { id: 'forearm_far', bones: ['arm_far', 'forearm_far'], vx: 80, vy: 125, spin: 250, bounce: 0.22, floor: 5 },
  { id: 'magnet', bones: ['magnet', 'magnet_tip'], vx: 83, vy: 50, spin: -135, bounce: 0.08, floor: 2, gravity: 820 },
  { id: 'blaster', bones: ['weapon', 'muzzle'], vx: -75, vy: 115, spin: 240, bounce: 0.16, floor: 1 },
  { id: 'thigh_near', bones: ['thigh_near'], vx: -50, vy: 120, spin: -260, bounce: 0.22, floor: 0 },
  { id: 'shin_near', bones: ['shin_near'], vx: -70, vy: 80, spin: 270, bounce: 0.21, floor: 0 },
  { id: 'thigh_far', bones: ['thigh_far'], vx: 47, vy: 98, spin: 260, bounce: 0.22, floor: 5 },
  { id: 'shin_far', bones: ['shin_far'], vx: 67, vy: 72, spin: -250, bounce: 0.19, floor: 5 },
  { id: 'boot_near', bones: ['foot_near'], vx: -25, vy: 18, spin: -65, bounce: 0.12, floor: 0 },
  { id: 'boot_far', bones: ['foot_far'], vx: 28, vy: 23, spin: 80, bounce: 0.13, floor: 6 }
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

function detachedPose (t: number, options: MagnetPoseOptions): Pose {
  const st = standingPose('fall_apart', 0.16, options)
  const rest = matrices(st)
  const m = { ...rest }
  const parts: Debris[] = []
  for (const group of DEBRIS_GROUPS) {
    const geometry = HULLS[group.id]
    const bone = rest[group.bones[0]]
    const origin = motionPoint(bone, geometry.center[0], geometry.center[1])
    const startAngle = Math.atan2(bone.b, bone.a) / MRAD
    // Unlike Peep's, the support hull is scaled by the bone (the magnet's arm is 1.5x).
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
export function animationPose (name: ClipName | 'reference', seconds: number, options: MagnetPoseOptions = {}): Pose {
  const t = clipTime(name, seconds)
  if (name === 'run' || name === 'reference') {
    const st = state(name === 'run' ? t / CLIPS.run.duration : 0, name === 'reference', options)
    st.animation = { name, time: t, height: 0, flash: 0, eyeOpacity: 1, detached: false }
    return { state: st, matrices: matrices(st) }
  }
  if (name === 'fall_apart' && t > 0.16) return detachedPose(t, options)
  const st = standingPose(name, t, options)
  return { state: st, matrices: matrices(st) }
}
