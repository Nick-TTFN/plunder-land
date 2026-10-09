import { type Matrix, multiply } from '../../peep/rig'
import { deepClone } from '../clone'
import { type NpcClip, type NpcDrawItem, type NpcDrawList, type NpcImage, type NpcPose, type NpcRig } from '../npcrig'

/**
 * The Reactor Spider (l1-9): a hand port of `tools/reactor.mjs` in its Codex
 * package (`codex_output/npc-refinements/reactor-v6`, not checked in).
 * **PROVISIONAL**: v6 (the repainted parts and the hit) is delivered but not
 * yet approved by Nick; a re-sync after his review is expected
 * (`tools/npc-rig-sync.mjs reactor`, `tools/bake-npc-atlas.py reactor`).
 *
 * Six legs round a low circular core under a body that never turns; walking
 * is the gait laid along the ground direction. `activate` is the 1 s charge,
 * the 1 s release (`release_start`, `release_end`) and the 0.35 s settle;
 * `hit` and `fall_apart` start from a captured pose. Only rig A, the one with
 * art, is ported. `npcrigs.spec.ts` checks the evaluator and the drawing
 * against the package (`reactor.fixtures.json`).
 *
 * Kept in the package's order of operations so the numbers agree to its
 * tolerance. Its renderer draws only images; the core's chamber is drawn
 * through the aperture mask (`NpcMasked`), as the package composites it
 * offscreen.
 */

const TAU = Math.PI * 2

export const CONFIG = Object.freeze({ tilt: 0.68, upper: 37, lower: 32, period: 1.6, duty: 0.68, stride: 12, lift: 7 })
/** Rig A, 'Low circular core', the one painted. */
const A = Object.freeze({ ring: 44, top: 29, shell: 39, rim: 39, aperture: 26, foot: 98 })

/** From `rig/animation-manifest.json`. */
export const CLIPS: Readonly<Record<string, NpcClip>> = Object.freeze({
  idle: { duration: 4.8, loop: true, events: [] },
  walk: { duration: 4.8, loop: true, events: [] },
  activate: { duration: 2.35, loop: false, events: [{ time: 1, name: 'release_start' }, { time: 2, name: 'release_end' }, { time: 2.35, name: 'complete' }] },
  hit: { duration: 0.68, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: {
    duration: 2.6,
    loop: false,
    events: [
      { time: 0.14, name: 'leg_break', leg: 1 }, { time: 0.14, name: 'detach' }, { time: 0.18, name: 'leg_break', leg: 2 }, { time: 0.22, name: 'leg_break', leg: 0 },
      { time: 0.25, name: 'leg_break', leg: 3 }, { time: 0.29, name: 'leg_break', leg: 5 }, { time: 0.32, name: 'leg_break', leg: 4 }, { time: 2.6, name: 'complete' }, { time: 2.6, name: 'settled' }
    ]
  }
})

interface Vec { x: number, y: number }
interface Vec3 { x: number, y: number, z: number }

const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const smooth = (t: number): number => t * t * (3 - 2 * t)
const wrap = (t: number): number => ((t % 1) + 1) % 1
export const project = (p: Vec3): Vec => ({ x: p.x, y: p.y * CONFIG.tilt - p.z })
const polar = (r: number, a: number, z: number): Vec3 => ({ x: r * Math.cos(a), y: r * Math.sin(a), z })
const length = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t))
const eased = (t: number): number => smooth(clamp01(t))

function solveLeg (hip: Vec3, foot: Vec3): Vec3 {
  const dx = foot.x - hip.x
  const dy = foot.y - hip.y
  const dz = foot.z - hip.z
  const actual = Math.hypot(dx, dy, dz)
  const d = Math.min(CONFIG.upper + CONFIG.lower - 0.001, Math.max(0.001, actual))
  const u = { x: dx / actual, y: dy / actual, z: dz / actual }
  const h = Math.hypot(dx, dy)
  const n = { x: -u.z * dx / h, y: -u.z * dy / h, z: h / actual }
  const a = (CONFIG.upper ** 2 - CONFIG.lower ** 2 + d * d) / (2 * d)
  const b = Math.sqrt(Math.max(0, CONFIG.upper ** 2 - a * a))
  return { x: hip.x + a * u.x + b * n.x, y: hip.y + a * u.y + b * n.y, z: hip.z + a * u.z + b * n.z }
}

