import { Skill } from './skill'
import Multiplayer from '../network/multiplayer'
import Throwable from '../objects/throwable'
import { type GameObject, ObjectType } from '../objects/gameobject'
import Slowdown from '../buffs/slowdown'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { RangedAttack } from './rangedattack'
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

    // A 10-cell hex line through the aimed cell, or along the hex facing
    // (hex-cells P3, #34); `Throwable` steps along it and bursts at its end.
    // The 1200 ms lifetime ends nothing now; it is only sent, as before.
    const icicle = new Throwable(
      RangedAttack.lineOf(this.owner, aimCell, Throwable.RANGE_CELLS),
      1200,
      this.owner.tag,
      this.owner,
      this.explode.bind(this),
      Throwable.ICICLE
    )
    World.PROJECTILES.push(icicle)

    return true
  }

  /** See ThrowFireball.explode: centred on the cell of the unit it struck. */
  explode (target: GameObject, struck?: Unit) {
    const origin = Hex.toCell((struck ?? target).position)
    // The blast's own cell, so the client draws the ring the server damages.
    // The client cannot work it out: the destroy record carries no position,
    // and its last one is a tick behind the hit.
    Multiplayer.Instance.effectAt(6, this.owner.id, 500, origin, target.tag)
    for (const collidee of World.FIND_IN_CELLS(
      origin,
      Throwicicle.BLAST_RINGS,
      target.tag,
      ObjectType.Player | ObjectType.Mob
    )) {
      if (collidee !== this.owner) {
        let damage = this.byLevel(Throwicicle.Damage)
        if (collidee.buffs.length > 0) damage += 10

        // Provoke before slowing: provoking raises a mob to chase speed, and the
        // slow has to halve that, not the idle speed it was walking at.
        GuardPosition.provoke(collidee, this.owner)
        collidee.addBuff(new Slowdown(collidee, 2000))
        if (collidee.hit(this.dealt(damage))) this.owner.onKill(collidee)
      }
    }
    // No removal here; see ThrowFireball.explode.
  }
}
