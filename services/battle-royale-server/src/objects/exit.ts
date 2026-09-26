import Multiplayer from '../network/multiplayer'
import { GameObject, ObjectType } from './gameobject'

/**
 * An extraction pad. It sits in `World.OBSTACLES` with the rocks and portals,
 * but it is a zone, not a wall: a player walks onto it and extracts by
 * staying there for the layer's `extractMs` (`Player.channelExtract`). It
 * used to push players out like a rock and extract them on contact.
 *
 * A mob never steps onto its cell (`World.mobCanEnter`), as with a portal
 * (decision #26). Until hex-cells P2 that was a push-out (`solidFor`).
 */
export default class Exit extends GameObject {
  constructor (x: number, y: number, tag: number) {
    super(ObjectType.Exit, x, y, 50, tag)
    Multiplayer.Instance.create(this)
  }
}
