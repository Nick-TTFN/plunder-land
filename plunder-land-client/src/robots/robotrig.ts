import { type ClipName, type EyeBone, type Matrix, type Pose, type PoseOptions, type Region, type RigState } from '../peep/rig'
import * as peep from '../peep/rig'
import * as magnet from '../magnet/rig'
import * as periscope from '../periscope/rig'
import * as hopper from '../hopper/rig'
import * as waddle from '../waddle/rig'

/**
 * What `RobotSprite` needs to draw one robot (magnet-rig, #42): the minimal
 * common interface `codex_output/ROBOT-PRODUCTION.md` asks the second robot to
 * establish. Each robot's evaluator stays its own (`src/<robot>/rig.ts`,
 * checked against their drops by `robotrigs.spec.ts`); this is only the data
 * and the drawing constants that differ between them, every one the drop's.
 */
export interface RobotRig {
  /** Its sheet (`assets/res/<sheet>.json`, `tools/bake-peep-atlas.py <sheet>`) and frame prefix. */
  readonly sheet: 'peep' | 'periscope' | 'magnet' | 'hopper' | 'waddle'
  readonly regions: readonly Region[]
  readonly clips: Readonly<Record<ClipName | 'reference', { readonly duration: number, readonly events: ReadonlyArray<{ readonly time: number, readonly name: string }> }>>
  readonly animationPose: (name: ClipName | 'reference', seconds: number, options: PoseOptions) => Pose
  /**
   * Where an eye image goes, from the pose's matrices and that eye region's
   * bone (`state[region.bone]`; Waddle has two).
   */
  readonly eyeMatrix: (matrices: Record<string, Matrix>, eye: EyeBone) => Matrix
  /** The eye image's size in the units `eyeMatrix` maps. */
  readonly eyeSize: { readonly w: number, readonly h: number }
  /**
   * The eye shot's drawing (`chargedEyeMarks`): the rings' radius in the units
   * `eyeMatrix` maps, and how far along x from the first eye they sit (Waddle:
   * halfway to the second).
   */
  readonly shot: { readonly radius: number, readonly offset: (state: RigState) => number }
  /**
   * How much bigger than the base pixels per rig unit (`RobotSprite.SCALE`)
   * it is drawn: Magnet 1, Periscope 1.35 ("30-40% bigger, he's slim but
   * tall") and Peep 0.9 ("relatively cute"), Nick, 2026-10-01.
   * Its sheets are baked at the same factor (`bake-peep-atlas.py`
   * `DRAW_SCALE`), so it still draws texel for pixel. Change both together.
   */
  readonly drawScale: number
  /** The reference pose's visible height, rig units. */
  readonly referenceUnits: number
  /** The standing shadow: centre x, radii, and the jump height that shrinks it. */
  readonly shadow: { readonly x: number, readonly rx: number, readonly ry: number, readonly jumpHeight: number }
  /** Each piece's shadow radius once fallen apart, by debris id; 16 if not listed. */
  readonly debrisShadow: Readonly<Record<string, number>>
  /**
   * The clip each movement loop plays, when not its own: Hopper hops at rest
   * and on the move (Nick, 2026-10-01). A one-shot clip here plays on a loop,
   * the whole clip, or only its `segments` (clip seconds, played in order).
   */
  readonly loops?: Readonly<Partial<Record<'idle' | 'run', LoopClip>>>
  /** The run loop's speed on top of `RobotSprite.RUN_RATE`: Waddle's 0.9 s stride was too slow (Nick, 2026-10-01). */
  readonly runRate?: number
  /**
   * The most the run loop speeds up with ground speed (`RobotSprite.setPace`),
   * if less than `RobotSprite.MAX_PACE`: Hopper's bounce keeps its walking
   * rate through a dash (Nick, 2026-10-01).
   */
  readonly maxPace?: number
  /**
   * Its run loop timed from its own stride and size, as an NPC's (`RobotGait`,
   * `runClock`). Peep only, a trial (decision #52 open items, 3).
   */
  readonly gait?: RobotGait
}

/**
 * A robot's run timed from its stride (decision #52 open items, 3: "try a
 * faster robot walk, 6 steps/s cap, on Peep only"; PROVISIONAL until Nick
 * has looked). `NpcGait`'s idea for the side-view robots: the loop runs at
 * the rate a planted foot would keep still east and west, capped at
 * `maxSteps` a second per leg, and never slower than it ran before (so a
 * dash's legs are as fast as they were). A rate can't plant a side-view
 * foot going north or south: there the foot sweeps across the motion.
 */
