import Multiplayer from '../network/multiplayer'
import { Vector } from '../utils/vector'
import { GameObject, ObjectType } from './gameobject'
import { type Unit } from './unit'
import World from './world'
import { Hex } from '../utils/hex'

/**
 * A projectile that steps along a hex line (hex-cells P3, decisions #31, #34).
 * It finds its own targets; nothing collides with it.
 *
 * It lives in `World.PROJECTILES`, which the tick flies and sweeps
 * (`World.updateProjectiles`), and **not** in `World.OBSTACLES`: it is not
 * solid. Being solid is what once made every fireball and icicle explode on
 * its caster.
 *
 * The flight is a `Hex.line` of `RANGE_CELLS` steps from the caster's cell
 * (the skill builds it with `RangedAttack.lineOf`: through the aimed cell, or
 * along the hex facing). Its front is kept in thirds of a cell, in integers:
 * it starts `HEAD_START` thirds out and gains `STEP` thirds every tick, fixed
 * per tick and not scaled by dt, so after the n-th tick the front is on line
 * index `min(RANGE_CELLS, floor((8 + 5n) / 3))`: 4, 6, 7, 9, 10. That is
 * today's 300 u/s at the default 250 ms tick (5/3 cells of 45), from today's
 * 56-unit spawn plus 64-unit hit reach (8/3 cells). Rocks do not stop it.
 *
 * Each tick it tests the line indices the front newly crossed, in order
 * (index 0, the caster's own cell, is never crossed). The first index whose
 * cell or any neighbour of it (`SWATH_RINGS`) holds a unit other than the
 * owner decides; see `findHit` for which unit. A unit that has left that patch
 * before the front gets there is not hit, which is what keeps dodging. With no
 * hit by the end of the line it bursts on the last cell that tick: 10 cells
 * plus the 1-ring blast is today's reach of 11. The 1200 ms `lifetime` is
 * still set, so the create record carries it as before, but nothing on the
 * server ends a projectile by time any more.
 */
export default class Throwable extends GameObject {
  /** Line steps, in cells, not counting the caster's own cell (#34). */
  static RANGE_CELLS = 10
  /** The front's start, in thirds of a cell: 8/3 cells out. */
  static HEAD_START = 8
  /** The front's gain per tick, in thirds of a cell: 5/3 cells. */
  static STEP = 5
  /** A crossed cell hits units on it and within this many rings of it. */
  static SWATH_RINGS = 1

  owner: Unit
  /** The cells it flies over, the caster's own first. */
  readonly line: Vector[]
  /** How far the front has got, in thirds of a cell along `line`. */
  thirds: number
  /** The last line index tested; 0 until the first tick. */
  crossed = 0
  /** The unit it flew into, set just before it is destroyed by the hit. */
  struck: Unit | undefined
  destroyCallback: (value: GameObject, struck?: Unit) => void

  /** `Hex.key` of each line cell to its index. */
  private readonly lineIndex: Map<number, number>
  /** The first and last line cells' centres; the drawn position runs between them. */
  private readonly startAt: Vector
  private readonly endAt: Vector

  constructor (
    line: Vector[],
    lifetime: number,
    tag: number,
    owner: Unit,
    destroyCallback: (value: GameObject, struck?: Unit) => void
  ) {
    const from = Hex.toPosition(line[0])
    const to = Hex.toPosition(line[line.length - 1])
    const start = Throwable.pointAt(from, to, line.length - 1, Throwable.HEAD_START)
    super(ObjectType.Throwable, start.x, start.y, 50, tag)

    this.line = line
    this.lineIndex = new Map(line.map((c, i) => [Hex.key(c.x, c.y), i]))
    this.startAt = from
    this.endAt = to
    this.thirds = Throwable.HEAD_START
    this.lifetime = lifetime
    // Not on the wire, and nothing steers by it: the flight is `line`. Kept
    // so `direction` still says which way it is going.
    this.direction = line.length > 1 ? to.sub(from).normalised() : new Vector(0, 0)
    this.owner = owner
    this.destroyCallback = destroyCallback

    Multiplayer.Instance.create(this)
  }

  /** The line's last index: `RANGE_CELLS`, unless the line came up short. */
  get last (): number {
    return this.line.length - 1
  }

  update (dt: number) {
    this.thirds += Throwable.STEP
    const front = Math.min(this.last, Math.floor(this.thirds / 3))

    for (let i = this.crossed + 1; i <= front; i++) {
      const hit = this.findHit(i)
      if (hit !== undefined) {
        this.crossed = i
        this.position = Hex.toPosition(this.line[i])
        this.onCollide(hit)
        return
      }
    }
    this.crossed = front

    if (front >= this.last) {
      // The burst is centred on `Hex.toCell(position)`, so put it exactly on
      // the last cell's centre rather than trust the interpolation to round
      // there.
      this.position = Hex.toPosition(this.line[this.last])
      this.destroy()
      return
    }

    // Drawing only: the point `thirds` along the straight segment from the
    // first cell's centre to the last's, so the client sees an even 75 units
    // a tick along an axis (65 between axes, where cells are 39 apart).
    this.position = Throwable.pointAt(this.startAt, this.endAt, this.last, this.thirds)
    super.update(dt)
  }

  /**
   * The unit a front crossing line index `index` strikes, or undefined: a live
   * unit on this layer, not the owner, standing on that cell or within
   * `SWATH_RINGS` of it. Of several (main session's call on Dez's flag): one
   * standing on a line cell before one beside the line, of those on the line
   * the one on the earliest line cell, and then the lowest id, so the answer
   * never depends on the order units were filed in. A neighbour of the
   * crossed cell can itself be a line cell (the next one, or the one before
   * if a unit stepped onto it since), which is why "on the line" is not just
   * "on the crossed cell". Found through `World.UNITS`: 7 cell lookups.
   */
  findHit (index: number): Unit | undefined {
    const cell = this.line[index]
    const offLine = this.line.length
    let hit: Unit | undefined
    let hitRank = Infinity

    World.forKeysWithin(cell, Throwable.SWATH_RINGS, (key) => {
      const rank = this.lineIndex.get(key) ?? offLine
      for (const unit of World.UNITS.at(this.tag, key)) {
        if (unit === this.owner) continue
        if (unit.destroyed) continue
        if (rank < hitRank || (rank === hitRank && hit !== undefined && unit.id < hit.id)) {
          hit = unit
          hitRank = rank
        }
      }
    })

    return hit
  }

  /** `thirds` of a cell along the segment `from` -> `to`, which is `cells` long, clamped to its end. */
  static pointAt (from: Vector, to: Vector, cells: number, thirds: number): Vector {
    if (cells <= 0) return from
    const t = Math.min(1, thirds / (3 * cells))
    return from.add(to.sub(from).multiply(t))
  }

  onCollide (target: Unit) {
    super.onCollide(target)
    this.struck = target
    this.destroy()
  }

  /** Also the end of the line, when `struck` is unset. */
  destroy () {
    if (this.destroyCallback) this.destroyCallback(this, this.struck)
    super.destroy()
  }
}
