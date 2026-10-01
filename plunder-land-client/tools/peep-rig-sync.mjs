#!/usr/bin/env node
/**
 * Take a robot rig drop's numbers into the repo (2026-10-01: the eye-firing
 * drops, Peep v16, Magnet v3, Periscope v3, Hopper v2, Waddle v2).
 *
 *   node tools/peep-rig-sync.mjs [drop-dir]            # Peep
 *   node tools/peep-rig-sync.mjs <robot> [drop-dir]    # magnet, periscope, hopper, waddle
 *
 * The drop (default below, in `codex_output/`, not checked in) holds the
 * authoritative rig as JavaScript: `tools/rig.mjs`, `tools/legacy-motion.mjs`
 * (the body's clips), `tools/animations.mjs` (the eye shot laid over them,
 * shared by every robot) and `tools/collision-hulls.mjs`. `src/<robot>/rig.ts`
 * and `src/robots/eyeshot.ts` are hand ports of them. This writes:
 *
 * - `src/<robot>/hulls.ts`: the fall-apart contact hulls, as data.
 * - `services/battle-royale-server/src/utils/<robot>rig.fixtures.json`: poses
 *   sampled from the drop's own modules, which `<robot>rig.spec.ts` checks the
 *   port against. A new drop that changes a number fails that spec until the
 *   port is updated to match.
 *
 * The art goes separately, through `tools/bake-peep-atlas.py`.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const client = join(here, '..')
// Peep is the default, so the old one-argument form still means Peep.
const ROBOTS = {
  peep: { drop: 'peep-animations-v16', label: 'Peep' },
  magnet: { drop: 'magnet-animations-v3', label: 'Magnet' },
  periscope: { drop: 'periscope-animations-v3', label: 'Periscope' },
  hopper: { drop: 'hopper-animations-v2', label: 'Hopper' },
  waddle: { drop: 'waddle-animations-v2', label: 'Waddle' }
}
const named = ROBOTS[process.argv[2]] !== undefined
const key = named ? process.argv[2] : 'peep'
const robot = ROBOTS[key]
const drop = resolve((named ? process.argv[3] : process.argv[2]) ?? join(client, 'codex_output', robot.drop))
const load = (file) => import(pathToFileURL(join(drop, 'tools', file)).href)

const { collisionHulls } = await load('collision-hulls.mjs')
const { animationPose, clips } = await load('animations.mjs')
const rig = await load('rig.mjs')

const round6 = (v) => Math.round(v * 1e6) / 1e6
const round5 = (v) => Math.round(v * 1e5) / 1e5
const mul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]]
// Undo drawPose's outer scale(1, -1), so what is recorded is in rig space (y up).
const unflip = (m) => mul([1, 0, 0, -1, 0, 0], m)

/**
 * What the drop's own Canvas drawing does for one region (`drawPose` with
 * `onlyRegion`), run against a context that only records:
 *
 * - `images`: each drawImage's four corners, in rig units.
 * - `marks`: each stroke or fill, with the matrix it was made under, the
 *   arc's radius (none for a path of lines: Hopper's spring), line width,
 *   colour and alpha. That is the eye shot's rings and dot, and the spring.
 *
 * The spec checks `regionMatrix` / `eyeMatrix` against the images and the
 * port's own eye-shot and spring drawing against the marks.
 */
function drawnRegion (state, matrices, region, eyeOpacity) {
  const fresh = () => ({ m: [1, 0, 0, 1, 0, 0], alpha: 1, lineWidth: 1, strokeStyle: '#000', fillStyle: '#000' })
  let cur = fresh()
  let arc = null
  const stack = []
  const images = []
  const marks = []
  const mark = (kind) => {
    marks.push({
      m: unflip(cur.m).map(round5),
      kind,
      r: arc === null ? null : round5(arc),
      lw: kind === 'stroke' ? round5(cur.lineWidth) : null,
      color: kind === 'stroke' ? cur.strokeStyle : cur.fillStyle,
      alpha: round5(cur.alpha)
    })
  }
  const noop = () => {}
  const ctx = {
    save: () => stack.push({ ...cur }),
    restore: () => { cur = stack.pop() },
    translate: (x, y) => { cur.m = mul(cur.m, [1, 0, 0, 1, x, y]) },
    scale: (x, y) => { cur.m = mul(cur.m, [x, 0, 0, y, 0, 0]) },
    rotate: (r) => { cur.m = mul(cur.m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]) },
    transform: (a, b, c, d, e, f) => { cur.m = mul(cur.m, [a, b, c, d, e, f]) },
    drawImage: (img, x, y, w, h) => {
      const m = unflip(cur.m)
      const pts = []
      for (const [u, v] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) pts.push(round5(m[0] * u + m[2] * v + m[4]), round5(m[1] * u + m[3] * v + m[5]))
      images.push(pts)
    },
    beginPath: () => { arc = null },
    arc: (x, y, r) => { arc = r },
    stroke: () => mark('stroke'),
    fill: () => mark('fill'),
    // Clips (the visor, the lenses) and paths of lines move nothing.
    moveTo: noop, lineTo: noop, bezierCurveTo: noop, closePath: noop, clip: noop, ellipse: noop
  }
  for (const prop of ['globalAlpha', 'lineWidth', 'strokeStyle', 'fillStyle']) {
    const field = prop === 'globalAlpha' ? 'alpha' : prop
    Object.defineProperty(ctx, prop, { get: () => cur[field], set: (v) => { cur[field] = v } })
  }
  for (const prop of ['shadowColor', 'shadowBlur', 'lineCap', 'lineJoin', 'globalCompositeOperation']) ctx[prop] = undefined
  rig.drawPose(ctx, new Proxy({}, { get: () => ({}) }), state, matrices, 0, 0, 1, { onlyRegion: region.name, eyeOpacity })
  return { images, marks }
}

