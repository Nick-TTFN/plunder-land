import { Point, Sprite, type Texture } from 'pixi.js'
import { GameObject } from './gameobject'
import { HexTerrain } from './hexterrain'
import { Hex } from '../utils/hex'

/**
 * A rock, tree or ruin standing on one blocked cell.
 *
 * Nothing here derives a size from the collider any more. The old art was
 * fitted with `radius * 3 / texture.width`, which was the only way to get a
 * consistent scale out of sprites drawn at 16, 32, 64 and 128 px - and it meant
 * a boulder and a shrub ended up the same size on screen because the collider
 * was the same. The props are now baked against the cell they sit on, so the
 * artist's own proportions are the right ones and the only scaling left is the
 * one that corrects a `Hex.SIZE` that has moved away from the bake.
 */
export class Obstacle extends GameObject {
  shadow: Sprite

  constructor (texture: Texture, radius: number) {
    super()
    this.radius = radius

    const scale = Hex.SIZE / HexTerrain.BAKED_FOR

    this.shadow = this.createShadow(texture)
    this.shadow.scale = new Point(scale * 1.1, scale * 1.1)
    this.addChild(this.shadow)

    this.main = new Sprite(texture)
    this.main.scale = new Point(scale, scale)
    this.main.anchor.x = 0.5
    // Based on the cell centre, not on the far edge of the cell. A unit stands
    // with its feet at its position, so anything else puts obstacles and units
    // on two different ground lines and the depth sort by `y` stops agreeing
    // with what the eye sees.
    this.main.anchor.y = 1

    this.addChild(this.main)
  }
}
