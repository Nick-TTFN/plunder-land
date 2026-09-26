/**
 * One piece of a unit's behaviour, run every tick from `Unit.update`
 * (`GuardPosition`, `UseSkillOnTarget`; built from an archetype's `routines`).
 */
export interface IAIRoutine {
  update: (dt: number) => void
}
