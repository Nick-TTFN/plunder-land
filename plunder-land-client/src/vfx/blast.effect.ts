import AnimationClip from '../animation/animationclip'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { BLAST_RINGS, discCells } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { type Container } from 'pixi.js'

/** The blast clips' frame, in logical px (`blasts.json`, 256 px at scale 2). */
const BLAST_FRAME = 128

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
    playBlast(layer, cell, BLAST_RINGS, icy ? 'fx/blast_ice' : 'fx/blast_fire')
  }
}

/**
 * One blast clip on `cell`, sized so its frame spans the disc of `rings`
 * around it, played once and removed. The art grows inside a fixed frame,
 * so nothing here tweens its scale (INTEGRATION.md: no second growth curve).
 */
export function playBlast (layer: Container, cell: Vector, rings: number, clip: string): void {
  const at = Hex.toPosition(cell)
  const expl = new AnimationClip(clip)
  expl.x = at.x
  expl.y = at.y
  expl.zIndex = at.y + 1
  expl.scale.set((2 * rings + 1) * Hex.SIZE / BLAST_FRAME)
  expl.onComplete = () => {
    expl.parent?.removeChild(expl)
    expl.destroy()
  }
  layer.addChild(expl)
  expl.play()
}
