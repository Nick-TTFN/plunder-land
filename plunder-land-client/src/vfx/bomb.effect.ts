import TWEEN from '@tweenjs/tween.js'
import { type Vector } from '../utils/vector'
import { ITEM_INFO } from '../utils/items'
import { discCells } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { playBlast } from './blast.effect'

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

    playBlast(layer, cell, ITEM_INFO.bomb.rings, 'fx/blast_fire')
  }

  /**
   * The doomed cells, pulsing faster as the fuse runs down, gone when it ends.
   * Also the Kiln's landing marker (`kilnlob.effect.ts`, #51 l1-4).
   */
  static fuse (tag: number | undefined, cells: Array<{ x: number, y: number }>, lifetime: number, colour: number = FUSE_COLOUR): void {
    const layer = layerOf(tag)
    if (layer === undefined) return

    const highlight = new CellHighlight(colour, 0.35)
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
