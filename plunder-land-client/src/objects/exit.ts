import { GameObject } from './gameobject'
import { Sprite, Texture } from 'pixi.js'
import { namePlate } from '../ui/elements/nameplate'
import { PAD_HEIGHT, shadowOffset } from './shadow'
import { THEME } from '../ui/theme'

export class Exit extends GameObject {
  /**
   * The arena's extraction pad (art pass 2026-09-28): baked already squashed
   * for the tilted camera, drawn at its baked size on its centre, with its
   * middle left empty for the extraction ring.
   */
  constructor (radius: number) {
    super()

    this.radius = radius
    const texture = Texture.from('map/extract_pad.png')
    this.main = new Sprite(texture)
    // Its shadow: a black copy offset under it the way every shadow falls.
    const shadow = this.createSilhouette(texture)
    const offset = shadowOffset(PAD_HEIGHT)
    shadow.position.set(offset.x, offset.y)
    this.addChild(shadow)
    this.addChild(this.main)

    // "EXTRACT" under the pad, as the mockup (world-markers): exits are marked
    // through fog (#16), and this is what says what the pad is.
    const label = namePlate('EXTRACT', THEME.hp, THEME.hp, 12)
    label.y = texture.frame.height / 2 + 2
    this.addChild(label)

    this.DEBUG_DRAW_COLLIDER()
  }
}
