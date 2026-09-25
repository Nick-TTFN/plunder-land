import Multiplayer from '../network/multiplayer'
import { GameObject, ObjectType } from './gameobject'
import Player from './player'

/**
 * A way to the layer `to`. Solid, like every gate: it sits in
 * `World.OBSTACLES`, so `Unit.update` pushes every unit out of it before
 * calling `onCollide`.
 */
export default class Portal extends GameObject {
  constructor (x: number, y: number, to: number | undefined, tag: number) {
    super(ObjectType.Portal, x, y, 50, tag, undefined, to)
    Multiplayer.Instance.create(this)
  }

  /**
   * **Players only** (decision #26). A mob or boss is pushed out and stays on
   * its layer, like a rock, so each layer keeps the danger designed for it and
   * nothing can be dragged up to layer 01.
   */
  onCollide (target: GameObject): void {
    super.onCollide(target)
    if (target instanceof Player) target.tag = this.to
  }
}
