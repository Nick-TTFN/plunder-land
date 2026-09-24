import { Skill } from './skill'
import Throwable from '../objects/throwable'
import { type GameObject, ObjectType } from '../objects/gameobject'
import Slowdown from '../buffs/slowdown'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import Timers from '../objects/timers'
import { Hex } from '../utils/hex'
import GuardPosition from '../ai/guardposition'
import { type Vector } from '../utils/vector'

export class Throwicicle extends Skill {
  static Damage = [35, 30, 55, 65]
  /** The impact cell and its 6 neighbours. */
  static BLAST_RINGS = 1

  constructor (owner: Unit) {
    super(owner, 4000)
  }

  execute (aimCell?: Vector): boolean {
    if (!super.execute()) return false

    // 1200 ms at 300 u/s is 360 units, 8 cells: out to base vision.
    const lifetime = 1200
    // Through the centre of the aimed cell and on to its lifetime (decision #21).
    const aim = Skill.aimDirection(this.owner, aimCell)
    const pos = this.owner.position.add(
      aim.multiply(this.owner.radius * 4)
    )
    const icicle = new Throwable(
      pos.x,
      pos.y,
      lifetime,
      aim,
      300,
      this.owner.tag,
      this.owner,
      this.explode.bind(this)
    )
    World.PROJECTILES.push(icicle)
    // Owned by the projectile, not the skill: a hit destroys it, which cancels
    // this, so any number can be in flight whatever the cooldown.
    Timers.schedule(lifetime, () => { icicle.destroy() }, icicle)

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
    // No removal here; see ThrowFireball.explode.
  }
}