export interface RobotGait {
  /** How fast a planted foot sweeps back, in rig units per clip second (the drop's stride over its contact time). */
  readonly groundSpeed: number
  /** One leg's step cycle, clip seconds. */
  readonly period: number
  /** The most steps a second one leg takes. */
  readonly maxSteps: number
}

/** `RobotSprite`'s numbers `runClock` needs (the class itself fits; it is a pixi module, so the spec passes copies). */
export interface RunSprite {
  readonly RUN_RATE: number
  readonly STRIDE_SPEED: number
  readonly SCALE: number
}

/**
 * Clip seconds a second of `rig`'s run loop at `pace` (ground speed over
 * `STRIDE_SPEED`, as `RobotSprite.setPace` clamps it): what
 * `RobotSprite.update` adds to its clock, before the sign for running
 * backwards. Without a gait, `RUN_RATE x runRate x pace`, as every robot ran
 * before. With one, the planted rate, ground speed / (`groundSpeed` x
 * `SCALE` x `drawScale`), capped at `maxSteps x period`, but never below the
 * rate without it.
 */
export function runClock (rig: Pick<RobotRig, 'gait' | 'runRate' | 'drawScale'>, pace: number, sprite: RunSprite): number {
  const before = sprite.RUN_RATE * (rig.runRate ?? 1) * pace
  const gait = rig.gait
  if (gait === undefined) return before
  const planted = pace * sprite.STRIDE_SPEED / (gait.groundSpeed * sprite.SCALE * rig.drawScale)
  return Math.max(before, Math.min(planted, gait.maxSteps * gait.period))
}

/**
 * Peep's run (`peep/rig.ts` `foot`): a foot sweeps back 24 rig units over
 * the first 0.38 of the 0.6 s loop, and each leg steps once a loop. Planted
 * at its 140 u/s that is 11.4 steps a second; capped at 6, 3.6 clip seconds
 * a second, 1.8x the 2 it ran at.
 */
const PEEP_GAIT: RobotGait = Object.freeze({ groundSpeed: 24 / 0.38 / 0.6, period: 0.6, maxSteps: 6 })

/** A movement loop made of another clip, or of stretches of one. */
export interface LoopClip {
  readonly clip: ClipName
  readonly segments?: ReadonlyArray<readonly [number, number]>
}

const noOffset = (): number => 0

/**
 * Hopper's hop as a bounce (Nick, 2026-10-01: "contact with ground should be
 * really short ... he should just bounce"): its jump clip without the settle
 * after landing or the wind-up before the push. The landing squash (1.0-1.07)
 * runs straight into the push-off (0.17-0.25), then the flight (to 1.0).
 * About 0.15 s on the ground of a 0.9 s loop, where the whole clip spent 0.65 s
 * of 1.4. The squash ends 4 units of head height off the crouch it cuts to.
 */
const HOPPER_BOUNCE: LoopClip = Object.freeze({ clip: 'jump', segments: Object.freeze([[1.0, 1.07], [0.17, 1.0]] as const) })

export const PEEP_RIG: RobotRig = Object.freeze({
  sheet: 'peep',
  regions: peep.REGIONS,
  clips: peep.CLIPS,
  animationPose: peep.animationPose,
  eyeMatrix: (m: Record<string, Matrix>, eye: EyeBone) => peep.eyeMatrix(m.head, eye),
  // In the head art's pixels (`eye/open.png` is 144 x 198 of the 428 x 388 head).
  eyeSize: Object.freeze({ w: 144, h: 198 }),
  shot: Object.freeze({ radius: 42, offset: noOffset }),
  // A little smaller than the rest: "he's relatively cute" (Nick, 2026-10-01).
  drawScale: 0.9,
  // Measured from the drop's reference pose.
  referenceUnits: 245.5,
  shadow: Object.freeze({ x: 0, rx: 70, ry: 9, jumpHeight: 48 }),
  debrisShadow: Object.freeze({ head: 53, torso: 29 }),
  gait: PEEP_GAIT
})

/** Numbers from the v2 drop (unchanged in v3): `rig/character.json` and `drawAnimation` in `tools/animations.mjs`. */
export const MAGNET_RIG: RobotRig = Object.freeze({
  sheet: 'magnet',
  regions: magnet.REGIONS,
  clips: magnet.CLIPS,
  animationPose: magnet.animationPose,
  // Peep's head art and eye, on Magnet's head bone.
  eyeMatrix: (m: Record<string, Matrix>, eye: EyeBone) => magnet.eyeMatrix(m.head, eye),
  eyeSize: Object.freeze({ w: 144, h: 198 }),
  shot: Object.freeze({ radius: 42, offset: noOffset }),
  drawScale: 1,
  referenceUnits: 227.93044,
  shadow: Object.freeze({ x: 10, rx: 76, ry: 9, jumpHeight: 42 }),
  debrisShadow: Object.freeze({ head: 42, magnet: 35, torso: 29 })
})

