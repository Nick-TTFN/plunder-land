import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ClipName, type EyeBone, type Matrix, type PoseOptions, multiply, regionMatrix } from '../../../../plunder-land-client/src/peep/rig'
import { ROBOT_RIGS, type RobotRig } from '../../../../plunder-land-client/src/robots/robotrig'
import { chargedEyeMarks, SHOT } from '../../../../plunder-land-client/src/robots/eyeshot'
import { SPRING_STROKES } from '../../../../plunder-land-client/src/hopper/rig'

/**
 * Every robot's rig (`src/<robot>/rig.ts`, under the eye shot in
 * `src/robots/eyeshot.ts`) is a hand port of its art drop's JavaScript, which
 * is the authority. The fixtures, `<robot>rig.fixtures.json`, are poses
 * sampled from the drop's own modules by
 * `plunder-land-client/tools/peep-rig-sync.mjs <robot>`: every clip across its
 * length and past its end, aim at both limits, gaze apart from aim, blinks,
 * every expression and the eye shot laid over idle and run.
 *
 * For each pose and each region, `images` is where the drop's own Canvas
 * `drawPose` puts each image's corners and `marks` each stroke and fill it
 * makes (the eye shot's rings and dot, Hopper's spring), so this checks what
 * `RobotSprite` draws with (`RobotRig`: `regionMatrix`, `eyeMatrix`,
 * `chargedEyeMarks`, `shot`), not just the bones. Run here because the client
 * has no test runner. The specs aren't typechecked.
 */

interface Mark { m: number[], kind: 'stroke' | 'fill', r: number | null, lw: number | null, color: string, alpha: number }

interface Fixture {
  name: ClipName | 'reference'
  t: number
  options: PoseOptions
  bones: string
  eyeMuzzle: number[]
  eyes: Array<Array<number | string>>
  animation: number[]
  detached: boolean
  shot: Array<number | string> | null
  springLength?: number
  regions: Array<{ images: number[][], marks: Mark[] }>
}

// The fixtures are rounded to 1e-6 (corners and marks 1e-5); the port should agree to that.
const EPS = 2e-6
const CORNER_EPS = 2e-5

