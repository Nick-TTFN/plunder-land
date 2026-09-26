import { Skill } from './skill'
import Obstacle from '../objects/obstacle'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import Timers from '../objects/timers'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

export class StoneWall extends Skill {
  /** Fixed, not random, so the wall's duration is legible. */
  static LIFETIME = 4000

  constructor (owner: Unit) {
    super(owner, 6000)
  }

  /**
   * The cells the wall goes on: the caster cell's three neighbours directly
   * behind it, at directions b-1, b and b+1 where b is the opposite of the
   * facing (decision #22). That is the first ring of a cone pointing backwards.
   *
   * **Behind on purpose**, to block anyone chasing the caster (decision #17,
   * Nick). Do not "fix" it to the front.
   */
  static cells (owner: Unit): Vector[] {
    const back = (World.FACING_INDEX(owner.facing) + 3) % 6
    const origin = owner.cell
    return [(back + 5) % 6, back, (back + 1) % 6].map((d) => Hex.neighbour(origin, d))
  }

  /**
   * True if a stone may go on this cell. Each refusal skips that one cell; the
   * rest of the wall is still placed.
   *
   * - **Off the map, a rock, or another stone** (`World.isBlocked`). The stacking
   *   case matters beyond tidiness: `World.BLOCKED` holds one blocker per
   *   cell, not a count, so the first of two blockers on a cell to go would
   *   release it and leave the other as an obstacle you can walk through.
   *   Skipping is what lets a stone's expiry unblock its cell unconditionally.
   * - **A portal or an exit** (`World.GATES_ON`). Neither is in `BLOCKED` (you
   *   have to walk into them), so `isBlocked` misses them. A stone on one would
   *   make it unroutable for the wall's lifetime.
   * - **A portal's arrival cell** (`World.isArrival`, hex-cells P2): a player
   *   coming through would be put down inside the stone.
   * - **A unit standing on it** (`World.UNITS_ON`, live units only) - the
   *   occupied-cell rule in the hex design record: a wall never seals anyone
   *   inside terrain. Nothing pushes units out of a stone any more.
   * - **A mob stepping into or out of it** (`World.mobHolds`): its step would
   *   end inside the stone, since a mob always finishes a step it started.
   */
  static canPlace (cell: Vector, tag: number): boolean {
    if (World.isBlocked(cell.x, cell.y, tag)) return false
    if (World.GATES_ON(cell.x, cell.y, tag).length > 0) return false
    if (World.isArrival(cell.x, cell.y, tag)) return false
    if (World.mobHolds(cell.x, cell.y, tag)) return false
    return !World.UNITS_ON(cell.x, cell.y, tag).some((unit) => !unit.destroyed)
  }

  execute (): boolean {
    if (!super.execute()) return false

    const tag = this.owner.tag
    for (const cell of StoneWall.cells(this.owner)) {
      if (!StoneWall.canPlace(cell, tag)) continue

      // The Obstacle blocks its cell on construction, and `World.block`
      // re-routes every unit whose path crosses it, so a chaser detours
      // without anything here asking it to.
      const centre = Hex.toPosition(cell)
      const lifetime = StoneWall.LIFETIME
      const stone = new Obstacle(centre.x, centre.y, tag, lifetime)
      World.addObstacle(stone)
      Timers.schedule(lifetime, () => {
        stone.destroy()
        // Only if still listed: a bomb may have taken it already.
        World.removeObstacle(stone)
      }, stone)
    }
    return true
  }
}
