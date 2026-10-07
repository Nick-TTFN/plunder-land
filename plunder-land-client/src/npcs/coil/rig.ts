import { type Matrix, multiply } from '../../peep/rig'
import { deepClone } from '../clone'
import { type NpcClip, type NpcDrawList, type NpcImage, type NpcPose, type NpcRig } from '../npcrig'

/**
 * The Coil (l1-9): a hand port of `tools/coil.mjs` and `tools/actions.mjs` in
 * its Codex package (`codex_output/npc-refinements/coil-v5`, not checked in).
 * **PROVISIONAL**: v5 (the hit, the fall apart and the baked effect PNGs) is
 * delivered but not yet approved by Nick (v4 was); a re-sync after his review
 * is expected (`tools/npc-rig-sync.mjs coil`, `tools/bake-npc-atlas.py coil`).
 *
 * A tripod under one painted torso. `charge` is the field's pulse: gather to
 * 1.2 s, release to 1.5 s, the hold to 3.0 s (the package's "Hold /
 * white-hot"), then cool and settle; the package names no event in it.
 * `basePose` is the package's stateless evaluator, `actionPose` its hit and
 * fall apart from a captured pose, and `draw` its `drawCoil` as a draw list.
 * `npcrigs.spec.ts` checks all three against the package
 * (`coil.fixtures.json`).
 *
 * The package mixes its body and cooled body offscreen (`cooledBody`:
 * `1 - dark` source-over, `dark` lighter); the port draws the body, then the
 * cooled body over it at `dark`. That is the same where both are opaque (the
 * armour: 478,839 of the body's 501,854 drawn pixels have alpha 250 or more);
 * the faint halo the cooled body drops (12,894 pixels, mostly alpha 1-10 in
 * the body, 0 in the cooled one) stays at full instead of fading with `dark`,
 * until `dark` reaches 1 and the body is no longer drawn (measured with PIL,
 * 2026-10-07). The bloom is drawn with `screen`, as the package's.
 */

const TAU = Math.PI * 2

/** From `rig/animation-manifest.json` (the move's `gaitPeriod` 2.1 is `CONFIG.period`). */
export const CLIPS: Readonly<Record<string, NpcClip>> = Object.freeze({
  idle: { duration: 4.2, loop: true, events: [] },
  move: { duration: 4.2, loop: true, events: [] },
  charge: { duration: 4.2, loop: true, events: [] },
  hit: { duration: 0.72, loop: false, events: [{ time: 0, name: 'hurt' }] },
  fall_apart: { duration: 2.8, loop: false, events: [{ time: 0.18, name: 'detach' }, { time: 0.27, name: 'right_detach' }, { time: 0.32, name: 'rear_detach' }, { time: 2.8, name: 'settled' }] }
})

export const CONFIG = Object.freeze({ tilt: 0.68, period: 2.1, duty: 0.77, stride: 6, lift: 4 })

/** The charge's phases (`basePose`): the hold ends at 3.0 s, when the server's field does (tell + hold). */
export const CHARGE = Object.freeze({ releaseEnd: 1.5, holdEnd: 3.0 })

interface Vec { x: number, y: number }
interface Vec3 { x: number, y: number, z: number }

interface Shape { w: number, h: number, start: Vec, end: Vec }
interface FootShape { w: number, h: number, socket: Vec, ground: Vec }

/** `tools/art-meta.mjs` (`parts`) and `art` in `coil.mjs`. */
const ART = Object.freeze({
  body: { w: 1536, h: 1024, scale: 0.095, pivot: { x: 768, y: 353 } },
  upper: { w: 303, h: 690, start: { x: 206, y: 110 }, end: { x: 43, y: 618 } } as Shape,
  lower: { w: 184, h: 680, start: { x: 60, y: 87 }, end: { x: 144, y: 647 } } as Shape,
  foot: { w: 459, h: 360, socket: { x: 218, y: 22 }, ground: { x: 218, y: 343 } } as FootShape,
  rearfoot: { w: 364, h: 293, socket: { x: 164, y: 18 }, ground: { x: 164, y: 275 } } as FootShape
})

