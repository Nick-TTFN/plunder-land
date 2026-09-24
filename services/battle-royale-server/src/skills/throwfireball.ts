import { Skill } from './skill'
import Multiplayer from '../network/multiplayer'
import Throwable from '../objects/throwable'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import Timers from '../objects/timers'
import { Hex } from '../utils/hex'
import GuardPosition from '../ai/guardposition'
import { type Vector } from '../utils/vector'

export class ThrowFireball extends Skill {
  static Damage = [35, 35, 55, 70]
  /** The impact cell and its 6 neighbours. */
  static BLAST_RINGS = 1

  constructor (owner: Unit) {
    super(owner, 4000)
  }

  execute (aimCell?: Vector) {
    if (!super.execute()) return false

    // 1200 ms at 300 u/s is 360 units, 8 cells: out to base vision.
    const lifetime = 1200
    // Through the centre of the aimed cell and on to its lifetime (decision #21).
    const aim = Skill.aimDirection(this.owner, aimCell)
    const pos = this.owner.position.add(
      aim.multiply(this.owner.radius * 4)
    )
    const fireball = new Throwable(
      pos.x,
      pos.y,
      lifetime,
      aim,
      300,
      this.owner.tag,
      this.owner,
      this.explode.bind(this)
    )
    World.PROJECTILES.push(fireball)
    // Owned by the projectile, not the skill: a hit destroys it, which cancels
    // this, so any number can be in flight whatever the cooldown.
    Timers.schedule(lifetime, () => { fireball.destroy() }, fireball)

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
    // The blast's own cell, so the client draws the ring the server damages.
    // The client cannot work it out: the destroy record carries no position,
    // and its last one is a tick behind the hit.
    Multiplayer.Instance.effect(5, this.owner, 500, origin)
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
    // No removal here: `World.updateProjectiles` sweeps the destroyed
    // projectile. Splicing from inside its own update skipped the next one.
  }
}
