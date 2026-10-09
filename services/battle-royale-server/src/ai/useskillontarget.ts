import { type Unit } from '../objects/unit'
import { type Skill } from '../skills/skill'
import { type IAIRoutine } from './airoutine'
import Timers from '../objects/timers'
import { Hex } from '../utils/hex'

export default class UseSkillOnTarget implements IAIRoutine {
  skill: Skill
  owner: Unit
  /** See `UseSkillOnTargetSpec.withinCells`. Undefined = any distance. */
  withinCells: number | undefined
  /** See `UseSkillOnTargetSpec.holdMs`. Undefined = cast on the move, no hold. */
  holdMs: number | undefined
  /** True from a cast until `holdMs` after it: the owner stands still. */
  holding = false

  constructor (owner: Unit, skill: Skill, withinCells?: number, holdMs?: number) {
    this.owner = owner
    this.skill = skill
    this.withinCells = withinCells
    this.holdMs = holdMs
  }

  /**
   * After the owner's guard, which picks the target and sets the step goal.
   *
   * With `holdMs` (#52 lane 2, the Crawler and the Kiln): **come to rest,
   * then cast, then hold.** Once the cast is due (target in range, cooldown
   * over) and the owner is mid-step, it clears `stepGoal` so the step in
   * progress lands on its centre and no new one starts (`Unit.step`), and
   * casts on the first tick it is at rest (`stepTo` undefined). From the
   * cast it clears `stepGoal` every tick until a `holdMs` timer owned by the
   * owner ends the hold (the first tick at or after cast + `holdMs`), where
   * the guard's goal stands again. A target that leaves range while it comes
   * to rest calls the cast off, and the guard steers it again next tick.
   */
  update (dt: number) {
    if (this.holding) {
      this.owner.stepGoal = undefined
      return
    }
    if (this.owner.target != null) {
      // Out of range: hold fire, so the cooldown is not spent on a shot that
      // cannot land. Checked before `execute`, which is what starts it.
      if (
        this.withinCells !== undefined &&
        Hex.distance(Hex.toCell(this.owner.position), Hex.toCell(this.owner.target.position)) > this.withinCells
      ) return

      if (this.holdMs !== undefined) {
        if (!this.skill.ready()) return
        if (this.owner.stepTo !== undefined) {
          this.owner.stepGoal = undefined
          return
        }
      }

      // Aim at the target's cell, the same message a player's click sends
      // (decision #21). A target on the mob's own cell falls back to facing.
      if (!this.skill.execute(Hex.toCell(this.owner.target.position))) return
      if (this.holdMs !== undefined) this.hold(this.holdMs)
    }
  }

  private hold (holdMs: number): void {
    this.holding = true
    this.owner.stepGoal = undefined
    Timers.schedule(holdMs, () => { this.holding = false }, this.owner)
  }
}
