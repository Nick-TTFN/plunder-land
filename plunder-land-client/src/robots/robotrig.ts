import { type ClipName, type Pose, type PoseOptions, type Region } from '../peep/rig'
import * as peep from '../peep/rig'
import * as magnet from '../magnet/rig'

/**
 * What `RobotSprite` needs to draw one robot (magnet-rig, #42): the minimal
 * common interface `codex_output/ROBOT-PRODUCTION.md` asks the second robot to
 * establish. Each robot's evaluator stays its own (`src/peep/rig.ts`,
 * `src/magnet/rig.ts`, checked against their drops); this is only the data
 * and the drawing constants that differ between them, every one the drop's.
 */
export interface RobotRig {
  /** Its sheet (`assets/res/<sheet>.json`, `tools/bake-peep-atlas.py <sheet>`) and frame prefix. */
  readonly sheet: 'peep' | 'magnet'
  readonly regions: readonly Region[]
  readonly clips: Readonly<Record<ClipName | 'reference', { readonly duration: number }>>
  readonly animationPose: (name: ClipName | 'reference', seconds: number, options: PoseOptions) => Pose
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
  referenceUnits: 227.93044,
  shoulderY: 95,
  shadow: Object.freeze({ x: 10, rx: 76, ry: 9, jumpHeight: 42 }),
  debrisShadow: Object.freeze({ head: 42, magnet: 35, torso: 29 }),
  flashScale: 0.8
})

export const ROBOT_RIGS: Readonly<Record<RobotRig['sheet'], RobotRig>> = Object.freeze({ peep: PEEP_RIG, magnet: MAGNET_RIG })
