import TWEEN from '@tweenjs/tween.js'
import { Graphics } from 'pixi.js'
import { Game } from '../game'
import { type GameObject } from '../objects/gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import Unit from '../objects/unit'
import { RANGED_RANGE_CELLS, firstOnLine, rangedRangeCells, type Body, type Cell } from './cells'
import { CellHighlight, cellOf, facingOf, layerOf } from './cellhighlight'
import { onGround, TILT } from '../objects/tilt'
import AnimationClip from '../animation/animationclip'

/**
 * A beam from the caster to where the shot stops: the first unit on its hex
 * line (decision #25, N4), or the end of its range.
 *
 * The line is `Hex.line` from the caster's cell through the aimed cell the
 * record carries, on to the range in cells, which is the same call on the same
 * mirrored file the server hits with. An unaimed shot, or one aimed at the
 * caster's own cell, runs the line along the caster's hex facing, as the
 * server's `RangedAttack.lineOf` does. The cells it crossed are lit faintly so
 * the path the shot took is the one on the ground.
 *
 * The stopping unit is found with `firstOnLine`, the port of the server's
 * `World.FIRST_ON_LINE`, run over the positions this client is drawing. Those
 * lag the server by the interpolation delay, so a beam at a unit crossing a
 * cell edge can stop on a different unit than the one the server hit, and a
 * client that places the caster one cell off draws a line one cell off.
 */
export class RangedAttackEffect {
  constructor (owner: GameObject, aimCell?: Vector) {
    const layer = layerOf(owner.tag)
    if (layer === undefined) return

    const from = new Vector(owner.x, owner.y)
    const own = cellOf(owner)
    const ownCell = new Vector(own.x, own.y)
    const toward = aimCell !== undefined && (aimCell.x !== own.x || aimCell.y !== own.y)
      ? aimCell
      : Hex.neighbour(ownCell, facingOf(owner))
    // The shooter's archetype's range; an unknown archetype falls back to the
    // unit type's default (rangedRangeCells).
    const archetype = owner instanceof Unit ? owner.archetype : undefined
    const range = rangedRangeCells(archetype?.rangedCells, (Game.MOBS as GameObject[]).includes(owner))
    const line: Cell[] = Hex.line(ownCell, toward, range).map((c) => ({ x: c.x, y: c.y }))

    const candidates: GameObject[] = []
    for (const unit of [...Game.PLAYERS, ...Game.MOBS] as GameObject[]) {
      if (unit === owner || unit.killed || !unit.visible || unit.tag !== owner.tag) continue
      candidates.push(unit)
    }
    const bodies: Body[] = candidates.map((u) => ({ x: u.x, y: u.y, cell: cellOf(u) }))
    const hit = firstOnLine(line, from.x, from.y, bodies)

    let end: Vector
    let crossed: Cell[]
    if (hit >= 0) {
      // Stop on the struck unit.
      const b = bodies[hit]
      end = new Vector(b.x, b.y)
      const at = line.findIndex((c) => c.x === b.cell.x && c.y === b.cell.y)
      crossed = line.slice(1, at)
      CellHighlight.flash(owner.tag, [b.cell], 0x88ffff, 300)
    } else {
      const last = line[line.length - 1]
      end = Hex.toPosition(new Vector(last.x, last.y))
      crossed = line.slice(1)
    }
    // Dimmer than the struck cell: the path, not the hit.
    if (crossed.length > 0) CellHighlight.flash(owner.tag, crossed, 0x2f6f7a, 300)
    const length = Math.hypot(end.x - from.x, end.y - from.y)
    const fullLength = RANGED_RANGE_CELLS * Hex.SIZE

    // Along the ground, so it squashes with the tilted camera like the cells.
    const beam = onGround(new Graphics())
    beam.eventMode = 'none'
    beam.zIndex = Math.max(from.y, end.y) + 1
    const state = { head: 0, tail: 0 }
    const redraw = (): void => {
      beam.clear()
      const hx = from.x + (end.x - from.x) * state.head
      const hy = from.y + (end.y - from.y) * state.head
      const tx = from.x + (end.x - from.x) * state.tail
      const ty = from.y + (end.y - from.y) * state.tail
      beam.lineStyle(6, 0x1a3a44, 0.35).moveTo(tx, ty + 2).lineTo(hx, hy + 2)
      beam.lineStyle(3, 0x88ffff, 0.95).moveTo(tx, ty).lineTo(hx, hy)
    }
    layer.addChild(beam)

    // A rigged robot turns, aims and fires, flash and all (`RobotSprite`).
    const rigged = owner instanceof Unit && owner.playAction('shoot', end)

    // A flash at the muzzle, a little way out along the shot, pointed along it
    // on screen (the camera squashes y by TILT; the clip stands up).
    if (length > 0 && !rigged) {
      const flash = new AnimationClip('fx/muzzle')
      const out = Math.min(20, length) / length
      flash.x = from.x + (end.x - from.x) * out
      flash.y = from.y + (end.y - from.y) * out - owner.radius
      flash.zIndex = from.y + 2
      flash.rotation = Math.atan2((end.y - from.y) * TILT, end.x - from.x)
      flash.onComplete = () => {
        flash.parent?.removeChild(flash)
        flash.destroy()
      }
      layer.addChild(flash)
      flash.play()
    }

    // The head crosses the full range in 120 ms, the tail follows it in.
    const travel = 120 * Math.min(1, length / fullLength) + 30
    new TWEEN.Tween(state)
      .to({ head: 1 }, travel)
      .onUpdate(redraw)
      .chain(
        new TWEEN.Tween(state)
          .to({ tail: 1 }, 180)
          .onUpdate(redraw)
          .onComplete(() => {
            beam.parent?.removeChild(beam)
            beam.destroy()
          })
      )
      .start()
  }
}
