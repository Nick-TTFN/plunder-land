import { Skill } from './skill'

/**
 * Speed up for 3 hexes (decision #34): the next 3 cells of the route at 2.5x
 * speed, or, standing, a 3-cell route along the facing (`Unit.dash`). Until
 * hex-cells P2 it was a velocity boost of 1.5 that decayed over half a second,
 * which the client could not predict and which could never last less than a
 * tick.
 *
 * Predicted on the client (`LocalPlayer.dash`, run by the client's Dash on
 * the press). The aim is ignored.
 */
export class Dash extends Skill {
  constructor (owner) {
    super(owner, 2000)
  }

  /**
   * Refused, with the cooldown not spent, while it is cooling down or when a
   * standing dash has no free cell ahead (#34, as a refused item use spends
   * nothing).
   */
  execute () {
    if (this.executeTime > Date.now() - this.cooldown) return false
    if (!this.owner.dash()) return false
    return super.execute()
  }
}