/** Every image the draw list names, with its PNG size (`rig/parts.json`). */
const ARTS: Readonly<Record<string, { readonly w: number, readonly h: number }>> = Object.freeze({
  body: { w: 1536, h: 1024 },
  dark: { w: 1536, h: 1024 },
  heat: { w: 1536, h: 1024 },
  bloom: { w: 1536, h: 1024 },
  upper: { w: 303, h: 690 },
  lower: { w: 184, h: 680 },
  foot: { w: 459, h: 360 },
  rearfoot: { w: 364, h: 293 },
  shadow: { w: 632, h: 240 },
  'foot-shadow': { w: 112, h: 48 },
  'rear-shadow': { w: 80, h: 48 },
  ring: { w: 320, h: 112 },
  'ring-charge': { w: 320, h: 112 },
  'local-glow': { w: 544, h: 544 }
})

interface LegDef { id: string, label: string, hip: Vec, home: Vec, upper: number, lower: number, bend: number, phase: number }

const LEG_DEFS: readonly LegDef[] = Object.freeze([
  { id: 'rear', label: 'Rear socket', hip: { x: -1, y: -60 }, home: { x: 0, y: -4 }, upper: 24, lower: 31, bend: 1, phase: 0 },
  { id: 'left', label: 'Left shoulder', hip: { x: -36.9, y: -73 }, home: { x: -78, y: 45 }, upper: 45, lower: 55, bend: -1, phase: 1 / 3 },
  { id: 'right', label: 'Right shoulder', hip: { x: 38.35, y: -73.2 }, home: { x: 78, y: 45 }, upper: 45, lower: 55, bend: 1, phase: 2 / 3 }
])

export interface CoilLeg extends LegDef {
  foot: Vec
  ankle: Vec
  knee: Vec
  worldFoot: Vec3
  contact: boolean
}

interface BodyTransform { x: number, y: number, rotation: number, pivot: Vec }

export interface CoilDebris {
  id: string
  legId: string
  kind: 'upper' | 'lower'
  releaseTime: number
  source: CoilLeg
  pivot: Vec
  rotation: number
  x: number
  y: number
  settled: boolean
}

/** The package's pose: `basePose`'s, and with `action` its hit's or fall apart's. */
export interface CoilState {
  time: number
  mode: string
  heading: number
  bob: number
  charge: number
  heat: number
  extension: number
  phaseName: string
  position: Vec
  legs: CoilLeg[]
  action?: { name: string, time: number, sourceMode: string, sourceTime: number }
  bodyTransform?: BodyTransform
  dark?: number
  debris?: CoilDebris[]
  settled?: boolean
}

const wrap = (t: number): number => ((t % 1) + 1) % 1
const clamp = (t: number): number => Math.max(0, Math.min(1, t))
const smooth = (t: number): number => t * t * (3 - 2 * t)
const project = (p: Vec & { z?: number }): Vec => ({ x: p.x, y: p.y * CONFIG.tilt - (p.z ?? 0) })

export function kneeFor (h: Vec, f: Vec, l: LegDef): Vec {
  const dx = f.x - h.x
  const dy = f.y - h.y
  const d = Math.hypot(dx, dy)
  if (d >= l.upper + l.lower || d <= Math.abs(l.upper - l.lower)) throw Error(`Unreachable ${l.id}: ${d}`)
  const a = (l.upper * l.upper - l.lower * l.lower + d * d) / (2 * d)
  const b = Math.sqrt(Math.max(0, l.upper * l.upper - a * a)) * l.bend
  return { x: h.x + dx / d * a - dy / d * b, y: h.y + dy / d * a + dx / d * b }
}

export interface CoilOptions {
  mode?: string
  direction?: Vec
}

