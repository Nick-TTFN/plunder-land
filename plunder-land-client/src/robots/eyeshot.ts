import { type Bone, type ClipName, type Clip, type Matrix, type Pose, type PoseOptions, type Region, type RigState } from '../peep/rig'

/**
 * Every robot shoots from its eye (2026-10-01, the eye-firing drops: Peep v16,
 * Magnet v3, Periscope v3, Hopper v2, Waddle v2). A port of the drops'
 * `tools/animations.mjs`, which is the same file in all five but for its
 * `robotId`: the body's clips (each robot's own `legacy-motion.mjs`, ported in
 * `src/<robot>/rig.ts`) with the guns gone, and the eye shot laid over them.
 *
 * - The shot is an eye state, `SHOT.duration` long: two rings close in on the
 *   eye's focus until `SHOT.fire`, where a bright dot fires, then the normal
 *   eye comes back. `shootEyeState` is it at a time.
 * - The `shoot` clip is the reference pose with a small recoil per robot after
 *   the fire. `eyeShootTime` lays the eye shot over any other clip (idle, run)
 *   without the recoil; `expression: 'shoot'` runs it on the clip's clock.
 * - Aim no longer moves an arm: the body is posed at aim 0 and the aim turns
 *   the head and eye (`lookAngle` defaults to it). `eye_muzzle` (and `muzzle`,
 *   its alias) is the shot's origin: the centre of the eye regions, pointed
 *   along the aim.
 *
 * Pixi-free, like the rigs, so the server's specs can load it.
 */

export type RobotId = 'peep' | 'magnet' | 'periscope' | 'hopper' | 'waddle'

export const SHOT = Object.freeze({ duration: 0.8, fire: 0.36, recoveryStart: 0.48, recoveryEnd: 0.68, rings: 2 })

export interface ShotEye {
  active: boolean
  time: number
  phase: 'charge' | 'release'
  /** The outer ring's radius, as a fraction of the robot's `shot.radius`. */
  radius: number
  concentration: number
  /** The dot's burst at the fire, 1 falling to 0 over 0.09 s. */
  flash: number
  dotOpacity: number
  /** The normal eye's opacity under the shot. */
  eyeOpacity: number
  rings: number
  /** The eye region the rings are drawn on (Waddle's first eye, offset to between both). */
  primaryRegion?: string
}

