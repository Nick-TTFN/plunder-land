import { Skill } from './skill'
import Obstacle from '../objects/obstacle'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

export class StoneWall extends Skill {
  /** Fixed, not random, so the wall's duration is legible. */
  static LIFETIME = 4000

  constructor (owner: Unit) {
    super(owner, 6000)
  }

  execute (): boolean {
    if (!super.execute()) return false

    for (let i = 0; i < 4; i++) {
      // Negative on purpose: the arc goes BEHIND the caster, to block anyone
      // chasing them (Nick, 2026-09-24). Do not "fix" it to the front.
      const offset = this.owner.facing
        .multiply(-70)
        .rotateBy(-Math.PI / 2 + (i * Math.PI) / 3)
      const pos_x = this.owner.position.x + offset.x
      const pos_y = this.owner.position.y + offset.y

      // Skip a cell that is already solid. Two stones on one cell would each
      // block it and the first to expire would release it, leaving the second
      // as a rock you can walk through. The 70-unit offsets are two cells apart
      // so the four never collide with each other - this is about landing on
      // terrain that was already there.
      const cell = Hex.toCell(new Vector(pos_x, pos_y))
      if (World.isBlocked(cell.x, cell.y, this.owner.tag)) continue

      const lifetime = StoneWall.LIFETIME
      const stone = new Obstacle(pos_x, pos_y, this.owner.tag, lifetime)
      World.OBSTACLES.push(stone)
      setTimeout(
        (v) => {
          v.destroy()
          World.OBSTACLES.splice(World.OBSTACLES.indexOf(v), 1)
        },
        lifetime,
        stone
      )
    }
    return true
  }
}
