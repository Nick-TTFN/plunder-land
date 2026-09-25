import Multiplayer from '../network/multiplayer'
import { GameObject, ObjectType } from './gameobject'
import Player from './player'

/**
 * An extraction pad. It sits in `World.OBSTACLES` with the rocks and portals,
 * but it is a zone to a player, not a wall: a player walks onto it and
 * extracts by staying there for the layer's `extractMs`
 * (`Player.channelExtract`). It used to push players out like a rock and
 * extract them on contact.
 *
 * To everything else it is solid, as a portal is (decision #26): a mob is
 * pushed off it and never stands on it.
 */
export default class Exit extends GameObject {
  constructor (x: number, y: number, tag: number) {
    super(ObjectType.Exit, x, y, 50, tag)
    Multiplayer.Instance.create(this)
  }

  /**
   * Players only walk through. The client mirrors this by leaving exits out of
   * the local player's colliders (`LocalPlayer.SOLID_TYPES`).
   */
  solidFor (unit: GameObject): boolean {
    return !(unit instanceof Player)
  }
}
