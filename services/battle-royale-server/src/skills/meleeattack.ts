import { Skill } from './skill'
import { ObjectType } from '../objects/gameobject'
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import GuardPosition from '../ai/guardposition'

export class MeleeAttack extends Skill {
  /** 2 rings around the caster's cell: 19 cells (it was a 100, then 90 u radius). */
  static RINGS = 2

  constructor (owner) {
    super(owner, 1000)
  }

  execute () {
    if (!super.execute()) return false

    for (const collidee of World.FIND_IN_CELLS(
      this.owner.cell,
      MeleeAttack.RINGS,
      this.owner.tag,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee !== this.owner) {
        if (collidee.hit(this.dealt((this.damage ?? World.config.melee) + this.owner.weapon))) { this.owner.onKill(collidee) } else GuardPosition.provoke(collidee, this.owner)
      }
    }

    Multiplayer.Instance.effect(2, this.owner, 1)
    return true
  }
}
