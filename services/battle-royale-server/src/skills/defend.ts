import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers, { type Timer } from '../objects/timers'
import { Skill } from './skill'

export class Defend extends Skill {
  /** The pending end of the current cast, so a re-cast can replace it. */
  private _end: Timer | undefined

  constructor (owner) {
    super(owner, 8000)
  }

  execute () {
    if (!super.execute()) return false

    // set damage reduction to
    this.owner.damageReduction = World.config.defend

    const lifetime = 3000
    Multiplayer.Instance.effect(4, this.owner, lifetime)

    // A re-cast inside the lifetime restarts it rather than being ended early by
    // the first cast's timer, so the cooldown no longer has to exceed the
    // lifetime. Owned by the caster: it dies or exits, it is cancelled.
    Timers.cancel(this._end)
    this._end = Timers.schedule(lifetime, () => {
      this.owner.damageReduction = 0
    }, this.owner)

    return true
  }
}
