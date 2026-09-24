import { Skill } from './skill'
import SectorArea from '../area/sectorarea'
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import { type Vector } from '../utils/vector'

export class IceBreath extends Skill {
  /** 3 cells (the balance pass's 135 u = 3 * Hex.SIZE). */
  static RINGS = 3

  // Per second, applied as `damage * dt` and floored per tick by `hit()`, so
  // keep it a multiple of 4 at 250 ms ticks: 32/s is 8 a tick, 32 a cast.
  // Only [1] is read while `setLevel(1)` is the only level.
  static Damage = [25, 32, 45, 55]

  constructor (owner) {
    super(owner, 3000)
  }

  execute (aimCell?: Vector) {
    if (!super.execute()) return false

    // Aimed: snapped to one of six once, and held for the breath (decision #21).
    const aimed = SectorArea.aimIndex(this.owner, aimCell)
    const area = new SectorArea(this.owner, IceBreath.RINGS, aimed)
    area.setEffect(IceBreath.Damage[this.owner.level], true)
    World.AREA_EFFECT.push(area)
    const lifetime = 1000
    Multiplayer.Instance.effect(1, this.owner, lifetime, aimed !== undefined ? area.tipCell() : undefined)

    // FireBreath has always had this; IceBreath never did, so every cast left a
    // permanent damage field tracking its caster.
    // No owner: the area must go even if its caster dies first.
    Timers.schedule(lifetime, () => {
      const idx = World.AREA_EFFECT.indexOf(area)
      if (idx >= 0) World.AREA_EFFECT.splice(idx, 1)
    })

    return true
  }
}