/** The package's `basePose`: idle, move along `direction`, or the charge. */
export function basePose (time = 0, { mode = 'idle', direction = { x: 0, y: 0 } }: CoilOptions = {}): CoilState {
  const moving = mode === 'move' && Math.hypot(direction.x, direction.y) > 0
  const n = Math.hypot(direction.x, direction.y) || 1
  const dir = { x: direction.x / n, y: direction.y / n }
  const speed = moving ? CONFIG.stride / (CONFIG.period * CONFIG.duty) : 0
  const t = wrap(time / 4.2) * 4.2
  // Release rises briskly out of a deep wind-up, then holds near extension
  // for exactly 1.5 seconds. Feet and artwork dimensions remain fixed.
  let charge = 0
  let heat = 0
  let extension = 0
  let phaseName = 'Idle'
  const idleBob = 0.4 * Math.sin(TAU * time / 4.2)
  let bob = idleBob
  if (mode === 'charge') {
    const wind = smooth(clamp(t / 1.2))
    const rise = smooth(clamp((t - 1.2) / 0.3))
    const recovery = smooth(clamp((t - 3) / 0.7))
    charge = (0.6 * wind + 0.4 * rise) * (1 - recovery)
    extension = rise * (1 - recovery)
    heat = (0.16 * wind + 0.84 * rise) * (1 - smooth(clamp((t - 2.9) / 0.8)))
    const engagement = wind * (1 - recovery)
    bob = idleBob * (1 - engagement) - 6 * wind * (1 - rise) + 5 * extension
    phaseName = t < 1.2 ? 'Gather' : t < 1.5 ? 'Release' : t < 3 ? 'Hold / white-hot' : t < 3.7 ? 'Cool / settle' : 'Idle'
  }
  const legs = LEG_DEFS.map((l): CoilLeg => {
    const phase = wrap(time / CONFIG.period + l.phase)
    const contact = !moving || phase < CONFIG.duty
    const q = phase < CONFIG.duty ? phase / CONFIG.duty : (phase - CONFIG.duty) / (1 - CONFIG.duty)
    const offset = moving ? (contact ? CONFIG.stride * (0.5 - q) : CONFIG.stride * (smooth(q) - 0.5)) : 0
    const worldFoot = { x: l.home.x + dir.x * offset, y: l.home.y + dir.y * offset, z: moving && !contact ? CONFIG.lift * Math.sin(Math.PI * q) ** 2 : 0 }
    const hip = { x: l.hip.x, y: l.hip.y - bob }
    const foot = project(worldFoot)
    const ankle = { x: foot.x, y: foot.y - (l.id === 'rear' ? 9 : 18) }
    const knee = kneeFor(hip, ankle, l)
    return { ...l, hip, foot, ankle, knee, worldFoot, contact, phase }
  })
  return { time, mode, heading: 0, bob, charge, heat, extension, phaseName, position: { x: dir.x * speed * time, y: dir.y * speed * time }, legs }
}

// --- actions.mjs ---

const ACTION_DURATIONS: Readonly<Record<string, number>> = Object.freeze({ hit: 0.72, fall_apart: 2.8 })
const sat = (x: number): number => Math.max(0, Math.min(1, x))
const ease = (x: number): number => { x = sat(x); return x * x * (3 - 2 * x) }
const rotateAbout = (p: Vec, o: Vec, r: number): Vec => ({ x: o.x + (p.x - o.x) * Math.cos(r) - (p.y - o.y) * Math.sin(r), y: o.y + (p.x - o.x) * Math.sin(r) + (p.y - o.y) * Math.cos(r) })

