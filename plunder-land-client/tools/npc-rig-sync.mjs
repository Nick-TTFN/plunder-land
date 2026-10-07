#!/usr/bin/env node
/**
 * Take an NPC rig package's numbers into the repo (l1-8, decision #51).
 *
 *   node tools/npc-rig-sync.mjs <npc> [package-dir]    # crawler, broodling
 *
 * The package (default below, in `codex_output/`, not checked in) holds the
 * authoritative rig as JavaScript (`tools/rig.mjs` for the Crawler,
 * `tools/broodling.mjs` for the Broodling) and, since the export-only
 * copies of 2026-10-07, `rig/pose-samples.json`: poses sampled from that
 * module (`version`, `tolerance`, `samples` of `name`, `time`, `options`,
 * `state`). `src/npcs/<npc>/rig.ts` is a hand port. This writes
 * `services/battle-royale-server/src/utils/npcrigs/<npc>.fixtures.json`,
 * which `npcrigs.spec.ts` checks the port against:
 *
 * - every package sample, plus a few the game needs that the package didn't
 *   sample (actions aimed and started from a run, a walk in eight
 *   directions), each re-evaluated here with the package's own module, which
 *   must reproduce the package's `state` exactly;
 * - the evaluator's `state` (and the Crawler's `regions`), flattened to
 *   dotted paths and values, numbers rounded to 1e-10 (the package's
 *   tolerance is 1e-9). The Crawler's `matrices` are checked through the
 *   images they place (below), to 1e-5: at full precision they would double
 *   the file;
 * - what the package's own Canvas drawing does with it, run against a
 *   context that only records: each image's art, clip and three corners, and
 *   each shape filled or stroked (rounded to 1e-5; a long line thinned to
 *   every eighth point).
 *
 * A Crawler action's `basePose` is stored as the only parts the evaluator
 * reads (the presence and the feet); this checks that the package gives the
 * same pose from that as from the whole one. The manifest's clip table goes
 * in too, for the spec to hold the port's against.
 *
 * The art goes separately, through `tools/bake-npc-atlas.py`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const client = join(here, '..')
const NPCS = {
  crawler: { pkg: 'crawler-animations-v4', module: 'rig.mjs' },
  broodling: { pkg: 'npc-refinements/broodling-v3', module: 'broodling.mjs' }
}
const key = process.argv[2]
if (NPCS[key] === undefined) {
  console.error(`usage: node tools/npc-rig-sync.mjs <${Object.keys(NPCS).join('|')}> [package-dir]`)
  process.exit(1)
}
const npc = NPCS[key]
const pkg = resolve(process.argv[3] ?? join(client, 'codex_output', npc.pkg))
const rig = await import(pathToFileURL(join(pkg, 'tools', npc.module)).href)
const samples = JSON.parse(readFileSync(join(pkg, 'rig', 'pose-samples.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(pkg, 'rig', 'animation-manifest.json'), 'utf8'))
const parts = JSON.parse(readFileSync(join(pkg, 'rig', 'parts.json'), 'utf8'))

const round10 = (v) => Math.round(v * 1e10) / 1e10
const round5 = (v) => Math.round(v * 1e5) / 1e5
// A sample's options (the Crawler's base pose among them) are written exactly:
// rounded, they move the pose by more than the tolerance.

/**
 * A value as [paths, leaves]: every leaf (number, string, boolean) under a
 * dotted path, keys sorted, so the spec can flatten the port's result the
 * same way and compare structure and numbers. Paths are shared between
 * samples of the same shape (the fixture's `paths`).
 */
function flatten (value, prefix = '', out = [[], []]) {
  if (value !== null && typeof value === 'object') {
    const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value).sort()
    for (const k of keys) flatten(value[k], prefix === '' ? k : prefix + '.' + k, out)
  } else if (value !== undefined) {
    out[0].push(prefix)
    out[1].push(typeof value === 'number' ? (Number.isFinite(value) ? (round10(value) || 0) : String(value)) : value)
  }
  return out
}
const shapes = new Map()
/** The id of this list of paths in the fixture's `paths`. */
function shapeOf (paths) {
  const sig = paths.join(' ')
  if (!shapes.has(sig)) shapes.set(sig, shapes.size)
  return shapes.get(sig)
}

/** A long polyline (the fuse's 25 points) kept as every eighth point and the last: enough to pin the curve. */
function thin (points) {
  const n = points.length / 2
  if (n <= 9) return points
  const out = []
  for (let i = 0; i < n; i++) if (i % 8 === 0 || i === n - 1) out.push(points[2 * i], points[2 * i + 1])
  return out
}

