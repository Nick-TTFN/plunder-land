import { type Matrix, multiply } from '../../peep/rig'
import { deepClone } from '../clone'
import { type NpcClip, type NpcDrawItem, type NpcDrawList, type NpcGait, type NpcPose, type NpcPoseOptions, type NpcRig } from '../npcrig'

/**
 * The Walking Kiln (l1-9): a hand port of `tools/kiln.mjs`, the Kiln's path
 * through `tools/rig.mjs` and `tools/fire.mjs` in its Codex package
 * (`codex_output/npc-refinements/kiln-v3`, not checked in). **PROVISIONAL**:
 * v3 (the hit, the fall apart and the furnace baked to PNG atlases) is
 * delivered but not yet approved by Nick (v2 was); a re-sync after his review
 * is expected (`tools/npc-rig-sync.mjs kiln`, `tools/bake-npc-atlas.py kiln`).
 *
 * Four legs on IK under a base that never turns, a canister on it with a
 * furnace in its mouth. `fire` is the lob: its `attack` event (0.58 s) is the
 * launch. `rig.mjs` is the packages' shared NPC core; only the Kiln's path
 * through it is ported (four legs, the `base` body, the `kiln` tool, the `lob`
 * attack), and not its `NpcController` (stateful foot planting: the game plays
 * the stateless clips, as for every rig). `npcrigs.spec.ts` checks the
 * evaluator and every drawn image and shape against the package
 * (`kiln.fixtures.json`).
 *
 * **The flame is drawn in code**, from the package's own `fire.mjs` (the
 * approved v2 furnace), at the frame v3's atlases would show (`furnaceFrame`:
 * the 6.4 s cycle at 30 frames a second, the charge in eighths, the bank
 * without embers for the hit and the fall apart). The 18 atlases are that
 * function rasterised (365 MiB of RGBA in the package's own words); they are
 * not shipped. Its gradient tongue is drawn flat (`approx`, not compared);
 * every other shape is the package's, its curves flattened as
 * `tools/npc-rig-sync.mjs` records them (`ARC_STEPS`, `CUBIC_STEPS`,
 * `QUAD_STEPS`). The furnace runs on the sprite's clock
 * (`NpcPoseOptions.clock`), never the clip's, as the package asks. The lob's
 * projectile is the game's (effect 9), not the package's demonstration.
 */

const TAU = Math.PI * 2