const screenDistance = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

interface Link { upper: number, lower: number, bend: number }

/** Each leg's screen lengths in the neutral pose, captured once: the plates rotate, never stretch. */
const RIGID_LINKS: readonly Link[] = Array.from({ length: 6 }, (_, i) => {
  const a = i * TAU / 6
  const hip = polar(A.ring, a, A.top - 3)
  const foot = polar(A.foot, a, 0)
  const knee = solveLeg(hip, foot)
  const h = project(hip)
  const k = project(knee)
  const f = project(foot)
  return { upper: screenDistance(h, k), lower: screenDistance(k, f), bend: Math.sign((f.x - h.x) * (k.y - h.y) - (f.y - h.y) * (k.x - h.x)) || 1 }
})

function rigidKnee (hip: Vec3, foot: Vec3, shape: Link): Vec3 {
  const h = project(hip)
  const f = project(foot)
  const dx = f.x - h.x
  const dy = f.y - h.y
  const d = Math.hypot(dx, dy)
  if (d >= shape.upper + shape.lower || d <= Math.abs(shape.upper - shape.lower)) throw Error('Rigid leg target outside its reach')
  const along = (shape.upper ** 2 - shape.lower ** 2 + d * d) / (2 * d)
  const bend = Math.sqrt(Math.max(0, shape.upper ** 2 - along * along)) * shape.bend
  const k = { x: h.x + dx / d * along - dy / d * bend, y: h.y + dy / d * along + dx / d * bend }
  // z is bookkeeping only: the screen lengths are the constraint.
  const z = solveLeg(hip, foot).z
  return { x: k.x, y: (k.y + z) / CONFIG.tilt, z }
}

export interface ReactorLeg {
  id: number
  angle: number
  hip: Vec3
  knee: Vec3
  foot: Vec3
  contact: boolean
  phase: number
}

export interface ReactorAction { name: string, time: number, phase: string, releaseActive: boolean }

export interface ReactorFallPart {
  id: string
  legId: number
  type: 'upper' | 'lower'
  releaseTime: number
  rotation: number
  height: number
  ground: Vec
  source: ReactorLeg
  leg: ReactorLeg
  pivot: Vec
  settled: boolean
}

export interface ReactorDeath {
  time: number
  body: { translation: Vec, rotation: number, pivot: Vec, ground: Vec, height: number, settled: boolean }
  parts: ReactorFallPart[]
  attached: ReactorLeg[]
  settled: boolean
  bodyPieces: number
}

/** The package's pose: its `pose` plus what each clip adds. */
export interface ReactorState {
  variant: 'A'
  time: number
  heading: number
  position: Vec
  speed: number
  dir: Vec
  pulse: number
  bob: number
  shutter: number
  legs: ReactorLeg[]
  linkLengths: number[][]
  energy?: number
  coreLift?: number
  corePower?: number
  action?: ReactorAction
  attachments?: { core: Vec3, floor: Vec3, coreScreen: Vec, floorScreen: Vec }
  death?: ReactorDeath
}

