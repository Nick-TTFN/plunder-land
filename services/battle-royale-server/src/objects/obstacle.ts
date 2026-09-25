import { GameObject, ObjectType } from './gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import Multiplayer from '../network/multiplayer'
import World from './world'

/**
 * A blocked cell.
 *
 * Position and radius stopped being free parameters when the grid arrived: an
 * obstacle is snapped to a cell centre and always carries the cell's own
 * inradius. Anything else leaves the push-out and the grid disagreeing about
 * where the world is solid, and a path routed around a rock the collision code
 * puts somewhere slightly different is a rubber-band with no log line.
 *
 * This is why the old `Random.RangeInt(10, 45)` radius is gone. Visual variety
 * has to come from the sprite, not the collider.
 */
export default class Obstacle extends GameObject {
  /** The cell this obstacle blocks, held so destroy can release exactly it. */
  readonly cell: Vector

  constructor (x: number, y: number, tag: number, lifetime: number | undefined = undefined) {
    const cell = Hex.toCell(new Vector(x, y))
    const centre = Hex.toPosition(cell)

    super(ObjectType.Obstacle, centre.x, centre.y, Hex.RADIUS, tag, lifetime)

    this.cell = cell
    World.block(cell.x, cell.y, tag, this)

    Multiplayer.Instance.create(this)
  }

  destroy (): void {
    // Released here rather than by whoever splices OBSTACLES, because the timed
    // ones (StoneWall) and the world's own culling take different routes out and
    // only this one is common to both. A cell left blocked after its obstacle is
    // gone is an invisible wall.
    World.unblock(this.cell.x, this.cell.y, this.tag)
    super.destroy()
  }
}
