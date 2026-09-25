import { GameObject } from './gameobject'
import { Sprite, Point, Texture, ObservablePoint, Text } from 'pixi.js'

export class Portal extends GameObject {
  /**
   * `up` points the arrow toward the surface. `destination` is the layer
   * number the portal leads to (1 = layer 01), shown as a label above it;
   * undefined for a tag this client was not told about, which draws no label.
   */
  constructor (radius: number, up: boolean, destination?: number) {
    super()

    this.radius = radius
    const texture = Texture.from('portal.png')
    const targetScale = (radius * 2) / texture.frame.width

    this.main = new Sprite(texture)
    this.main.scale = new Point(targetScale, targetScale)
    this.main.anchor = new ObservablePoint(() => {}, 0, 0.5, 0.5)

    if (!up) { this.main.rotation = Math.PI }

    this.addChild(this.main)

    if (destination !== undefined) {
      // Text, not art: a placeholder until there is a sign for it.
      const label = new Text(`LAYER ${String(destination).padStart(2, '0')}`, {
        fontFamily: '"Trebuchet MS", Helvetica, sans-serif',
        fontSize: 12,
        fontWeight: 'bold',
        fill: 'white',
        stroke: 'black',
        strokeThickness: 3
      })
      label.anchor.set(0.5, 1)
      label.y = -radius - 4
      this.addChild(label)
    }

    this.DEBUG_DRAW_COLLIDER()
  }
}
