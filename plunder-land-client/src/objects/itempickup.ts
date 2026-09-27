import { Graphics } from 'pixi.js'
import { GameObject } from './gameobject'
import { type ItemInfo } from '../utils/items'

/**
 * A usable item lying on the ground: a medkit or a bomb (decision #12).
 *
 * Drawn with `Graphics`, because the atlas has no item art (a name missing
 * from the atlas throws on every use; `textures.spec.ts`). A medkit is a white
 * box with a red cross, a bomb a dark ball with a lit fuse, and a kind this
 * build doesn't know a grey disc. Real sprites are wanted (Nick's boundary).
 */
export class ItemPickup extends GameObject {
  readonly info: ItemInfo | undefined

  constructor (info: ItemInfo | undefined, radius: number | undefined) {
    super()
    this.info = info
    if (radius !== undefined) this.radius = radius
    const r = this.radius

    const g = new Graphics()
    // A shadow, so it reads as lying on the ground like the loot does.
    g.beginFill(0x000000, 0.3).drawEllipse(0, r * 0.7, r * 0.9, r * 0.35).endFill()

    ItemPickup.drawIcon(g, info, r)

    this.addChild(g)
    this.DEBUG_DRAW_COLLIDER()
  }

  /**
   * The item's placeholder icon, centred on (0, 0) at size `r`, into `g`. Also
   * the inventory slot icon (`ui/components/inventory.ts`), so the two match
   * until the art pass replaces both.
   */
  static drawIcon (g: Graphics, info: ItemInfo | undefined, r: number): void {
    switch (info?.key) {
      case 'medkit': {
        const s = r * 1.3
        g.lineStyle(2, 0x5a0d0d, 1)
        g.beginFill(0xf4f1ea).drawRoundedRect(-s / 2, -s / 2, s, s, 4).endFill()
        g.lineStyle(0)
        const arm = s * 0.22
        g.beginFill(0xd8262b)
          .drawRect(-arm / 2, -s * 0.35, arm, s * 0.7)
          .drawRect(-s * 0.35, -arm / 2, s * 0.7, arm)
          .endFill()
        break
      }
      case 'bomb':
        g.lineStyle(2, 0x000000, 1)
        g.beginFill(0x2b2b33).drawCircle(0, 0, r * 0.7).endFill()
        g.lineStyle(3, 0x8a6a3a, 1).moveTo(r * 0.35, -r * 0.55).lineTo(r * 0.6, -r * 0.95)
        g.lineStyle(0)
        g.beginFill(0xffb02e).drawCircle(r * 0.62, -r * 1.0, 3).endFill()
        break
      default:
        g.lineStyle(2, 0x000000, 1)
        g.beginFill(0x9a9a9a).drawCircle(0, 0, r * 0.6).endFill()
    }
  }
}
