import { type Unit } from '../objects/unit'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'

export class Skill {
  owner: Unit
  cooldown: number
  executeTime: number
  /**
   * The archetype's override of this skill's damage (`SkillSpec.damage`), or
   * undefined for the skill's own default. Set after construction by
   * `buildSkills`. A skill's default belongs in its own `??` fallback, never
   * in an initialiser here or on a subclass, or it would read as an override.
   */
  damage: number | undefined
  constructor (owner: Unit, cooldown: number) {
    this.owner = owner
    this.cooldown = cooldown
  }

  /**
   * `aimCell` is the absolute axial cell the caster aimed at (decision #21), or
   * undefined for no aim. Skills that do not aim ignore it.
   */
  execute (aimCell?: Vector) {
    if (!this.ready()) { return false }

    this.executeTime = Date.now()
    return true
  }

  /** True when the cooldown is over, so `execute` would not refuse on it. */
  ready (): boolean {
    return !(this.executeTime > Date.now() - this.cooldown)
  }

  /**
   * Damage from a per-level table, unless the archetype overrides it. A unit
   * with no level (a grunt) would read `table[undefined]`, which `hit` turns
   * into NaN hp, so such an archetype must override every skill that calls
   * this (archetypes.spec.ts checks the table).
   */
  protected byLevel (table: number[]): number {
    return this.damage ?? table[this.owner.level]
  }

  /**
   * Damage this skill deals, times the owner's `damageScale` (robot-select,
   * #42: one multiplier on all of a robot's skill damage; a player's gear adds
   * to it, #49). Every skill that hits goes through here. Not floored: `hit`
   * floors.
   */
  protected dealt (base: number): number {
    return base * this.owner.damageScale
  }

  /** True when `aimCell` names a cell other than the one the caster stands on. */
  static isAimed (owner: Unit, aimCell?: Vector): aimCell is Vector {
    if (aimCell === undefined) return false
    const own = Hex.toCell(owner.position)
    return own.x !== aimCell.x || own.y !== aimCell.y
  }
}
