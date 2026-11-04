import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { type SkillKey } from '../utils/skills'
import { RANGED_RANGE_CELLS } from '../vfx/cells'

/**
 * Auto-aim (decision #58 and its addenda): which unit every aimed press
 * fires at, and the cell a press sends. It replaced mouse aim and touch's
 * arm-then-tap, and supersedes #21's "aim at the clicked cell" for players.
 *
 * The client picks and sends an absolute cell in the existing `skill` /
 * `use_item` bytes (`Aim.message`); the server works out the direction from
 * its own position of the caster, as it always did. So no wire change: the
 * line drawn (`vfx/aimline.ts`) and the cell sent come from the same pick.
 *
 * Pure targeting logic, no pixi drawing and no `Game`, so the server's specs
 * import it (`services/battle-royale-server/src/skills/autoaim.spec.ts`).
 * `Aim` (`skills/aim.ts`) feeds it from `Game` each frame.
 */

/** A cell, axial (q, r) as (x, y). */
export interface Cell { x: number, y: number }

/**
 * Dez's tunables (#58 addendum 2, Q11 and the target rule), in one place.
 * A target is acquired within `ACQUIRE_RINGS`, kept up to `KEEP_RINGS` and
 * dropped beyond it (hysteresis, so one at the edge doesn't flicker). A
 * current target gives way to another at least `REPICK_MARGIN` rings closer.
 * A bomb lands at least `BOMB_MIN_CELLS` out: its 2-ring blast hurts the
 * thrower (server `items/bomb.ts` `detonate`).
 */
export const AUTO_AIM = Object.freeze({
  ACQUIRE_RINGS: 6,
  KEEP_RINGS: 7,
  REPICK_MARGIN: 2,
  BOMB_MIN_CELLS: 3
})

/**
 * How far each aimed skill reaches, in cells: only the no-target cell uses
 * it (targeting uses `AUTO_AIM`). Copies of server constants, pinned by
 * `autoaim.spec.ts`: throwables `Throwable.RANGE_CELLS`, Ice Breath
 * `IceBreath.RINGS`. The ranged shot's is the robot's mirrored `rangedCells`
 * (`rangeCellsOf`). Not in the mirrored `utils/skills.ts` on purpose: only
 * this client needs it.
 */
export const AIM_RANGE_CELLS: Readonly<Partial<Record<SkillKey, number>>> = Object.freeze({
  fireball: 10,
  icicle: 10,
  iceBreath: 3
})

/**
 * The reach of skill `key` for a robot whose `rangedCells` is given, or
 * undefined for a skill that doesn't aim (Dash, Melee, Defend, StoneWall)
 * or an unknown one.
 */
export function rangeCellsOf (key: SkillKey | undefined, rangedCells: number | null | undefined): number | undefined {
  if (key === 'ranged') return typeof rangedCells === 'number' ? rangedCells : RANGED_RANGE_CELLS
  return key !== undefined ? AIM_RANGE_CELLS[key] : undefined
}

/**
 * What the target picker sees of one object this client holds. `kind` is
 * `player` or `mob` for a unit; anything else (pickups, caches, StoneWall
 * stones, portals, exits) is never a target. `own` marks this client's robot.
 * `alive` is false for a killed or destroyed unit and for one the client has
 * hidden as gone from its view. `seen` is whether its cell is VISIBLE in the
 * fog (the `renderable` rule, `Game.applyFog`), never the margin ring.
 */
export interface TargetView {
  id: number
  kind: 'player' | 'mob' | 'pickup' | 'obstacle' | 'portal' | 'exit' | 'other'
  own: boolean
  alive: boolean
  seen: boolean
  tag: number | undefined
  /** The cell it is drawn on (its centre, for a 7-cell body). */
  cell: Cell
  /** 0, or 1 for a 7-cell body (Reactor, Brood; mirrored `bodyRings`). */
  bodyRings: number
}

/** Whether `view` may be targeted by a robot on layer `tag`. */
export function isTarget (view: TargetView, tag: number | undefined): boolean {
  return (view.kind === 'player' || view.kind === 'mob') &&
    !view.own && view.alive && view.seen && view.tag === tag
}

/** Rings from `own` to the nearest cell of `view`'s body. */
export function reach (own: Cell, view: TargetView): number {
  return Math.max(0, distance(own, view.cell) - view.bodyRings)
}

function distance (a: Cell, b: Cell): number {
  const q = a.x - b.x
  const r = a.y - b.y
  return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2
}

/**
 * Whether the hex line from `own` to `to` crosses no wall (#44), not
 * counting either end: a Hopper on a wall shoots over it. The line is the
 * shot's own (`Hex.line`).
 */
export function clearLine (own: Cell, to: Cell, isWall: (q: number, r: number) => boolean): boolean {
  const n = distance(own, to)
  const line = Hex.line(new Vector(own.x, own.y), new Vector(to.x, to.y), n)
  for (let i = 1; i < n; i++) {
    if (isWall(line[i].x, line[i].y)) return false
  }
  return true
}

interface Ranked { view: TargetView, reach: number, clear: boolean }

/** Clear line first, then nearest, then the lower id (so the pick doesn't flicker). */
function better (a: Ranked, b: Ranked): boolean {
  if (a.clear !== b.clear) return a.clear
  if (a.reach !== b.reach) return a.reach < b.reach
  return a.view.id < b.view.id
}

function best (list: Ranked[]): Ranked | undefined {
  let pick: Ranked | undefined
  for (const r of list) if (pick === undefined || better(r, pick)) pick = r
  return pick
}

