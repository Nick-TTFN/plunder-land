import { Texture, AnimatedSprite, Point, Assets } from 'pixi.js'

/**
 * The sheets a clip can come from, searched in order. The character atlas
 * first; the arena sheets (`tools/bake-arena-atlas.py`) hold the effects and
 * carry each clip's frame rate and loop in `meta.clips`.
 */
const SHEETS = ['./res/atlas.json', './res/arena.json', './res/blasts.json']

/** The drop's frame rate for a clip, if its sheet has one. */
function clipMeta (sheet: any, name: string): { fps: number, loop: boolean } | undefined {
  return sheet?.data?.meta?.clips?.[name]
}

export default class AnimationClip extends AnimatedSprite {
  tex: Texture[]

  /**
   * `speed` is pixi's, frames per 60 Hz frame; left out, it is the sheet's own
   * fps for the clip (or 0.5). `loop` likewise. `anchor` left out keeps each
   * frame's baked anchor (the arena sheets carry the drop's pivots), which is
   * the centre for every atlas clip.
   */
  constructor (
    framesetName: string,
    speed?: number,
    loop?: boolean,
    anchor?: Point
  ) {
    const sheet = SHEETS.map((s) => Assets.get(s)).find((s) => s?.data?.animations?.[framesetName] !== undefined)
    const tex = new Array<Texture>()
    for (const frame of sheet.data.animations[framesetName]) { tex.push(Texture.from(frame)) }

    super(tex, true)
    this.tex = tex
    const meta = clipMeta(sheet, framesetName)
    if (anchor !== undefined) this.anchor = anchor
    else if (meta === undefined) this.anchor = new Point(0.5, 0.5)
    this.animationSpeed = speed ?? (meta !== undefined ? meta.fps / 60 : 0.5)
    this.loop = loop ?? meta?.loop ?? false
  }
}
