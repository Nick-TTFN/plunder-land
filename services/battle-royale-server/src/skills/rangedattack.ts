import { Skill } from './skill'
import { ObjectType } from '../objects/gameobject'
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'

export class RangedAttack extends Skill {
  range: number

  constructor (owner) {
    super(owner, 500)
    this.range = 1000
  }

  execute () {
    const endpoint = this.owner.position.add(
      this.owner.facing.multiply(this.range)
    )
    if (!super.execute()) return false

    for (const collidee of World.FIND_BETWEEN_POINTS(
      this.owner.position.x,
      this.owner.position.y,
      endpoint.x,
      endpoint.y,
      this.owner.tag,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee !== this.owner) {
        if (collidee.hit(World.config.ranged)) { this.owner.onKill(collidee) }
      }
    }

    Multiplayer.Instance.effect(3, this.owner, 1)
    return true
  }
}
