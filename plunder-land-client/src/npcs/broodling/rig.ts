import { type Matrix, multiply } from '../../peep/rig'
import { cssColour } from '../colour'
import { type NpcClip, type NpcDrawItem, type NpcDrawList, type NpcDrawOptions, type NpcEllipse, type NpcPose, type NpcPoseOptions, type NpcRig } from '../npcrig'

/**
 * The Broodling (l1-8): a hand port of `tools/broodling.mjs` in its Codex
 * package (`codex_output/npc-refinements/broodling-v3`, an export-only copy of
 * the approved v2, not checked in). A bomb body on four short legs with a lit
 * fuse; it walks, emerges from a socket, and detonates. `sample` is the
 * package's pose function and `draw` its `drawBroodling`, as a draw list; both
 * are checked against the package by `npcrigs.spec.ts`
 * (`broodling.fixtures.json`, `tools/npc-rig-sync.mjs broodling`).
 *
 * The fuse, its ember and sparks, the socket and the blast are drawn in code,
 * as the package draws them. Its legs are the Crawler's art.
 */

const TAU = Math.PI * 2

export const CFG = Object.freeze({ tilt: 0.68, renderScale: 1.12, bodyWidth: 38, bodyHeight: 38 * 1069 / 1052, upper: 13, lower: 18, period: 0.72, duty: 0.76, stride: 6, lift: 3.5, fuseLength: 1 })

/** From `rig/animation-manifest.json`; the walk's 2.88 s is the preview's cycle of four 0.72 s steps. */
export const CLIPS: Readonly<Record<string, NpcClip>> = Object.freeze({
  idle: { duration: 3.6, loop: true, events: [] },
  walk: { duration: 2.88, loop: true, events: [] },
  detonate: { duration: 2.8, loop: false, events: [{ time: 1.35, name: 'detonate' }] },
  emerge: { duration: 3.6, loop: false, events: [] }
})

const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x))
const smooth = (x: number): number => { x = clamp(x); return x * x * (3 - 2 * x) }
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const wrap = (x: number): number => ((x % 1) + 1) % 1

interface Vec { x: number, y: number }
interface Vec3 { x: number, y: number, z: number }

const project = (p: Vec3): Vec => ({ x: p.x, y: p.y * CFG.tilt - p.z })

const DEFINITIONS = [{ id: 0, side: -1, row: -1, phase: 0 }, { id: 1, side: 1, row: -1, phase: 0.5 }, { id: 2, side: -1, row: 1, phase: 0.75 }, { id: 3, side: 1, row: 1, phase: 0.25 }]

function knee (h: Vec, f: Vec, side: number): Vec {
  const dx = f.x - h.x
  const dy = f.y - h.y
  const d = Math.hypot(dx, dy)
  const a = (CFG.upper ** 2 - CFG.lower ** 2 + d * d) / (2 * d)
  if (d >= CFG.upper + CFG.lower || d <= Math.abs(CFG.upper - CFG.lower)) throw Error(`Unreachable leg: ${d}`)
  const b = Math.sqrt(Math.max(0, CFG.upper ** 2 - a * a))
  return { x: h.x + dx / d * a + dy / d * b * side, y: h.y + dy / d * a - dx / d * b * side }
}

export interface BroodlingLeg {
  id: number
  side: number
  row: number
  phase: number
  hip: Vec
  knee: Vec
  foot: Vec3
  screenFoot: Vec
  contact: boolean
}

export interface BroodlingState {
  clip: string
  time: number
  body: { x: number, y: number, width: number, height: number }
  legs: BroodlingLeg[]
  root: Vec3
  fold: number
  contract: number
  fuseBurn: number
  fuseLength: number
  direction: Vec
  dead: boolean
  blastTime: number
  worldTravel: Vec
}

/**
 * The package's `sample(clip, time, {direction, fuseLength})`. `fuseLength`
 * draws the cord 0.25-2x as long about its collar; it never changes timing.
 */
