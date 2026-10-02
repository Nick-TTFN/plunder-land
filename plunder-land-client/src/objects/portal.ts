import { GameObject } from './gameobject'
import { Sprite, Texture } from 'pixi.js'
import { namePlate } from '../ui/elements/nameplate'
import { PAD_HEIGHT, shadowOffset } from './shadow'

export class Portal extends GameObject {
  /**
   * `up` points the arrow toward the surface. `destination` is the layer
   * number the portal leads to (1 = layer 01), shown as a plate under it;
   * undefined for a tag this client was not told about, which draws no label.
   *
   * The arena's floor portal (art pass 2026-09-28) is baked already squashed
   * for the tilted camera and stands up like everything else, so it is drawn
   * at its baked size on its centre. Direction is the separate arrow overlay
   * in the aperture; the portal itself is never rotated.
   */
  constructor (radius: number, up: boolean, destination?: number) {
    super()

    this.radius = radius
    const texture = Texture.from('map/portal.png')
    this.main = new Sprite(texture)
    // Its shadow: a black copy offset under it the way every shadow falls.
    const shadow = this.createSilhouette(texture)
    const offset = shadowOffset(PAD_HEIGHT)
    shadow.position.set(offset.x, offset.y)
    this.addChild(shadow)
    this.addChild(this.main)

    const arrow = new Sprite(Texture.from(up ? 'map/portal_up.png' : 'map/portal_down.png'))
    this.addChild(arrow)

    if (destination !== undefined) {
      // Under the portal in a violet plate, as the mockup (world-markers).
      const label = namePlate(`LAYER ${String(destination).padStart(2, '0')}`, 0xD9C8FF, 0x8A5CFF, 12)
      label.y = texture.frame.height / 2 + 2
      this.addChild(label)
    }

    this.DEBUG_DRAW_COLLIDER()
  }
}
