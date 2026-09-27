import { GameObject } from './gameobject'
import { Sprite, Point, Texture, ObservablePoint } from 'pixi.js'
import { namePlate } from '../ui/elements/nameplate'
import { THEME } from '../ui/theme'

export class Exit extends GameObject {
  constructor (radius: number) {
    super()

    this.radius = radius
    const texture = Texture.from('exit.png')
    const targetScale = (radius * 2) / texture.frame.width

    this.main = new Sprite(texture)
    this.main.scale = new Point(targetScale, targetScale)
    this.main.anchor = new ObservablePoint(() => {}, 0, 0.5, 0.5)

    this.addChild(this.main)

    // "EXTRACT" under the pad, as the mockup (world-markers): exits are marked
    // through fog (#16), and this is what says what the pad is.
    const label = namePlate('EXTRACT', THEME.hp, THEME.hp, 12)
    label.y = radius + 2
    this.addChild(label)

    this.DEBUG_DRAW_COLLIDER()
  }
}
