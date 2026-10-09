import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ClipName, type EyeBone, type Matrix, type PoseOptions, multiply, regionMatrix } from '../../../../plunder-land-client/src/peep/rig'
import { ROBOT_RIGS, actionOnMove, runClock, type RobotRig } from '../../../../plunder-land-client/src/robots/robotrig'
import { ARCHETYPE_INFO } from '../../../../plunder-land-client/src/utils/archetypes'
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

// Decision #52 A1: while a robot moves, its standing shot carries on as the
// eye shot over the run (any time: the charge and the fire stay), and its
// swing ends once past its blow (`melee_hit`, each rig's own), never before.
test('a moving robot\'s shot turns into the eye shot and its swing ends from its blow on', () => {
  const blows: Record<string, number> = { peep: 0.30, magnet: 0.42, periscope: 0.38, hopper: 0.39, waddle: 0.43 }
  for (const rig of Object.values(ROBOT_RIGS)) {
    const blow = rig.clips.swing.events.find((e) => e.name === 'melee_hit')?.time
    assert.equal(blow, blows[rig.sheet], rig.sheet)
    assert.equal(actionOnMove(rig, 'swing', blow! - 0.001), 'play', rig.sheet)
    assert.equal(actionOnMove(rig, 'swing', blow!), 'end', rig.sheet)
    assert.ok(blow! < rig.clips.swing.duration, rig.sheet)
    for (const t of [0, SHOT.fire - 0.01, SHOT.fire, 0.7]) assert.equal(actionOnMove(rig, 'shoot', t), 'eye', `${rig.sheet} ${t}`)
    assert.equal(actionOnMove(rig, 'fall_apart', 0.5), 'play', rig.sheet)
  }
})

// Decision #52 open items (3): Peep's run timed from its stride, capped at 6
// steps a second per leg, never slower than before; the other robots as they
// were. `RobotSprite`'s numbers parsed from its source (a pixi module).
const SPRITE = (() => {
  const src = readFileSync(join(__dirname, '../../../../plunder-land-client/src/robots/robotsprite.ts'), 'utf8')
  const num = (re: RegExp): number => {
    const m = src.match(re)
    assert.ok(m !== null, `robotsprite.ts no longer has ${String(re)}`)
    return Number(m[1])
  }
  // The clock `update` adds, so the numbers below are the game's.
  assert.match(src, /this\.baseTime \+= this\.base === 'run' \? dt \* runClock\(this\.character, this\.pace, RobotSprite\) \* backwards : dt/)
  assert.match(src, /this\.pace = Math\.min\(this\.character\.maxPace \?\? RobotSprite\.MAX_PACE, Math\.max\(RobotSprite\.MIN_PACE, pace\)\)/)
  return {
    RUN_RATE: num(/static readonly RUN_RATE = ([\d.]+)/),
    STRIDE_SPEED: num(/static readonly STRIDE_SPEED = ([\d.]+)/),
    MIN_PACE: num(/static readonly MIN_PACE = ([\d.]+)/),
    MAX_PACE: num(/static readonly MAX_PACE = ([\d.]+)/),
    SCALE: num(/static readonly PEEP_HEIGHT = ([\d.]+)/) / ROBOT_RIGS.peep.referenceUnits
  }
})()

/** A foot bone's `contact` (Peep's, Magnet's and Periscope's feet carry one). */
const planted = (bone: object): boolean => (bone as { contact?: boolean }).contact === true

const runPace = (rig: RobotRig, v: number): number => Math.min(rig.maxPace ?? SPRITE.MAX_PACE, Math.max(SPRITE.MIN_PACE, v / SPRITE.STRIDE_SPEED))

/**
 * A planted foot's mean velocity over the ground, world u/s, for a robot
 * running east at `v` as `RobotSprite` plays its run (`runClock`): the
 * unit's velocity plus the foot's in the sprite (rig x at `SCALE x
 * drawScale`; rig y is up the screen, still while planted). Zero is planted.
 */
function robotPlanted (rig: RobotRig, v: number): { x: number, y: number, n: number } {
  const ppu = SPRITE.SCALE * rig.drawScale
  const rate = runClock(rig, runPace(rig, v), SPRITE)
  const bones = Object.keys(rig.animationPose('run', 0, {}).matrices).filter((b) => /^foot(_|$)/.test(b))
  const h = 1e-5
  let sx = 0
  let sy = 0
  let n = 0
  const period = rig.clips.run.duration
  for (let i = 0; i < 600; i++) {
    const t = period * i / 600
    const [lo, hi] = [rig.animationPose('run', t - h, {}), rig.animationPose('run', t + h, {})]
    for (const b of bones) {
      if (!planted(lo.state[b]) || !planted(hi.state[b])) continue
      sx += v + rate * ppu * (hi.matrices[b].x - lo.matrices[b].x) / (2 * h)
      sy += rate * ppu * (hi.matrices[b].y - lo.matrices[b].y) / (2 * h)
      n++
    }
  }
  return { x: sx / n, y: sy / n, n }
}

