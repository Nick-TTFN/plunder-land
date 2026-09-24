import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import { Skill } from './skill'

export class Defend extends Skill {
  constructor (owner) {
    super(owner, 8000)
  }

  execute () {
    if (!super.execute()) return false

    // set damage reduction to
    this.owner.damageReduction = World.config.defend

    // Must stay under the 8000 ms cooldown until `move-timers-into-tick`: a
    // re-cast inside the lifetime would be ended early by the first timeout.
    const lifetime = 3000
    Multiplayer.Instance.effect(4, this.owner, lifetime)

    setTimeout(() => {
      this.owner.damageReduction = 0
    }, lifetime)

    return true
  }
}
