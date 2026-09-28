import { Sprite, type Texture } from 'pixi.js'
import { GameObject } from './gameobject'

/**
 * A StoneWall stone standing on one blocked cell: the arena crate (art pass
 * 2026-09-28), the only obstacle since the valleys replaced world rocks.
 *
 * Drawn at its baked size on its baked ground point (the frame's anchor from
 * `tools/bake-arena-atlas.py`), which is the cell centre. Nothing derives a
 * size from the collider: the old art was fitted with `radius * 3 /
 * texture.width`, and a boulder and a shrub came out the same size.
 */
export class Obstacle extends GameObject {
  shadow: Sprite

  constructor (texture: Texture, radius: number) {
    super()
    this.radius = radius

    this.main = new Sprite(texture)
    // The shadow's base on the sprite's: the ground point sits above the
    // frame's bottom edge by the anchor's remainder.
    this.shadow = this.createShadow(texture)
    this.shadow.y = -(1 - this.main.anchor.y) * texture.frame.height
    this.addChild(this.shadow)
    // Based on the cell centre, not on the far edge of the cell. A unit stands
    // with its feet at its position, so anything else puts obstacles and units
    // on two different ground lines and the depth sort by `y` stops agreeing
    // with what the eye sees.
    this.addChild(this.main)
  }
}
