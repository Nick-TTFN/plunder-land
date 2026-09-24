import TWEEN from '@tweenjs/tween.js'
import { Graphics } from 'pixi.js'
import { Game } from '../game'
import { type GameObject } from '../objects/gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { RANGED_RANGE, firstOnLine, type Body } from './cells'
import { CellHighlight, cellOf, directionVector, facingOf, layerOf } from './cellhighlight'

/**
 * A beam from the caster to where the shot stops: the first unit on the line
 * (N4, decision #16), or the end of its 8-cell range.
 *
 * Aimed shots fly toward the aimed cell's centre at any angle (decision #21);
 * the record carries that cell. An unaimed one goes along the caster's hex
 * facing, which is the nearest of six to the server's continuous facing, so
 * it can be up to 30 degrees out. It used to fly 1000 units along
 * `owner.direction`, which never reached the client, so it drew nothing.
 *
 * The stopping unit is found with `firstOnLine`, the port of the server's own
 * pick, run over the positions this client is drawing. Those lag the server
 * by the interpolation delay, so a beam at a moving target can stop on a
 * different unit than the one the server hit.
 */
export class RangedAttackEffect {
  constructor (owner: GameObject, aimCell?: Vector) {
    const layer = layerOf(owner.tag)
    if (layer === undefined) return

    const from = new Vector(owner.x, owner.y)
    let dir: Vector
    const own = cellOf(owner)
    if (aimCell !== undefined && (aimCell.x !== own.x || aimCell.y !== own.y)) {
      const centre = Hex.toPosition(aimCell)
      dir = new Vector(centre.x - from.x, centre.y - from.y).normalised()
    } else {
      dir = directionVector(facingOf(owner))
    }

    const far = new Vector(from.x + dir.x * RANGED_RANGE, from.y + dir.y * RANGED_RANGE)
    const candidates: GameObject[] = []
    for (const unit of [...Game.PLAYERS, ...Game.MOBS] as GameObject[]) {
      if (unit === owner || unit.killed || !unit.visible || unit.tag !== owner.tag) continue
      candidates.push(unit)
    }
    const bodies: Body[] = candidates.map((u) => ({ x: u.x, y: u.y, radius: u.radius }))
    const hit = firstOnLine(from.x, from.y, far.x, far.y, bodies)

    let length = RANGED_RANGE
    if (hit >= 0) {
      // Stop where the line passes the struck unit's centre.
      const b = bodies[hit]
      length = Math.max(0, (b.x - from.x) * dir.x + (b.y - from.y) * dir.y)
      const struck = cellOf(b)
      CellHighlight.flash(owner.tag, [struck], 0x88ffff, 300)
    }
    const end = new Vector(from.x + dir.x * length, from.y + dir.y * length)

    const beam = new Graphics()
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

    // The head crosses the full range in 120 ms, the tail follows it in.
    const travel = 120 * (length / RANGED_RANGE) + 30
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
