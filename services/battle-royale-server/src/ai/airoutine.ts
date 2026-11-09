/**
 * One piece of a unit's behaviour, run every tick from `Unit.update`
 * (`GuardPosition`, `UseSkillOnTarget`; built from an archetype's `routines`).
 */
export interface IAIRoutine {
  update: (dt: number) => void
  /**
   * True while it has work in flight that skipping its owner's `update` would
   * cut short: a target, a hold, a charge, a planted burst, a fuse. A mob with
   * a busy routine never sleeps (private-13, `World.canSleep`). Absent: never.
   */
  busy?: () => boolean
  /**
   * Rings at which it notices a player by itself (a guard's `acquire`). A mob
   * sleeps only beyond the largest of these, plus a viewer's reach and the
   * margin (`World.isFar`). Absent: 0.
   */
  readonly noticeRings?: number
}
