import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * The left-thumb joystick's maths (decision #59, mobile-2): how a stick angle
 * becomes an ordinary one-waypoint route, and when it re-targets. No pixi and
 * no DOM here, so the server's specs import it (`stick.spec.ts`); the drawing
 * is `ui/components/joystick.ts` and the pointer wiring `index.ts`.
 *
 * The stick never sends anything new on the wire: it calls
 * `LocalPlayer.setDestination` with a cell it chose so that the route to it is
 * short (`stickTarget`), and on release `LocalPlayer.cutToNextCell`.
 */

/**
 * How far out along the stick the target cell is, in cells (Dez's tunable;
 * 3, Nick 2026-11-04). The route to it is searched inside a disc of this
 * radius on both sides (`stickTarget`), so it bounds the stick's search cost.
 */
export const STICK_CELLS = 3

/** The stick's angle is binned into this many sectors; a new bin re-targets. */
export const STICK_SECTORS = 12

/**
 * How far past a bin's edge the angle must go before the bin changes, as a
 * fraction of a bin's width (0.2 of 30 degrees: 6 degrees), so a thumb resting
 * on a boundary doesn't flip the route back and forth.
 */
export const SECTOR_HYSTERESIS = 0.2

/** Stick deflection under this, in CSS pixels, is no direction at all. */
export const STICK_DEAD_ZONE = 12

/**
 * The point the line is aimed at, in cells out along the angle. Far beyond
 * `STICK_CELLS` so the rounding of the aimed cell costs little angle (about
 * 1/24 rad); the line still stops at `STICK_CELLS` cells.
 */
const AIM_FAR = 8 * STICK_CELLS

/** World distance between neighbouring cell centres (`Hex.toPosition`). */
const STEP = Hex.SIZE

const SECTOR = (2 * Math.PI) / STICK_SECTORS

/**
 * The cell to route to for a stick at `angle` (world radians, as `atan2` of a
 * world direction): walk `Hex.line` from `from` toward a point along the angle
 * and take **the farthest cell before the first blocked one**, at most `cells`
 * out. Undefined when the first cell is blocked: stand.
 *
 * The line is a chain of neighbours, every one of them free up to the target,
 * so the target is always reachable within `cells` steps, and `Path.find`
 * (BFS) reaches it inside a disc of radius `cells` around `from` on the client
 * and, from a cell or two back on the route, on the server. The stick never
 * hands either side an unblocked-but-unreachable cell, whose search would
 * sweep the whole window (`Path.WINDOW`, 140 rings).
 *
 * `isBlocked` is the local player's own (`LocalPlayer`'s, `Game.blocksLocal`),
 * so it already counts the map edge, walls, voids and, for Hopper, only voids.
 */
export function stickTarget (
  from: Vector,
  angle: number,
  isBlocked: (q: number, r: number) => boolean,
  cells: number = STICK_CELLS
): Vector | undefined {
  const at = Hex.toPosition(from)
  const toward = Hex.toCell(new Vector(
    at.x + Math.cos(angle) * STEP * AIM_FAR,
    at.y + Math.sin(angle) * STEP * AIM_FAR
  ))
  const line = Hex.line(from, toward, cells)
  let target: Vector | undefined
  for (let i = 1; i < line.length; i++) {
    if (isBlocked(line[i].x, line[i].y)) break
    target = line[i]
  }
  return target
}

/** The bin's own angle: the middle of sector `sector`, sector 0 centred on East. */
export function sectorAngle (sector: number): number {
  return sector * SECTOR
}

/**
 * The sector for `angle`, keeping `held` until the angle is
 * `SECTOR_HYSTERESIS` of a bin past its edge.
 */
export function sectorOf (angle: number, held?: number): number {
  const raw = ((Math.round(angle / SECTOR) % STICK_SECTORS) + STICK_SECTORS) % STICK_SECTORS
  if (held === undefined || raw === held) return raw
  // Off the held bin's centre, wrapped into (-pi, pi].
  let off = angle - sectorAngle(held)
  off = Math.atan2(Math.sin(off), Math.cos(off))
  return Math.abs(off) > SECTOR * (0.5 + SECTOR_HYSTERESIS) ? raw : held
}

/**
 * The joystick's steering state: which bin it is held in and when it last
 * re-targeted. `aim` on every stick move, `due` once a frame.
 */
export class StickSteer {
  /** The bin being steered; undefined while the stick is up or centred. */
  sector: number | undefined

  /** The bin changed since the last re-target. */
  private _changed = false
  private _lastRetarget = -Infinity

  /**
   * The stick moved: its world angle, or undefined inside the dead zone.
   * True when the stick has just come back to the centre, which stops the
   * robot as a release does.
   */
  aim (angle: number | undefined): boolean {
    if (angle === undefined) {
      const was = this.sector
      this.sector = undefined
      this._changed = false
      return was !== undefined
    }
    const next = sectorOf(angle, this.sector)
    if (next !== this.sector) {
      this.sector = next
      this._changed = true
    }
    return false
  }

  /** The stick is up. The cap's clock is kept, so a quick re-press is capped too. */
  release (): void {
    this.sector = undefined
    this._changed = false
  }

  /**
   * Once a frame: true when it is time to re-target, which is when the bin
   * changed or the route has `remaining` (cells still to walk) of 1 or less,
   * and **never more than once per `tickMs`** (`Session.tickMs`), however the
   * thumb moves. A held stick on a finished or cut route (knockback, a hop)
   * re-targets from here, so it keeps walking.
   */
  due (now: number, tickMs: number, remaining: number): boolean {
    if (this.sector === undefined) return false
    if (!this._changed && remaining > 1) return false
    if (now - this._lastRetarget < tickMs) return false
    this._lastRetarget = now
    this._changed = false
    return true
  }
}

/** What `steer` needs of `LocalPlayer`. */
export interface Steered {
  readonly cell: Vector
  readonly path: Vector[]
  readonly pathIndex: number
  readonly awaitingHop: boolean
  setDestination: (worldX: number, worldY: number) => void
  cutToNextCell: () => void
}

/**
 * The frame loop's step for a held stick: re-target when `due`, through
 * `setDestination` like a click. While the robot waits on a portal's cell for
 * the new layer's tag (`awaitingHop`) it does nothing, and the next frame after
 * the hop (the route is empty then) re-targets from the arrival cell. No
 * target (the first cell along the stick is blocked) stops at the next cell.
 */
export function steer (
  local: Steered,
  stick: StickSteer,
  now: number,
  tickMs: number,
  isBlocked: (q: number, r: number) => boolean
): void {
  if (stick.sector === undefined || local.awaitingHop) return
  if (!stick.due(now, tickMs, local.path.length - local.pathIndex)) return
  const target = stickTarget(local.cell, sectorAngle(stick.sector), isBlocked)
  if (target === undefined) {
    local.cutToNextCell()
    return
  }
  const at = Hex.toPosition(target)
  local.setDestination(at.x, at.y)
}