export function sample (clip: string, time: number, { direction = { x: 1, y: 0 }, fuseLength = CFG.fuseLength }: { direction?: Vec, fuseLength?: number } = {}): BroodlingState {
  fuseLength = Number.isFinite(fuseLength) ? clamp(fuseLength, 0.25, 2) : CFG.fuseLength
  const t = Math.max(0, time)
  const dt = Math.min(t, CLIPS[clip].duration)
  const active = clip === 'walk'
  const norm = Math.hypot(direction.x, direction.y) || 1
  const dir = { x: direction.x / norm, y: direction.y / norm }
  let fold = 0
  let contract = 0
  let bodyZ = 27
  let bob = 0
  let root = { x: 0, y: 0, z: 0 }
  let fuseBurn = 0
  if (clip === 'idle') bob = 0.48 * Math.sin(t * TAU / 3.6)
  if (active) bob = 0.32 * Math.sin(t * TAU / CFG.period * 2)
  if (clip === 'detonate') { contract = smooth(dt / 0.88); fuseBurn = clamp(dt / 1.35); bodyZ -= 8 * contract }
  if (clip === 'emerge') {
    fold = 1 - smooth((dt - 1.8) / 1.0); bodyZ = mix(27, 21, fold)
    root = { x: 0, y: 64 * smooth((dt - 1.25) / 1.4), z: -22 * (1 - smooth((dt - 0.45) / 0.85)) }
  }
  const shake = clip === 'detonate' && dt > 0.88 && dt < 1.35 ? 0.36 * Math.sin(dt * 95) * smooth((dt - 0.88) / 0.3) : 0
  const body = { x: shake, y: -bodyZ - bob, width: CFG.bodyWidth, height: CFG.bodyHeight }
  const legs = DEFINITIONS.map((l): BroodlingLeg => {
    let x = l.side * mix(29, 23, contract)
    let y = l.row < 0 ? mix(-18, -14, contract) : mix(12, 9, contract)
    let z = 0
    let contact = true
    const phase = wrap(t / CFG.period + l.phase)
    x = mix(x, l.side * 9, fold); y = mix(y, l.row < 0 ? -7 : 5, fold)
    if (active) {
      let travel: number
      if (phase < CFG.duty) travel = CFG.stride * (0.5 - phase / CFG.duty)
      else { const q = (phase - CFG.duty) / (1 - CFG.duty); travel = CFG.stride * (-0.5 + smooth(q)); z = CFG.lift * Math.sin(Math.PI * q) ** 2; contact = false }
      x += dir.x * travel; y += dir.y * travel
    }
    const foot = { x, y, z }
    const f = project(foot)
    const h = { x: l.side * 14 + body.x, y: body.y + (l.row < 0 ? 0 : 14) }
    return { ...l, hip: h, knee: knee(h, f, l.side), foot, screenFoot: f, contact, phase }
  })
  return {
    clip,
    time: t,
    body,
    legs,
    root,
    fold,
    contract,
    fuseBurn,
    fuseLength,
    direction: dir,
    dead: clip === 'detonate' && t >= 1.35,
    blastTime: clip === 'detonate' ? t - 1.35 : -1,
    worldTravel: active ? { x: dir.x * t * CFG.stride / CFG.duty / CFG.period, y: dir.y * t * CFG.stride / CFG.duty / CFG.period } : { x: 0, y: 0 }
  }
}

/** The art's full sizes in pixels. The legs and joint are the Crawler's. */
export const ARTS = Object.freeze({
  body: Object.freeze({ w: 1052, h: 1069 }),
  upper: Object.freeze({ w: 570, h: 242 }),
  lower: Object.freeze({ w: 653, h: 232 }),
  joint: Object.freeze({ w: 300, h: 305 })
})

const UPPER_ANCHORS = [76, 141, 505, 141]
const LOWER_ANCHORS = [76, 123, 622, 207]

/**
 * Collects what `drawBroodling` draws, in its order, in rig units once its own
 * `renderScale` (1.12) and the root's travel are applied.
 */
class Drawing {
  readonly ground: NpcEllipse[] = []
  readonly items: NpcDrawItem[] = []
  constructor (private readonly outer: Matrix) {}

