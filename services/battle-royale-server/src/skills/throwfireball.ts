import { Skill } from './skill'
import Throwable from '../objects/throwable'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { Hex } from '../utils/hex'
import GuardPosition from '../ai/guardposition'

export class ThrowFireball extends Skill {
  static Damage = [35, 35, 55, 70]
  /** The impact cell and its 6 neighbours. */
  static BLAST_RINGS = 1

  private _timeoutId: NodeJS.Timeout | undefined

  constructor (owner: Unit) {
    super(owner, 4000)
  }

  execute () {
    if (!super.execute()) return false

    // 1200 ms at 300 u/s is 360 units, 8 cells: out to base vision. Must stay
    // under the cooldown until `move-timers-into-tick` (one _timeoutId per skill).
    const lifetime = 1200
    const pos = this.owner.position.add(
      this.owner.facing.multiply(this.owner.radius * 4)
    )
    const fireball = new Throwable(
      pos.x,
      pos.y,
      lifetime,
      this.owner.facing,
      300,
      this.owner.tag,
      this.owner,
      this.explode.bind(this)
    )
    World.OBSTACLES.push(fireball)
    this._timeoutId = setTimeout(
      (v) => {
        v.destroy()
      },
      lifetime,
      fireball
    )

    return true
  }

  /**
   * `struck` is the unit the fireball flew into, if it did. The blast is centred
   * on that unit's cell, so it is always inside it; centred on the projectile,
   * whose collider reaches 50 + a unit's radius, a 70-unit blast missed about
   * one grunt in eight and one boss in four that it had just hit. A fireball
   * that runs out of lifetime bursts on its own cell.
   */
  explode (target: GameObject, struck?: Unit) {
    const origin = Hex.toCell((struck ?? target).position)
    for (const collidee of World.FIND_IN_CELLS(
      origin,
      ThrowFireball.BLAST_RINGS,
      target.tag,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee !== this.owner) {
        if (collidee.hit(ThrowFireball.Damage[this.owner.level])) { this.owner.onKill(collidee) } else GuardPosition.provoke(collidee, this.owner)
      }
    }

    World.OBSTACLES.splice(World.OBSTACLES.indexOf(target), 1)
    if (this._timeoutId != null) {
      clearTimeout(this._timeoutId)
      this._timeoutId = undefined
    }
  }
}
