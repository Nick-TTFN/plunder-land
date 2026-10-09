import { type Matrix, multiply } from '../../peep/rig'
import { cssColour } from '../colour'
import { type NpcClip, type NpcDrawItem, type NpcDrawList, type NpcEllipse, type NpcGait, type NpcPose, type NpcRig } from '../npcrig'

/**
 * The Scrap Crawler (l1-8): a hand port of `tools/rig.mjs` in its Codex
 * package (`codex_output/crawler-animations-v4`, an export-only copy of the
 * approved v3, not checked in). Six legs on IK under a shell that never turns
 * (`bodyHeading: fixed`); running is the gait laid along the ground direction.
 * `npcrigs.spec.ts` checks it against the package's own pose samples
 * (`crawler.fixtures.json`, `tools/npc-rig-sync.mjs crawler`).
 *
 * Kept in the package's order of operations so the numbers agree to its
 * tolerance (1e-9). Not ported: `CrawlerController` (stateful foot planting
 * for real movement: the game plays the stateless clips, like the robots),
 * and the shot's own projectile streak (the game's beam is the shot).
 */

const TAU = Math.PI * 2
const wrap = (x: number): number => ((x % 1) + 1) % 1

export const CLIPS: Readonly<Record<string, NpcClip>> = Object.freeze({
  reference: { duration: 1, loop: false, events: [] },
  idle: { duration: 8.4, loop: true, events: [] },
  run: { duration: 0.72, loop: true, events: [] },
  fire: { duration: 1.12, loop: false, events: [{ time: 0.34, name: 'fire' }] },
  hit: { duration: 0.76, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: { duration: 2.6, loop: false, events: [{ time: 0.24, name: 'detach' }] }
})

export const CONFIG = Object.freeze({ tilt: 0.68, bodyHeight: 32, upperLength: 44, lowerLength: 64, stride: 20, duty: 0.62, nominalSpeed: 20 / 0.62 / 0.72, lift: 12 })

/**
 * The game's gait (decision #52 lane 3, a foot-slide trial; PROVISIONAL until
 * Nick has seen it). The package's walk (stride 20, `CONFIG`) covers 44.8 rig
 * units a clip second, 8.6 world units at clip rate 1, a tenth of the chase's
 * 90 u/s: its feet slid 88% (strand B). So the game runs a 3x stride, as far
 * as the legs reach without the knee going straight or a foot meeting its
 * neighbour (`npcrigs.spec.ts` holds both), and the loop faster, at the rate
 * `gaitClock` derives from the stride's sweep (`groundSpeed`, stride / duty /
 * 0.72 = 134.4 rig units a clip second) and the size: 90 u/s / (134.4 x
 * `RobotSprite.SCALE` x `sizeScale`). At the 0.89 Nick saw that was 3.48
 * clip seconds a second (`RUN_RATE` x 2.71 x pace, the literal of lane 3),
 * 4.8 steps a second per leg; at 1.31 (size review, 2026-10-09) it is 2.37,
 * 3.3 steps. Resized, it keeps the feet planted by itself. `maxSteps` (6)
 * doesn't bind below 164 u/s. `minPace` lets idle wander
 * (30 u/s, pace 0.21) run the legs at its own speed; `groundTilt` points and
 * times the stride for the game's squash (`gaitDirection`).
 */
const GAME_STRIDE = 60
export const GAIT: NpcGait & { readonly stride: number } = Object.freeze({
  stride: GAME_STRIDE,
  groundSpeed: GAME_STRIDE / CONFIG.duty / CLIPS.run.duration,
  period: CLIPS.run.duration,
  maxSteps: 6,
  minPace: 0.2,
  groundTilt: CONFIG.tilt
})

interface Vec { x: number, y: number }
interface Vec3 { x: number, y: number, z: number }
interface Foot extends Vec3 { contact: boolean }

interface LegDef {
  id: string
  side: number
  row: number
  phase: number
  home: Vec
  hip: Vec
}

const LEGS: readonly LegDef[] = [
  { id: 'left_back', side: -1, row: -1, phase: 0 }, { id: 'left_middle', side: -1, row: 0, phase: 0.5 }, { id: 'left_front', side: -1, row: 1, phase: 0 },
  { id: 'right_back', side: 1, row: -1, phase: 0.5 }, { id: 'right_middle', side: 1, row: 0, phase: 0 }, { id: 'right_front', side: 1, row: 1, phase: 0.5 }
].map((l) => ({ ...l, home: { x: l.side * (l.row === 0 ? 85 : 76), y: l.row * 65 }, hip: { x: l.side * 29, y: l.row * 39 } }))

/** The package's art: full sizes in pixels, and the segments' start and end anchors. */
const ART = {
  body: { w: 414, h: 581 },
  upper: { w: 570, h: 242, start: { x: 76, y: 141 }, end: { x: 505, y: 141 } },
  lower: { w: 653, h: 232, start: { x: 76, y: 123 }, end: { x: 622, y: 207 } },
  joint: { w: 300, h: 305 }
}

const project = (p: Vec3): Vec => ({ x: p.x, y: p.y * CONFIG.tilt - p.z })
const ease = (t: number): number => t * t * (3 - 2 * t)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const normalized = (x: number, y: number): Vec => {
  const d = Math.hypot(x, y)
  return d > 1e-8 ? { x: x / d, y: y / d } : { x: 0, y: 0 }
}
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

const IDLE_GESTURE = { start: 5.2, duration: 0.95, leg: 2 }
const windowPulse = (t: number, start: number, end: number): number => t > start && t < end ? Math.sin(Math.PI * (t - start) / (end - start)) ** 2 : 0

/** The shared performance layer: translation, suspension, sensor focus, mild pitch and roll. */
export interface Presence {
  x: number
  y: number
  z: number
  pitch: number
  roll: number
  sensorX: number
  sensorY: number
  focus: number
  glow: number
  idleTime?: number
  idleWeight?: number
  expression?: number
  dead?: boolean
}

/** `nominalSpeed`: the run's own ground speed, rig units per clip second (`CONFIG.nominalSpeed` at the package's stride). */
interface PresenceOptions { idleTime?: number, idleWeight?: number, phase?: number, speed?: number, velocity?: Vec, expression?: number, nominalSpeed?: number }

function presencePose (time: number, { idleTime = time, idleWeight = 1, phase = 0, speed = 0, velocity = { x: 0, y: 0 }, expression = 1, nominalSpeed = CONFIG.nominalSpeed }: PresenceOptions = {}): Presence {
  const t = wrap(idleTime / CLIPS.idle.duration) * CLIPS.idle.duration
  const breathe = Math.sin(TAU * t / 2.8)
  const inspect = windowPulse(t, 1.35, 4.8)
  const settle = windowPulse(t, 6.35, 8.15)
  const right = windowPulse(t, 1.8, 3.1)
  const left = windowPulse(t, 3.15, 4.65)
  const weight = windowPulse(t, 4.75, 6.45)
  const amount = Math.max(0, Math.min(1.5, expression))
  const w = idleWeight * amount
  const effort = Math.min(1, speed / nominalSpeed)
  const runWeight = 1 - idleWeight
  return {
    x: w * (2.8 * Math.sin(TAU * t / 8.4) + 2.2 * (right - left) - 3.2 * weight) + runWeight * amount * velocity.x / nominalSpeed * 0.9,
    y: w * (1.4 * Math.sin(TAU * t / 4.2) - 1.8 * inspect),
    z: idleWeight * 0.65 * breathe + w * (1.6 * breathe + 4.4 * inspect - 3.6 * settle) + runWeight * (1 + amount * 0.75) * Math.sin(TAU * phase * 2) * effort,
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

export interface LegState extends LegDef {
  hip: Vec3
  knee: Vec3 & { reach: number }
  foot: Foot
  contact: boolean
  screen: { hip: Vec, knee: Vec, foot: Vec }
}

export interface Region {
  name: string
  bone: string
  art: 'body' | 'upper' | 'lower' | 'joint'
  clip?: { x: number, y: number, w: number, h: number }
  group?: string
  sensor?: boolean
}

export interface Effects {
  aim: Vec
  charge: number
  flash: number
  projectile: number
  hit: number
  muzzle?: Vec
  shotOrigin?: Vec
}

export interface DebrisPiece {
  id: string
  x: number
  y: number
  height: number
  groundY: number
  angle: number
  radius: number
  releaseTime: number
  released: boolean
  settled: boolean
}

export interface CrawlerState {
  root: { x: number, y: number, r: number }
  body: { x: number, y: number, z: number, r: number, pitch: number, roll: number }
  presence: Presence
  animation: { name: string, time: number, phase: number }
  legs: LegState[]
  controls: { bodyRotation: number, speed: number }
  effects?: Effects
  aim?: Vec
  debris?: DebrisPiece[]
  detached?: boolean
}

export interface CrawlerPose {
  state: CrawlerState
  matrices: Record<string, Matrix>
  regions: Region[]
}

/** What an action reads of the pose it starts from: the presence and the feet. Any full pose will do. */
export interface BasePose {
  state: { presence: Partial<Presence>, legs: ReadonlyArray<{ foot: Foot }> }
}

export interface CrawlerOptions {
  /** Ground direction of the run (any length); default straight down the screen. */
  directionX?: number
  directionY?: number
  /** Ground direction an action points (fire's recoil, a hit's knock); default right and up. */
  aimX?: number
  aimY?: number
  expression?: number
  /** The pose an action starts from (fire, hit, fall_apart); default idle at 0. */
  basePose?: BasePose
  /**
   * The run's stride, rig units; default the package's `CONFIG.stride`. The
   * game runs a longer one (`GAIT.stride`, decision #52 lane 3). Its run
   * speed scales with it, so the run's lean and bob are the same at any stride.
   */
  stride?: number
}

interface Performance extends PresenceOptions { presenceOverride?: Presence }

function composePose (name: string, time: number, feet: Foot[], phase = 0, speed = 0, performance: Performance = {}): CrawlerPose {
  const presence = performance.presenceOverride ?? (name === 'reference'
    ? { x: 0, y: 0, z: 0, pitch: 0, roll: 0, sensorX: 0, sensorY: 0, focus: 1, glow: 0.6 }
    : presencePose(time, { idleWeight: name === 'idle' ? 1 : 0, phase, speed, ...performance }))
  const bodyZ = CONFIG.bodyHeight + presence.z
  const state: CrawlerState = {
    root: { x: 0, y: 0, r: 0 },
    body: { x: presence.x, y: presence.y, z: bodyZ, r: 0, pitch: presence.pitch, roll: presence.roll },
    presence,
    animation: { name, time, phase },
    legs: [],
    controls: { bodyRotation: 0, speed }
  }
  const matrices: Record<string, Matrix> = {}
  const regions: Region[] = []
  for (let i = 0; i < LEGS.length; i++) {
    const l = LEGS[i]
    const hip = { x: l.hip.x + presence.x, y: l.hip.y + presence.y, z: bodyZ - 3 + l.hip.y * presence.pitch + l.hip.x * presence.roll }
    const foot = feet[i]
    const knee = solveLeg(hip, foot)
    const hp = project(hip)
    const kp = project(knee)
    const fp = project(foot)
    matrices[l.id + '_upper'] = segmentMatrix(hp, kp, ART.upper)
    matrices[l.id + '_lower'] = segmentMatrix(kp, fp, ART.lower)
    matrices[l.id + '_joint'] = { a: 15 / ART.joint.w, b: 0, c: 0, d: 15 / ART.joint.h, x: kp.x - 7.5, y: kp.y - 7.5 }
    state.legs.push({ ...l, hip, knee, foot: { ...foot }, contact: foot.contact, screen: { hip: hp, knee: kp, foot: fp } })
  }
  for (const l of [...state.legs].sort((a, b) => a.home.y - b.home.y)) {
    for (const part of ['upper', 'lower', 'joint'] as const) regions.push({ name: l.id + '_' + part, bone: l.id + '_' + part, art: part })
  }
  const width = 85
  const scale = width / ART.body.w
  const a = scale
  const b = -presence.roll * scale
  const c = 0
  const d = scale * (1 - presence.pitch / CONFIG.tilt)
  matrices.body = { a, b, c, d, x: presence.x - a * ART.body.w / 2, y: presence.y * CONFIG.tilt - bodyZ - b * ART.body.w / 2 - d * ART.body.h / 2 }
  regions.push({ name: 'body', bone: 'body', art: 'body' })
  return { state, matrices, regions }
}

const ACTIONS = new Set(['fire', 'hit', 'fall_apart'])
const canonicalClip = (name: string): string => name === 'shoot' ? 'fire' : name

function pulse (t: number, peak: number, end: number): number {
  return t <= 0 || t >= end ? 0 : t < peak ? ease(t / peak) : 1 - ease((t - peak) / (end - peak))
}

const PRESENCE_KEYS = ['x', 'y', 'z', 'pitch', 'roll', 'sensorX', 'sensorY', 'focus', 'glow'] as const

function actionPresence (name: string, t: number, base: BasePose, options: CrawlerOptions): { p: Presence, effects: Effects, aim: Vec } {
  const aim = normalized(options.aimX ?? 1, options.aimY ?? -0.5)
  const strength = 0.75 + 0.25 * clamp(options.expression ?? 1, 0, 1.5)
  const neutral = presencePose(0)
  const p: Presence = { ...neutral }
  const fade = 1 - ease(clamp(t / 0.22))
  for (const k of PRESENCE_KEYS) p[k] = lerp(neutral[k], base.state.presence[k] ?? neutral[k], fade)
  const effects: Effects = { aim, charge: 0, flash: 0, projectile: 0, hit: 0 }
  if (name === 'fire') {
    const brace = pulse(t, 0.25, 0.52)
    const recoil = pulse(t - 0.34, 0.045, 0.39)
    const recover = windowPulse(t, 0.61, 1.05)
    p.x -= aim.x * (1.1 * brace + 6.8 * recoil - 1.1 * recover) * strength
    p.y -= aim.y * (1.1 * brace + 6.8 * recoil - 1.1 * recover) * strength
    p.z += (-4.1 * brace + 2.3 * recoil + 1.0 * recover) * strength
    p.pitch += aim.y * 0.045 * (brace - recoil) * strength; p.roll += aim.x * 0.04 * (brace - recoil) * strength
    const focus = pulse(t, 0.28, 0.59); p.sensorX += aim.x * 2.4 * focus; p.sensorY += aim.y * 1.6 * focus; p.focus -= 0.42 * brace
    effects.charge = t < 0.34 ? ease(clamp(t / 0.34)) : 0; effects.flash = pulse(t - 0.34, 0.018, 0.11)
    effects.projectile = t >= 0.34 && t < 0.88 ? (t - 0.34) : 0
    p.glow += effects.charge * 0.8 + effects.flash * 2
  } else if (name === 'hit') {
    const knock = pulse(t, 0.065, 0.4)
    const recover = windowPulse(t, 0.24, 0.69)
    p.x += (-aim.x * 7.5 * knock + aim.x * 1.7 * recover) * strength; p.y += (-aim.y * 7.5 * knock + aim.y * 1.7 * recover) * strength
    p.z += (-5.5 * knock + 1.8 * recover) * strength; p.roll += aim.x * 0.075 * knock; p.pitch += aim.y * 0.065 * knock
    p.focus -= 0.84 * knock; p.glow *= 1 - 0.75 * knock; effects.hit = pulse(t, 0.035, 0.15)
  } else {
    const fold = ease(clamp(t / 0.24)); p.z -= 8 * fold; p.x -= 4 * fold; p.pitch += 0.07 * fold; p.roll -= 0.12 * fold
    p.focus *= 1 - 0.9 * fold; p.glow *= Math.max(0, 1 - t / 0.24); p.dead = t >= 0.24
  }
  p.focus = clamp(p.focus, 0.06, 1.2)
  return { p, effects, aim }
}

function bounceHeight (t: number, height: number, velocity: number, restitution = 0.24, gravity = 225): number {
  for (let bounce = 0; bounce < 4; bounce++) {
    const land = (velocity + Math.sqrt(velocity * velocity + 2 * gravity * height)) / gravity
    if (t <= land) return Math.max(0, height + velocity * t - gravity * t * t / 2)
    t -= land; velocity = Math.sqrt(velocity * velocity + 2 * gravity * height) * restitution; height = 0
  }
  return 0
}

// The package's authored, repeatable imbalance: a buckled side, a few loose
// pieces and a heavy core; delayed pieces follow the tipping shell until release.
const COLLAPSE_MOTION = [
  { delay: 0.00, vx: -115, vy: -17, spin: -1.32, lift: 8, drag: 3.5, bounce: 0.12 },
  { delay: 0.04, vx: 38, vy: 22, spin: 1.73, lift: -9, drag: 4.2, bounce: 0.08 },
  { delay: 0.10, vx: -145, vy: 83, spin: -0.56, lift: 38, drag: 2.5, bounce: 0.30 },
  { delay: 0.22, vx: 49, vy: -109, spin: 2.16, lift: 47, drag: 2.9, bounce: 0.28 },
  { delay: 0.08, vx: 183, vy: 12, spin: -1.02, lift: 28, drag: 2.4, bounce: 0.20 },
  { delay: 0.31, vx: -30, vy: 32, spin: 0.84, lift: -3, drag: 4.5, bounce: 0.10 },
  { delay: 0.15, vx: 86, vy: -96, spin: 0.91, lift: 41, drag: 2.6, bounce: 0.27 },
  { delay: 0.25, vx: -17, vy: 8, spin: -0.49, lift: -16, drag: 4.8, bounce: 0.06 },
  { delay: 0.05, vx: -72, vy: 121, spin: -1.13, lift: 19, drag: 3.1, bounce: 0.18 }
]

/** The shell's three sections in the body art, by row: what fall_apart splits it into. */
export const SHELLS: ReadonlyArray<readonly [string, number, number]> = [['rear', 0, 149], ['core', 149, 280], ['front', 429, 152]]

interface Group { id: string, pivot: Vec, height: number, regions: Region[], radius: number, sensor?: boolean }

function detachPose (source: CrawlerPose, t: number): CrawlerPose {
  const pose: CrawlerPose = { state: { ...source.state, legs: [], debris: [], detached: true }, matrices: {}, regions: [] }
  const groups: Group[] = []
  for (const l of source.state.legs) {
    const pivot = { x: (l.screen.hip.x + l.screen.knee.x + l.screen.foot.x) / 3, y: (l.screen.hip.y + l.screen.knee.y + l.screen.foot.y) / 3 }
    const height = (l.hip.z + l.knee.z + l.foot.z) / 3
    groups.push({ id: l.id, pivot, height, regions: source.regions.filter((r) => r.name.startsWith(l.id + '_')), radius: 18 })
  }
  const b = source.matrices.body
  for (const [id, y, h] of SHELLS) {
    const px = 207
    const py = y + h / 2
    const pivot = { x: b.a * px + b.c * py + b.x, y: b.b * px + b.d * py + b.y }
    groups.push({ id: 'shell_' + id, pivot, height: source.state.body.z, regions: [{ name: 'shell_' + id, bone: 'body', art: 'body', clip: { x: 0, y, w: 414, h } }], radius: id === 'core' ? 23 : 17, sensor: id === 'core' })
  }
  const center = { x: source.state.body.x, y: source.state.body.y * CONFIG.tilt - source.state.body.z }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const motion = COLLAPSE_MOTION[i]
    const release = motion.delay
    const u = clamp(t - release, 0, 1.9)
    const tip = ease(clamp(Math.min(t, release) / 0.32))
    const tilt = -0.18 * tip
    const tc = Math.cos(tilt)
    const ts = Math.sin(tilt)
    const dx = g.pivot.x - center.x
    const dy = g.pivot.y - center.y
    const startX = center.x + tc * dx - ts * dy - 9 * tip
    const startY = center.y + ts * dx + tc * dy + 12 * tip
    const startHeight = Math.max(2, g.height - 12 * tip)
    const released = t >= release
    const travel = (1 - Math.exp(-motion.drag * u)) / motion.drag
    const height = released ? bounceHeight(u, startHeight, motion.lift, motion.bounce) : startHeight
    const x = startX + motion.vx * travel
    const y = startY + motion.vy * travel * CONFIG.tilt + startHeight - height
    const angle = tilt + motion.spin * (1 - Math.exp(-3.8 * u))
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    const delta = { a: c, b: sn, c: -sn, d: c, x: x - c * g.pivot.x + sn * g.pivot.y, y: y - sn * g.pivot.x - c * g.pivot.y }
    for (const r of g.regions) {
      const bone = r.name
      pose.matrices[bone] = multiply(delta, source.matrices[r.bone])
      pose.regions.push({ ...r, bone, group: g.id, sensor: g.sensor === true })
    }
    pose.state.debris!.push({ id: g.id, x, y, height, groundY: y + height, angle, radius: g.radius, releaseTime: 0.24 + release, released, settled: released && height === 0 && u >= 1.9 })
  }
  pose.state.presence = { ...source.state.presence, dead: true, glow: 0, focus: 0.06 }
  return pose
}

function actionPose (name: string, seconds: number, options: CrawlerOptions = {}): CrawlerPose {
  name = canonicalClip(name)
  const t = clamp(Number.isFinite(seconds) ? seconds : 0, 0, CLIPS[name].duration)
  const base: BasePose = options.basePose ?? animationPose('idle', 0, { expression: options.expression ?? 1 })
  if (name === 'fall_apart' && t >= 0.24) {
    const source = actionPose(name, 0.24 - 1e-10, { ...options, basePose: base })
    const pose = detachPose(source, t - 0.24)
    pose.state.animation = { name, time: t, phase: 0 }
    return pose
  }
  const { p, effects, aim } = actionPresence(name, t, base, options)
  const settle = ease(clamp(t / 0.14))
  const feet = base.state.legs.map((l) => ({ ...l.foot, z: l.foot.z * (1 - settle), contact: l.foot.contact || settle === 1 }))
  const pose = composePose(name, t, feet, 0, 0, { presenceOverride: p })
  const m = pose.matrices.body
  effects.muzzle = { x: m.a * 207 + m.c * 253 + m.x, y: m.b * 207 + m.d * 253 + m.y }
  if (name === 'fire' && t > 0.34) effects.shotOrigin = actionPose('fire', 0.34, { ...options, basePose: base }).state.effects!.muzzle
  pose.state.effects = effects
  pose.state.aim = aim
  return pose
}

/** The package's stateless `animationPose(name, seconds, options)`. */
export function animationPose (name: string, seconds: number, options: CrawlerOptions = {}): CrawlerPose {
  name = canonicalClip(name)
  if (ACTIONS.has(name)) return actionPose(name, seconds, options)
  const clip = CLIPS[name]
  if (clip === undefined) throw Error('Unknown crawler clip: ' + name)
  const t = clip.loop ? wrap(seconds / clip.duration) * clip.duration : seconds
  const dir = normalized(options.directionX ?? 0, options.directionY ?? 1)
  const phase = t / CLIPS.run.duration
  const stride = options.stride ?? CONFIG.stride
  const nominalSpeed = options.stride === undefined ? CONFIG.nominalSpeed : stride / CONFIG.duty / CLIPS.run.duration
  const feet = LEGS.map((l): Foot => {
    if (name !== 'run') {
      if (name === 'idle' && l.id === LEGS[IDLE_GESTURE.leg].id) {
        const q = (t - IDLE_GESTURE.start) / IDLE_GESTURE.duration
        if (q > 0 && q < 1) {
          const amp = Math.max(0, Math.min(1.5, options.expression ?? 1))
          const pulse = Math.sin(Math.PI * q) ** 2
          return { x: l.home.x + 3 * amp * pulse, y: l.home.y - 4 * amp * pulse, z: 11 * amp * pulse, contact: amp === 0 }
        }
      }
      return { ...l.home, z: 0, contact: true }
    }
    const p = wrap(phase + l.phase)
    const contact = p < CONFIG.duty
    let s: number
    let z = 0
    if (contact) s = stride / 2 - stride * p / CONFIG.duty
    else {
      const q = (p - CONFIG.duty) / (1 - CONFIG.duty)
      s = lerp(-stride / 2, stride / 2, ease(q))
      z = CONFIG.lift * Math.sin(Math.PI * q) ** 2
    }
    return { x: l.home.x + dir.x * s, y: l.home.y + dir.y * s, z, contact }
  })
  return composePose(name, t, feet, phase, name === 'run' ? nominalSpeed : 0, { expression: options.expression ?? 1, velocity: { x: dir.x * nominalSpeed, y: dir.y * nominalSpeed }, nominalSpeed })
}

const SHADOW = 0x000000

/**
 * The package's `drawPose` as a draw list: contact shadows, the regions in
 * order (by the debris' ground line once fallen apart), the sensor after the
 * body (or on the core shell), then the effects. The sensor's glass and glow
 * are Canvas radial gradients clipped to the housing; here they are a few
 * flat discs (`approx`). The shot's streak is left to the game's beam.
 */
export function draw (pose: CrawlerPose): NpcDrawList {
  const { state } = pose
  const ground: NpcEllipse[] = []
  const items: NpcDrawItem[] = []
  const debris = state.debris
  if (debris !== undefined) {
    for (const piece of debris) ground.push({ kind: 'ellipse', x: piece.x, y: piece.groundY, rx: piece.radius * (1 - 0.003 * piece.height), ry: piece.radius * 0.38, color: SHADOW, alpha: 0.22 })
  } else {
    ground.push({ kind: 'ellipse', x: 0, y: 3, rx: 83, ry: 46, color: SHADOW, alpha: 0.24 })
    for (const l of state.legs) {
      const f = project({ ...l.foot, z: 0 })
      ground.push({ kind: 'ellipse', x: f.x, y: f.y, rx: 7, ry: 3.8, color: SHADOW, alpha: l.contact ? 0.32 : 0.13 })
    }
  }
  const groundOf = (r: Region): number => debris!.find((g) => g.id === r.group)!.groundY
  const ordered = debris !== undefined ? [...pose.regions].sort((a, b) => groundOf(a) - groundOf(b)) : pose.regions
  for (const region of ordered) {
    const m = pose.matrices[region.bone]
    items.push({ kind: 'image', art: region.art, m, clip: region.clip })
    if (region.sensor === true) sensor(items, m, state.presence)
  }
  if (debris === undefined) sensor(items, pose.matrices.body, state.presence)
  effects(items, state)
  return { ground, items }
}

/** The sensor in the body art's space (centre 207, 253 px), as flat discs for the package's gradients. */
function sensor (items: NpcDrawItem[], m: Matrix, p: Presence): void {
  const sx = Math.hypot(m.a, m.b)
  const sy = Math.hypot(m.c, m.d)
  const at = (u: number, v: number): Vec => ({ x: m.a * u + m.c * v + m.x, y: m.b * u + m.d * v + m.y })
  const c = at(207, 253)
  const disc = (x: number, y: number, r: number, css: string, alpha = 1, squash = 1): void => {
    const { color } = cssColour(css)
    items.push({ kind: 'ellipse', x, y, rx: r * sx, ry: r * sy * squash, color, alpha, approx: true })
  }
  // The glass: dark rim to warm centre.
  disc(c.x, c.y, 52, '#2b1007')
  disc(c.x, c.y, 40, '#652307')
  disc(c.x, c.y, 16, '#8a320a')
  if (p.dead === true) {
    disc(c.x, c.y, 22, '#3f2923')
    return
  }
  // The glow, moved by the scan and squashed by the focus.
  const alpha = Math.min(1, 0.86 + 0.12 * p.glow)
  const g = { x: c.x + p.sensorX, y: c.y + p.sensorY }
  disc(g.x, g.y, 46, '#ff851a', alpha * 0.45, p.focus)
  disc(g.x, g.y, 34, '#ffdb62', alpha * 0.85, p.focus)
  disc(g.x, g.y, 23, '#fff5b8', alpha, p.focus)
}

function effects (items: NpcDrawItem[], state: CrawlerState): void {
  const fx = state.effects
  if (fx !== undefined && fx.muzzle !== undefined) {
    const o = fx.muzzle
    if (fx.charge > 0) {
      const color = cssColour('#ffd789').color
      for (const r of [9, 14]) items.push({ kind: 'ellipse', x: o.x, y: o.y, rx: r * (1 - 0.35 * fx.charge), ry: r * 0.72 * (1 - 0.35 * fx.charge), color, alpha: fx.charge * 0.8, stroke: 1.1 })
    }
    if (fx.flash > 0) items.push({ kind: 'ellipse', x: o.x, y: o.y, rx: 14 * fx.flash, ry: 14 * fx.flash, color: cssColour('#fff3c9').color, alpha: fx.flash })
    if (fx.hit > 0) {
      const a = fx.aim
      const px = o.x + a.x * 30
      const py = o.y + a.y * CONFIG.tilt * 30
      const color = cssColour('#ffe0ad').color
      for (let i = 0; i < 6; i++) {
        const angle = i * TAU / 6
        items.push({ kind: 'line', points: [px + Math.cos(angle) * 5, py + Math.sin(angle) * 5, px + Math.cos(angle) * (9 + 9 * fx.hit), py + Math.sin(angle) * (9 + 9 * fx.hit)], width: 1.6, color, alpha: fx.hit })
      }
    }
  }
  if (state.detached === true) {
    const t = state.animation.time
    const alpha = windowPulse(t, 0.54, 1.35) * 0.12
    // Listed at alpha 0 too, as the package draws it; `NpcSprite` skips what can't show.
    const color = cssColour('#9bafbb').color
    for (let i = 0; i < 7; i++) {
      const a = i * TAU / 7
      items.push({ kind: 'ellipse', x: Math.cos(a) * 38, y: Math.sin(a) * 19 + 18, rx: 10 + 9 * t, ry: 5 + 4 * t, color, alpha })
    }
  }
}

/** The reference pose's top: the shell's top edge (measured from the package's reference pose). */
const REFERENCE_UNITS = (() => {
  const m = animationPose('reference', 0).matrices.body
  return -(m.y)
})()

export const CRAWLER_RIG: NpcRig = Object.freeze({
  key: 'crawler' as const,
  clips: CLIPS,
  // Nick, 2026-10-07: 89% of its own rig (npc-scale-preview-v1).
  // Nick, 2026-10-09 (size review): 0.89 -> 1.31; the gait follows (`gaitClock`); the sheet is re-baked at it (`bake-npc-atlas.py`).
  sizeScale: 1.31,
  referenceUnits: REFERENCE_UNITS,
  deathHolds: true,
  gait: GAIT,
  roles: Object.freeze({
    idle: 'idle',
    move: 'run',
    attack: Object.freeze({ clip: 'fire', event: 0.34 }),
    hit: 'hit',
    death: Object.freeze({ clip: 'fall_apart', from: 0 })
  }),
  pose: (clip: string, seconds: number, direction: { x: number, y: number }, aim?: { x: number, y: number }, from?: NpcPose): NpcPose => {
    const base = from === undefined ? undefined : from.state as CrawlerPose
    const pose = animationPose(clip, seconds, { directionX: direction.x, directionY: direction.y, aimX: aim?.x, aimY: aim?.y, basePose: base, stride: GAIT.stride })
    return { clip, time: seconds, muzzle: pose.state.effects?.shotOrigin ?? pose.state.effects?.muzzle ?? muzzleOf(pose), state: pose }
  },
  draw: (pose: NpcPose): NpcDrawList => draw(pose.state as CrawlerPose),
  arts: Object.freeze({ body: ART.body, upper: ART.upper, lower: ART.lower, joint: ART.joint })
})

/** The sensor's centre, where a shot leaves, for a pose without effects (idle, run). */
function muzzleOf (pose: CrawlerPose): Vec {
  const m = pose.matrices.body
  return { x: m.a * 207 + m.c * 253 + m.x, y: m.b * 207 + m.d * 253 + m.y }
}
