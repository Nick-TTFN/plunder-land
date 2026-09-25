import Multiplayer from '../network/multiplayer'
import { GameObject, ObjectType } from './gameobject'
import Player from './player'

/**
 * A way to the layer `to`. Solid to every unit (unlike an exit, which players
 * stand on to extract): it sits in `World.OBSTACLES`, so `Unit.update` pushes
 * every unit out of it before calling `onCollide`.
 */
export default class Portal extends GameObject {
  /**
   * Collider radius. A player is pushed out to this plus their body, and
   * that is where they arrive on the other layer, so `World.GATE_SPACING` is
   * derived from it.
   */
  static RADIUS = 50

  constructor (x: number, y: number, to: number | undefined, tag: number) {
    super(ObjectType.Portal, x, y, Portal.RADIUS, tag, undefined, to)
    Multiplayer.Instance.create(this)
  }

  /**
   * **Players only** (decision #26). A mob or boss is pushed out and stays on
   * its layer, like a rock, so each layer keeps the danger designed for it and
   * nothing can be dragged up to layer 01.
   *
   * The hop ends the player's route (`Unit.changeLayer`): they stop where the
   * portal pushed them out, now on the other layer.
   */
  onCollide (target: GameObject): void {
    super.onCollide(target)
    if (target instanceof Player) target.changeLayer(this.to)
  }
}