/** The package's `pose(time, {direction})`: idle at rest, walking along `direction` (any length). */
export function pose (time = 0, { direction = { x: 0, y: 0 } }: { direction?: Vec } = {}): ReactorState {
  const len = Math.hypot(direction.x, direction.y)
  const moving = len > 0
  const dir = moving ? { x: direction.x / len, y: direction.y / len } : { x: 0, y: 0 }
  const speed = moving ? CONFIG.stride / (CONFIG.duty * CONFIG.period) : 0
  const pulse = (1 - Math.cos(TAU * time / 4.8)) * 0.5
  const bob = 0.6 * Math.sin(TAU * time / 4.8)
  const legs = Array.from({ length: 6 }, (_, i): ReactorLeg => {
    const angle = i * TAU / 6
    const phase = wrap(time / CONFIG.period + (i % 2) * 0.5)
    const stance = phase < CONFIG.duty
    const q = stance ? phase / CONFIG.duty : (phase - CONFIG.duty) / (1 - CONFIG.duty)
    const offset = moving ? (stance ? CONFIG.stride * (0.5 - q) : CONFIG.stride * (smooth(q) - 0.5)) : 0
    const hip = polar(A.ring, angle, A.top - 3 + bob)
    const home = polar(A.foot - (moving ? 6 : 0), angle, 0)
    const foot = { x: home.x + dir.x * offset, y: home.y + dir.y * offset, z: moving && !stance ? CONFIG.lift * Math.sin(Math.PI * q) ** 2 : 0 }
    return { id: i, angle, hip, knee: rigidKnee(hip, foot, RIGID_LINKS[i]), foot, contact: !moving || stance, phase }
  })
  return {
    variant: 'A',
    time,
    heading: 0,
    position: { x: dir.x * speed * time, y: dir.y * speed * time },
    speed,
    dir,
    pulse,
    bob,
    shutter: 1.2 + 2.3 * pulse,
    legs,
    linkLengths: legs.map((l) => [length(l.hip, l.knee), length(l.knee, l.foot)])
  }
}

/** The package's `activationPose(time, {startTime})`: the idle clock from `startTime` under the charge, release and settle. */
export function activationPose (time = 0, { startTime = 0 }: { startTime?: number } = {}): ReactorState {
  const t = Math.max(0, time)
  const p = pose(startTime + t)
  let phase = 'idle'
  let offset = 0
  let energy = 0
  let lift = 0
  let shutter = p.shutter
  let pulse = p.pulse
  if (t < 1) {
    phase = 'activate'
    const charge = eased(t)
    offset = -2.8 * eased(t / 0.28); shutter = mix(p.shutter, -5, charge)
    pulse = mix(p.pulse, 1, charge); energy = 0.85 * charge; lift = 4 * charge
  } else if (t < 2) {
    phase = 'release'
    const r = t - 1
    const open = eased(r / 0.10)
    offset = r < 0.10 ? mix(-2.8, 0.7, open) : 0.7 * (1 - eased((r - 0.10) / 0.90))
    shutter = mix(-5, 8.5, open); pulse = 1; energy = mix(0.85, 1, open); lift = mix(4, 6, open)
  } else if (t < CLIPS.activate.duration) {
    phase = 'settle'
    const close = eased((t - 2) / 0.35)
    shutter = mix(8.5, p.shutter, close); pulse = mix(1, p.pulse, close); energy = 1 - close; lift = 6 * (1 - close)
  }
  if (offset !== 0) {
    p.bob += offset
    for (const leg of p.legs) { leg.hip.z += offset; leg.knee = rigidKnee(leg.hip, leg.foot, RIGID_LINKS[leg.id]) }
  }
  p.shutter = shutter; p.pulse = pulse; p.energy = energy; p.coreLift = lift
  p.action = { name: 'activate', time: t, phase, releaseActive: t >= 1 && t < 2 }
  const core = { x: 0, y: 0, z: A.rim + p.bob - 13 + lift + 2.5 }
  const floor = { x: 0, y: 0, z: 0 }
  p.attachments = { core, floor, coreScreen: project(core), floorScreen: project(floor) }
  p.linkLengths = p.legs.map((l) => [length(l.hip, l.knee), length(l.knee, l.foot)])
  return p
}

const BREAK_TIMES = [0.22, 0.14, 0.18, 0.25, 0.32, 0.29]
const GRAVITY = 245
const FALL_BODY_RELEASE = 0.34

