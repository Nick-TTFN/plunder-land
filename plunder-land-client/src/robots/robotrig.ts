import { type ClipName, type EyeBone, type Matrix, type Pose, type PoseOptions, type Region } from '../peep/rig'
import * as peep from '../peep/rig'
import * as magnet from '../magnet/rig'
import * as periscope from '../periscope/rig'

/**
 * What `RobotSprite` needs to draw one robot (magnet-rig, #42): the minimal
 * common interface `codex_output/ROBOT-PRODUCTION.md` asks the second robot to
 * establish. Each robot's evaluator stays its own (`src/peep/rig.ts`,
 * `src/magnet/rig.ts`, checked against their drops); this is only the data
 * and the drawing constants that differ between them, every one the drop's.
 */
export interface RobotRig {
  /** Its sheet (`assets/res/<sheet>.json`, `tools/bake-peep-atlas.py <sheet>`) and frame prefix. */
  readonly sheet: 'peep' | 'periscope' | 'magnet'
  readonly regions: readonly Region[]
  readonly clips: Readonly<Record<ClipName | 'reference', { readonly duration: number }>>
  readonly animationPose: (name: ClipName | 'reference', seconds: number, options: PoseOptions) => Pose
  /** Where the eye image goes, from the pose's matrices and its eye bone. */
  readonly eyeMatrix: (matrices: Record<string, Matrix>, eye: EyeBone) => Matrix
  /** The eye image's size in the units `eyeMatrix` maps. */
  readonly eyeSize: { readonly w: number, readonly h: number }
  /**
   * How much bigger than Peep's pixels per rig unit it is drawn: 1, except
   * Periscope at 1.35 (Nick, 2026-10-01: "30-40% bigger, he's slim but tall").
   * Its sheets are baked at the same factor (`bake-peep-atlas.py`
   * `DRAW_SCALE`), so it still draws texel for pixel. Change both together.
   */
  readonly drawScale: number
  /** The reference pose's visible height, rig units. */
  readonly referenceUnits: number
  /** Height of the gun shoulder (the aim origin) above the feet, rig units. */
  readonly shoulderY: number
  /** The standing shadow: centre x, radii, and the jump height that shrinks it. */
  readonly shadow: { readonly x: number, readonly rx: number, readonly ry: number, readonly jumpHeight: number }
  /** Each piece's shadow radius once fallen apart, by debris id; 16 if not listed. */
  readonly debrisShadow: Readonly<Record<string, number>>
  /** The muzzle flash's size along the muzzle bone. */
  readonly flashScale: number
}

export const PEEP_RIG: RobotRig = Object.freeze({
  sheet: 'peep',
  regions: peep.REGIONS,
  clips: peep.CLIPS,
  animationPose: peep.animationPose,
  eyeMatrix: (m: Record<string, Matrix>, eye: EyeBone) => peep.eyeMatrix(m.head, eye),
  // In the head art's pixels (`eye/open.png` is 144 x 198 of the 428 x 388 head).
  eyeSize: Object.freeze({ w: 144, h: 198 }),
  drawScale: 1,
  // Measured from the drop's reference pose.
  referenceUnits: 245.5,
  shoulderY: 79,
  shadow: Object.freeze({ x: 0, rx: 70, ry: 9, jumpHeight: 48 }),
  debrisShadow: Object.freeze({ head: 53, torso: 29 }),
  flashScale: 1
})

/** Numbers from the v2 drop: `rig/character.json` and `drawAnimation` in `tools/animations.mjs`. */
export const MAGNET_RIG: RobotRig = Object.freeze({
  sheet: 'magnet',
  regions: magnet.REGIONS,
  clips: magnet.CLIPS,
  animationPose: magnet.animationPose,
  // Peep's head art and eye, on Magnet's head bone.
  eyeMatrix: (m: Record<string, Matrix>, eye: EyeBone) => magnet.eyeMatrix(m.head, eye),
  eyeSize: Object.freeze({ w: 144, h: 198 }),
  drawScale: 1,
  referenceUnits: 227.93044,
  shoulderY: 95,
  shadow: Object.freeze({ x: 10, rx: 76, ry: 9, jumpHeight: 42 }),
  debrisShadow: Object.freeze({ head: 42, magnet: 35, torso: 29 }),
  flashScale: 0.8
})

/**
 * Numbers from the v1 drop: `rig/character.json` and `drawAnimation` in
 * `tools/animations.mjs`. Its shadow and debris-shadow numbers are Magnet's,
 * copied there (the debris lookup names Magnet's pieces, so every Periscope
 * piece gets the default); kept as the drop has them.
 */
export const PERISCOPE_RIG: RobotRig = Object.freeze({
  sheet: 'periscope',
  regions: periscope.REGIONS,
  clips: periscope.CLIPS,
  animationPose: periscope.animationPose,
  eyeMatrix: periscope.eyeMatrix,
  eyeSize: periscope.EYE_SIZE,
  drawScale: 1.35,
  referenceUnits: 222.63683,
  // The gun mount: body 80 up, mount 16 below it.
  shoulderY: 64,
  shadow: Object.freeze({ x: 10, rx: 76, ry: 9, jumpHeight: 42 }),
  debrisShadow: Object.freeze({}),
  flashScale: 0.8
})

export const ROBOT_RIGS: Readonly<Record<RobotRig['sheet'], RobotRig>> = Object.freeze({ peep: PEEP_RIG, periscope: PERISCOPE_RIG, magnet: MAGNET_RIG })
