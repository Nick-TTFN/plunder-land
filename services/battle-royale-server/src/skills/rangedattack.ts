import { Skill } from './skill'
import { ObjectType } from '../objects/gameobject'
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import { type Unit } from '../objects/unit'
import GuardPosition from '../ai/guardposition'

export class RangedAttack extends Skill {
  range: number

  constructor (owner) {
    super(owner, 750)
    // 8 cells at Hex.SIZE 45: base vision, so you can shoot only what you see.
    this.range = 360
  }

  execute () {
    const endpoint = this.owner.position.add(
      this.owner.facing.multiply(this.range)
    )
    if (!super.execute()) return false

    // The shot stops at the first unit on the line (N4, decision #16). It used
    // to hit every unit on it, which let a player snipe from behind a mob pack.
    let first: Unit | undefined
    let nearest = Infinity
    for (const collidee of World.FIND_BETWEEN_POINTS(
      this.owner.position.x,
      this.owner.position.y,
      endpoint.x,
      endpoint.y,
      this.owner.tag,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee === this.owner || collidee.destroyed) continue
      const sqDistance = collidee.position.sub(this.owner.position).getSquareMagnitude()
      if (sqDistance < nearest) {
        nearest = sqDistance
        first = collidee
      }
    }

    if (first !== undefined) {
      if (first.hit(World.config.ranged)) this.owner.onKill(first)
      else GuardPosition.provoke(first, this.owner)
    }

    Multiplayer.Instance.effect(3, this.owner, 1)
    return true
  }
}