function fallAttachedPose (t: number, source: ReactorState): ReactorState {
  const p = deepClone(source)
  const brace = 2.8 * eased(t / 0.18)
  p.bob = source.bob - brace; p.shutter = mix(source.shutter, 1.2, eased(t / 0.6)); p.coreLift = mix(source.coreLift ?? 0, 0, eased(t / 0.5))
  p.corePower = 1 - eased(t / 0.55)
  for (const l of p.legs) { l.hip.z -= brace; l.knee = rigidKnee(l.hip, l.foot, RIGID_LINKS[l.id]) }
  return p
}

function fallingHeight (t: number, height: number, lift: number, restitution: number): { height: number, landed: boolean, settled: boolean } {
  if (t <= 0) return { height, landed: false, settled: false }
  let h = height
  let v = lift
  let u = t
  for (let i = 0; i < 3; i++) {
    const land = (v + Math.sqrt(v * v + 2 * GRAVITY * h)) / GRAVITY
    if (u < land) return { height: Math.max(0, h + v * u - 0.5 * GRAVITY * u * u), landed: i > 0, settled: false }
    u -= land; v = Math.sqrt(v * v + 2 * GRAVITY * h) * restitution; h = 0
  }
  return { height: 0, landed: true, settled: true }
}

const turn2 = (p: Vec, pivot: Vec, r: number, translation: Vec): Vec => ({
  x: pivot.x + Math.cos(r) * (p.x - pivot.x) - Math.sin(r) * (p.y - pivot.y) + translation.x,
  y: pivot.y + Math.sin(r) * (p.x - pivot.x) + Math.cos(r) * (p.y - pivot.y) + translation.y
})

const LOWER_SPIN = [1.1, -1.55, 0.85, -1.2, 1.65, -0.95]
const UPPER_SPIN = [-0.72, 0.94, -1.28, 0.63, -0.42, 1.13]
const RADIAL = [0, 9, -4, 6, -8, 3]

function fallPart (l: ReactorLeg, type: 'upper' | 'lower', t: number, release: number): ReactorFallPart {
  const points = type === 'upper' ? [l.hip, l.knee] : [l.knee, l.foot]
  const screen = points.map(project)
  const pivot = { x: (screen[0].x + screen[1].x) / 2, y: (screen[0].y + screen[1].y) / 2 }
  const initialHeight = (points[0].z + points[1].z) / 2
  const restHeight = 2
  const u = Math.max(0, t - release)
  const lower = type === 'lower'
  const id = l.id
  const sign = id % 2 !== 0 ? 1 : -1
  const flight = fallingHeight(u, Math.max(0, initialHeight - restHeight), lower ? 12 : 19, 0.22)
  const travel = (1 - Math.exp(-4 * u)) / 4
  const radial = (lower ? 85 : 54) + RADIAL[id]
  const tangent = sign * (lower ? 28 : 20)
  const vx = Math.cos(l.angle) * radial - Math.sin(l.angle) * tangent
  const vy = Math.sin(l.angle) * radial + Math.cos(l.angle) * tangent
  const ground = { x: pivot.x + vx * travel, y: pivot.y + initialHeight + vy * travel * CONFIG.tilt }
  const spin = (lower ? LOWER_SPIN : UPPER_SPIN)[id]
  const rotation = spin * (1 - Math.exp(-4.5 * u))
  const translation = { x: vx * travel, y: vy * travel * CONFIG.tilt + initialHeight - (flight.height + restHeight) }
  const move = (p: Vec3): Vec3 => {
    const s = turn2(project(p), pivot, rotation, translation)
    return { x: s.x, y: (s.y + p.z) / CONFIG.tilt, z: p.z }
  }
  return {
    id: `${id}_${type}`,
    legId: id,
    type,
    releaseTime: release,
    rotation,
    height: flight.height + restHeight,
    ground,
    source: l,
    leg: { ...l, hip: move(l.hip), knee: move(l.knee), foot: move(l.foot) },
    pivot: turn2(pivot, pivot, rotation, translation),
    settled: flight.settled
  }
}