/** The package's `actionPose`: a hit or the fall apart from `base`, captured once. */
export function actionPose (name: 'hit' | 'fall_apart', time: number, base: CoilState): CoilState {
  const p = deepClone(base)
  const t = Math.max(0, Math.min(ACTION_DURATIONS[name], time))
  p.action = { name, time: t, sourceMode: base.mode, sourceTime: base.time }
  p.bodyTransform = { x: 0, y: 0, rotation: 0, pivot: { x: 0, y: -73 - base.bob } }
  p.dark = 0
  if (name === 'hit') {
    const q = t / 0.72
    const e = Math.sin(Math.PI * q) ** 2
    const shock = Math.sin(Math.PI * Math.min(1, t / 0.16))
    const dx = -3.3 * e * Math.cos(q * Math.PI * 2)
    const dy = 3.8 * e + 1.8 * shock
    const roll = 0.035 * e * Math.sin(q * Math.PI * 3)
    Object.assign(p.bodyTransform, { x: dx, y: dy, rotation: roll })
    const pivot = p.bodyTransform.pivot
    p.legs = p.legs.map((l) => { const hip = rotateAbout(l.hip, pivot, roll); hip.x += dx; hip.y += dy; return { ...l, hip, knee: kneeFor(hip, l.ankle, l) } })
    p.dark = 0.65 * Math.sin(Math.PI * sat(t / 0.28)) ** 2 * (0.55 + 0.45 * Math.cos(t * 70) ** 2)
    p.heat = base.heat * (1 - p.dark)
    p.charge = base.charge * (1 - p.dark)
    return p
  }
  // First the left support folds, then the remaining supports fail in sequence.
  const bodyAt = (u: number): BodyTransform => {
    const buckle = ease(u / 0.18)
    const q = ease((u - 0.18) / 0.86)
    const b = u > 1.04 && u < 2.8 ? Math.sin((u - 1.04) * 14) * Math.exp(-(u - 1.04) * 4) * (1 - ease((u - 2.2) / 0.6)) : 0
    return { x: -4 * buckle * (1 - q) - 32 * q, y: 5 * buckle * (1 - q) + (69 + base.bob) * q - 4 * Math.abs(b), rotation: -0.055 * buckle * (1 - q) - 1.38 * q + 0.055 * b, pivot: { x: 0, y: -73 - base.bob } }
  }
  const attached = (l: CoilLeg, u: number): CoilLeg => {
    const b = bodyAt(u)
    const hip = rotateAbout(l.hip, b.pivot, b.rotation)
    hip.x += b.x; hip.y += b.y
    return { ...l, hip, knee: kneeFor(hip, l.ankle, l) }
  }
  p.bodyTransform = bodyAt(t)
  p.dark = ease(t / 0.55)
  p.heat = base.heat * (1 - p.dark)
  p.charge = base.charge * (1 - p.dark)
  p.debris = []
  p.legs = []
  base.legs.forEach((l, i) => {
    const release = [0.32, 0.18, 0.27][i]
    if (t < release) { p.legs!.push(attached(l, t)); return }
    const s = attached(l, release)
    for (const kind of ['upper', 'lower'] as const) {
      const upper = kind === 'upper'
      const a = upper ? s.hip : s.knee
      const b = upper ? s.knee : s.ankle
      const o = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const q = ease((t - release) / (1.1 + i * 0.15))
      const angle = Math.atan2(b.y - a.y, b.x - a.x)
      const target = [0.15, -0.18, 0.22][i] + (upper ? 0.1 : -0.2)
      const rotation = (target - angle) * q
      const end = { x: [-20, -88, 51][i] + (upper ? 0 : 22), y: [5, 25, 30][i] + (upper ? -9 : 6) }
      const bounce = t > release + 0.65 && t < 2.8 ? Math.abs(Math.sin((t - release - 0.65) * 13)) * Math.exp(-(t - release - 0.65) * 4) * 4 * (1 - ease((t - 2.1) / 0.7)) : 0
      p.debris!.push({ id: l.id + '_' + kind, legId: l.id, kind, releaseTime: release, source: s, pivot: o, rotation, x: (end.x - o.x) * q, y: (end.y - o.y) * q - bounce, settled: t === 2.8 })
    }
  })
  p.settled = t === 2.8
  return p
}

/**
 * The pose a hit was captured from: a hit moves only the hips and knees (and
 * dims heat and charge, which are 0 in the idle and move it plays over), so
 * the source's are rebuilt as `basePose` made them, exactly.
 */
export function hitSource (hit: CoilState): CoilState {
  const { action, bodyTransform, dark, ...rest } = hit
  const legs = rest.legs.map((l, i) => {
    const hip = { x: LEG_DEFS[i].hip.x, y: LEG_DEFS[i].hip.y - rest.bob }
    return { ...l, hip, knee: kneeFor(hip, l.ankle, l) }
  })
  return { ...rest, time: action?.sourceTime ?? rest.time, mode: action?.sourceMode ?? rest.mode, legs }
}

