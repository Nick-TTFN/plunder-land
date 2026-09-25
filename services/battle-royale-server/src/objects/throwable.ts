import Multiplayer from '../network/multiplayer'
import { type Vector } from '../utils/vector'
import { GameObject, ObjectType } from './gameobject'
import { type Unit } from './unit'
import World from './world'
import { Hex } from '../utils/hex'

/**
 * A projectile. It finds its own targets; nothing collides with it.
 *
 * It lives in `World.PROJECTILES`, which the tick flies and sweeps
 * (`World.updateProjectiles`), and **not** in `World.OBSTACLES`: it is not
 * solid, so `Unit.update`'s push-out never sees it. Being solid is what made
 * every fireball and icicle explode on its caster. It spawned `radius * 4` (about 57 units) ahead of a caster
 * whose push-out reach is 50 + 14, so the caster's own next tick touched it and
 * `onCollide` destroyed it. A stopped caster used to have direction (0,0) and
 * spawn it on their own centre; skills now aim with `Unit.facing`, the last
 * way the caster moved (East if never), so a standing cast flies too.
 *
 * So the test runs the other way round: after moving, the projectile looks for
 * a unit on its plane that it overlaps, never its owner, and detonates on it.
 */
export default class Throwable extends GameObject {
  velocity: number
  owner: Unit
  /** The unit it flew into, set just before it is destroyed by the hit. */
  struck: Unit | undefined
  destroyCallback: (value: GameObject, struck?: Unit) => void
  constructor (
    x: number,
    y: number,
    lifetime: number,
    direction: Vector,
    velocity: number,
    tag: number,
    owner: Unit,
    destroyCallback: (value: GameObject, struck?: Unit) => void
  ) {
    super(ObjectType.Throwable, x, y, 50, tag)

    this.lifetime = lifetime
    this.direction = direction
    this.velocity = velocity
    this.owner = owner
    this.destroyCallback = destroyCallback

    Multiplayer.Instance.create(this)
  }

  update (dt: number) {
    this.position = this.position.add(
      this.direction.multiply(dt * this.velocity)
    )

    const hit = this.findHit()
    if (hit !== undefined) {
      this.onCollide(hit)
      return
    }

    super.update(dt)
  }

  /**
   * A live unit on this plane that the projectile overlaps, owner excluded:
   * the nearest, ties to the lowest id. Still a disc test (P3 moves it onto
   * cells); only the candidates come from `World.UNITS`, the cells within
   * `Throwable.hitRings` of the projectile's. It used to test every unit in
   * the world and take the first in list order, players before mobs.
   */
  findHit (): Unit | undefined {
    const x = this.position.x
    const y = this.position.y
    let hit: Unit | undefined
    let hitSq = Infinity

    World.forKeysWithin(Hex.toCell(this.position), Throwable.hitRings(this.radius), (key) => {
      for (const unit of World.UNITS.at(this.tag, key)) {
        if (unit === this.owner) continue
        if (unit.destroyed) continue

        const sumWidth = unit.radius + this.radius
        const dx = unit.position.x - x
        const dy = unit.position.y - y
        const sq = dx * dx + dy * dy
        if (sq >= sumWidth * sumWidth) continue
        if (sq < hitSq || (sq === hitSq && hit !== undefined && unit.id < hit.id)) {
          hit = unit
          hitSq = sq
        }
      }
    })

    return hit
  }

  /**
   * How many rings around the projectile's cell can hold a unit it overlaps.
   * A unit it touches has its centre within `radius` + the unit's body of the
   * projectile, and each centre is at most a cell's circumradius (`Hex.SIZE`
   * / sqrt 3, about 26) from its own cell's centre, so the two cell centres
   * are within that sum plus two circumradii. Rings out to the last whose
   * nearest centre (`World.ringDistance`) is still inside it: 3 for a
   * 50-unit projectile and a 40-unit boss (142 against 117 and 156).
   *
   * The body is `World.UNIT_BODY_MAX`, the largest in the archetype table and
   * among the units the index has seen, so a bigger unit widens it.
   */
  static hitRings (radius: number): number {
    const reach = radius + World.UNIT_BODY_MAX + 2 * Hex.SIZE / Math.sqrt(3)
    const cached = Throwable._hitRings.get(reach)
    if (cached !== undefined) return cached
    let rings = 0
    while (World.ringDistance(rings + 1) < reach) rings++
    Throwable._hitRings.set(reach, rings)
    return rings
  }

  private static readonly _hitRings = new Map<number, number>()

  onCollide (target: Unit) {
    super.onCollide(target)
    this.struck = target
    this.destroy()
  }

  /** Also the end of its lifetime (the skill's timer), when `struck` is unset. */
  destroy () {
    if (this.destroyCallback) this.destroyCallback(this, this.struck)
    super.destroy()
  }
}