  private pt (x: number, y: number, m: Matrix = this.outer): [number, number] {
    return [m.a * x + m.c * y + m.x, m.b * x + m.d * y + m.y]
  }

  private get scale (): number {
    return Math.hypot(this.outer.a, this.outer.b)
  }

  image (art: string, local: Matrix): void {
    this.items.push({ kind: 'image', art, m: multiply(this.outer, local) })
  }

  ellipse (x: number, y: number, rx: number, ry: number, fill: string, under = false): void {
    const [cx, cy] = this.pt(x, y)
    const { color, alpha } = cssColour(fill)
    const e: NpcEllipse = { kind: 'ellipse', x: cx, y: cy, rx: Math.max(0.01, rx) * this.scale, ry: Math.max(0.01, ry) * this.scale, color, alpha }
    if (under) this.ground.push(e)
    else this.items.push(e)
  }

  line (points: Vec[], stroke: string, width: number): void {
    const { color, alpha } = cssColour(stroke)
    this.items.push({ kind: 'line', points: points.flatMap((p) => this.pt(p.x, p.y)), width: width * this.scale, color, alpha })
  }

  polygon (points: Vec[], fill: string, alpha: number, stroke?: { width: number, color: string }, local?: Matrix): void {
    const m = local === undefined ? this.outer : multiply(this.outer, local)
    const c = cssColour(fill)
    this.items.push({
      kind: 'polygon',
      points: points.flatMap((p) => this.pt(p.x, p.y, m)),
      color: c.color,
      alpha: c.alpha * alpha,
      stroke: stroke === undefined ? undefined : { width: stroke.width * Math.hypot(m.a, m.b), color: cssColour(stroke.color).color }
    })
  }

  /** Moves the outer transform, as the package's `translate`. */
  translate (x: number, y: number): Drawing {
    return new Drawing(multiply(this.outer, { a: 1, b: 0, c: 0, d: 1, x, y }))
  }
}

function limb (out: Drawing, art: string, h: Vec, f: Vec, anchors: number[]): void {
  const dx = f.x - h.x
  const dy = f.y - h.y
  const ax = anchors[2] - anchors[0]
  const ay = anchors[3] - anchors[1]
  const sc = Math.hypot(dx, dy) / Math.hypot(ax, ay)
  const angle = Math.atan2(dy, dx) - Math.atan2(ay, ax)
  const c = Math.cos(angle) * sc
  const s = Math.sin(angle) * sc
  out.image(art, { a: c, b: s, c: -s, d: c, x: h.x - c * anchors[0] + s * anchors[1], y: h.y - s * anchors[0] - c * anchors[1] })
}

function drawLeg (out: Drawing, l: BroodlingLeg): void {
  const h = l.hip
  const k = l.knee
  const f = l.screenFoot
  limb(out, 'upper', h, k, UPPER_ANCHORS)
  limb(out, 'lower', k, f, LOWER_ANCHORS)
  out.image('joint', { a: 5 / ARTS.joint.w, b: 0, c: 0, d: 5 / ARTS.joint.h, x: k.x - 2.5, y: k.y - 2.5 })
  out.image('joint', { a: 4.8 / ARTS.joint.w, b: 0, c: 0, d: 4.8 / ARTS.joint.h, x: h.x - 2.4, y: h.y - 2.4 })
}

/** The fuse's cord, as 25 points from the collar to where it has burnt to. */
export function fusePoints (p: BroodlingState): Vec[] {
  const x = p.body.x - 0.2
  const y = p.body.y - p.body.height * 0.448
  const tip = { x: x + 8 + 1.1 * Math.sin(p.time * TAU / 3.6), y: y - 15 }
  // Folding bends the long cord sideways; burning eats it from the free end.
  const full = [{ x, y }, { x: x + 1, y: y - 8 }, { x: tip.x - 3, y: tip.y - 3 }, { ...tip }]
  full[1].x += p.fold * 4; full[1].y += p.fold * 7; full[2].x += p.fold * 3; full[2].y += p.fold * 16; full[3].x += p.fold * 3; full[3].y += p.fold * 15
  const length = p.fuseLength ?? CFG.fuseLength
  if (length !== 1) for (const point of full) { point.x = x + (point.x - x) * length; point.y = y + (point.y - y) * length }
  const end = 1 - p.fuseBurn
  const pts: Vec[] = []
  for (let i = 0; i <= 24; i++) {
    const t = end * i / 24
    const a = 1 - t
    pts.push({ x: a * a * a * full[0].x + 3 * a * a * t * full[1].x + 3 * a * t * t * full[2].x + t * t * t * full[3].x, y: a * a * a * full[0].y + 3 * a * a * t * full[1].y + 3 * a * t * t * full[2].y + t * t * t * full[3].y })
  }
  return pts
}