/** The package's `fallApartPose(seconds, {basePose})`: the legs break off in turn, the body drops whole. */
export function fallApartPose (seconds = 0, { basePose = pose(0) }: { basePose?: ReactorState } = {}): ReactorState {
  const t = Math.max(0, Math.min(CLIPS.fall_apart.duration, seconds))
  const p = fallAttachedPose(Math.min(t, FALL_BODY_RELEASE), basePose)
  // Fade and shutter relaxation continue after the attachment pose freezes.
  p.corePower = 1 - eased(t / 0.55); p.shutter = mix(basePose.shutter, 1.2, eased(t / 0.6)); p.coreLift = mix(basePose.coreLift ?? 0, 0, eased(t / 0.5))
  const sourceBodyBottom = 15 + p.bob
  const drop = fallingHeight(Math.max(0, t - FALL_BODY_RELEASE), sourceBodyBottom, 0, 0.18)
  const q = eased((t - FALL_BODY_RELEASE) / 0.5)
  const body = { translation: { x: -4 * q, y: sourceBodyBottom - drop.height + 2 * q }, rotation: -0.065 * q, pivot: { x: 0, y: -17 - basePose.bob }, ground: { x: -4 * q, y: 2 * q }, height: drop.height, settled: drop.settled }
  const parts: ReactorFallPart[] = []
  const attached: ReactorLeg[] = []
  for (const l of p.legs) {
    const release = BREAK_TIMES[l.id]
    if (t < release) { attached.push(l); continue }
    const atRelease = fallAttachedPose(release, basePose).legs[l.id]
    parts.push(fallPart(atRelease, 'upper', t, release), fallPart(atRelease, 'lower', t, release))
  }
  const phase = t < 0.34 ? 'fail' : t < 0.85 ? 'drop' : 'settle'
  p.action = { name: 'fall_apart', time: t, phase, releaseActive: false }
  p.death = { time: t, body, parts, attached, settled: t === CLIPS.fall_apart.duration && body.settled && parts.length === 12 && parts.every((s) => s.settled), bodyPieces: 1 }
  p.speed = 0; p.dir = { x: 0, y: 0 }
  const coreZ = A.rim + p.bob - 13 + p.coreLift + 2.5
  const coreScreen = turn2({ x: 0, y: -coreZ }, body.pivot, body.rotation, body.translation)
  const core = { x: coreScreen.x, y: body.ground.y / CONFIG.tilt, z: body.ground.y - coreScreen.y }
  const floor = { x: body.ground.x, y: body.ground.y / CONFIG.tilt, z: 0 }
  p.attachments = { core, floor, coreScreen, floorScreen: project(floor) }
  p.linkLengths = p.legs.map((l) => [length(l.hip, l.knee), length(l.knee, l.foot)])
  return p
}

/** The package's `hitPose(seconds, {basePose})`: a 0.68 s compression and spring back, the feet held; exactly the source at 0 and at the end. */
export function hitPose (seconds = 0, { basePose = pose(0) }: { basePose?: ReactorState } = {}): ReactorState {
  const t = Math.max(0, Math.min(0.68, seconds))
  if (t === 0 || t === 0.68) return deepClone(basePose)
  const p = deepClone(basePose)
  const q = t / 0.68
  const drop = t < 0.085 ? 3.2 * eased(t / 0.085) : 3.2 * (1 - eased((t - 0.085) / 0.595))
  const spring = 0.5 * Math.sin(Math.PI * (t - 0.085) / 0.595) * Math.sin(Math.PI * 4 * q) * (t > 0.085 ? 1 : 0)
  p.bob -= drop + spring
  for (const l of p.legs) { l.hip.z -= drop + spring; l.knee = rigidKnee(l.hip, l.foot, RIGID_LINKS[l.id]) }
  p.shutter += 0.7 * Math.sin(8 * Math.PI * q) * Math.sin(Math.PI * q); p.corePower = (basePose.corePower ?? 1) * (1 - 0.72 * Math.exp(-8 * q) * Math.sin(6 * Math.PI * q) ** 2)
  p.linkLengths = p.legs.map((l) => [length(l.hip, l.knee), length(l.knee, l.foot)]); p.action = { name: 'hit', time: t, phase: t < 0.085 ? 'recoil' : 'recover', releaseActive: false }
  return p
}

