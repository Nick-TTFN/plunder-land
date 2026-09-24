import Multiplayer from '../network/multiplayer'
import { type Vector } from '../utils/vector'
import { GameObject, ObjectType } from './gameobject'
import { type Unit } from './unit'
import World from './world'

/**
 * A projectile. It finds its own targets; nothing collides with it.
 *
 * It still lives in `World.OBSTACLES`, because the world's tick only updates
 * throwables by walking that list, but it is **not** solid: `Unit.update`'s
 * push-out skips it. Being solid is what made every fireball and icicle explode
 * on its caster. It spawned `radius * 4` (about 57 units) ahead of a caster
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

  /** The first live unit on this plane that the projectile overlaps, owner excluded. */
  findHit (): Unit | undefined {
    const x = this.position.x
    const y = this.position.y

    for (const source of World.UNIT_SOURCES) {
      for (const unit of source) {
        if (unit === this.owner) continue
        if (unit.destroyed) continue
        if (unit.tag !== this.tag) continue

        const sumWidth = unit.radius + this.radius
        const dx = unit.position.x - x
        const dy = unit.position.y - y
        if (dx * dx + dy * dy < sumWidth * sumWidth) return unit
      }
    }

    return undefined
  }

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
