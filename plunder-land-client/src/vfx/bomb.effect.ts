import TWEEN from '@tweenjs/tween.js'
import AnimationClip from '../animation/animationclip'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { ITEM_INFO } from '../utils/items'
import { discCells } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'

const FUSE_COLOUR = 0xff3b1f
const BLAST_COLOUR = 0xffa21f

/**
 * A bomb (balance pass section 1 "Items"): its fuse and its blast, on the disc
 * of `ITEM_INFO.bomb.rings` rings around the bomb's cell, which is exactly the
 * set the server damages (`World.FIND_IN_CELLS`, `Hex.distance <= rings`).
 *
 * `blast` false is the fuse (effect type 7): the doomed cells pulse for
 * `lifetime` ms, the fuse, and are then removed. The blast (type 8) arrives as
 * its own record when the server detonates, so the explosion is drawn when the
 * damage lands and not on a client-side guess of when that is. A viewer who
 * comes into range mid-fuse sees only the blast.
 */
export class BombEffect {
  constructor (cell: Vector, tag: number | undefined, blast: boolean, lifetime: number) {
    const cells = discCells(cell, ITEM_INFO.bomb.rings)

    if (!blast) {
      BombEffect.fuse(tag, cells, lifetime)
      return
    }

    CellHighlight.flash(tag, cells, BLAST_COLOUR, Math.max(lifetime, 300))
    const layer = layerOf(tag)
    if (layer === undefined) return

    for (const c of cells) {
      const at = Hex.toPosition(new Vector(c.x, c.y))
      const centre = c.x === cell.x && c.y === cell.y
      setTimeout(() => {
        const expl = new AnimationClip('explosion/expl')
        expl.x = at.x
        expl.y = at.y
        expl.zIndex = at.y + 1
        const size = centre ? 1.8 : 1.1
        expl.scale.set(size, size)
        layer.addChild(expl)
        expl.play()
        new TWEEN.Tween(expl.scale)
          .to({ x: 0, y: 0 }, 550)
          .onComplete(() => {
            expl.parent?.removeChild(expl)
            expl.destroy()
          })
          .start()
      }, centre ? 0 : 40 + 80 * Math.random())
    }
  }

  /** The doomed cells, pulsing faster as the fuse runs down, gone when it ends. */
  private static fuse (tag: number | undefined, cells: Array<{ x: number, y: number }>, lifetime: number): void {
    const layer = layerOf(tag)
    if (layer === undefined) return

    const highlight = new CellHighlight(FUSE_COLOUR, 0.35)
    highlight.draw(cells)
    layer.addChild(highlight)

    const duration = Math.max(lifetime, 100)
    const state = { t: 0 }
    new TWEEN.Tween(state)
      .to({ t: 1 }, duration)
      .onUpdate(() => {
        // From about 2 pulses a second to about 8, so the last moment reads.
        const phase = state.t * (2 + 6 * state.t) * (duration / 1000) * Math.PI * 2
        highlight.alpha = 0.55 + 0.45 * Math.sin(phase)
      })
      .onComplete(() => {
        highlight.parent?.removeChild(highlight)
        highlight.destroy()
      })
      .start()
  }
}
