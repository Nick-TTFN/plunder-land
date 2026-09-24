import { Skill } from './skill'
import SectorArea from '../area/sectorarea'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import Multiplayer from '../network/multiplayer'

export class FireBreath extends Skill {
  /**
   * 4 cells. It was a 200-unit radius, 4.4 cells; rounded down, so the ring-5
   * cells whose centres sat at 196 u are no longer reached.
   */
  static RINGS = 4

  constructor (owner: Unit) {
    super(owner, 3000)
  }

  execute () {
    if (!super.execute()) return false

    const area = new SectorArea(this.owner, FireBreath.RINGS)
    area.setEffect(World.config.fire, true)
    World.AREA_EFFECT.push(area)
    const lifetime = 1000
    Multiplayer.Instance.effect(0, this.owner, lifetime)

    setTimeout(
      (a) => {
        const idx = World.AREA_EFFECT.indexOf(area)
        if (idx >= 0) World.AREA_EFFECT.splice(idx, 1)
      },
      lifetime,
      area
    )

    return true
  }
}
