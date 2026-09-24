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
    if (this.executeTime > Date.now() - this.cooldown) { return false }

    this.executeTime = Date.now()
    return true
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

  /** True when `aimCell` names a cell other than the one the caster stands on. */
  static isAimed (owner: Unit, aimCell?: Vector): aimCell is Vector {
    if (aimCell === undefined) return false
    const own = Hex.toCell(owner.position)
    return own.x !== aimCell.x || own.y !== aimCell.y
  }

  /**
   * The unit vector from the caster toward the centre of `aimCell`, at any
   * angle. No aim, or an aim at the caster's own cell, falls back to `facing`:
   * the own cell gives no usable direction.
   *
   * The offset is taken from the server's own position, never the client's.
   * That is why the wire carries an absolute cell rather than an offset: the
   * predicting client can disagree about which cell the caster is on by one,
   * and an offset would then land a cell off (decision #21).
   */
  static aimDirection (owner: Unit, aimCell?: Vector): Vector {
    if (!Skill.isAimed(owner, aimCell)) return owner.facing
    return Hex.toPosition(aimCell).sub(owner.position).normalised()
  }
}
