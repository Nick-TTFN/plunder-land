import { Skill } from './skill'
import Obstacle from '../objects/obstacle'
import { Random } from '../utils/random'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

export class StoneWall extends Skill {
  constructor (owner: Unit) {
    super(owner, 1000)
  }

  execute (): boolean {
    if (!super.execute()) return false

    for (let i = 0; i < 4; i++) {
      const offset = this.owner.direction
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

      const lifetime = Random.RangeInt(2000, 2500)
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
