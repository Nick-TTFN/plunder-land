import { Vector } from '../utils/vector'
import { GameObject, ObjectType } from '../objects/gameobject'
import { Random } from '../utils/random'
import { type IAIRoutine } from './findnearestconsumable'
import { type Unit } from '../objects/unit'
import World from '../objects/world'

export default class GuardPosition implements IAIRoutine {
  static TARGET_AQUIRE_DISTANCE = 200
  static TARGET_LOSE_DISTANCE = 250
  homePosition: Vector
  targetAquiredAt: number
  target_REFRESH_RATE: number
  owner: Unit
  moveTarget: Vector | undefined

  constructor (owner: Unit) {
    this.homePosition = owner.position
    this.target_REFRESH_RATE = 2000
    this.targetAquiredAt = 0
    this.owner = owner
    this.owner.target = undefined
  }

  update (dt: number) {
    const now = new Date().getTime()

    // Release a target that is no longer in the world. Without this the unit is
    // permanently blinded: acquisition only runs while `target` is null, and a
    // dead or extracted player leaves it non-null forever. The unit then wanders
    // (the chase branch requires a live target) while UseSkillOnTarget, which
    // only tests for null, keeps firing at the corpse.
    const target = this.owner.target
    if (target != null && (target.destroyed || (target as any).exited === true)) {
      this.owner.target = undefined
    }

    if (
      this.owner.target == null &&
			this.targetAquiredAt < now - this.target_REFRESH_RATE
    ) {
      for (const target of World.FIND_AROUND(
        this.owner.position.x,
        this.owner.position.y,
        this.owner.tag,
        GuardPosition.TARGET_AQUIRE_DISTANCE,
        ObjectType.Player
      )) { this.owner.target = target }

      this.owner.maxVelocity = (this.owner.target != null) ? 100 : 30

      this.targetAquiredAt = now
    }

    if ((this.owner.target != null) && !this.owner.target.destroyed) {
      if (
        this.owner.target.position
          .sub(this.owner.position)
          .getSquareMagnitude() <
				GuardPosition.TARGET_LOSE_DISTANCE * GuardPosition.TARGET_LOSE_DISTANCE
      ) {
        this.owner.setDirectionTo(
          this.owner.target.position.x,
          this.owner.target.position.y
        )
      } else this.owner.target = undefined
    } else {
      if (this.moveTarget != null) {
        if (this.moveTarget.sub(this.owner.position).getSquareMagnitude() < 100) { this.moveTarget = undefined }
      } else {
        this.moveTarget = new Vector(
          this.homePosition.x + Random.RangeInt(-30, 30),
          this.homePosition.y + Random.RangeInt(-30, 30)
        )
      }

      if (this.moveTarget != null) { this.owner.setDirectionTo(this.moveTarget.x, this.moveTarget.y) }
    }
  }
}