/** From `rig/animation-manifest.json`. */
export const CLIPS: Readonly<Record<string, NpcClip>> = Object.freeze({
  reference: { duration: 1, loop: false, events: [] },
  idle: { duration: 8.4, loop: true, events: [] },
  run: { duration: 1.18, loop: true, events: [] },
  fire: { duration: 1.7, loop: false, events: [{ time: 0.58, name: 'attack' }] },
  hit: { duration: 0.7, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: { duration: 2.8, loop: false, events: [{ time: 0.18, name: 'detach' }, { time: 2.8, name: 'settled' }] }
})

/** The lob's launch, seconds into `fire` (its `attack` event). */
export const LAUNCH = 0.58

// --- rig.mjs, the Kiln's profile only ---

const PROFILE = Object.freeze({ legs: 4, body: 'base', width: 98, height: 30, kind: 'lob', run: 1.18, power: 1.15 })
const TRIGGER = LAUNCH
const DUTY = 0.79
export const CONFIG = Object.freeze({ tilt: 0.68, bodyHeight: PROFILE.height, upperLength: 48, lowerLength: 70, stride: 20, duty: DUTY, nominalSpeed: 20 / DUTY / PROFILE.run, lift: 12 })
/**
 * The game's gait (decision #52 lane 4, the Crawler's treatment; PROVISIONAL
 * until Nick has seen it). The package's walk (stride 20) slid 93% at the
 * chase's 70 u/s (strand B). Its legs are already long for the body: a foot
 * stands at 0.80 of its leg's full reach at rest and the package's own walk
 * takes it to 0.87, so the stride grows only to 26, where the straightest
 * leg reaches 0.898 (the Crawler's rule: under 0.9; `npcrigs.spec.ts`).
 * `gaitClock` derives the rate from that sweep and the size. At size 1 planted
 * feet at the chase's 70 u/s needed 9.9 steps a second per leg, over
 * `maxSteps` 6, so they slid 39%; at 1.65 (size review, 2026-10-09) they
 * need 5.97, under the cap: planted at chase and idle (2.6 steps), up to
 * 70.3 u/s. `minPace` and `groundTilt` as the Crawler's.
 */
const GAME_STRIDE = 26
export const GAIT: NpcGait & { readonly stride: number } = Object.freeze({
  stride: GAME_STRIDE,
  groundSpeed: GAME_STRIDE / DUTY / CLIPS.run.duration,
  period: CLIPS.run.duration,
  maxSteps: 6,
  minPace: 0.2,
  groundTilt: 0.68
})
const IDLE_GESTURE = Object.freeze({ start: 5.2, duration: 0.95, leg: 0 })
/** The canister's width, rig units (`P.tool === 'kiln'`). */
const CANISTER_WIDTH = 55

interface Vec { x: number, y: number }
interface Vec3 { x: number, y: number, z: number }
interface Foot extends Vec3 { contact: boolean }

interface LegDef { id: string, side: number, row: number, phase: number, home: Vec, hip: Vec }

const LEGS: readonly LegDef[] = (() => {
  const out: LegDef[] = []
  for (const side of [-1, 1]) {
    for (const row of [-1, 1]) {
      const index = out.length
      out.push({ id: `leg_${side}_${row}`, side, row, phase: [0, 0.25, 0.5, 0.75][index], home: { x: side * 76, y: row * 59 }, hip: { x: side * 30, y: row * 29 } })
    }
  }
  // Kiln v2: spread the ground contacts; keep body sockets and link lengths.
  for (const leg of out) { leg.home.x = leg.side * 108; leg.home.y = leg.row * 71 }
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
  base: { w: 718, h: 756 },
  canister: { w: 336, h: 485 },
  upper: { w: 570, h: 242, start: { x: 76, y: 141 }, end: { x: 505, y: 141 } },
  lower: { w: 653, h: 232, start: { x: 76, y: 123 }, end: { x: 622, y: 207 } },
  joint: { w: 300, h: 305 }
})

/** Every image the draw list names, with its PNG size (`rig/parts.json`; the furnace atlases are drawn in code, see above). */
const ARTS: Readonly<Record<string, { readonly w: number, readonly h: number }>> = Object.freeze({
  base: { w: 718, h: 756 },
  canister: { w: 336, h: 485 },
  upper: { w: 570, h: 242 },
  lower: { w: 653, h: 232 },
  joint: { w: 300, h: 305 },
  'furnace-off': { w: 144, h: 192 },
  shadow: { w: 256, h: 128 }
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

/** `nominalSpeed`: the run's own ground speed, rig units per clip second (`CONFIG.nominalSpeed` at the package's stride). */
interface Performance { idleTime?: number, idleWeight?: number, phase?: number, speed?: number, velocity?: Vec, expression?: number, nominalSpeed?: number }

function presencePose (time: number, { idleTime = time, idleWeight = 1, phase = 0, speed = 0, velocity = { x: 0, y: 0 }, expression = 1, nominalSpeed = CONFIG.nominalSpeed }: Performance = {}): Presence {
  const t = wrap(idleTime / CLIPS.idle.duration) * CLIPS.idle.duration
  const breathe = Math.sin(TAU * t / 2.8)
  const inspect = windowPulse(t, 1.35, 4.8)
  const settle = windowPulse(t, 6.35, 8.15)
  const right = windowPulse(t, 1.8, 3.1)
  const left = windowPulse(t, 3.15, 4.65)
  const weight = windowPulse(t, 4.75, 6.45)
  const amount = Math.max(0, Math.min(1.5, expression))
  const w = idleWeight * amount * 0.19
  const effort = Math.min(1, speed / nominalSpeed)
  const runWeight = 1 - idleWeight
  return {
    x: w * (2.8 * Math.sin(TAU * t / 8.4) + 2.2 * (right - left) - 3.2 * weight) + runWeight * amount * velocity.x / nominalSpeed * 0.9,
    y: w * (1.4 * Math.sin(TAU * t / 4.2) - 1.8 * inspect),
    z: idleWeight * 0.3 * breathe + w * (1.6 * breathe + 4.4 * inspect - 3.6 * settle) + runWeight * (1 + amount * 0.75) * Math.sin(TAU * phase * 2) * effort,
    pitch: w * (0.035 * inspect - 0.028 * settle),
    roll: w * (0.028 * (right - left) - 0.025 * weight),
    sensorX: w * (2.2 * (right - left)) + runWeight * amount * velocity.x / nominalSpeed * 1.2,
    sensorY: w * (-1.15 * inspect) + runWeight * amount * velocity.y / nominalSpeed * 0.7,
    focus: 1 - 0.8 * w * windowPulse(t, 6.8, 7.2),
    glow: 0.7 + 0.3 * Math.sin(TAU * time / 2.8) + w * 0.35 * inspect,
    idleTime: t,
    idleWeight,
    expression: amount
  }
}

export interface KilnLeg extends LegDef {
  hip: Vec3
  knee: Vec3 & { reach: number }
  foot: Foot
  contact: boolean
  screen: { hip: Vec, knee: Vec, foot: Vec }
}

interface Region {
  name: string
  bone: string
  art: string
  leg?: string
  depth?: string
  clip?: { x: number, y: number, w: number, h: number }
  pivot?: Vec
  flat?: boolean
  furnace?: boolean
}

export interface KilnDebris { id: string, bones: string[], pivot: Vec, x: number, y: number, angle: number, dx: number, dy: number, releaseTime: number, settled: boolean }

export interface KilnState {
  root: { x: number, y: number, r: number }
  body: { x: number, y: number, z: number, r: number, pitch: number, roll: number }
  layout: Layout
  presence: Presence
  animation: { name: string, time: number, phase: number }
  legs: KilnLeg[]
  parts: Array<{ id: string, pivot: Vec, height: number, radius: number }>
  controls: { bodyRotation: number, speed: number }
  turret: { angle: number, center: Vec3, tip: Vec3, muzzle: Vec }
  aim: Vec
  fireTime: number
  effects?: Record<string, unknown> | null
  hitFlare?: number
  extinction?: number
  debris?: KilnDebris[]
  detached?: boolean
}

/** The package's whole pose (`animationPose`'s return). Only `state` is compared field by field; the matrices through what they draw. */
export interface KilnPose {
  state: KilnState
  matrices: Record<string, Matrix>
  regions: Region[]
}

interface PoseExtras { presenceOverride?: Presence, layout?: Layout, aimAngle?: number, velocity?: Vec, expression?: number, nominalSpeed?: number }

/** `composePose` for the Kiln: legs on IK, the base, the canister with its furnace. */
function composePose (name: string, time: number, feet: Foot[], phase = 0, speed = 0, performance: PoseExtras = {}): KilnPose {
  const presence = performance.presenceOverride ?? presencePose(time, { idleWeight: name === 'idle' ? 1 : 0, phase, speed, velocity: performance.velocity, expression: performance.expression, nominalSpeed: performance.nominalSpeed })
  const layout = performance.layout ?? defaultFrame()
  const bodyZ = CONFIG.bodyHeight + presence.z
  const state = {
    root: { x: 0, y: 0, r: layout.heading },
    body: { x: presence.x, y: presence.y, z: bodyZ, r: layout.heading, pitch: presence.pitch, roll: presence.roll },
    layout,
    presence,
    animation: { name, time, phase },
    legs: [],
    parts: [],
    controls: { bodyRotation: layout.heading, speed }
  } as unknown as KilnState
  const matrices: Record<string, Matrix> = {}
  const regions: Region[] = []
  /** The core's `sprite`: an image of `width` rig units centred on `at`, flat on the ground or standing (roll shears it, pitch squashes it). */
  const sprite = (id: string, key: 'base' | 'canister', width: number, at: Vec3, flat: boolean, pivot: Vec, furnace: boolean): void => {
    const shape = ART[key]
    const sc = width / shape.w
    const center = project(at)
    const a = sc * 1
    const b = sc * (flat ? 0 * CONFIG.tilt : -presence.roll)
    const c = flat ? -sc * 0 / CONFIG.tilt : 0
    const d = sc * 1 * (1 - presence.pitch * 0.5)
    matrices[id] = { a, b, c, d, x: center.x - a * shape.w * pivot.x - c * shape.h * pivot.y, y: center.y - b * shape.w * pivot.x - d * shape.h * pivot.y }
    regions.push(furnace ? { name: id, bone: id, art: key, flat, pivot, furnace } : { name: id, bone: id, art: key, pivot, flat })
    state.parts.push({ id, pivot: center, height: at.z, radius: width * 0.35 })
  }
  LEGS.forEach((l, i) => {
    const loc = placement(l, layout)
    const hip = { x: loc.hip.x + presence.x, y: loc.hip.y + presence.y, z: bodyZ - 3 + 0 + l.hip.y * presence.pitch + l.hip.x * presence.roll }
    const foot = feet[i]
    const knee = solveLeg(hip, foot)
    const hp = project(hip)
    const kp = project(knee)
    const fp = project(foot)
    matrices[l.id + '_upper'] = segmentMatrix(hp, kp, ART.upper)
    matrices[l.id + '_lower'] = segmentMatrix(kp, fp, ART.lower)
    matrices[l.id + '_joint'] = { a: 15 / ART.joint.w, b: 0, c: 0, d: 15 / ART.joint.h, x: kp.x - 7.5, y: kp.y - 7.5 }
    state.legs.push({ ...l, hip, knee, foot: { ...foot }, contact: foot.contact, screen: { hip: hp, knee: kp, foot: fp } })
  })
  // Rear assemblies stay behind. Foreground roots also stay below the shell.
  const front = state.legs.filter((l) => l.row > 0)
  const rear = state.legs.filter((l) => l.row < 0)
  for (const l of rear) for (const part of ['upper', 'lower', 'joint']) regions.push({ name: l.id + '_' + part, bone: l.id + '_' + part, art: part, leg: l.id, depth: 'rear' })
  for (const l of front) regions.push({ name: l.id + '_root', bone: l.id + '_upper', art: 'upper', leg: l.id, depth: 'root' })
  const center = { x: presence.x, y: presence.y, z: bodyZ }
  sprite('body', 'base', PROFILE.width, center, true, { x: 0.5, y: 0.5 }, false)
  // Redraw the distal upper plate only; the proximal connection remains covered.
  for (const l of front) {
    regions.push({ name: l.id + '_distal', bone: l.id + '_upper', art: 'upper', leg: l.id, depth: 'front', clip: { x: 265, y: 0, w: 305, h: 242 } })
    for (const part of ['lower', 'joint']) regions.push({ name: l.id + '_' + part, bone: l.id + '_' + part, art: part, leg: l.id, depth: 'front' })
  }
  const aimAngle = performance.aimAngle ?? -Math.PI / 4
  const idleScan = name === 'idle' ? 0.24 * (windowPulse(presence.idleTime ?? 0, 1.8, 3.1) - windowPulse(presence.idleTime ?? 0, 3.15, 4.65)) : 0
  const angle = aimAngle + idleScan
  const weaponCenter = { x: center.x, y: center.y, z: bodyZ + 23 }
  const tip = { x: weaponCenter.x + Math.cos(angle) * 43, y: weaponCenter.y + Math.sin(angle) * 43, z: weaponCenter.z }
  state.turret = { angle, center: weaponCenter, tip, muzzle: project(tip) }
  sprite('furnace', 'canister', CANISTER_WIDTH, { ...center, z: bodyZ + 3 }, false, { x: 0.5, y: 0.90 }, true)
  state.turret.center = { ...center, z: bodyZ + CANISTER_WIDTH * 0.9 }
  state.turret.tip = { ...state.turret.center }
  state.turret.muzzle = project(state.turret.tip)
  // The furnace's mouth on the canister art.
  const fm = matrices.furnace
  state.turret.muzzle = { x: fm.a * 168 + fm.c * 91 + fm.x, y: fm.b * 168 + fm.d * 91 + fm.y }
  state.aim = { x: Math.cos(angle), y: Math.sin(angle) }
  state.fireTime = time
  return { state, matrices, regions }
}

function pulseCore (t: number, peak: number, end: number): number { return t <= 0 || t >= end ? 0 : t < peak ? ease(t / peak) : 1 - ease((t - peak) / (end - peak)) }

export interface KilnOptions {
  directionX?: number
  directionY?: number
  aimX?: number
  aimY?: number
  expression?: number
  basePose?: KilnPose
  /** The furnace's clock for the lob (the package's `fireTime`); undefined is the clip's seconds. */
  fireTime?: number
  sourceClip?: string
  sourceTime?: number
  sourceOptions?: KilnOptions
  /**
   * The run's stride, rig units; default the package's `CONFIG.stride`. The
   * game runs a longer one (`GAIT.stride`, decision #52 lane 4). Its run
   * speed scales with it, so the run's lean and bob are the same at any stride.
   */
  stride?: number
}

/** The core's `actionPresence` for the lob. */
function firePresence (t: number, base: KilnPose, options: KilnOptions): { p: Presence, effects: Record<string, unknown>, aim: Vec } {
  const aim = normalized(options.aimX ?? 1, options.aimY ?? -0.5)
  const strength = (0.75 + 0.25 * clamp(options.expression ?? 1, 0, 1.5)) * PROFILE.power
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
  p.z += (-4.3 * charge - 3 * impact + 1.5 * recovery) * strength
  p.focus -= 0.4 * charge; p.glow += charge * 0.8
  // The lob's own: a lean back as it gathers, a lift and a push away as it throws.
  p.pitch -= 0.05 * charge; p.z += 8 * impact; p.x -= aim.x * 3 * impact; p.y -= aim.y * 3 * impact
  effects = { ...effects, charge, impact, attackTime: t - TRIGGER, kind: PROFILE.kind }
  p.focus = clamp(p.focus, 0.06, 1.2)
  return { p, effects, aim }
}

/** The core's `actionPose('fire', ...)`: the lob. */
function firePose (seconds: number, options: KilnOptions): KilnPose {
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, CLIPS.fire.duration)
  const base = options.basePose ?? legacyPose('idle', 0, options)
  const { p, effects, aim } = firePresence(t, base, options)
  const settle = ease(clamp(t / 0.14))
  const feet = base.state.legs.map((l) => ({ ...l.foot, z: l.foot.z * (1 - settle), contact: l.foot.contact || settle === 1 }))
  const initial = base.state.turret.angle
  const target = Math.atan2(aim.y, aim.x)
  const angle = initial + angleDelta(initial, target) * ease(clamp(t / 0.28))
  const pose = composePose('fire', t, feet, 0, 0, { presenceOverride: p, aimAngle: angle, layout: base.state.layout })
  pose.state.fireTime = options.fireTime ?? seconds
  effects.muzzle = pose.state.turret.muzzle; effects.aim = { x: Math.cos(angle), y: Math.sin(angle) }
  pose.state.effects = effects; pose.state.aim = effects.aim as Vec
  return pose
}

/** The core's stateless `animationPose` (`legacy` in `kiln.mjs`): reference, idle (with its toe lift), run along `directionX/Y`, or the lob. */
function legacyPose (name: string, seconds: number, options: KilnOptions = {}): KilnPose {
  if (name === 'shoot' || name === 'attack') name = 'fire'
  if (name === 'fire') return firePose(seconds, options)
  const clip = CLIPS[name]
  if (clip === undefined || name === 'hit' || name === 'fall_apart') throw Error('Unknown NPC clip: ' + name)
  const t = clip.loop ? wrap(seconds / clip.duration) * clip.duration : seconds
  const dir = normalized(options.directionX ?? 0, options.directionY ?? 1)
  const phase = t / CLIPS.run.duration
  const stride = options.stride ?? CONFIG.stride
  const nominalSpeed = options.stride === undefined ? CONFIG.nominalSpeed : stride / CONFIG.duty / CLIPS.run.duration
  const layout = defaultFrame(0)
  const feet = LEGS.map((l): Foot => {
    const home = placement(l, layout).home
    if (name !== 'run') {
      if (name === 'idle' && l.id === LEGS[IDLE_GESTURE.leg].id) {
        const q = (t - IDLE_GESTURE.start) / IDLE_GESTURE.duration
        if (q > 0 && q < 1) {
          const amp = Math.max(0, Math.min(1.5, (options.expression ?? 1) * 0.2))
          const pulse = Math.sin(Math.PI * q) ** 2
          return { x: home.x + 3 * amp * pulse, y: home.y - 4 * amp * pulse, z: 11 * amp * pulse, contact: amp === 0 }
        }
      }
      return { ...home, z: 0, contact: true }
    }
    const p = wrap(phase + l.phase)
    const contact = p < CONFIG.duty
    let s: number
    let z = 0
    if (contact) s = stride / 2 - stride * p / CONFIG.duty
    else { const q = (p - CONFIG.duty) / (1 - CONFIG.duty); s = lerp(-stride / 2, stride / 2, ease(q)); z = CONFIG.lift * Math.sin(Math.PI * q) ** 2 }
    return { x: home.x + dir.x * s, y: home.y + dir.y * s, z, contact }
  })
  return composePose(name, t, feet, phase, name === 'run' ? nominalSpeed : 0, { layout, aimAngle: Math.atan2(options.aimY ?? -1, options.aimX ?? 1), expression: options.expression ?? 1, velocity: { x: dir.x * nominalSpeed, y: dir.y * nominalSpeed }, nominalSpeed })
}

// --- kiln.mjs (v3): the hit and the fall apart ---

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
const easeC = (x: number): number => { x = clamp01(x); return x * x * (3 - 2 * x) }
const pulse = (t: number, a: number, b: number): number => t <= 0 || t >= b ? 0 : t < a ? easeC(t / a) : 1 - easeC((t - a) / (b - a))

function baseFor (o: KilnOptions): KilnPose {
  return o.basePose ?? legacyPose(o.sourceClip ?? 'idle', o.sourceTime ?? 0, o.sourceOptions ?? {})
}

function posed (base: KilnPose, p: Presence, name: string, t: number): KilnPose {
  return composePose(name, t, base.state.legs.map((l) => ({ ...l.foot })), base.state.animation.phase, base.state.controls.speed, { presenceOverride: p, aimAngle: base.state.turret.angle, layout: base.state.layout })
}

function fold (base: KilnPose, t: number): KilnPose {
  if (t === 0) return deepClone(base)
  const p = { ...base.state.presence }
  const q = easeC(t / 0.18)
  p.z -= 4 * q; p.roll -= 0.025 * q
  const out = posed(base, p, 'fall_apart', t)
  out.state.fireTime = base.state.fireTime + t
  out.state.effects = null
  return out
}

function delta (m: Matrix, p: Vec, x: number, y: number, r: number): Matrix {
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { a: c * m.a - s * m.b, b: s * m.a + c * m.b, c: c * m.c - s * m.d, d: s * m.c + c * m.d, x: p.x + x + c * (m.x - p.x) - s * (m.y - p.y), y: p.y + y + s * (m.x - p.x) + c * (m.y - p.y) }
}

interface Piece { id: string, bones: string[], pivot: Vec, drop: number, dx: number, dy: number, spin: number, delay: number }

/** v3's fall apart: the furnace gutters out by 0.42 s; at 0.18 s the base and canister drop as one, and each leg breaks at hip and knee into two pieces. Held at 2.8 s. */
function fall (base: KilnPose, t: number): KilnPose {
  const out = fold(base, Math.min(t, 0.18))
  out.state.animation = { name: 'fall_apart', time: t, phase: 0 }
  out.state.effects = null
  out.state.fireTime = base.state.fireTime + Math.min(t, 0.42)
  out.state.extinction = easeC(t / 0.42)
  out.state.presence.dead = t >= 0.42
  if (t < 0.18) return out
  const body = out.state.body
  const bodyPivot = { x: body.x, y: body.y * 0.68 - body.z }
  const pieces: Piece[] = [{ id: 'body_assembly', bones: ['body', 'furnace'], pivot: bodyPivot, drop: Math.max(0, body.z - 8), dx: -7, dy: 2, spin: -0.14, delay: 0 }]
  out.state.legs.forEach((l, i) => {
    const hip = l.screen.hip
    const knee = l.screen.knee
    const foot = l.screen.foot
    pieces.push({ id: l.id + '_upper', bones: [l.id + '_upper'], pivot: { x: (hip.x + knee.x) / 2, y: (hip.y + knee.y) / 2 }, drop: Math.max(0, (l.hip.z + l.knee.z) / 2 - 4), dx: l.side * (20 + i * 2), dy: l.row * 11, spin: l.side * (0.45 + i * 0.08), delay: i * 0.025 })
    pieces.push({ id: l.id + '_lower', bones: [l.id + '_lower', l.id + '_joint'], pivot: { x: (knee.x + foot.x) / 2, y: (knee.y + foot.y) / 2 }, drop: Math.max(0, (l.knee.z + l.foot.z) / 2 - 4), dx: l.side * (31 + i * 2), dy: l.row * 18, spin: -l.side * (0.32 + i * 0.06), delay: i * 0.025 })
  })
  out.state.debris = []
  for (const p of pieces) {
    const u = Math.max(0, t - 0.18 - p.delay)
    const q = easeC(u / (2.62 - p.delay))
    const land = Math.min(1, u / 0.56)
    const drop = p.drop * land * land
    const bounce = u > 0.56 && u < 1.12 ? Math.sin((u - 0.56) / 0.56 * Math.PI) * (p.id === 'body_assembly' ? 2.2 : 4) : 0
    const settle = u < 0.56 ? 0 : Math.sin((u - 0.56) * 12) * Math.exp(-(u - 0.56) * 5) * (1 - easeC((u - 0.56) / 1.7))
    const dx = p.dx * (1 - (1 - q) ** 3)
    const dy = drop - bounce + p.dy * q
    const r = p.spin * (1 - (1 - q) ** 2) + settle * 0.035
    for (const bone of p.bones) out.matrices[bone] = delta(out.matrices[bone], p.pivot, dx, dy, r)
    out.state.debris.push({ id: p.id, bones: p.bones, pivot: p.pivot, x: p.pivot.x + dx, y: p.pivot.y + dy, angle: r, dx, dy, releaseTime: 0.18 + p.delay, settled: t >= 2.8 })
  }
  out.state.detached = true
  out.state.presence.glow = 0
  out.state.legs = []
  return out
}

/**
 * The package's `animationPose(name, seconds, options)` (v3): reference,
 * idle, run and fire as the core gives them; hit and fall_apart from
 * `basePose`, or from `sourceClip`/`sourceTime`/`sourceOptions`.
 */
export function animationPose (name: string, seconds: number, options: KilnOptions = {}): KilnPose {
  if (name !== 'hit' && name !== 'fall_apart') return legacyPose(name, seconds, options)
  const base = baseFor(options)
  const t = Math.max(0, Math.min(CLIPS[name].duration, Number.isFinite(seconds) ? seconds : 0))
  if (name === 'fall_apart') return fall(base, t)
  const p = { ...base.state.presence }
  const knock = pulse(t, 0.065, 0.38)
  const spring = pulse(t - 0.24, 0.13, 0.4)
  const ax = options.aimX ?? 1
  const ay = options.aimY ?? -0.35
  const n = Math.hypot(ax, ay) || 1
  p.x += (-8 * knock + 1.6 * spring) * ax / n; p.y += (-8 * knock + 1.6 * spring) * ay / n; p.z += -6 * knock + 2 * spring; p.roll += 0.08 * knock * ax / n; p.pitch += 0.055 * knock * ay / n
  const out = (t === 0 || t === 0.7) ? deepClone(base) : posed(base, p, 'hit', t)
  out.state.animation = { name: 'hit', time: t, phase: base.state.animation.phase }
  out.state.effects = null
  out.state.fireTime = base.state.fireTime + t
  out.state.hitFlare = 0.65 * pulse(t, 0.035, 0.25)
  return out
}

// --- fire.mjs: the furnace ---

export const FIRE_PERIOD = 6.4

export interface FireState { phase: number, swell: number, charge: number, life: number, height: number, sway: number, flicker: number, heat: number }

export function fireState (seconds: number, charge = 0, extinction = 0): FireState {
  const phase = ((seconds / FIRE_PERIOD) % 1 + 1) % 1
  const swell = Math.sin(Math.PI * clamp01((phase - 0.62) / 0.25)) ** 2
  const slow = 0.5 + 0.5 * Math.sin(TAU * phase)
  return {
    phase,
    swell,
    charge,
    life: 1 - clamp01(extinction),
    height: 17 + 3 * slow + 8 * swell + 11 * charge,
    sway: 2.2 * Math.sin(TAU * phase * 3) + 0.9 * Math.sin(TAU * phase * 7),
    flicker: Math.sin(TAU * phase * 11),
    heat: 0.55 + 0.13 * slow + 0.28 * swell + 0.4 * charge
  }
}

/** The atlas frame v3 draws (`furnaceFrame`): which bank, frame and charge level, and the opacity it is drawn at. */
export function furnaceFrame (pose: KilnPose): { clean: boolean, frame: number, level: number, life: number } {
  const s = pose.state
  const clean = s.animation.name === 'hit' || s.animation.name === 'fall_apart'
  const charge = (s.presence.charge ?? 0) + (s.hitFlare ?? 0)
  const f = fireState(s.fireTime ?? s.animation.time, charge, s.extinction ?? 0)
  let life = f.life
  if (s.animation.name === 'fall_apart') life *= 0.65 + 0.35 * Math.cos(s.animation.time * 65) ** 2
  return { clean, frame: Math.floor(f.phase * 192) % 192, level: Math.round(clamp01(charge) * 8), life }
}

/** Flattening, as `tools/npc-rig-sync.mjs` records the package's curves: segments in a full ellipse, a cubic, a quadratic. */
export const ARC_STEPS = 32
export const CUBIC_STEPS = 12
export const QUAD_STEPS = 8

const apply = (m: Matrix, x: number, y: number): number[] => [m.a * x + m.c * y + m.x, m.b * x + m.d * y + m.y]

/** Points of an ellipse arc (Canvas `ellipse`), `start` to `end` inclusive, through `m`. */
export function arcPoints (m: Matrix, x: number, y: number, rx: number, ry: number, rot: number, start: number, end: number): number[] {
  const span = end - start
  const n = Math.max(1, Math.ceil(ARC_STEPS * span / TAU))
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const out: number[] = []
  for (let k = 0; k <= n; k++) {
    const t = start + span * k / n
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    out.push(...apply(m, x + ex * cr - ey * sr, y + ex * sr + ey * cr))
  }
  return out
}

/** `fire.mjs`'s `tongue`: a flame tongue's outline (moveTo, two cubics, a quadratic), through `m`. */
function tonguePoints (m: Matrix, x: number, bottom: number, width: number, height: number, sway: number): number[] {
  const out: number[] = [...apply(m, x - width, bottom)]
  let px = x - width
  let py = bottom
  const cubic = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number): void => {
    for (let k = 1; k <= CUBIC_STEPS; k++) {
      const t = k / CUBIC_STEPS
      const a = 1 - t
      out.push(...apply(m, a * a * a * px + 3 * a * a * t * c1x + 3 * a * t * t * c2x + t * t * t * ex, a * a * a * py + 3 * a * a * t * c1y + 3 * a * t * t * c2y + t * t * t * ey))
    }
    px = ex; py = ey
  }
  cubic(x - width * 1.2, bottom - height * 0.35, x + sway - width * 0.6, bottom - height * 0.52, x + sway, bottom - height)
  cubic(x + sway + width * 0.18, bottom - height * 0.65, x + width * 1.3, bottom - height * 0.4, x + width, bottom)
  for (let k = 1; k <= QUAD_STEPS; k++) {
    const t = k / QUAD_STEPS
    const a = 1 - t
    out.push(...apply(m, a * a * px + 2 * a * t * x + t * t * (x - width), a * a * py + 2 * a * t * (bottom + 3) + t * t * bottom))
  }
  return out
}

/**
 * The shapes of `fire.mjs`'s `drawFurnace` for one atlas frame (`frame`,
 * charge `level`, `clean` without embers), through `m` (the furnace's own
 * units to rig units), at opacity `life`: what that frame of v3's atlases
 * holds, drawn at `life`.
 */
export function flameMarks (out: NpcDrawItem[], m: Matrix, frame: number, level: number, clean: boolean, life: number): void {
  const f = fireState(frame / 30, level / 8, 0)
  const scale = Math.hypot(m.a, m.b)
  const fill = (points: number[], color: number, alpha: number, approx?: boolean): void => { out.push({ kind: 'polygon', points, color, alpha: alpha * life, approx }) }
  const stroke = (points: number[], color: number, alpha: number, width: number): void => { out.push({ kind: 'line', points, color, alpha: alpha * life, width: width * scale }) }
  // The old lens, replaced inside its graphite collar.
  fill(arcPoints(m, 0, 0, 10.2, 6.6, 0, 0, TAU), 0x120f14, 1)
  fill(arcPoints(m, 0, 1.7, 8.1, 3.5, 0, 0, TAU), 0x883017, 1)
  fill(arcPoints(m, -0.5, 2.5, 6.3, 2, 0, 0, TAU), 0xed6b22, 1)
  // A warm edge on the bevel.
  stroke(arcPoints(m, 0, 1, 13.1, 8.5, 0, 0.1, Math.PI - 0.1), 0xffa03f, 0.14 * f.heat, 1.5)
  fill(tonguePoints(m, -4, 1.4, 3.1, f.height * 0.65, -2 + f.sway * 0.45), 0xf47b29, 1)
  fill(tonguePoints(m, 3.8, 1.9, 3, f.height * 0.74, 2 - f.sway * 0.65), 0xec6825, 1)
  // A linear gradient in the package (#ffd46b at the base to #d94a23 at the tip), flat here.
  fill(tonguePoints(m, 0, 2.3, 5.2, f.height + f.flicker * 0.8, f.sway), 0xffae37, 1, true)
  fill(tonguePoints(m, -0.7, 2.7, 2.7, f.height * 0.61, f.sway * 0.35), 0xffe59a, 1)
  fill(tonguePoints(m, -1, 2.8, 1.35, f.height * 0.3, -0.5), 0xfff3c1, 1)
  // The near rim occludes the base: the flame rises out of a cavity.
  stroke(arcPoints(m, 0, 0, 10.1, 6.45, 0, 0.08, Math.PI - 0.08), 0x302e35, 1, 1.9)
  stroke(arcPoints(m, 0, -0.25, 9.2, 5.85, 0, 0.25, Math.PI - 0.25), 0xffa742, 0.3 + 0.23 * f.heat, 0.65)
  if (clean) return
  for (const [i, start] of [[0, 0.65], [1, 0.72]]) {
    const age = (f.phase - start) / 0.18
    if (age > 0 && age < 1) fill(arcPoints(m, (i !== 0 ? 3 : -2) + Math.sin(age * 4 + i) * 2, -f.height * 0.68 - age * 15, 0.65, 0.9 + age * 0.3, 0.25, 0, TAU), i !== 0 ? 0xffd97b : 0xffa342, Math.sin(Math.PI * age) * 0.85)
  }
}

/** The furnace's own units (rig units in the canister's frame, its mouth at 0,0) to rig units. */
function furnaceMatrix (canister: Matrix): Matrix {
  return multiply(canister, { a: 336 / 55, b: 0, c: 0, d: 336 / 55, x: 168, y: 91 })
}

const rect = (art: string, x: number, y: number, w: number, h: number): Matrix => ({ a: w / ARTS[art].w, b: 0, c: 0, d: h / ARTS[art].h, x, y })

/** v3's `drawPose` at 0,0 and scale 1, as a draw list: shadows, regions, the furnace; not the lob's projectile (the game's). */
export function draw (pose: KilnPose): NpcDrawList {
  const items: NpcDrawItem[] = []
  const s = pose.state
  if (s.detached === true) {
    for (const d of s.debris ?? []) {
      const radius = d.id === 'body_assembly' ? 48 : 18
      items.push({ kind: 'image', art: 'shadow', m: rect('shadow', d.x - radius, d.y + 4 - radius * 0.32, radius * 2, radius * 0.64), alpha: 0.20, contact: true })
    }
  } else {
    items.push({ kind: 'image', art: 'shadow', m: rect('shadow', -PROFILE.width * 0.72, -36, PROFILE.width * 1.44, 78), alpha: 0.23, contact: true })
    for (const l of s.legs) items.push({ kind: 'image', art: 'shadow', m: rect('shadow', l.foot.x - 6, l.foot.y * 0.68 - 3, 12, 6), alpha: l.contact ? 0.25 : 0.10, contact: true })
  }
  for (const r of pose.regions) {
    const m = pose.matrices[r.bone]
    items.push({ kind: 'image', art: r.art, m, clip: r.clip })
    if (r.furnace === true) {
      const f = furnaceFrame(pose)
      const fm = furnaceMatrix(m)
      items.push({ kind: 'image', art: 'furnace-off', m: multiply(fm, rect('furnace-off', -24, -52, 48, 64)) })
      if (f.life > 0) flameMarks(items, fm, f.frame, f.level, f.clean, f.life)
    }
  }
  return { ground: [], items }
}

/** The rig units from the ground to the top of the idle pose's highest image (the canister). */
const REFERENCE_UNITS = (() => {
  let top = 0
  for (const item of draw(animationPose('idle', 0)).items) {
    if (item.kind !== 'image' || item.contact === true) continue
    const { w, h } = ARTS[item.art]
    const m = item.m
    for (const [u, v] of [[0, 0], [w, 0], [0, h], [w, h]]) top = Math.min(top, m.b * u + m.d * v + m.y)
  }
  return -top
})()

export const KILN_RIG: NpcRig = Object.freeze({
  key: 'kiln' as const,
  clips: CLIPS,
  // Nick, 2026-10-07: 100% of its own rig (ideas/npc-roster.md; the package's gameScale).
  // Nick, 2026-10-09 (size review): 1 -> 1.65; the gait follows (`gaitClock`); the sheet is re-baked at it (`bake-npc-atlas.py`).
  sizeScale: 1.65,
  referenceUnits: REFERENCE_UNITS,
  deathHolds: true,
  gait: GAIT,
  roles: Object.freeze({
    idle: 'idle',
    move: 'run',
    // The lob (effect 9, sent at the server's cast with the flight as its
    // lifetime): played from its `attack` event, the launch, so the shell
    // leaves as the server casts. Hits are an overlay (#52).
    attack: Object.freeze({ clip: 'fire', event: LAUNCH }),
    hit: 'hit',
    // It falls apart from whatever it shows, mid-lob included.
    death: Object.freeze({ clip: 'fall_apart', from: 0, fromAction: true })
  }),
  pose: (clip: string, seconds: number, direction: Vec, aim?: Vec, from?: NpcPose, options?: NpcPoseOptions): NpcPose => {
    const clock = options?.clock
    let base = from?.state as KilnPose | undefined
    // The package refuses a hit over the lob; `NpcSprite` never asks for one, but never throw in a frame.
    if (clip === 'hit' && base?.state.animation.name === 'fire') base = undefined
    let pose: KilnPose
    if (clip === 'hit' || clip === 'fall_apart') pose = animationPose(clip, seconds, base === undefined ? {} : { basePose: base })
    else if (clip === 'fire') pose = animationPose(clip, seconds, { basePose: base, aimX: aim?.x, aimY: aim?.y, fireTime: clock })
    else {
      pose = animationPose(clip, seconds, clip === 'run' ? { directionX: direction.x, directionY: direction.y, stride: GAIT.stride } : {})
      // The furnace keeps its own clock across clips (the package's controller's `fireTime`).
      if (clock !== undefined) pose.state.fireTime = clock
    }
    return { clip, time: seconds, muzzle: pose.state.turret.muzzle, state: pose }
  },
  draw: (p: NpcPose): NpcDrawList => draw(p.state as KilnPose),
  arts: ARTS
})
