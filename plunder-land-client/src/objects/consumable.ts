import { GameObject } from './gameobject'
import { Sprite, Texture } from 'pixi.js'

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

    // At its baked size, on its baked ground point (the frame's anchor).
    this.main = new Sprite(texture)
    // A cast shadow like a stone's, laid to the bottom right (Nick,
    // 2026-10-02: "skewed silhouette for loot"). It was a contact ellipse,
    // for fear the crystal's baked glow would come out as a dark smear.
    const shadow = this.createShadow(texture)
    shadow.y = -(1 - this.main.anchor.y) * texture.frame.height
    this.addChild(shadow)
    this.addChild(this.main)

    this.DEBUG_DRAW_COLLIDER()
  }
}
