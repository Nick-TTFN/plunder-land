import { GameObject } from './gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Path } from '../utils/path'
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
  /**
   * Cells still to walk, first step first, and how far along we are.
   *
   * This is the whole of "where a unit is going" - there is no trajectory
   * object, the way there is no velocity object. `path` plus `pathIndex` is to
   * movement what `direction` plus `maxVelocity` already is to speed.
   *
   * A unit with no path keeps whatever direction was last set on it, which is
   * how the AI routines go on steering by `setDirectionTo` untouched.
   */
  path: Vector[] = []
  pathIndex: number = 0

  /**
   * The cells the unit was told to go to, in order, kept so the route can be
   * recomputed without the caller having to remember it - which is what
   * StoneWall needs when it drops terrain across somebody's path.
   *
   * A list rather than a single cell because a route can be built up leg by leg
   * (shift-click on the client). One waypoint is the ordinary case.
   */
  waypoints: Vector[] = []

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

  /** The cell this unit is standing in. */
  get cell (): Vector {
    return Hex.toCell(this.position)
  }

  /**
   * Route to a destination cell, replacing any path in progress.
   *
   * An unreachable destination - blocked, outside the search window, or walled
   * off - leaves the unit standing still rather than drifting toward it, which
   * is the honest answer and the one the client predicts too.
   */
  setDestination (q: number, r: number): void {
    this.setWaypoints([new Vector(q, r)])
  }

  setWaypoints (cells: Vector[]): void {
    this.waypoints = cells
    this.repath()
  }

  /**
   * Recompute the route through the standing waypoints from wherever we are.
   *
   * Legs are searched one at a time and concatenated. A leg that cannot be
   * reached ends the route there rather than skipping to the next waypoint,
   * because walking a route with a hole in it is worse than stopping short of
   * one - and the client, running the same thing, stops in the same place.
   */
  repath (): void {
    if (this.waypoints.length === 0) return

    this.path = []
    let from = this.cell

    for (const waypoint of this.waypoints) {
      const leg = Path.find(
        from,
        waypoint,
        (cq, cr) => World.isBlocked(cq, cr, this.tag)
      )
      if (leg.length === 0) break
      for (const cell of leg) this.path.push(cell)
      from = waypoint
    }

    this.pathIndex = 0

    // Give up rather than retry forever. A destination that cannot be reached
    // now will not become reachable by asking again next tick, and a unit
    // silently re-searching every tick is the cost blow-up this design exists
    // to avoid.
    if (this.path.length === 0) this.stop()
  }

  /** Drop the path, the waypoints and the heading, and stand still. */
  stop (): void {
    this.path = []
    this.pathIndex = 0
    this.waypoints = []
    this.direction = new Vector(0, 0)
  }

  /** True if any cell still to be walked is this one. */
  pathCrosses (q: number, r: number): boolean {
    for (let i = this.pathIndex; i < this.path.length; i++) {
      if (this.path[i].x === q && this.path[i].y === r) return true
    }
    return false
  }

  /**
   * Aim `direction` at the next cell on the path.
   *
   * Arrival is "the cell I am standing in is that cell" rather than a distance
   * threshold, so there is no tuned epsilon and nothing to oscillate around.
   *
   * The look-ahead is deliberately one cell and no more. It exists for a single
   * case: push-out, or a tick that covers a whole cell, can carry a unit past a
   * cell it never stood in, and without it the unit turns round to collect one
   * it has already passed. Scanning the rest of the route instead is what broke
   * multi-leg routes - an appended leg comes back through cells the unit is
   * standing in right now, and matching that later occurrence teleported the
   * index to the far side of the route, so the unit set off for the last leg's
   * destination while the first leg was still ahead of it. Two adjacent cells
   * are never equal, so a look-ahead of one cannot land on a duplicate.
   */
  static PATH_LOOKAHEAD = 1

  followPath (): void {
    const here = this.cell

    const limit = Math.min(this.path.length, this.pathIndex + Unit.PATH_LOOKAHEAD + 1)
    for (let i = this.pathIndex; i < limit; i++) {
      if (this.path[i].x === here.x && this.path[i].y === here.y) {
        this.pathIndex = i + 1
        break
      }
    }

    if (this.pathIndex >= this.path.length) {
      this.stop()
      return
    }

    const centre = Hex.toPosition(this.path[this.pathIndex])
    this.setDirectionTo(centre.x, centre.y)
  }

  update (dt: number): void {
    for (const routine of this.routines) {
      routine.update(dt)
    }

    for (let i = this.buffs.length - 1; i >= 0; i--) {
      if (this.buffs[i].update(dt)) this.buffs.splice(i, 1)
    }

    // Only when there is a path. A unit without one is being steered directly by
    // an AI routine, and overwriting its direction here would freeze it.
    if (this.path.length > 0) this.followPath()

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