export interface ReactorOptions { direction?: Vec, startTime?: number, basePose?: ReactorState }

/** The package's `sampleClip(name, time, options)`. */
export function sampleClip (name: string, time = 0, opts: ReactorOptions = {}): ReactorState {
  if (name === 'activate') return activationPose(time, opts)
  if (name === 'fall_apart') return fallApartPose(time, opts)
  if (name === 'hit') return hitPose(time, opts)
  return pose(time, name === 'walk' ? { ...opts, direction: opts.direction ?? { x: 1, y: 0 } } : opts)
}

/** Every part's PNG size and pivot, in its pixels (4 to a rig unit), from `rig/parts.json`. */
export const PARTS: Readonly<Record<string, { readonly w: number, readonly h: number, readonly px: number, readonly py: number }>> = Object.freeze({
  shell: { w: 380, h: 325, px: 190, py: 256 },
  chamber: { w: 216, h: 194, px: 108, py: 231 },
  core: { w: 248, h: 186, px: 124, py: 197 },
  'core-off': { w: 248, h: 186, px: 124, py: 197 },
  'core-emission': { w: 248, h: 186, px: 124, py: 197 },
  ribs: { w: 190, h: 117, px: 95, py: 190 },
  rim: { w: 320, h: 220, px: 160, py: 266 },
  shutter0: { w: 236, h: 77, px: 118, py: 272 },
  shutter1: { w: 139, h: 160, px: -19, py: 201 },
  shutter2: { w: 139, h: 160, px: 158, py: 201 },
  upper0: { w: 133, h: 78, px: -8, py: 33 },
  lower0: { w: 126, h: 74, px: -9, py: 31 },
  upper1: { w: 103, h: 78, px: -5, py: 33 },
  lower1: { w: 147, h: 74, px: -12, py: 31 },
  upper2: { w: 103, h: 78, px: -5, py: 33 },
  lower2: { w: 147, h: 74, px: -12, py: 31 },
  upper3: { w: 133, h: 78, px: -8, py: 33 },
  lower3: { w: 126, h: 74, px: -9, py: 31 },
  upper4: { w: 109, h: 78, px: -5, py: 33 },
  lower4: { w: 80, h: 74, px: -3, py: 31 },
  upper5: { w: 109, h: 78, px: -5, py: 33 },
  lower5: { w: 80, h: 74, px: -3, py: 31 },
  hip: { w: 58, h: 52, px: 29, py: 26 },
  knee: { w: 62, h: 56, px: 31, py: 28 },
  'aperture-mask': { w: 512, h: 512, px: 256, py: 360 },
  shadow: { w: 256, h: 128, px: 128, py: 64 }
})

/**
 * A Canvas 2D context's transform and alpha, and the images it draws, as the
 * package's renderer uses them; what it draws becomes the draw list.
 */
class Pen {
  m: Matrix = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }
  alpha = 1
  private readonly stack: Array<{ m: Matrix, alpha: number }> = []
  constructor (readonly out: NpcDrawItem[]) {}
  save (): void { this.stack.push({ m: this.m, alpha: this.alpha }) }
  restore (): void { const s = this.stack.pop()!; this.m = s.m; this.alpha = s.alpha }
  translate (x: number, y: number): void { this.m = multiply(this.m, { a: 1, b: 0, c: 0, d: 1, x, y }) }
  scale (x: number, y: number): void { this.m = multiply(this.m, { a: x, b: 0, c: 0, d: y, x: 0, y: 0 }) }
  rotate (r: number): void { this.m = multiply(this.m, { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), x: 0, y: 0 }) }
  /** `drawImage(art, x, y, w, h)`. */
  image (art: string, x: number, y: number, w: number, h: number, contact = false): NpcImage {
    const part = PARTS[art]
    const image: NpcImage = { kind: 'image', art, m: multiply(this.m, { a: w / part.w, b: 0, c: 0, d: h / part.h, x, y }), alpha: this.alpha, contact: contact || undefined }
    this.out.push(image)
    return image
  }
}