function drawFuse (out: Drawing, p: BroodlingState): void {
  const pts = fusePoints(p)
  const end = pts[pts.length - 1]
  out.line(pts, '#17202a', 2.35); out.line(pts, '#b7a383', 1.45); out.line(pts.map((v) => ({ x: v.x - 0.22, y: v.y - 0.15 })), '#e6cf9d', 0.45)
  const lit = p.fold < 0.1 || p.clip === 'detonate'
  if (lit) {
    const r = 1.2 + 0.2 * Math.sin(p.time * 31)
    out.ellipse(end.x, end.y, r * 2.3, r * 2.3, '#ff90232b'); out.ellipse(end.x, end.y, r, r, '#ffbd59'); out.ellipse(end.x - 0.1, end.y - 0.2, 0.5, 0.5, '#fff4ce')
    for (let i = 0; i < 3; i++) {
      const a = p.time * 8 + i * 2.3
      const d = 2 + wrap(p.time * 2 + i * 0.31) * 2
      out.line([{ x: end.x + Math.cos(a) * d, y: end.y + Math.sin(a) * d }, { x: end.x + Math.cos(a) * (d + 0.6), y: end.y + Math.sin(a) * (d + 0.6) }], '#ffc878', 0.45)
    }
  }
}

function explosion (out: Drawing, p: BroodlingState): void {
  const t = p.blastTime
  out.ellipse(0, 0, 21, 10, '#0b172844')
  if (t < 0.85) {
    const q = clamp(t / 0.85)
    for (let i = 0; i < 7; i++) {
      const a = i * TAU / 7
      const r = 12 + q * 29
      out.ellipse(Math.cos(a) * r, -14 + Math.sin(a) * r * 0.55 - q * 7, 6 + q * 8, 6 + q * 6, `rgba(54,60,69,${0.75 * (1 - q)})`)
    }
  }
  if (t < 0.28) {
    const q = t / 0.28
    const r = 5 + 30 * Math.sin(Math.PI * q * 0.8)
    out.ellipse(0, -16, r, r * 0.87, `rgba(255,138,64,${1 - q})`); out.ellipse(0, -16, r * 0.65, r * 0.62, `rgba(255,239,176,${1 - q})`)
  }
  if (t < 1.2) {
    for (let i = 0; i < 6; i++) {
      const a = i * 2.399
      const travel = 1 - Math.exp(-4 * t)
      const x = Math.cos(a) * 36 * travel
      const y = Math.sin(a) * 22 * travel - Math.max(0, 26 * t - 32 * t * t)
      const rot = i + t * 6 * (i % 2 !== 0 ? 1 : -1)
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      out.polygon([{ x: -2, y: -2 }, { x: 3, y: -1 }, { x: 1, y: 3 }, { x: -2, y: 2 }], i % 2 !== 0 ? '#ba493d' : '#f5775e', 1 - smooth((t - 0.55) / 0.65),
        { width: 0.6, color: '#1b2633' }, { a: c, b: s, c: -s, d: c, x, y: y - 5 })
    }
  }
}