test('runClock: RUN_RATE x runRate x pace without a gait; with one, the planted rate capped at maxSteps, never below that', () => {
  const sprite = { RUN_RATE: 2, STRIDE_SPEED: 140, SCALE: 0.5 }
  assert.equal(runClock({ drawScale: 3 }, 0.7, sprite), 1.4)
  assert.ok(Math.abs(runClock({ drawScale: 3, runRate: 1.5 }, 0.7, sprite) - 2.1) < 1e-12)
  const gait = { groundSpeed: 40, period: 0.5, maxSteps: 6 }
  // 70 u/s over (40 x 0.5 x 2) = 1.75 clip seconds a second (3.5 steps): under the cap of 6 x 0.5 = 3, over the 1 it ran at.
  assert.ok(Math.abs(runClock({ gait, drawScale: 2 }, 0.5, sprite) - 1.75) < 1e-12)
  // 280 u/s would need 7, capped at 3; but it ran at RUN_RATE x pace = 4 before, so 4.
  assert.ok(Math.abs(runClock({ gait, drawScale: 2 }, 2, sprite) - 4) < 1e-12)
  // 210 u/s: planted 5.25, capped 3, before 3: 3.
  assert.ok(Math.abs(runClock({ gait, drawScale: 2 }, 1.5, sprite) - 3) < 1e-12)
  // drawScale counts: twice as big, half the planted rate.
  assert.ok(Math.abs(runClock({ gait, drawScale: 4 }, 0.5, sprite) - 1) < 1e-12)
})

test('only Peep\'s run has a gait: its period is the loop\'s step cycle and its groundSpeed the planted sweep; the rest run as before', () => {
  assert.deepEqual(Object.values(ROBOT_RIGS).filter((r) => r.gait !== undefined).map((r) => r.sheet), ['peep'])
  for (const rig of Object.values(ROBOT_RIGS)) {
    if (rig.gait !== undefined) continue
    for (const pace of [0.5, 1, 2.5]) assert.equal(runClock(rig, pace, SPRITE), SPRITE.RUN_RATE * (rig.runRate ?? 1) * pace, rig.sheet)
  }
  const rig = ROBOT_RIGS.peep
  const gait = rig.gait!
  const clip = rig.clips.run.duration
  const bones = Object.keys(rig.animationPose('run', 0, {}).matrices).filter((b) => /^foot(_|$)/.test(b))
  assert.equal(bones.length, 2)
  const n = 4000
  const contact = (t: number): boolean[] => bones.map((b) => planted(rig.animationPose('run', t, {}).state[b]))
  const downs = bones.map(() => 0)
  let before = contact(clip * (n - 1) / n)
  for (let i = 0; i < n; i++) {
    const now = contact(clip * i / n)
    now.forEach((c, k) => { if (c && !before[k]) downs[k]++ })
    before = now
  }
  for (const d of downs) assert.equal(d, Math.round(clip / gait.period), 'touchdowns per leg a loop')
  assert.ok(Math.abs(clip / gait.period - Math.round(clip / gait.period)) < 1e-9, 'the loop is whole steps')
  assert.equal(gait.maxSteps, 6)
})

test('Peep runs planted east and west until 6 steps a second, then slides only the capped share; a dash is as fast as before', () => {
  const rig = ROBOT_RIGS.peep
  const gait = rig.gait!
  const base = ARCHETYPE_INFO.peep.stats.speed
  const plantedRate = (v: number): number => runPace(rig, v) * SPRITE.STRIDE_SPEED / (gait.groundSpeed * SPRITE.SCALE * rig.drawScale)
  // Under the cap (it binds from 73.6 u/s; 70 is the pace floor 0.5): planted, at 1% of the ground speed.
  for (const v of [70, 72, 73]) {
    assert.ok(plantedRate(v) < gait.maxSteps * gait.period, `${v} is under the cap`)
    const w = robotPlanted(rig, v)
    assert.ok(w.n > 0)
    assert.ok(Math.hypot(w.x, w.y) < 0.01 * v, `at ${v} u/s a planted foot moves ${w.x.toFixed(2)},${w.y.toFixed(2)}`)
  }
  // At its own speed: 6 steps a second (3.6 clip s a second, 1.8x the 2 before), the capped share of the slide along the motion.
  const rate = runClock(rig, runPace(rig, base), SPRITE)
  assert.ok(Math.abs(rate / gait.period - 6) < 1e-9, `steps a second ${rate / gait.period}`)
  assert.ok(Math.abs(rate / (SPRITE.RUN_RATE * runPace(rig, base)) - 1.8) < 1e-9)
  const want = 1 - rate / plantedRate(base)
  const w = robotPlanted(rig, base)
  assert.ok(Math.abs(w.x - want * base) < 0.01 * base && Math.abs(w.y) < 0.01 * base, `at ${base} a planted foot moves ${w.x.toFixed(2)},${w.y.toFixed(2)}, want ${(want * base).toFixed(2)},0`)
  // Measured 47.4% (70.8% before).
  assert.ok(Math.abs(want - 0.474) < 0.001, `slide ${want}`)
  // A dash (2.5x): the legs run as before, not slowed to the cap.
  assert.equal(runClock(rig, 2.5, SPRITE), SPRITE.RUN_RATE * 2.5)
})
