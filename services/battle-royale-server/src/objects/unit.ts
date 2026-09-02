import { GameObject } from './gameobject'
import { Vector } from '../utils/vector'
import World from './world'
import type Buff from '../buffs/buff'
import { type IAIRoutine } from '../ai/findnearestconsumable'

// Below this squared distance two bodies count as coincident and the
// normalised push-out would divide by zero.
const EPSILON = 1e-9

/**
 * Impulse lost per second, applied to the magnitude.
 *
 * Dash duration is simply `impulse magnitude / IMPULSE_FRICTION`. Dash starts at
 * 1.5, so 3.0 gives a half-second burst. This is a feel value - change it freely.
 *
 * Two earlier versions were wrong in different ways. `dt / sqMagnitude` made the
 * decay rate inversely proportional to the square of the impulse, so a dash held
 * its speed and then fell off a cliff. Replacing it with `reduceBy(dt * F)` fixed
 * the curve but decayed each axis independently, so a dash along an axis lasted
 * √2 longer than a diagonal one - the same input felt different depending on
 * which way you were facing.
 */
const IMPULSE_FRICTION = 3.0

export class Unit extends GameObject {
  damageReduction: number = 0
  routines: IAIRoutine[] = []
  buffs: Buff[] = []
  canAttack: boolean = true
  target: GameObject | undefined
  armor: number = 0
  weapon: number = 0

  constructor (
    objType: number,
    x: number,
    y: number,
    radius: number,
    tag: number
  ) {
    // Named `lifetime` before, but GameObject's fourth parameter is radius, so
    // that is what every caller was actually setting.
    super(objType, x, y, radius, tag)
    this.maxHp = this.maxHP()
    this.direction = new Vector(0, 0)
    this.impulse = new Vector(0, 0)
  }

  getDirectionTo (targetX: number, targetY: number): Vector {
    return new Vector(
      targetX - this.position.x,
      targetY - this.position.y
    ).normalised()
  }

  getNextPos (dt): Vector {
    if (this.direction.getSquareMagnitude() === 0) return this.position

    const translate = this.direction
      .normalised()
      .add(this.impulse)
      .multiply(dt * this.maxVelocity)
    return this.position.add(translate)
  }

  setDirection (directionX: number, directionY: number): void {
    this.direction = new Vector(directionX, directionY).normalised()
  }

  setDirectionTo (targetX: number, targetY: number): void {
    this.direction = this.getDirectionTo(targetX, targetY)
  }

  addAIRoutine (value: IAIRoutine): void {
    this.routines.push(value)
  }

  update (dt: number): void {
    for (const routine of this.routines) {
      routine.update(dt)
    }

    for (let i = this.buffs.length - 1; i >= 0; i--) {
      if (this.buffs[i].update(dt)) this.buffs.splice(i, 1)
    }

    if (this.direction == null) return

    // Scalar throughout: this runs once per obstacle per unit per tick, and the
    // Vector form allocated a throwaway object for every one of those pairs.
    let px = this.position.x
    let py = this.position.y

    const dirSq = this.direction.x * this.direction.x + this.direction.y * this.direction.y
    if (dirSq > 0) {
      const inv = 1 / Math.sqrt(dirSq)
      const step = dt * this.maxVelocity
      px += (this.direction.x * inv + this.impulse.x) * step
      py += (this.direction.y * inv + this.impulse.y) * step
    }

    for (const obstacle of World.OBSTACLES) {
      if (obstacle.tag !== this.tag) continue

      const sumWidth = obstacle.radius + this.radius
      const dx = obstacle.position.x - px
      const dy = obstacle.position.y - py
      const sqr = dx * dx + dy * dy
      if (sqr < sumWidth * sumWidth) {
        if (sqr > EPSILON) {
          const magnitude = Math.sqrt(sqr)
          px = obstacle.position.x - (sumWidth * dx) / magnitude
          py = obstacle.position.y - (sumWidth * dy) / magnitude
        } else {
          // Coincident centres: the normalised push-out is 0/0. Pick an axis
          // rather than writing NaN into the position, which is unrecoverable.
          px = obstacle.position.x - sumWidth
          py = obstacle.position.y
        }

        obstacle.onCollide(this)
      }
    }

    for (const obj of World.PLAYERS) {
      if ((obj as Unit) === this) continue

      if (obj.tag !== this.tag) continue

      const sumWidth = obj.radius + this.radius
      const dx = obj.position.x - px
      const dy = obj.position.y - py
      const sqr = dx * dx + dy * dy
      if (sqr < sumWidth * sumWidth) {
        this.onCollideWithPlayer(obj)

        if (sqr > EPSILON) {
          const magnitude = Math.sqrt(sqr)
          px = obj.position.x - (sumWidth * dx) / magnitude
          py = obj.position.y - (sumWidth * dy) / magnitude
        } else {
          px = obj.position.x - sumWidth
          py = obj.position.y
        }
      }
    }

    for (const area of World.AREA_EFFECT) {
      if (area.tag !== this.tag) continue
      if (area.target === this) continue
      if (area.overlaps(this.position)) {
        const damage = area.getEffect(dt)
        this.hit(damage)
      }
    }

    px = px < 0 ? 0 : px
    px = px > World.mapSize ? World.mapSize : px

    py = py < 0 ? 0 : py
    py = py > World.mapSize ? World.mapSize : py

    const sqMagnitude = this.impulse.getSquareMagnitude()
    if (sqMagnitude > EPSILON) {
      const magnitude = Math.sqrt(sqMagnitude)
      const remaining = magnitude - dt * IMPULSE_FRICTION
      // Scale towards zero so the direction is preserved and the duration is the
      // same whichever way the dash points.
      this.impulse = remaining > 0
        ? this.impulse.multiply(remaining / magnitude)
        : new Vector(0, 0)
    }

    if (this.position.x !== px || this.position.y !== py) {
      this.position = new Vector(px, py)
    }

    super.update(dt)
  }

  maxHP (): number {
    return World.config.hp
  }

  getDamage (): number {
    return World.config.damage
  }

  hit (value: number): boolean {
    // Clamped: at armor 10 the multiplier hits zero, and above it went negative,
    // so `hp -= inflictedDamage` healed - past maxHP, since only pickups clamp.
    const multiplier = Math.max(0, Math.min(1, 1 - this.damageReduction - this.armor / 10))
    const inflictedDamage = Math.floor(value * multiplier)
    this.hp -= inflictedDamage

    if (this.hp <= 0) {
      this.hp = 0
      super.destroy()
      return true
    }

    return false
  }

  onCollideWithPlayer (target: GameObject): void {}

  addBuff (value: Buff): void {
    // dont stack same buffs?
    this.buffs.push(value)
  }

  onKill (obj: GameObject): void {}
}
