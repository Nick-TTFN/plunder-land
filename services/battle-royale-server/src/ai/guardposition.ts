import { Vector } from '../utils/vector'
import { ObjectType } from '../objects/gameobject'
import { Random } from '../utils/random'
import { Hex } from '../utils/hex'
import { type IAIRoutine } from './findnearestconsumable'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { type GuardSpec } from '../archetypes/archetypes'

/**
 * A mob's watch over its spot: notice a player, chase it, drop it, wander.
 *
 * **Every range is in rings** (hex-cells P1, decisions #31 and #32): `h` is
 * `Hex.distance` between the mob's cell and the player's, and each test
 * includes its boundary. Noticed at `h <= acquire`, kept while
 * `h <= loseRings`, held off at `h <= standoff` (0 = never), and an idle mob
 * walks to the centre of a random free cell within `wander` rings of home.
 * Contact damage is not here: it stays on the bodies' overlap in P1 (#32).
 */
export default class GuardPosition implements IAIRoutine {
  /** This unit's parameters, from its archetype (acquire, lose, speeds, wander, refresh). */
  spec: GuardSpec
  homePosition: Vector
  targetAquiredAt: number
  owner: Unit
  /** The wander goal: a cell centre, or undefined between goals. */
  moveTarget: Vector | undefined
  /**
   * How many rings away the current target may get and still be kept.
   * `spec.lose` for a target found by looking around; further for one that
   * provoked the unit from beyond it (see `provoke`).
   */
  loseRings: number

  /**
   * Rings past the distance of a provoking hit that the chase lasts, when that
   * is beyond `spec.lose` (decision #32: `max(lose, hitRings + 1)`). It was
   * `lose - acquire` in units (#19), which is one ring at today's values.
   */
  static PROVOKE_MARGIN_RINGS = 1

  constructor (owner: Unit, spec: GuardSpec) {
    this.spec = spec
    this.loseRings = spec.lose
    this.homePosition = owner.position
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

    // Chase from wherever the hit came, a ring further than that, and never
    // less than the usual lose range. A player who backs off past it loses it.
    const rings = Hex.distance(this.owner.cell, attacker.cell)
    this.loseRings = Math.max(this.spec.lose, rings + GuardPosition.PROVOKE_MARGIN_RINGS)

    if (this.owner.target === attacker) return
    this.owner.target = attacker
    // Assigned, like the acquisition below, and only on a change of target, so
    // repeated hits from the unit it is already chasing - every ranged shot,
    // every tick of a breath - do not cancel a Slowdown each time. Assigning
    // over one does cancel it, which is why the icicle provokes before it slows.
    // Known wrinkle: Slowdown.stop() adds back what it took, so if this (or the
    // 2 s refresh below) reassigned speed mid-slow, the unit runs fast until the
    // next refresh reassigns it again - at most one refresh period, mobs only.
    this.owner.maxVelocity = this.spec.chaseSpeed
  }

  private release (): void {
    this.owner.target = undefined
    this.loseRings = this.spec.lose
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
			this.targetAquiredAt < now - this.spec.refreshMs
    ) {
      // The nearest live player within `acquire` rings, ties to the lowest id
      // (hex-cells P1). It took the last match of a radius scan, and a dead or
      // extracted one as readily as a live one, which the release above then
      // dropped a tick later with the rescan blocked for `refreshMs`.
      this.owner.target = World.NEAREST_IN_CELLS(
        this.owner.cell,
        this.spec.acquire,
        this.owner.tag,
        ObjectType.Player,
        (unit) => !unit.destroyed && (unit as any).exited !== true
      )

      this.loseRings = this.spec.lose
      this.owner.maxVelocity = (this.owner.target != null) ? this.spec.chaseSpeed : this.spec.idleSpeed

      this.targetAquiredAt = now
    }

    if ((this.owner.target != null) && !this.owner.target.destroyed) {
      const target = this.owner.target
      const rings = Hex.distance(this.owner.cell, Hex.toCell(target.position))
      if (rings <= this.loseRings) {
        if (this.spec.standoff > 0 && rings <= this.spec.standoff) {
          // Close enough: hold here rather than close in (standoff 0 never
          // gets here). Zeroing `direction` keeps `facing`, and the unit's
          // skills aim at the target's cell, not along facing.
          this.owner.direction = new Vector(0, 0)
        } else {
          this.owner.setDirectionTo(target.position.x, target.position.y)
        }
      } else this.release()
    } else {
      if (this.moveTarget != null) {
        if (this.moveTarget.sub(this.owner.position).getSquareMagnitude() < 100) { this.moveTarget = undefined }
      } else {
        this.moveTarget = this.wanderGoal()
      }

      if (this.moveTarget != null) { this.owner.setDirectionTo(this.moveTarget.x, this.moveTarget.y) }
    }
  }

  /**
   * The centre of a random free cell within `spec.wander` rings of home
   * (decision #32: 1 ring, 7 cells). Free is on the map, not blocked, and not
   * a portal's or exit's cell (both are solid to mobs, so a goal there could
   * never be reached). Home's own cell if none is. The cells are taken in
   * `World.forKeysWithin` order, which puts home in the middle of the 1-ring
   * patch: a `Math.random` of 0.5 picks home when all seven are free.
   *
   * It was home plus a random offset of up to 30 units on each axis, which
   * landed in the home cell about half the time and in ring 1 otherwise.
   */
  wanderGoal (): Vector {
    const home = Hex.toCell(this.homePosition)
    const tag = this.owner.tag
    const free: Vector[] = []
    const rings = this.spec.wander
    for (let dq = -rings; dq <= rings; dq++) {
      const lo = Math.max(-rings, -dq - rings)
      const hi = Math.min(rings, -dq + rings)
      for (let dr = lo; dr <= hi; dr++) {
        const q = home.x + dq
        const r = home.y + dr
        if (World.isBlocked(q, r, tag) || World.GATES_ON(q, r, tag).length > 0) continue
        free.push(new Vector(q, r))
      }
    }
    return Hex.toPosition(free.length > 0 ? free[Random.RangeInt(0, free.length)] : home)
  }
}