writeFileSync(join(client, 'src', key, 'hulls.ts'),
  '/* eslint-disable */\n' +
  `// Generated by tools/peep-rig-sync.mjs from the ${robot.label} drop's collision-hulls.mjs:\n` +
  '// contact silhouettes derived from the art\'s alpha, for the fall-apart clip.\n' +
  '// Do not edit; re-run the tool on a new drop.\n' +
  'export const HULLS: Readonly<Record<string, { center: readonly [number, number], points: ReadonlyArray<readonly [number, number]> }>> = ' +
  JSON.stringify(collisionHulls) + '\n')

// Enough to cover every clip's keys, both ends of the aim, gaze apart from
// aim, a blink and every expression, without a huge file.
const OPTIONS = [
  {},
  { aimAngle: 60, blink: 0.5, expression: 'closed' },
  { aimAngle: -45, lookAngle: 20, expression: 'smile' },
  // Magnet's own magnet target, apart from the aim; the others ignore it.
  ...(key === 'magnet' ? [{ aimAngle: 30, magnetAngle: -20 }] : [])
]
// The eye shot laid over the loops: charging, the dot, recovering, and done;
// and the 'shoot' expression, which runs on the clip's own clock.
const OVERLAY = [
  { aimAngle: 40, eyeShootTime: 0.12, blink: 0.5 },
  { aimAngle: -30, lookAngle: 10, eyeShootTime: 0.4 },
  { aimAngle: 20, eyeShootTime: 0.6, expression: 'smile' },
  { eyeShootTime: 0.75 },
  { aimAngle: -50, expression: 'shoot' }
]
const poses = []
for (const name of Object.keys(clips)) {
  const duration = clips[name].duration
  // Twelfths of the clip as well, at the default options only (the file's
  // size): fixed times alone missed a changed swing key.
  const dense = Array.from({ length: 11 }, (_, k) => round6((k + 1) * duration / 12))
  const fixed = [0, 0.23, 0.52, 1.1, 1.7, duration, duration + 0.37]
  const times = [...fixed, ...dense].filter((t, i, a) => a.indexOf(t) === i)
  const options = name === 'idle' || name === 'run' ? [...OPTIONS, ...OVERLAY] : OPTIONS
  for (const t of times) {
    for (const opts of fixed.includes(t) ? options : [OPTIONS[0]]) {
      const { state, matrices } = animationPose(name, t, opts)
      const a = state.animation
      const shot = state.shootEye
      // The images cover every drawn bone; the shot's origin is the one that isn't drawn.
      const mz = matrices.eye_muzzle
      poses.push({
        name,
        t,
        options: opts,
        bones: Object.keys(matrices).join(' '),
        eyeMuzzle: [mz.a, mz.b, mz.c, mz.d, mz.x, mz.y].map(round6),
        eyes: rig.regions.filter((r) => r.kind === 'eye').map((r) => {
          const e = state[r.bone]
          return [e.x, e.y, e.sx, e.sy].map(round6).concat([e.expression])
        }),
        animation: [a.height, a.flash, a.eyeOpacity].map(round6),
        detached: a.detached,
        shot: shot === null || shot === undefined
          ? null
          : [shot.radius, shot.concentration, shot.flash, shot.dotOpacity, shot.eyeOpacity].map(round6).concat([shot.phase, shot.primaryRegion]),
        ...(state.springLength !== undefined ? { springLength: round6(state.springLength) } : {}),
        regions: rig.regions.map((r) => drawnRegion(state, matrices, r, a.eyeOpacity))
      })
    }
  }
}
const fixtures = join(client, '..', 'services', 'battle-royale-server', 'src', 'utils', `${key}rig.fixtures.json`)
writeFileSync(fixtures, JSON.stringify({ drop: drop.split('/').pop(), poses }) + '\n')
console.log(`hulls.ts: ${Object.keys(collisionHulls).length} hulls; fixtures: ${poses.length} poses`)