/** The package's `sprite`: a part at its pivot, turned, its alpha multiplied in. */
function sprite (c: Pen, id: string, x = 0, y = 0, rotation = 0, alpha = 1): void {
  const m = PARTS[id]
  c.save(); c.translate(x, y); if (rotation !== 0) c.rotate(rotation); c.alpha *= alpha
  c.image(id, -m.px / 4, -m.py / 4, m.w / 4, m.h / 4)
  c.restore()
}
function joint (c: Pen, p: Vec3, id = 'hip'): void { const s = project(p); sprite(c, id, s.x, s.y) }
function section (c: Pen, l: ReactorLeg, type: 'upper' | 'lower'): void {
  const a = project(type === 'upper' ? l.hip : l.knee)
  const b = project(type === 'upper' ? l.knee : l.foot)
  sprite(c, `${type}${l.id}`, a.x, a.y, Math.atan2(b.y - a.y, b.x - a.x))
  if (type === 'lower') joint(c, l.knee, 'knee')
}
function drawLeg (c: Pen, l: ReactorLeg): void { section(c, l, 'lower'); section(c, l, 'upper'); joint(c, l.knee, 'knee'); joint(c, l.hip) }

/**
 * The package's `drawBody`: the shell, the chamber seen through the aperture
 * (drawn offscreen at 4 px a unit from 256, 360 and cut by `aperture-mask`,
 * then laid back over 128 units from -64, -90: the same place), the rim and
 * the three shutters.
 */
function drawBody (c: Pen, p: ReactorState): void {
  c.save(); c.translate(0, -p.bob); sprite(c, 'shell')
  const inner: NpcDrawItem[] = []
  const ic = new Pen(inner)
  ic.translate(256, 360); ic.scale(4, 4)
  const lift = p.coreLift ?? 0
  sprite(ic, 'chamber'); sprite(ic, 'core-off', 0, -lift)
  const power = p.corePower ?? 1
  sprite(ic, 'core-emission', 0, -lift, 0, (0.55 + 0.3 * p.pulse + 0.15 * (p.energy ?? 0)) * power)
  sprite(ic, 'core', 0, -lift, 0, power); sprite(ic, 'ribs')
  // The surface's pixels to the body's units, then the surface's own drawing.
  c.save(); c.translate(-64, -90); c.scale(128 / 512, 128 / 512)
  const items = inner.map((i) => ({ ...(i as NpcImage), m: multiply(c.m, (i as NpcImage).m), alpha: (i as NpcImage).alpha! * c.alpha }))
  // The mask is drawn into the surface untransformed: its pixels are the surface's.
  c.out.push({ kind: 'masked', items, mask: { kind: 'image', art: 'aperture-mask', m: c.m, alpha: 1 } })
  c.restore()
  sprite(c, 'rim')
  for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + i * TAU / 3; sprite(c, `shutter${i}`, Math.cos(a) * p.shutter, Math.sin(a) * p.shutter * CONFIG.tilt) }
  c.restore()
}

function bodyTransform (c: Pen, b: ReactorDeath['body']): void {
  c.translate(b.pivot.x + b.translation.x, b.pivot.y + b.translation.y); c.rotate(b.rotation); c.translate(-b.pivot.x, -b.pivot.y)
}
function shadowAt (c: Pen, x: number, y: number, w: number, h: number, alpha = 1): void {
  c.save(); c.alpha *= alpha; c.image('shadow', x - w, y - h, w * 2, h * 2, true); c.restore()
}

