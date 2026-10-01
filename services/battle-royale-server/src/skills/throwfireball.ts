import { Skill } from './skill'
import Multiplayer from '../network/multiplayer'
import Throwable from '../objects/throwable'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { RangedAttack } from './rangedattack'
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

    // A 10-cell hex line through the aimed cell, or along the hex facing
    // (hex-cells P3, #34); `Throwable` steps along it and bursts at its end.
    // The 1200 ms lifetime ends nothing now; it is only sent, as before.
    const fireball = new Throwable(
      RangedAttack.lineOf(this.owner, aimCell, Throwable.RANGE_CELLS),
      1200,
      this.owner.tag,
      this.owner,
      this.explode.bind(this),
      Throwable.FIREBALL
    )
    World.PROJECTILES.push(fireball)

    return true
  }

  /**
   * `struck` is the unit the fireball flew into, if it did. The blast is centred
   * on that unit's cell, so it is always inside it; centred on the old 50-unit
   * disc projectile, a 70-unit blast missed about one grunt in eight and one
   * boss in four that it had just hit. A fireball that reaches the end of its
   * line without striking anyone bursts on its own cell, the line's last
   * (`Throwable.update`).
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
        if (collidee.hit(this.dealt(this.byLevel(ThrowFireball.Damage)))) { this.owner.onKill(collidee) } else GuardPosition.provoke(collidee, this.owner)
      }
    }
    // No removal here: `World.updateProjectiles` sweeps the destroyed
    // projectile. Splicing from inside its own update skipped the next one.
  }
}
