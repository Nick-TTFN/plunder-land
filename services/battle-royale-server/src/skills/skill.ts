import { type Unit } from '../objects/unit'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'

export class Skill {
  owner: Unit
  cooldown: number
  executeTime: number
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
