import { Container, Graphics, Point, type Text } from 'pixi.js'
import { ToolKit } from './toolkit'

export class LoaderOverlay extends Container {
  dimmer: Graphics
  text: Text

  constructor () {
    super()

    this.dimmer = new Graphics().beginFill(0, 0.5).drawRect(0, 0, 1000, 1000).endFill()
    this.addChild(this.dimmer)

    this.text = ToolKit.createText('please wait..')
    this.addChild(this.text)

    this.visible = false
    this.eventMode = 'static'
  }

  enable (): void {
    this.visible = true
    this.eventMode = 'static'
  }

  disable (): void {
    this.visible = false
    this.eventMode = 'auto'
  }

  resize (width: number, height: number): void {
    this.dimmer.width = width
    this.dimmer.height = height
    this.text.position = new Point(width / 2, height / 2)
  }
}
