import { GameObject } from './gameobject'
import { Graphics, Sprite, Texture } from 'pixi.js'

/**
 * A loot crystal. Its size says what it is worth (art pass 2026-09-28): the
 * server sends a pickup's `loot` in its create since then, and a server from
 * before sends none, so the radius (15-25, what a natural pickup's value was
 * based on) stands in for it and draws a small one.
 */
export class Consumable extends GameObject {
  /** Loot below each bound draws the smaller crystal; at or over the last, the large one. */
  static TIERS = [25, 50]
  static TEXTURES = ['map/loot_small.png', 'map/loot_medium.png', 'map/loot_large.png']

  loot: number

  static textureFor (loot: number): Texture {
    const tier = Consumable.TIERS.findIndex((bound) => loot < bound)
    return Texture.from(Consumable.TEXTURES[tier < 0 ? Consumable.TIERS.length : tier])
  }

  constructor (loot: number, radius: number) {
    super()

    this.radius = radius
    this.loot = loot
    const texture = Consumable.textureFor(loot)

    // A contact shadow rather than a silhouette of the sprite: the crystal's
    // baked glow would come out as a dark smear.
    const w = texture.frame.width * 0.35
    const shadow = new Graphics().beginFill(0x000000, 0.3).drawEllipse(0, 0, w, w * 0.4).endFill()
    this.addChild(shadow)

    // At its baked size, on its baked ground point (the frame's anchor).
    this.main = new Sprite(texture)
    this.addChild(this.main)

    this.DEBUG_DRAW_COLLIDER()
  }
}