function drawFallApart (c: Pen, p: ReactorState): void {
  const d = p.death!
  shadowAt(c, d.body.ground.x, d.body.ground.y + 6, 60, 29)
  for (const s of d.parts) shadowAt(c, s.ground.x, s.ground.y, 15, 3.2)
  const sorted = [...d.parts].sort((a, b) => a.ground.y - b.ground.y)
  const back = (s: ReactorFallPart): boolean => s.ground.y <= d.body.ground.y
  for (const l of d.attached.filter((l) => l.hip.y <= 0.01)) drawLeg(c, l)
  for (const s of sorted.filter(back)) section(c, s.leg, s.type)
  c.save(); bodyTransform(c, d.body)
  for (const l of p.legs.filter((l) => l.hip.y < -0.01 && !d.attached.some((a) => a.id === l.id))) joint(c, l.hip)
  drawBody(c, p); c.restore()
  for (const l of d.attached.filter((l) => l.hip.y > 0.01)) drawLeg(c, l)
  for (const s of sorted.filter((s) => !back(s))) section(c, s.leg, s.type)
  c.save(); bodyTransform(c, d.body); for (const l of p.legs.filter((l) => l.hip.y >= -0.01)) joint(c, l.hip); c.restore()
}

/** The package's `drawReactor(context, pose, 0, 0, 1)`, shadows on, as a draw list (shadows are `contact` images, in turn). */
export function draw (p: ReactorState): NpcDrawList {
  const items: NpcDrawItem[] = []
  const c = new Pen(items)
  if (p.death !== undefined && p.death.time > 0) {
    drawFallApart(c, p)
    return { ground: [], items }
  }
  shadowAt(c, 0, 6, 60, 29)
  for (const l of p.legs) { const f = project({ ...l.foot, z: 0 }); shadowAt(c, f.x, f.y, 6, 3, l.contact ? 1 : 0.42) }
  const sorted = [...p.legs].sort((a, b) => a.hip.y - b.hip.y)
  for (const l of sorted.filter((l) => l.hip.y <= 0.01)) drawLeg(c, l)
  drawBody(c, p)
  for (const l of sorted.filter((l) => l.hip.y > 0.01)) drawLeg(c, l)
  for (const l of sorted.filter((l) => l.hip.y >= -0.01)) joint(c, l.hip)
  return { ground: [], items }
}

/** The rig units from the ground to the shell's top at rest (the shell's pivot is 64 units below its top edge). */
const REFERENCE_UNITS = PARTS.shell.py / 4 + pose(0).bob

export const REACTOR_RIG: NpcRig = Object.freeze({
  key: 'reactor' as const,
  clips: CLIPS,
  // Nick, 2026-10-07: 211% of its own rig (ideas/npc-roster.md; the package's gameScale).
  sizeScale: 2.11,
  referenceUnits: REFERENCE_UNITS,
  deathHolds: true,
  roles: Object.freeze({
    idle: 'idle',
    move: 'walk',
    // The tell (effect 11) plays the charge; the release (effect 12) lands on
    // release_start. Hits are an overlay (#52).
    attack: Object.freeze({ clip: 'activate', event: 1 }),
    hit: 'hit',
    // It falls apart from whatever it shows, the activation included.
    death: Object.freeze({ clip: 'fall_apart', from: 0, fromAction: true })
  }),
  pose: (clip: string, seconds: number, direction: { x: number, y: number }, _aim?: { x: number, y: number }, from?: NpcPose): NpcPose => {
    const base = from?.state as ReactorState | undefined
    if (clip === 'hit' || clip === 'fall_apart') return { clip, time: seconds, state: sampleClip(clip, seconds, { basePose: base ?? pose(0) }) }
    // The charge rides the idle clock from where the loop was.
    if (clip === 'activate') return { clip, time: seconds, state: activationPose(seconds, { startTime: base?.action === undefined ? (base?.time ?? 0) : 0 }) }
    return { clip, time: seconds, state: pose(seconds, clip === 'walk' ? { direction } : {}) }
  },
  draw: (p: NpcPose): NpcDrawList => draw(p.state as ReactorState),
  arts: Object.freeze(Object.fromEntries(Object.entries(PARTS).map(([k, v]) => [k, Object.freeze({ w: v.w, h: v.h })])))
})
