import { Skill } from './skill'
import Throwable from '../objects/throwable'
import { type GameObject, ObjectType } from '../objects/gameobject'
import Slowdown from '../buffs/slowdown'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { Hex } from '../utils/hex'
import GuardPosition from '../ai/guardposition'

export class Throwicicle extends Skill {
  static Damage = [35, 30, 55, 65]
  /** The impact cell and its 6 neighbours. */
  static BLAST_RINGS = 1

  private _timeoutId: NodeJS.Timeout | undefined

  constructor (owner: Unit) {
    super(owner, 4000)
  }

  execute (): boolean {
    if (!super.execute()) return false

    // 1200 ms at 300 u/s is 360 units, 8 cells: out to base vision. Must stay
    // under the cooldown until `move-timers-into-tick` (one _timeoutId per skill).
    const lifetime = 1200
    const pos = this.owner.position.add(
      this.owner.facing.multiply(this.owner.radius * 4)
    )
    const icicle = new Throwable(
      pos.x,
      pos.y,
      lifetime,
      this.owner.facing,
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

  /** See ThrowFireball.explode: centred on the cell of the unit it struck. */
  explode (target: GameObject, struck?: Unit) {
    const origin = Hex.toCell((struck ?? target).position)
    for (const collidee of World.FIND_IN_CELLS(
      origin,
      Throwicicle.BLAST_RINGS,
      target.tag,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee !== this.owner) {
        let damage = Throwicicle.Damage[this.owner.level]
        if (collidee.buffs.length > 0) damage += 10

        // Provoke before slowing: provoking raises a mob to chase speed, and the
        // slow has to halve that, not the idle speed it was walking at.
        GuardPosition.provoke(collidee, this.owner)
        collidee.addBuff(new Slowdown(collidee, 2000))
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
