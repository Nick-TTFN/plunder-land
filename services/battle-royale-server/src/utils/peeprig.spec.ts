import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { animationPose, eyeMatrix, regionMatrix, REGIONS, type ClipName, type Matrix, type PoseOptions } from '../../../../plunder-land-client/src/peep/rig'

/**
 * The client's Peep rig (`src/peep/rig.ts`) is a hand port of the art drop's
 * JavaScript rig, which is the authority. The fixtures are poses sampled from
 * the drop's own modules by `plunder-land-client/tools/peep-rig-sync.mjs`:
 * every clip across its length and past its end, aim at both limits, gaze
 * apart from aim, blinks and every expression. `corners` is where the drop's
 * own Canvas `drawPose` puts each image's corners, so the check covers the
 * drawing transforms (`regionMatrix`, `eyeMatrix`) as well as the bones. Run
 * here because the client has no test runner.
 */

interface Fixture {
  name: ClipName | 'reference'
  t: number
  options: PoseOptions
  muzzle: number[]
  corners: number[][]
  eye: number[]
  animation: number[]
  detached: boolean
}

const { poses } = JSON.parse(readFileSync(join(__dirname, 'peeprig.fixtures.json'), 'utf8')) as { poses: Fixture[] }

// The fixtures are rounded to 1e-6 (corners 1e-5); the port should agree to that.
const EPS = 2e-6
const CORNER_EPS = 2e-5

function close (actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: ${actual} vs ${expected}`)
}

/** An image's corners in the order the fixture's drawImage recorded them. */
function corners (m: Matrix, w: number, h: number): number[] {
  const out: number[] = []
  for (const [u, v] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) out.push(m.a * u + m.c * v + m.x, m.b * u + m.d * v + m.y)
  return out
}

test('the fixtures cover every clip', () => {
  const names = new Set(poses.map((p) => p.name))
  for (const n of ['idle', 'run', 'shoot', 'hit', 'swing', 'jump', 'fall_apart', 'reference']) assert.ok(names.has(n as ClipName), n)
  assert.ok(poses.some((p) => p.detached), 'no detached fall-apart pose sampled')
})

test('the port matches the drop\'s rig on every sampled pose', () => {
  for (const f of poses) {
    const where = `${f.name} t=${f.t} ${JSON.stringify(f.options)}`
    const { state, matrices } = animationPose(f.name, f.t, f.options)
    const mz = matrices.muzzle
    const got = [mz.a, mz.b, mz.c, mz.d, mz.x, mz.y]
    for (let i = 0; i < 6; i++) close(got[i], f.muzzle[i], `${where} muzzle[${i}]`)
    assert.equal(f.corners.length, REGIONS.length, where)
    REGIONS.forEach((r, k) => {
      const drawn = r.kind === 'eye'
        ? corners(eyeMatrix(matrices.head, state.eye), 144, 198)
        : corners(regionMatrix(matrices[r.bone], r), r.w, r.h)
      for (let i = 0; i < 8; i++) close(drawn[i], f.corners[k][i], `${where} ${r.name} corner[${i}]`, CORNER_EPS)
    })
    const eye = [state.eye.x, state.eye.y, state.eye.sx, state.eye.sy]
    for (let i = 0; i < 4; i++) close(eye[i], f.eye[i], `${where} eye[${i}]`)
    const a = state.animation
    const anim = [a.height, a.flash, a.eyeOpacity]
    for (let i = 0; i < 3; i++) close(anim[i], f.animation[i], `${where} animation[${i}]`)
    assert.equal(a.detached, f.detached, where)
  }
})
