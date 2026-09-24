import { Skill } from './skill'
import Throwable from '../objects/throwable'
import { ObjectType } from '../objects/gameobject'
import Slowdown from '../buffs/slowdown'
import { type Unit } from '../objects/unit'
import World from '../objects/world'

export class Throwicicle extends Skill {
  static Damage = [35, 45, 55, 65]

  private _timeoutId: NodeJS.Timeout | undefined

  constructor (owner: Unit) {
    super(owner, 4000)
  }

  execute (): boolean {
    if (!super.execute()) return false

    const lifetime = 3000
    const pos = this.owner.position.add(
      this.owner.direction.multiply(this.owner.radius * 4)
    )
    const icicle = new Throwable(
      pos.x,
      pos.y,
      lifetime,
      this.owner.direction,
      300,
      this.owner.tag,
      this.owner,
      this.explode.bind(this)
    )
    World.OBSTACLES.push(icicle)
    this._timeoutId = setTimeout(
      (v) => {
        v.destroy()
      },
      lifetime,
      icicle
    )

    return true
  }

  explode (target) {
    for (const collidee of World.FIND_AROUND(
      target.position.x,
      target.position.y,
      target.tag,
      100,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee !== this.owner) {
        let damage = Throwicicle.Damage[this.owner.level]
        if (collidee.buffs.length > 0) damage += 10

        collidee.addBuff(new Slowdown(collidee, 3000))
        if (collidee.hit(damage)) this.owner.onKill(collidee)
      }
    }

    World.OBSTACLES.splice(World.OBSTACLES.indexOf(target), 1)
    if (this._timeoutId != null) {
      clearTimeout(this._timeoutId)
      this._timeoutId = undefined
    }
  }
}