/**
 * Numbers from the v1 drop (unchanged in v3): `rig/character.json` and
 * `drawAnimation` in `tools/animations.mjs`. Its shadow and debris-shadow
 * numbers are Magnet's, copied there (the debris lookup names Magnet's
 * pieces, so every Periscope piece gets the default); kept as the drop has them.
 */
export const PERISCOPE_RIG: RobotRig = Object.freeze({
  sheet: 'periscope',
  regions: periscope.REGIONS,
  clips: periscope.CLIPS,
  animationPose: periscope.animationPose,
  eyeMatrix: periscope.eyeMatrix,
  eyeSize: periscope.EYE_SIZE,
  shot: Object.freeze({ radius: 4.2, offset: noOffset }),
  drawScale: 1.35,
  referenceUnits: 222.63683,
  shadow: Object.freeze({ x: 10, rx: 76, ry: 9, jumpHeight: 42 }),
  debrisShadow: Object.freeze({})
})

/**
 * Hopper (v2 drop): a head on a spring on one boot. Locked in the lobby, not
 * selectable; its stats and sizes wait for it to be designed in.
 */
export const HOPPER_RIG: RobotRig = Object.freeze({
  sheet: 'hopper',
  regions: hopper.REGIONS,
  clips: hopper.CLIPS,
  animationPose: hopper.animationPose,
  eyeMatrix: hopper.eyeMatrix,
  eyeSize: hopper.EYE_SIZE,
  shot: Object.freeze({ radius: 10, offset: noOffset }),
  // Nick, 2026-10-09 (size review): 1 -> 1.28. The bake's `DRAW_SCALE` matches.
  drawScale: 1.28,
  referenceUnits: hopper.REFERENCE_UNITS,
  // The eye-firing drops' `drawAnimation` contact shadow: one size for every
  // robot but Waddle (73 wide), at y -1; the robots before kept their own.
  shadow: Object.freeze({ x: 0, rx: 55, ry: 6, jumpHeight: 60 }),
  debrisShadow: Object.freeze({}),
  loops: Object.freeze({ idle: HOPPER_BOUNCE, run: HOPPER_BOUNCE }),
  maxPace: 1
})

/** Waddle (v2 drop): a shell with two eyes, flippers and short legs. Locked, like Hopper. */
export const WADDLE_RIG: RobotRig = Object.freeze({
  sheet: 'waddle',
  regions: waddle.REGIONS,
  clips: waddle.CLIPS,
  animationPose: waddle.animationPose,
  eyeMatrix: waddle.eyeMatrix,
  eyeSize: waddle.EYE_SIZE,
  // Between the two eyes: the shot fires from their shared focus.
  shot: Object.freeze({ radius: 13, offset: (st: RigState) => (st.eye_right.x - st.eye_left.x) / 2 }),
  // Nick, 2026-10-09 (size review): 1 -> 1.36. The bake's `DRAW_SCALE` matches.
  drawScale: 1.36,
  referenceUnits: waddle.REFERENCE_UNITS,
  shadow: Object.freeze({ x: 0, rx: 73, ry: 6, jumpHeight: 60 }),
  debrisShadow: Object.freeze({}),
  // The same strides a second as Peep's run (0.9 s against 0.6 s).
  runRate: 1.5
})

export const ROBOT_RIGS: Readonly<Record<RobotRig['sheet'], RobotRig>> = Object.freeze({
  peep: PEEP_RIG, periscope: PERISCOPE_RIG, magnet: MAGNET_RIG, hopper: HOPPER_RIG, waddle: WADDLE_RIG
})

/**
 * What an action clip `t` seconds in does while its robot moves (A1, decision
 * #52): every clip is authored with the feet planted, so one playing while
 * the body moves draws a statue sliding over the ground. `shoot` (the
 * standing shot) becomes the eye shot over the run at the same time
 * (`'eye'`): the shot keeps its charge and its fire moment, `SHOT.fire`.
 * `swing` ends once past its `melee_hit` event (`'end'`), the moment the
 * blow lands; before it, it plays on. Anything else plays on (`hit` is never
 * played since #52; `fall_apart` holds where it fell).
 */
export function actionOnMove (rig: Pick<RobotRig, 'clips'>, name: ClipName, t: number): 'play' | 'end' | 'eye' {
  if (name === 'shoot') return 'eye'
  if (name === 'swing') {
    const blow = rig.clips.swing.events.find((e) => e.name === 'melee_hit')
    return blow !== undefined && t >= blow.time ? 'end' : 'play'
  }
  return 'play'
}