function socket (out: Drawing, front: boolean): void {
  const pts = Array.from({ length: 6 }, (_, i) => ({ x: Math.cos(i * TAU / 6) * 35, y: Math.sin(i * TAU / 6) * 35 * CFG.tilt }))
  if (!front) {
    out.polygon(pts, '#101b2a', 1, { width: 3, color: '#66839a' })
    out.line([pts[3], pts[4], pts[5], pts[0]], '#f49478', 1.3)
  } else {
    out.polygon([{ x: -35, y: 0 }, { x: -17.5, y: 20.6 }, { x: 17.5, y: 20.6 }, { x: 35, y: 0 }, { x: 35, y: 8 }, { x: 17.5, y: 29 }, { x: -17.5, y: 29 }, { x: -35, y: 8 }], '#273e51', 1)
    out.line([pts[3], pts[2], pts[1], pts[0]], '#90adbe', 1.2)
  }
}

/**
 * The package's `drawBroodling` at 0,0 and scale 1, as a draw list. Its emerge
 * clips the creature to the socket's front edge while below the floor; a
 * draw list has no clip, so that crop is not drawn. With `inPlace` (the game)
 * neither the socket nor the root's travel out of it is drawn.
 */
export function draw (p: BroodlingState, options: NpcDrawOptions = {}): NpcDrawList {
  const s = CFG.renderScale
  const top = new Drawing({ a: s, b: 0, c: 0, d: s, x: 0, y: 0 })
  const inPlace = options.inPlace === true
  if (p.clip === 'emerge' && !inPlace) { socket(top, false); socket(top, true) }
  const r = inPlace ? { x: 0, y: -p.root.z } : project(p.root)
  const out = top.translate(r.x, r.y)
  if (p.dead) explosion(out, p)
  else {
    out.ellipse(0, p.root.z, 22 - 6 * p.fold, 9 - 2 * p.fold, '#06132166', true)
    for (const l of p.legs.filter((l) => l.row < 0)) drawLeg(out, l)
    out.image('body', { a: p.body.width / ARTS.body.w, b: 0, c: 0, d: p.body.height / ARTS.body.h, x: p.body.x - p.body.width / 2, y: p.body.y - p.body.height / 2 })
    for (const l of p.legs.filter((l) => l.row > 0)) drawLeg(out, l)
    drawFuse(out, p)
  }
  // The blast and the socket lie on the ground but are drawn in turn, as the package does.
  return { ground: [...out.ground, ...top.ground], items: [...top.items, ...out.items] }
}

export const BROODLING_RIG: NpcRig = Object.freeze({
  key: 'broodling' as const,
  clips: CLIPS,
  // Nick, 2026-10-07: 94% of its own rig (npc-scale-preview-v1, which drew it through `drawBroodling`, its 1.12 included).
  sizeScale: 0.94,
  // The fuse's tip in the idle pose, 27 + 19.3 + 15 units up, at the render scale.
  referenceUnits: (27 + CFG.bodyHeight / 2 + 15) * CFG.renderScale,
  deathHolds: true,
  roles: Object.freeze({
    idle: 'idle',
    move: 'walk',
    // A Broodling's death is its blast: from the detonation on, the contraction already over.
    death: Object.freeze({ clip: 'detonate', from: 1.35 }),
    // Out of the floor and unfolding (the socket's crop is over by 1.3 s); ready by 2.8 s.
    spawn: Object.freeze({ clip: 'emerge', from: 1.3, ready: 2.8 }),
    // The primed tell (effect 17, 500 ms on the server): the contraction's
    // last 0.5 s, so 0.85 + 0.5 lands on the detonation at 1.35 (Dez Q9).
    prime: Object.freeze({ clip: 'detonate', from: 0.85 })
  }),
  pose: (clip: string, seconds: number, direction: { x: number, y: number }, _aim?: { x: number, y: number }, _from?: NpcPose, options?: NpcPoseOptions): NpcPose => {
    // Its walk faces the way it goes; at rest the package's default, right.
    const dir = Math.hypot(direction.x, direction.y) > 0 ? direction : { x: 1, y: 0 }
    return { clip, time: seconds, state: sample(clip, seconds, { direction: dir, fuseLength: options?.fuseLength }) }
  },
  draw: (pose: NpcPose, options?: NpcDrawOptions): NpcDrawList => draw(pose.state as BroodlingState, options),
  arts: ARTS
})