// --- coil.mjs: drawCoil ---

const translate = (x: number, y: number): Matrix => ({ a: 1, b: 0, c: 0, d: 1, x, y })
const rotation = (r: number): Matrix => ({ a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), x: 0, y: 0 })
const rect = (art: string, x: number, y: number, w: number, h: number): Matrix => ({ a: w / ARTS[art].w, b: 0, c: 0, d: h / ARTS[art].h, x, y })

/** `segmentMatrix` in `coil.mjs`. */
function segmentMatrix (a: Vec, b: Vec, shape: { start: Vec, end: Vec }): Matrix {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const sc = Math.hypot(dx, dy) / Math.hypot(shape.end.x - shape.start.x, shape.end.y - shape.start.y)
  const r = Math.atan2(dy, dx) - Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x)
  const ca = Math.cos(r) * sc
  const si = Math.sin(r) * sc
  return { a: ca, b: si, c: -si, d: ca, x: a.x - ca * shape.start.x + si * shape.start.y, y: a.y - si * shape.start.x - ca * shape.start.y }
}

function drawLeg (out: NpcImage[], at: Matrix, l: CoilLeg, only: 'upper' | 'lower' | null = null): void {
  if (only !== 'upper') {
    const footId = l.id === 'rear' ? 'rearfoot' : 'foot'
    const shape = ART[footId]
    const sc = (l.id === 'rear' ? 9 : 18) / (shape.ground.y - shape.socket.y)
    let m = multiply(at, translate(l.foot.x, l.foot.y))
    if (l.id === 'left') m = multiply(m, { a: -1, b: 0, c: 0, d: 1, x: 0, y: 0 })
    out.push({ kind: 'image', art: footId, m: multiply(m, { a: sc, b: 0, c: 0, d: sc, x: -shape.ground.x * sc, y: -shape.ground.y * sc }) })
  }
  for (const [key, a, b] of [['upper', l.hip, l.knee], ['lower', l.knee, l.ankle]] as const) {
    if (only !== null && key !== only) continue
    const mirror = key === 'upper' ? l.id === 'right' : l.id === 'left'
    const shape = ART[key]
    const s = mirror ? { start: { x: shape.w - shape.start.x, y: shape.start.y }, end: { x: shape.w - shape.end.x, y: shape.end.y } } : shape
    let m = multiply(at, segmentMatrix(a, b, s))
    if (mirror) m = multiply(m, { a: -1, b: 0, c: 0, d: 1, x: shape.w, y: 0 })
    out.push({ kind: 'image', art: key, m })
  }
}

