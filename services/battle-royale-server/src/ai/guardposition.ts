import { Vector } from '../utils/vector'
import { GameObject, ObjectType } from '../objects/gameobject'
import { Random } from '../utils/random'
import { type IAIRoutine } from './findnearestconsumable'
import { type Unit } from '../objects/unit'
import World from '../objects/world'

export default class GuardPosition implements IAIRoutine {
  static TARGET_AQUIRE_DISTANCE = 200
  static TARGET_LOSE_DISTANCE = 250
  static IDLE_SPEED = 30
  static CHASE_SPEED = 100
  homePosition: Vector
  targetAquiredAt: number
  target_REFRESH_RATE: number
  owner: Unit
  moveTarget: Vector | undefined
  /**
   * How far the current target may get before it is dropped. TARGET_LOSE_DISTANCE
   * for a target found by looking around; further for one that provoked the unit
   * from beyond it (see `provoke`).
   */
  loseDistance: number = GuardPosition.TARGET_LOSE_DISTANCE

  constructor (owner: Unit) {
    this.homePosition = owner.position
    this.target_REFRESH_RATE = 2000
    this.targetAquiredAt = 0
    this.owner = owner
    this.owner.target = undefined
  }

  /**
   * Tell `unit` it was hit by `attacker`. It turns on the attacker if it guards
   * a position and the attacker is a player (N1, decision #16). Without this a
   * mob only noticed players within 200 units, so anything out-ranging that -
   * ranged fire, a thrown fireball - killed bosses that never fought back.
   * Mobs hurting each other (a boss's breath catching a grunt) start nothing.
   */
  static provoke (unit: Unit, attacker: Unit): void {
    for (const routine of unit.routines) {
      if (routine instanceof GuardPosition) routine.provoke(attacker)
    }
  }

  provoke (attacker: Unit): void {
    if (this.owner.destroyed) return
    if (attacker === this.owner) return
    if (attacker.type !== ObjectType.Player) return
    if (attacker.destroyed || (attacker as any).exited === true) return
    if (attacker.tag !== this.owner.tag) return

    // Chase from wherever the hit came, with the same margin the unit normally
    // gets between noticing a target and giving up on it. No new tunable: a
    // player who backs off past that margin loses it, as they would anyway.
    const distance = attacker.position.sub(this.owner.position).getMagnitude()
    this.loseDistance = Math.max(
      GuardPosition.TARGET_LOSE_DISTANCE,
      distance + GuardPosition.TARGET_LOSE_DISTANCE - GuardPosition.TARGET_AQUIRE_DISTANCE
    )

    if (this.owner.target === attacker) return
    this.owner.target = attacker
    // Assigned, like the acquisition below, and only on a change of target, so
    // repeated hits from the unit it is already chasing - every ranged shot,
    // every tick of a breath - do not cancel a Slowdown each time. Assigning
    // over one does cancel it, which is why the icicle provokes before it slows.
    // Known wrinkle: Slowdown.stop() adds back what it took, so if this (or the
    // 2 s refresh below) reassigned speed mid-slow, the unit runs fast until the
    // next refresh reassigns it again - at most one refresh period, mobs only.
    this.owner.maxVelocity = GuardPosition.CHASE_SPEED
  }

  private release (): void {
    this.owner.target = undefined
    this.loseDistance = GuardPosition.TARGET_LOSE_DISTANCE
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
      this.release()
    }

    // A breath cone hurts in `Unit.update` through the area, which does not know
    // it is dealing damage on anyone's behalf, so a cone overlapping this unit
    // counts as a hit from its caster here. Same test as the damage: same plane,
    // not the caster, overlapping. `provoke` ignores casters that are not players.
    for (const area of World.AREA_EFFECT) {
      if (area.tag !== this.owner.tag) continue
      if (area.target === this.owner) continue
      if (area.overlaps(this.owner.position)) this.provoke(area.target as Unit)
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

      this.loseDistance = GuardPosition.TARGET_LOSE_DISTANCE
      this.owner.maxVelocity = (this.owner.target != null) ? GuardPosition.CHASE_SPEED : GuardPosition.IDLE_SPEED

      this.targetAquiredAt = now
    }

    if ((this.owner.target != null) && !this.owner.target.destroyed) {
      if (
        this.owner.target.position
          .sub(this.owner.position)
          .getSquareMagnitude() <
				this.loseDistance * this.loseDistance
      ) {
        this.owner.setDirectionTo(
          this.owner.target.position.x,
          this.owner.target.position.y
        )
      } else this.release()
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