/** '#rrggbb', '#rrggbbaa' or 'rgba(...)' to [colour, alpha]; null for anything else (gradients). */
function colour (css) {
  if (typeof css !== 'string') return null
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.e-]+)\)$/.exec(css.replace(/\s/g, ''))
  if (m !== null) return [(+m[1] << 16) | (+m[2] << 8) | +m[3], +m[4]]
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(css)) return [parseInt(css.slice(1, 7), 16), css.length === 9 ? parseInt(css.slice(7, 9), 16) / 255 : 1]
  return null
}

const mul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]]

/**
 * Runs `paint(ctx, images)` against a context that only records, and returns
 * `{ images, marks }`: each drawImage's art, corners (rig units) and the clip
 * rectangle in force (in the image's own pixels, the Crawler's shell
 * sections); each fill or stroke of a path as an ellipse (centre, radii) or a
 * list of points, with its colour, alpha (colour alpha times globalAlpha) and
 * stroke width. Fills that aren't plain colours (the sensor's gradients) and
 * the `skip` colours are left out.
 */
function record (paint, artSizes, skip = []) {
  const fresh = () => ({ m: [1, 0, 0, 1, 0, 0], alpha: 1, lineWidth: 1, strokeStyle: '#000000', fillStyle: '#000000', clip: null })
  let cur = fresh()
  const stack = []
  let path = []
  let rect = null
  const images = []
  const marks = []
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const scaleOf = (m) => Math.hypot(m[0], m[1])
  const current = () => {
    if (path.length === 0 || path[path.length - 1].points === undefined) path.push({ points: [] })
    return path[path.length - 1]
  }
  const emit = (kind) => {
    const css = kind === 'fill' ? cur.fillStyle : cur.strokeStyle
    const c = colour(css)
    if (c === null || skip.includes(String(css).toLowerCase())) return
    // [f(ill) or s(troke), e(llipse) / o(pen) / c(losed), colour, alpha, width, ...]:
    // an ellipse's centre and radii, or a path's point count and its (thinned) points.
    for (const sub of path) {
      const head = [kind === 'fill' ? 'f' : 's', null, c[0], round5(c[1] * cur.alpha), kind === 'stroke' ? round5(cur.lineWidth * sub.scale) : 0]
      if (sub.ellipse !== undefined) {
        head[1] = 'e'
        marks.push([...head, ...sub.ellipse.map(round5)])
        continue
      }
      if (sub.points.length < 2) continue
      head[1] = sub.closed === true ? 'c' : 'o'
      marks.push([...head, sub.points.length / 2, ...thin(sub.points).map(round5)])
    }
  }
  const noop = () => {}
  const ctx = {
    save: () => stack.push({ ...cur }),
    restore: () => { cur = stack.pop() },
    translate: (x, y) => { cur.m = mul(cur.m, [1, 0, 0, 1, x, y]) },
    scale: (x, y) => { cur.m = mul(cur.m, [x, 0, 0, y, 0, 0]) },
    rotate: (r) => { cur.m = mul(cur.m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]) },
    transform: (a, b, c, d, e, f) => { cur.m = mul(cur.m, [a, b, c, d, e, f]) },
    beginPath: () => { path = []; rect = null },
    moveTo: (x, y) => { path.push({ points: apply(cur.m, x, y), scale: scaleOf(cur.m) }) },
    lineTo: (x, y) => { const s = current(); s.scale ??= scaleOf(cur.m); s.points.push(...apply(cur.m, x, y)) },
    closePath: () => { current().closed = true },
    ellipse: (x, y, rx, ry) => {
      const s = scaleOf(cur.m)
      path.push({ ellipse: [...apply(cur.m, x, y), rx * s, ry * s], scale: s })
    },
    arc: (x, y, r) => { ctx.ellipse(x, y, r, r) },
    rect: (x, y, w, h) => { rect = { x, y, w, h } },
    clip: () => { cur.clip = rect },
    fill: () => emit('fill'),
    stroke: () => emit('stroke'),
    fillRect: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    drawImage: (img, x, y, w, h) => {
      w ??= img.width
      h ??= img.height
      // Three corners fix a parallelogram: top left, top right, bottom left.
      const pts = []
      for (const [u, v] of [[x, y], [x + w, y], [x, y + h]]) pts.push(...apply(cur.m, u, v).map(round5))
      images.push([img.art, cur.clip === null ? null : [cur.clip.x, cur.clip.y, cur.clip.w, cur.clip.h], ...pts])
    }
  }
  for (const prop of ['globalAlpha', 'lineWidth', 'strokeStyle', 'fillStyle']) {
    const field = prop === 'globalAlpha' ? 'alpha' : prop
    Object.defineProperty(ctx, prop, { get: () => cur[field], set: (v) => { cur[field] = v } })
  }
  for (const prop of ['lineCap', 'lineJoin', 'filter', 'shadowColor', 'shadowBlur']) ctx[prop] = undefined
  const imgs = Object.fromEntries(Object.entries(artSizes).map(([art, s]) => [art, { art, width: s.w, height: s.h }]))
  paint(ctx, imgs)
  return { images, marks }
}

