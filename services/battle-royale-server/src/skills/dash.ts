import { Skill } from './skill'

/**
 * Speed up for 3 hexes (decision #34): the next 3 cells of the route at 2.5x
 * speed, or, standing, a 3-cell route along the facing (`Unit.dash`). It used
 * to be an impulse of 1.5 decaying at `IMPULSE_FRICTION`, which the client
 * could not predict and which could never last less than a tick.
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