/** The package's `drawCoil` at 0,0 and scale 1, as a draw list (images it draws invisible, at opacity 0, left out). */
export function draw (p: CoilState): NpcDrawList {
  const items: NpcImage[] = []
  const id: Matrix = translate(0, 0)
  items.push({ kind: 'image', art: 'shadow', m: rect('shadow', -79, -24, 158, 60), contact: true })
  for (const l of p.legs) {
    const f = project({ ...l.worldFoot, z: 0 })
    const rear = l.id === 'rear'
    items.push({ kind: 'image', art: rear ? 'rear-shadow' : 'foot-shadow', m: rect(rear ? 'rear-shadow' : 'foot-shadow', f.x - (rear ? 10 : 14), f.y - 5, rear ? 20 : 28, 12), contact: true })
  }
  for (const l of p.legs) drawLeg(items, id, l)
  for (const d of p.debris ?? []) {
    const m = multiply(multiply(translate(d.x + d.pivot.x, d.y + d.pivot.y), rotation(d.rotation)), translate(-d.pivot.x, -d.pivot.y))
    drawLeg(items, m, d.source, d.kind)
  }
  const b = p.bodyTransform ?? { x: 0, y: 0, rotation: 0, pivot: { x: 0, y: 0 } }
  const body = multiply(multiply(translate(b.x + b.pivot.x, b.y + b.pivot.y), rotation(b.rotation)), translate(-b.pivot.x, -b.pivot.y))
  const s = ART.body.scale
  const px = -ART.body.pivot.x * s
  const py = -73 - p.bob - ART.body.pivot.y * s
  const bodyAt = (art: string): Matrix => multiply(body, rect(art, px, py, ART.body.w * s, ART.body.h * s))
  const dark = p.dark ?? 0
  // `cooledBody`: the body, the cooled body, or the cooled body over the body at `dark` (see the header).
  if (dark !== 1) items.push({ kind: 'image', art: 'body', m: bodyAt('body') })
  if (dark !== 0) items.push({ kind: 'image', art: 'dark', m: bodyAt('dark'), alpha: dark === 1 ? undefined : dark })
  const energy = 1 - dark
  const flicker = 0.045 + 0.025 * Math.sin(p.time * TAU / 2.1)
  for (const [i, yy] of [[0, -52], [1, -35]]) {
    for (const [art, weight] of [['ring', 1 - p.charge], ['ring-charge', p.charge]] as const) {
      const alpha = (flicker + (i === 0 ? 0.2 : 0) * p.charge) * energy * weight
      if (alpha !== 0) items.push({ kind: 'image', art, m: multiply(body, rect(art, -20, yy - p.bob - 7, 40, 14)), alpha, effect: true })
    }
  }
  if (p.charge > 0 && p.charge * 0.2 * energy !== 0) items.push({ kind: 'image', art: 'local-glow', m: multiply(body, rect('local-glow', -34, -74 - p.bob, 68, 68)), alpha: p.charge * 0.2 * energy, effect: true })
  if (p.heat > 0) {
    items.push({ kind: 'image', art: 'bloom', m: bodyAt('bloom'), alpha: p.heat * 0.38, blend: 'screen', effect: true })
    items.push({ kind: 'image', art: 'heat', m: bodyAt('heat'), alpha: p.heat * 0.97, effect: true })
  }
  return { ground: [], items }
}

/** The rig units from the ground to the top of the idle pose's body (the torso is the highest part). */
const REFERENCE_UNITS = 73 + ART.body.pivot.y * ART.body.scale

export const COIL_RIG: NpcRig = Object.freeze({
  key: 'coil' as const,
  clips: CLIPS,
  // Nick, 2026-10-07: 121% of its own rig (ideas/npc-roster.md; the package's gameScale).
  sizeScale: 1.21,
  referenceUnits: REFERENCE_UNITS,
  deathHolds: true,
  roles: Object.freeze({
    idle: 'idle',
    move: 'move',
    // The pulse (effect 13, sent at the charge's start with a lifetime of
    // tell + hold): started so the hold's end, 3.0 s in, lands when the
    // server's field ends; so the clip starts at 0 on the effect. The
    // package names no event in its charge, and doesn't support a hit over it.
    attack: Object.freeze({ clip: 'charge', event: CHARGE.holdEnd, refusesHit: true }),
    hit: 'hit',
    holdGaitOnHit: true,
    // It falls apart from whatever it shows, any phase of the charge included.
    death: Object.freeze({ clip: 'fall_apart', from: 0, fromAction: true })
  }),
  pose: (clip: string, seconds: number, direction: Vec, _aim?: Vec, from?: NpcPose): NpcPose => {
    if (clip === 'hit' || clip === 'fall_apart') {
      let base = from?.state as CoilState | undefined
      // A death during a hit starts from the hit's source, as the package captures only idle, move and charge.
      if (base?.action?.name === 'hit') base = hitSource(base)
      // The package has no hit over the charge (`NpcSprite` never asks for one); never throw in a frame.
      if (base === undefined || base.action !== undefined || (clip === 'hit' && base.mode === 'charge')) base = basePose(0)
      return { clip, time: seconds, state: actionPose(clip, seconds, base) }
    }
    const state = clip === 'move' ? basePose(seconds, { mode: 'move', direction }) : basePose(seconds, { mode: clip })
    return { clip, time: seconds, state }
  },
  draw: (p: NpcPose): NpcDrawList => draw(p.state as CoilState),
  arts: ARTS
})