/** What the overlay needs of one robot's body: its own port of `rig.mjs` and `legacy-motion.mjs`. */
export interface BodyRig {
  readonly id: RobotId
  /** The body's clips; its `shoot` is never played. */
  readonly clips: Readonly<Record<ClipName | 'reference', Clip>>
  readonly pose: (name: ClipName | 'reference', seconds: number, options: PoseOptions) => Pose
  readonly matrices: (st: RigState) => Record<string, Matrix>
  readonly regions: readonly Region[]
  /** `boneParents.eye_muzzle`: the head, or Periscope's sensor. */
  readonly muzzleParent: string
  /** Peep's and Magnet's neck follow the look. */
  readonly headTiltForAim?: (angle: number) => number
  /** Hopper and Waddle re-solve their legs after the recoil. */
  readonly poseLegs?: (st: RigState) => void
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
const smooth = (x: number): number => {
  x = clamp01(x)
  return x * x * (3 - 2 * x)
}
const clampAim = (a: number = 0): number => Math.max(-60, Math.min(60, Number.isFinite(a) ? a : 0))
const angleOf = (m: Matrix): number => Math.atan2(m.b, m.a) * 180 / Math.PI

/** The body's clips with `shoot` replaced by the eye shot's. */
export function shotClips (body: Readonly<Record<ClipName | 'reference', Clip>>): Readonly<Record<ClipName | 'reference', Clip>> {
  return Object.freeze({
    ...body,
    shoot: { duration: SHOT.duration, loop: false, events: [{ time: 0, name: 'charge' }, { time: SHOT.fire, name: 'fire' }] }
  })
}

function clipTime (clips: Readonly<Record<ClipName | 'reference', Clip>>, name: ClipName | 'reference', t: number): number {
  const c = clips[name]
  t = Number.isFinite(t) ? t : 0
  return c.loop ? ((t % c.duration) + c.duration) % c.duration : Math.max(0, Math.min(c.duration, t))
}

export function shootEyeState (t: number): ShotEye {
  const fire = SHOT.fire
  const recover = smooth((t - SHOT.recoveryStart) / (SHOT.recoveryEnd - SHOT.recoveryStart))
  const p = clamp01(t / fire)
  return {
    active: t >= 0 && t < SHOT.recoveryEnd,
    time: t,
    phase: t < fire ? 'charge' : 'release',
    radius: t < fire ? (1 - p) ** 1.12 : 0,
    concentration: p,
    flash: t >= fire ? Math.max(0, 1 - (t - fire) / 0.09) : 0,
    dotOpacity: 1 - recover,
    eyeOpacity: recover,
    rings: 2
  }
}

/** The pose of `name` at `seconds` into it, the eye shot included: the drop's `animationPose`. */
export function eyeShotPose (body: BodyRig, clips: Readonly<Record<ClipName | 'reference', Clip>>, name: ClipName | 'reference', seconds: number, options: PoseOptions = {}): Pose {
  const id = body.id
  const t = clipTime(clips, name, seconds)
  const aim = clampAim(options.aimAngle)
  const requestedLook = clampAim(options.lookAngle ?? aim)
  const eyeTime = name === 'shoot'
    ? t
    : options.eyeShootTime ?? (options.expression === 'shoot' ? Math.max(0, seconds) % SHOT.duration : null)
  const shot = eyeTime === null ? null : shootEyeState(eyeTime)
  const recoverLook = name === 'shoot' ? smooth((t - 0.48) / 0.32) : 0
  const look = shot?.active === true || name === 'shoot' ? aim + (requestedLook - aim) * recoverLook : requestedLook
  const poseOptions: PoseOptions = {
    ...options,
    aimAngle: 0,
    lookAngle: look,
    blink: shot?.active === true ? 0 : options.blink,
    expression: shot?.active === true || options.expression === 'shoot' ? 'open' : options.expression
  }
  const pose = body.pose(name === 'shoot' ? 'reference' : name, name === 'shoot' ? 0 : t, poseOptions)
  const st = pose.state
  if (!st.animation.detached) {
    if (id === 'peep') st.neck.r = body.headTiltForAim!(look)
    if (id === 'magnet') {
      const mag = (st.controls.magnetAngle as number | undefined) ?? 0
      const tilt = body.headTiltForAim!(look)
      const need = -10 + 0.7 * mag - tilt
      st.neck.r = tilt + Math.max(0, need) * smooth(need / 6) + 14 * smooth((mag - 15) / 23)
    }
    if (name === 'shoot') {
      const dt = t - SHOT.fire
      const k = dt < 0 ? 0 : Math.sin(Math.PI * clamp01(dt / 0.36)) * Math.exp(-dt * 7) * 2.2
      if (id === 'hopper') {
        st.head.x -= 5 * k
        st.head.y -= 4 * k
        body.poseLegs!(st)
      } else if (id === 'waddle') {
        st.body.x -= 2.3 * k
        st.body.y -= 1.8 * k
        st.body.r += 1.8 * k
        body.poseLegs!(st)
      } else if (id === 'periscope') {
        st.neck_lower.r += 2 * k
        st.neck_upper.r += 2 * k
        st.sensor.r -= 2 * k
      } else st.head.r += 3 * k
    }
    // Periscope's unarmed swing uses its chassis weight and sensor follow-through.
    if (name === 'swing' && id === 'periscope') {
      const q = t / clips.swing.duration
      const bump = Math.sin(Math.PI * q) ** 2 * Math.sin(2 * Math.PI * q)
      st.neck_lower.r += 4 * bump
      st.neck_upper.r += 3 * bump
      st.sensor.r -= 4 * bump
    }
    pose.matrices = body.matrices(st)
  }
  const eyeRegions = body.regions.filter((r) => r.kind === 'eye')
  if (shot?.active === true && !st.animation.detached) {
    shot.primaryRegion = eyeRegions[0].name
    st.shootEye = shot
    for (const r of eyeRegions) {
      const eye = st[r.bone] as Bone & { expression?: string }
      eye.sy = 1
      eye.expression = 'open'
    }
    pose.matrices = body.matrices(st)
  } else st.shootEye = null

  // The shot's origin: between the eyes, pointed along the aim.
  const centres = eyeRegions.map((r) => pose.matrices[r.bone])
  const cx = centres.reduce((s, m) => s + m.x, 0) / centres.length
  const cy = centres.reduce((s, m) => s + m.y, 0) / centres.length
  const pm = pose.matrices[body.muzzleParent]
  const a = aim * Math.PI / 180
  const det = pm.a * pm.d - pm.b * pm.c
  const dx = cx - pm.x
  const dy = cy - pm.y
  const local = { x: (pm.d * dx - pm.c * dy) / det, y: (-pm.b * dx + pm.a * dy) / det, r: aim - angleOf(pm) }
  st.eye_muzzle = local
  st.muzzle = { ...local }
  pose.matrices.eye_muzzle = { a: Math.cos(a), b: Math.sin(a), c: -Math.sin(a), d: Math.cos(a), x: cx, y: cy }
  pose.matrices.muzzle = { ...pose.matrices.eye_muzzle }
  for (const key of ['grip_tip', 'mount', ...(id === 'peep' ? [] : ['grip'])]) {
    delete st[key] // eslint-disable-line @typescript-eslint/no-dynamic-delete
    delete pose.matrices[key] // eslint-disable-line @typescript-eslint/no-dynamic-delete
  }
  st.controls = { ...st.controls, aimAngle: aim, lookAngle: look, requestedLookAngle: requestedLook, emitter: 'eye_muzzle' }
  st.animation = { ...st.animation, name, time: t, flash: shot?.flash ?? 0 }
  return pose
}

/** One stroke or fill of the charged eye, in the eye's drawing space (`RobotRig.eyeMatrix`, then `shot.offset`). */
export interface ShotMark {
  kind: 'stroke' | 'fill'
  r: number
  /** Line width, for a stroke. */
  lw: number | null
  color: number
  alpha: number
}

/**
 * The drop's `drawChargedEye` as a list of marks: the two rings while it
 * charges, each a wide orange stroke under a thin pale one, then the dot, an
 * orange disc under a pale one. `radius` is the robot's (`RobotRig.shot`),
 * `alpha` what the eye is drawn at (the clip's `eyeOpacity`). The drop's
 * Canvas glow (`shadowBlur`) isn't a mark; `RobotSprite` approximates it.
 */
export function chargedEyeMarks (shot: ShotEye, radius: number, alpha: number): ShotMark[] {
  const marks: ShotMark[] = []
  const lw = Math.max(radius * 0.07, 0.48)
  const rr = radius * shot.radius
  if (shot.phase === 'charge') {
    for (const [scale, ringAlpha] of [[1, 1], [0.62, 0.88]]) {
      alpha *= ringAlpha
      const r = Math.max(0.2, rr * scale)
      marks.push({ kind: 'stroke', r, lw: lw * 2.6, color: 0xff8e15, alpha })
      marks.push({ kind: 'stroke', r, lw, color: 0xfff1a0, alpha })
    }
  }
  const dot = shot.phase === 'charge' ? radius * (0.035 + 0.04 * shot.concentration) : radius * (0.075 + 0.07 * shot.flash)
  marks.push({ kind: 'fill', r: Math.max(0.45, dot * 1.65), lw: null, color: 0xff9b19, alpha: shot.dotOpacity })
  marks.push({ kind: 'fill', r: Math.max(0.3, dot), lw: null, color: 0xfff8d5, alpha: shot.dotOpacity })
  return marks
}
