import { Skill } from './skill'
import Throwable from '../objects/throwable'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import World from '../objects/world'

export class ThrowFireball extends Skill {
  static Damage = [35, 45, 55, 70]

  private _timeoutId: NodeJS.Timeout | undefined

  constructor (owner: Unit) {
    super(owner, 4000)
  }

  execute () {
    if (!super.execute()) return false

    const lifetime = 3000
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

  explode (target: GameObject) {
    for (const collidee of World.FIND_AROUND(
      target.position.x,
      target.position.y,
      target.tag,
      100,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee !== this.owner) {
        if (collidee.hit(ThrowFireball.Damage[this.owner.level])) { this.owner.onKill(collidee) }
      }
    }

    World.OBSTACLES.splice(World.OBSTACLES.indexOf(target), 1)
    if (this._timeoutId != null) {
      clearTimeout(this._timeoutId)
      this._timeoutId = undefined
    }
  }
}