function close (actual: number, expected: number, what: string, eps = EPS): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: ${actual} vs ${expected}`)
}

function closeMatrix (m: Matrix, expected: number[], what: string, eps = CORNER_EPS): void {
  const got = [m.a, m.b, m.c, m.d, m.x, m.y]
  for (let i = 0; i < 6; i++) close(got[i], expected[i], `${what}[${i}]`, eps)
}

/** An image's corners in the order the fixture's drawImage recorded them. */
function corners (m: Matrix, w: number, h: number): number[] {
  const out: number[] = []
  for (const [u, v] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) out.push(m.a * u + m.c * v + m.x, m.b * u + m.d * v + m.y)
  return out
}

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0')

function check (rig: RobotRig): void {
  const file = join(__dirname, `${rig.sheet}rig.fixtures.json`)
  const { poses } = JSON.parse(readFileSync(file, 'utf8')) as { poses: Fixture[] }

  test(`${rig.sheet}: the fixtures cover every clip and the eye shot`, () => {
    const names = new Set(poses.map((p) => p.name))
    for (const n of ['idle', 'run', 'shoot', 'hit', 'swing', 'jump', 'fall_apart', 'reference']) assert.ok(names.has(n as ClipName), n)
    assert.ok(poses.some((p) => p.detached), 'no detached fall-apart pose sampled')
    assert.ok(poses.some((p) => p.shot?.[5] === 'charge'), 'no charging eye sampled')
    assert.ok(poses.some((p) => p.shot?.[5] === 'release'), 'no fired eye sampled')
    assert.equal(rig.clips.shoot.duration, SHOT.duration)
  })

  test(`${rig.sheet}: the port matches the drop on every sampled pose`, () => {
    for (const f of poses) {
      const where = `${rig.sheet} ${f.name} t=${f.t} ${JSON.stringify(f.options)}`
      const { state, matrices } = rig.animationPose(f.name, f.t, f.options)
      assert.equal(Object.keys(matrices).sort().join(' '), f.bones.split(' ').sort().join(' '), `${where} bones`)
      closeMatrix(matrices.eye_muzzle, f.eyeMuzzle, `${where} eye_muzzle`, EPS)
      closeMatrix(matrices.muzzle, f.eyeMuzzle, `${where} muzzle`, EPS)

      const a = state.animation
      const anim = [a.height, a.flash, a.eyeOpacity]
      for (let i = 0; i < 3; i++) close(anim[i], f.animation[i], `${where} animation[${i}]`)
      assert.equal(a.detached, f.detached, where)

      const shot = state.shootEye ?? null
      if (f.shot === null) assert.equal(shot, null, `${where} shot`)
      else {
        assert.ok(shot !== null, `${where} shot`)
        const got = [shot.radius, shot.concentration, shot.flash, shot.dotOpacity, shot.eyeOpacity]
        for (let i = 0; i < 5; i++) close(got[i], f.shot[i] as number, `${where} shot[${i}]`)
        assert.equal(shot.phase, f.shot[5], `${where} shot phase`)
        assert.equal(shot.primaryRegion, f.shot[6], `${where} shot region`)
      }
      if (f.springLength !== undefined) close(state.springLength!, f.springLength, `${where} springLength`)

      const eyeRegions = rig.regions.filter((r) => r.kind === 'eye')
      assert.equal(eyeRegions.length, f.eyes.length, where)
      eyeRegions.forEach((r, k) => {
        const e = state[r.bone] as EyeBone
        const got = [e.x, e.y, e.sx, e.sy]
        for (let i = 0; i < 4; i++) close(got[i], f.eyes[k][i] as number, `${where} ${r.name}[${i}]`)
        assert.equal(e.expression, f.eyes[k][4], `${where} ${r.name} expression`)
      })

      assert.equal(f.regions.length, rig.regions.length, where)
      rig.regions.forEach((r, k) => {
        const drawn = f.regions[k]
        const at = `${where} ${r.name}`
        if (r.kind === 'spring') {
          // Drawn in the spring bone's space, three strokes from dark to light.
          assert.equal(drawn.images.length, 0, at)
          assert.equal(drawn.marks.length, SPRING_STROKES.length, at)
          drawn.marks.forEach((mk, i) => {
            closeMatrix(matrices[r.bone], mk.m, `${at} spring[${i}]`)
            assert.equal(mk.kind, 'stroke', at)
            close(mk.lw!, SPRING_STROKES[i].width, `${at} spring[${i}] width`, CORNER_EPS)
            assert.equal(mk.color, hex(SPRING_STROKES[i].color), at)
          })
          return
        }
        if (r.kind !== 'eye') {
          assert.equal(drawn.images.length, 1, at)
          assert.equal(drawn.marks.length, 0, at)
          const got = corners(regionMatrix(matrices[r.bone], r), r.w, r.h)
          for (let i = 0; i < 8; i++) close(got[i], drawn.images[0][i], `${at} corner[${i}]`, CORNER_EPS)
          return
        }
        // The normal eye shows unless a shot hides it completely.
        const eyeM = rig.eyeMatrix(matrices, state[r.bone] as EyeBone)
        const normal = shot === null || shot.eyeOpacity > 0
        assert.equal(drawn.images.length, normal ? 1 : 0, `${at} image`)
        if (normal) {
          const got = corners(eyeM, rig.eyeSize.w, rig.eyeSize.h)
          for (let i = 0; i < 8; i++) close(got[i], drawn.images[0][i], `${at} corner[${i}]`, CORNER_EPS)
        }
        const marks = shot !== null && shot.primaryRegion === r.name ? chargedEyeMarks(shot, rig.shot.radius, a.eyeOpacity) : []
        assert.equal(drawn.marks.length, marks.length, `${at} marks`)
        const markM = multiply(eyeM, { a: 1, b: 0, c: 0, d: 1, x: rig.shot.offset(state), y: 0 })
        marks.forEach((mk, i) => {
          const want = drawn.marks[i]
          closeMatrix(markM, want.m, `${at} mark[${i}]`)
          assert.equal(mk.kind, want.kind, `${at} mark[${i}]`)
          close(mk.r, want.r!, `${at} mark[${i}] r`, CORNER_EPS)
          if (mk.lw !== null) close(mk.lw, want.lw!, `${at} mark[${i}] lw`, CORNER_EPS)
          assert.equal(hex(mk.color), want.color, `${at} mark[${i}] colour`)
          close(mk.alpha, want.alpha, `${at} mark[${i}] alpha`, CORNER_EPS)
        })
      })
    }
  })
}

for (const rig of Object.values(ROBOT_RIGS)) check(rig)