const artSizes = Object.fromEntries(parts.parts.map((p) => [p.id, { w: p.size[0], h: p.size[1] }]))
const out = []

if (key === 'crawler') {
  // Read by an action from its base pose: nothing else (see `actionPresence`, `actionPose`).
  const PRESENCE = ['x', 'y', 'z', 'pitch', 'roll', 'sensorX', 'sensorY', 'focus', 'glow']
  const compact = (base) => ({ state: { presence: Object.fromEntries(PRESENCE.filter((k) => k in base.state.presence).map((k) => [k, base.state.presence[k]])), legs: base.state.legs.map((l) => ({ foot: { ...l.foot } })) } })
  // The shot's streak is the game's beam; the sensor's discs are the port's stand-ins.
  const SKIP = ['#ff942d', '#ffe2a0', '#fff7d2', '#fff5b8', '#3f2923']
  const take = (name, time, options) => {
    const pose = rig.animationPose(name, time, options)
    const stored = options.basePose === undefined ? options : { ...options, basePose: compact(options.basePose) }
    if (options.basePose !== undefined && !isDeepStrictEqual(rig.animationPose(name, time, stored), pose)) throw Error(`compact base pose differs: ${name} ${time}`)
    const drawn = record((ctx, images) => rig.drawPose(ctx, images, pose, 0, 0, 1), artSizes, SKIP)
    // The matrices aren't stored: the images' corners (to 1e-5) are what they draw.
    const [paths, values] = flatten(pose.state)
    const regions = pose.regions.map((r) => [r.name, r.bone, r.art, r.group ?? '', r.sensor === true ? 1 : 0, r.clip === undefined ? '' : [r.clip.x, r.clip.y, r.clip.w, r.clip.h].join(':')].join(',')).join(' ')
    out.push({ name, time, options: stored, shape: shapeOf(paths), values, regions, ...drawn })
  }
  for (const s of samples.samples) {
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(rig.animationPose(s.name, s.time, s.options).state)), s.state)) throw Error(`the package's module no longer gives its sample: ${s.name} ${s.time}`)
    take(s.name, s.time, s.options)
  }
  // The game's own use: actions aimed along the ground, started from a run.
  const run = rig.animationPose('run', 0.31, { directionX: -1, directionY: 0.5 })
  for (const [aimX, aimY] of [[1, 0], [-0.6, 0.8], [0, -1]]) {
    for (const name of ['fire', 'hit']) {
      for (const t of [0, 0.1, 0.34, 0.5, 0.9, rig.clips[name].duration]) take(name, t, { aimX, aimY, basePose: run })
    }
  }
  for (const t of [0.12, 0.24, 0.6, 1.5, 2.6]) take('fall_apart', t, { aimX: -1, aimY: 0, basePose: run })
} else {
  const take = (name, time, options) => {
    const state = rig.sample(name, time, options)
    const drawn = record((ctx, images) => rig.drawBroodling(ctx, images, state, 0, 0, 1), artSizes)
    const [paths, values] = flatten(state)
    out.push({ name, time, options, shape: shapeOf(paths), values, ...drawn })
  }
  for (const s of samples.samples) {
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(rig.sample(s.name, s.time, s.options))), s.state)) throw Error(`the package's module no longer gives its sample: ${s.name} ${s.time}`)
    take(s.name, s.time, s.options)
  }
  // The game walks it any way it goes.
  for (let i = 0; i < 8; i++) {
    const direction = { x: Math.cos(i * Math.PI / 4), y: Math.sin(i * Math.PI / 4) }
    for (const t of [0.05, 0.3, 0.61, 1.9]) take('walk', t, { direction })
  }
}

const file = join(client, '..', 'services', 'battle-royale-server', 'src', 'utils', 'npcrigs', `${key}.fixtures.json`)
mkdirSync(dirname(file), { recursive: true })
// A region list the same as the sample before's is written as '='.
let last = ''
for (const sample of out) {
  if (sample.regions === undefined) continue
  if (sample.regions === last) sample.regions = '='
  else last = sample.regions
}
const paths = [...shapes.keys()].map((sig) => sig.split(' '))
writeFileSync(file, JSON.stringify({ package: pkg.split('/codex_output/').pop(), tolerance: samples.tolerance, manifest: manifest.clips, deathHolds: manifest.deathHolds, paths, samples: out }) + '\n')
console.log(`${key}: ${out.length} poses (${samples.samples.length} from the package), ${Math.round(readFileSync(file).length / 1024)} KB`)
