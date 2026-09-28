import { Graphics, Sprite, Texture } from 'pixi.js'
import { GameObject } from './gameobject'
import { type ItemInfo } from '../utils/items'

/** Each kind's ground sprite and inventory icon in the arena sheet, by `ItemInfo.key`. */
const ART: Record<string, { ground: string, icon: string }> = {
  medkit: { ground: 'map/medkit.png', icon: 'ui/item_medkit.png' },
  bomb: { ground: 'map/bomb.png', icon: 'ui/item_bomb.png' }
}

/**
 * A usable item lying on the ground: a medkit or a bomb (decision #12), drawn
 * with the arena art (2026-09-28), the same drawing as its inventory icon. A
 * kind this build doesn't know draws a grey disc rather than nothing.
 */
export class ItemPickup extends GameObject {
  readonly info: ItemInfo | undefined

  constructor (info: ItemInfo | undefined, radius: number | undefined) {
    super()
    this.info = info
    if (radius !== undefined) this.radius = radius
    const r = this.radius

    // A shadow, so it reads as lying on the ground like the loot does.
    this.addChild(new Graphics().beginFill(0x000000, 0.3).drawEllipse(0, 0, r * 0.75, r * 0.3).endFill())

    const art = info !== undefined ? ART[info.key] : undefined
    if (art !== undefined) {
      // At its baked size on its baked ground point (the frame's anchor).
      this.main = new Sprite(Texture.from(art.ground))
      this.addChild(this.main)
    } else {
      this.addChild(new Graphics().lineStyle(2, 0x000000, 1).beginFill(0x9a9a9a).drawCircle(0, -r * 0.6, r * 0.6).endFill())
    }
    this.DEBUG_DRAW_COLLIDER()
  }

  /** The inventory slot icon (`ui/components/inventory.ts`), or undefined for a kind with no art. */
  static icon (info: ItemInfo | undefined): Texture | undefined {
    const art = info !== undefined ? ART[info.key] : undefined
    return art !== undefined ? Texture.from(art.icon) : undefined
  }
}
