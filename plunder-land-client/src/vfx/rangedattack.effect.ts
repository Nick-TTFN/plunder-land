import TWEEN from '@tweenjs/tween.js'
import { type Container, Graphics } from 'pixi.js'
import { Game } from '../game'
import { type GameObject } from '../objects/gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import Unit from '../objects/unit'
import { RANGED_RANGE_CELLS, firstOnLine, lineIndexOf, rangedRangeCells, type Body, type Cell } from './cells'
import { CellHighlight, cellOf, facingOf, layerOf } from './cellhighlight'
import { onGround, TILT } from '../objects/tilt'
import AnimationClip from '../animation/animationclip'
import { SHOT } from '../robots/eyeshot'

/**
 * A beam from the caster to where the shot stops: the first unit on its hex
 * line (decision #25, N4), or the end of its range. A mob's shot skips other
 * mobs and stops at the first player (decision #51 Q7).
 *
 * The line is `Hex.line` from the caster's cell through the aimed cell the
 * record carries, on to the range in cells, which is the same call on the same
 * mirrored file the server hits with. An unaimed shot, or one aimed at the
 * caster's own cell, runs the line along the caster's hex facing, as the
 * server's `RangedAttack.lineOf` does. The cells it crossed are lit faintly so
 * the path the shot took is the one on the ground.
 *
 * The stopping unit is found with `firstOnLine`, the port of the server's
 * `World.FIRST_ON_LINE`, run over the positions this client is drawing. A
 * player's beam stops at the edge of a 7-cell body (ring-footprint: the
 * Reactor and the Brood), on the first of its cells on the line. Those
 * lag the server by the interpolation delay, so a beam at a unit crossing a
 * cell edge can stop on a different unit than the one the server hit, and a
 * client that places the caster one cell off draws a line one cell off.
 *
 * A rigged robot shoots from its eye, which charges for `SHOT.fire` (0.36 s)
 * before it fires, so its beam waits that long after the effect arrives
 * (Nick, 2026-10-01: "hold the beam"). The server has already dealt the
 * damage by then, so a hit can show before its beam does. The line and the
 * unit it stops on are worked out on arrival, as the server's were; the beam
 * runs from where the caster and that unit are when it fires, and leaves
 * the robot's eye (Nick, 2026-10-01): the bright line starts at the eye
 * (`Unit.eyeGlobal`) and ends at the target's ground point raised by the same
 * height, so it runs about level; its dark shadow line and the lit cells stay
 * on the ground, where the server's line ran. The two don't line up exactly,
 * which was accepted ("it wouldn't be super aligned, but let's try").
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
    const isMob = (Game.MOBS as GameObject[]).includes(owner)
    const range = rangedRangeCells(archetype?.rangedCells, isMob)
    const line: Cell[] = Hex.line(ownCell, toward, range).map((c) => ({ x: c.x, y: c.y }))

    // A mob's shot passes through other mobs to the first player (decision
    // #51 Q7, the server's `RangedAttack.stopsOn`); a player's stops at anyone.
    const candidates: GameObject[] = []
    const stoppers = (isMob ? Game.PLAYERS : [...Game.PLAYERS, ...Game.MOBS]) as GameObject[]
    for (const unit of stoppers) {
      if (unit === owner || unit.killed || !unit.visible || unit.tag !== owner.tag) continue
      candidates.push(unit)
    }
    // A Reactor or Brood is hit on any cell of its 7-cell body (ring-footprint,
    // the server's `World.BODIES`), so the beam stops at its edge.
    const bodies: Body[] = candidates.map((u) => ({
      x: u.x,
      y: u.y,
      cell: cellOf(u),
      rings: !isMob && u instanceof Unit ? u.archetype?.bodyRings ?? 0 : 0
    }))
    const hit = firstOnLine(line, from.x, from.y, bodies)

    let end: Vector
    let crossed: Cell[]
    let struck: Cell | undefined
    // Where the beam ends relative to the struck unit, kept as it moves.
    let offset = new Vector(0, 0)
    if (hit >= 0) {
      // Stop on the struck unit: its centre, or a body's first cell on the line.
      const b = bodies[hit]
      const at = lineIndexOf(line, b)
      const cell = line[at]
      end = (b.rings ?? 0) > 0 ? Hex.toPosition(new Vector(cell.x, cell.y)) : new Vector(b.x, b.y)
      offset = new Vector(end.x - b.x, end.y - b.y)
      crossed = line.slice(1, at)
      struck = cell
    } else {
      const last = line[line.length - 1]
      end = Hex.toPosition(new Vector(last.x, last.y))
      crossed = line.slice(1)
    }

    // A rigged robot turns, aims and charges its eye (`RobotSprite`).
    const rigged = owner instanceof Unit && owner.playAction('shoot', end)
    if (!rigged) {
      RangedAttackEffect.fire(owner, layer, from, end, struck, crossed, false)
      return
    }
    const target = hit >= 0 ? candidates[hit] : undefined
    new TWEEN.Tween({}).to({}, RangedAttackEffect.holdMs(owner)).onComplete(() => {
      const now = new Vector(owner.x, owner.y)
      const to = target !== undefined && !target.killed ? new Vector(target.x + offset.x, target.y + offset.y) : end
      RangedAttackEffect.fire(owner, layer, now, to, struck, crossed, true)
    }).start()
  }

  /**
   * When your own robot's charge started on the key press (`pressed`), not
   * on this effect's arrival a round trip later, so the charge the player saw
   * begin on the press is the one the beam leaves (latency on instant
   * skills, Nick's first remote play, #46). How long the beam still waits:
   * the rest of `SHOT.fire` after the press, nothing if the effect came later
   * than that, and the whole `SHOT.fire` for anyone else's shot or a press
   * more than a second old (not this effect's).
   */
  private static readonly pressedAt = new WeakMap<GameObject, number>()

  /** Your own shot's charge started now (`skills/rangedattack.ts`). */
  static pressed (owner: GameObject, now = performance.now()): void {
    RangedAttackEffect.pressedAt.set(owner, now)
  }

  private static holdMs (owner: GameObject, now = performance.now()): number {
    const full = SHOT.fire * 1000
    const at = RangedAttackEffect.pressedAt.get(owner)
    RangedAttackEffect.pressedAt.delete(owner)
    if (at === undefined || now - at > full + 1000) return full
    return Math.max(0, full - (now - at))
  }

  /** The beam, the cells it lit, and (for a sprite without a rig) a muzzle flash. */
  private static fire (owner: GameObject, layer: Container, from: Vector, end: Vector, struck: Cell | undefined, crossed: Cell[], rigged: boolean): void {
    if (struck !== undefined) CellHighlight.flash(owner.tag, [struck], 0x88ffff, 300)
    // Dimmer than the struck cell: the path, not the hit.
    if (crossed.length > 0) CellHighlight.flash(owner.tag, crossed, 0x2f6f7a, 300)
    const length = Math.hypot(end.x - from.x, end.y - from.y)
    const fullLength = RANGED_RANGE_CELLS * Hex.SIZE

    // Along the ground, so it squashes with the tilted camera like the cells.
    const beam = onGround(new Graphics())
    beam.eventMode = 'none'
    beam.zIndex = Math.max(from.y, end.y) + 1
    const state = { head: 0, tail: 0 }
    layer.addChild(beam)

    // The bright line from the eye, lifted off the ground line: in the beam's
    // own (ground) coordinates, an upright height on screen is height / TILT.
    let eyeX = from.x
    let lift = 0
    const eye = rigged && owner instanceof Unit ? owner.eyeGlobal() : undefined
    if (eye !== undefined) {
      const local = beam.toLocal(eye)
      eyeX = local.x
      lift = from.y - local.y
    }
    const redraw = (): void => {
      beam.clear()
      const hx = from.x + (end.x - from.x) * state.head
      const hy = from.y + (end.y - from.y) * state.head
      const tx = from.x + (end.x - from.x) * state.tail
      const ty = from.y + (end.y - from.y) * state.tail
      beam.lineStyle(6, 0x1a3a44, 0.35).moveTo(tx, ty + 2).lineTo(hx, hy + 2)
      const lx = (x: number, k: number): number => x + (eyeX - from.x) * (1 - k)
      beam.lineStyle(3, 0x88ffff, 0.95).moveTo(lx(tx, state.tail), ty - lift).lineTo(lx(hx, state.head), hy - lift)
    }

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