/**
 * The one shared target (#58 addendum 2): every aimed skill and item fires
 * at it, and one line shows it. Sticky: kept until it dies, leaves the
 * VISIBLE fog or goes beyond `KEEP_RINGS`, except that another enemy
 * `REPICK_MARGIN` rings closer takes over (not one with a walled line from a
 * clear current one). Among new candidates a clear line wins over a nearer
 * walled one; the nearest walled one is taken only if none is clear.
 *
 * The re-pick applies to every target. There is no tap-to-target and so no
 * exemption from it: a press on an enemy is a move order, desktop click
 * included. Deliberate: #59 reverses #58 addendum 2's tap-to-target; do not
 * put it back.
 */
export class AutoAim {
  /** The current target's object id, or undefined for none. */
  targetId: number | undefined

  /** A new run: no target (ids name other objects in the next world). */
  reset (): void {
    this.targetId = undefined
  }

  /**
   * This frame's target among `views`, for a robot on cell `own` of layer
   * `tag`; undefined for none. `isWall` is layer `tag`'s walls.
   */
  update (own: Cell, tag: number | undefined, views: readonly TargetView[], isWall: (q: number, r: number) => boolean): TargetView | undefined {
    let current: Ranked | undefined
    const candidates: Ranked[] = []
    for (const view of views) {
      if (!isTarget(view, tag)) continue
      const rings = reach(own, view)
      if (view.id === this.targetId) {
        if (rings <= AUTO_AIM.KEEP_RINGS) current = { view, reach: rings, clear: clearLine(own, view.cell, isWall) }
        continue
      }
      if (rings <= AUTO_AIM.ACQUIRE_RINGS) candidates.push({ view, reach: rings, clear: clearLine(own, view.cell, isWall) })
    }

    if (current === undefined) {
      const pick = best(candidates)
      this.targetId = pick?.view.id
      return pick?.view
    }

    const cur = current
    const closer = best(candidates.filter((c) =>
      c.reach <= cur.reach - AUTO_AIM.REPICK_MARGIN && (c.clear || !cur.clear)))
    if (closer !== undefined) {
      this.targetId = closer.view.id
      return closer.view
    }
    return current.view
  }
}

/** A unit vector from a movement direction, East for none. */
function unit (dx: number, dy: number): { x: number, y: number } {
  const len = Math.hypot(dx, dy)
  return len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 }
}

/**
 * The cell `cells` steps out from `own` along the hex line through `toward`,
 * walked back to the furthest one on the map; undefined if even the first
 * step is off it (the press then sends the bare slot).
 */
function alongLine (own: Cell, toward: Cell, cells: number, mapSize: number): Cell | undefined {
  if (cells < 1) return undefined
  const line = Hex.line(new Vector(own.x, own.y), new Vector(toward.x, toward.y), cells)
  for (let i = Math.min(cells, line.length - 1); i >= 1; i--) {
    if (Hex.onMap(line[i].x, line[i].y, mapSize)) return { x: line[i].x, y: line[i].y }
  }
  return undefined
}

/**
 * A cell far out along a world-space direction from `own`'s centre, for a
 * hex line to run through. Far, so the line's angle is the direction's to
 * within a fraction of a degree.
 */
function farAlong (own: Cell, dirX: number, dirY: number): Cell {
  const d = unit(dirX, dirY)
  const at = Hex.toPosition(new Vector(own.x, own.y))
  const far = Hex.toCell(new Vector(at.x + d.x * Hex.SIZE * 64, at.y + d.y * Hex.SIZE * 64))
  return { x: far.x, y: far.y }
}

/**
 * No target: the cell `range` steps out along the movement direction
 * (`dirX`, `dirY`, world space; the last one while standing), clamped to the
 * map; undefined (the bare slot) if the first step is off the map. A cell
 * rather than the bare slot, so the shot follows the drawn line and not the
 * server's `facing`, which lags the predicting client while turning.
 */
export function noTargetCell (own: Cell, dirX: number, dirY: number, range: number, mapSize: number): Cell | undefined {
  return alongLine(own, farAlong(own, dirX, dirY), range, mapSize)
}

/**
 * The cell an aimed skill press sends: the target's cell, else the
 * no-target cell. Every aimed press fires along the one line, whatever its
 * own reach (a breath at a target 5 cells off points at it).
 */
export function skillCell (own: Cell, target: Cell | undefined, dirX: number, dirY: number, range: number, mapSize: number): Cell | undefined {
  if (target !== undefined && distance(own, target) > 0) return { x: target.x, y: target.y }
  return noTargetCell(own, dirX, dirY, range, mapSize)
}

/**
 * The cell a bomb is thrown at (Q12): along the line to the target, at
 * least `BOMB_MIN_CELLS` out (a nearer target would put its thrower in the
 * blast) and at most `aimRange - 1` (the server refuses, not clamps, an aim
 * past `aimRange` from its own cell, and the predicting client can be a cell
 * ahead of it). No target: `aimRange - 1` along the movement direction.
 * Clamped to the map like `noTargetCell`.
 */
export function bombCell (own: Cell, target: Cell | undefined, dirX: number, dirY: number, aimRange: number, mapSize: number): Cell | undefined {
  const most = aimRange - 1
  if (target === undefined || distance(own, target) === 0) return noTargetCell(own, dirX, dirY, most, mapSize)
  const cells = Math.min(most, Math.max(AUTO_AIM.BOMB_MIN_CELLS, distance(own, target)))
  return alongLine(own, target, cells, mapSize)
}
