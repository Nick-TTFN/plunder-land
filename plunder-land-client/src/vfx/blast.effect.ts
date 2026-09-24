import TWEEN from '@tweenjs/tween.js'
import AnimationClip from '../animation/animationclip'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { BLAST_RINGS, discCells } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'

/**
 * A fireball or icicle bursting: the impact cell and its six neighbours
 * (`BLAST_RINGS`), which is exactly what the server damages (decision #18).
 *
 * The server sends the impact cell as an effect (types 5 and 6) because the
 * client could not work it out: it is the cell of the unit struck, the
 * projectile's destroy record carries no position, and the last position the
 * client has is a tick (75 units) behind the hit. `Throwable.dispose` used to
 * scatter explosions around that stale position; this replaces it.
 *
 * `tag` is the plane to draw on: the caster's, when the client knows the
 * caster, else the viewer's own.
 */
export class BlastEffect {
  constructor (cell: Vector, tag: number | undefined, icy: boolean) {
    const cells = discCells(cell, BLAST_RINGS)
    CellHighlight.flash(tag, cells, icy ? 0x9fe6ff : 0xff8c2a, 450)

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
        if (icy) expl.tint = 0x9fe6ff
        const size = centre ? 1.4 : 0.9
        expl.scale.set(size, size)
        layer.addChild(expl)
        expl.play()
        new TWEEN.Tween(expl.scale)
          .to({ x: 0, y: 0 }, 500)
          .onComplete(() => {
            expl.parent?.removeChild(expl)
            expl.destroy()
          })
          .start()
      }, centre ? 0 : 60 + 60 * Math.random())
    }
  }
}
