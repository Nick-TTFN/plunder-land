import Multiplayer from '../network/multiplayer'
import { GameObject, ObjectType } from './gameobject'

/**
 * A way to the layer `to`. A player whose tick ends on its cell is moved to
 * its arrival cell on that layer (`Player.hopPortal`, `World.arrivalOf`:
 * the east neighbour, decisions #31 Q3 and #33), and routes end on it
 * (`Unit.endAtPortal`). **Players only** (decision #26): a mob never steps
 * onto a portal's cell (`World.mobCanEnter`) and stays on its layer, so each
 * layer keeps the danger designed for it and nothing can be dragged up to
 * layer 01.
 *
 * It sits in `World.OBSTACLES` with the rocks and exits, and in `World.GATES`
 * by cell. Nothing is pushed out of it any more (hex-cells P2 deleted
 * push-out); it used to be a solid disc that held players 64 units off its
 * centre and moved them on contact.
 */
export default class Portal extends GameObject {
  /** How big it is drawn. It was also its collider until hex-cells P2. */
  static RADIUS = 50

  constructor (x: number, y: number, to: number | undefined, tag: number) {
    super(ObjectType.Portal, x, y, Portal.RADIUS, tag, undefined, to)
    Multiplayer.Instance.create(this)
  }
}
