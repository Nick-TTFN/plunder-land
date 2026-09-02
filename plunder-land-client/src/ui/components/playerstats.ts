import { Container, Point, Graphics, Text } from 'pixi.js'

export class PlayerStats extends Container {
  level: number
  LEVEL_THRESHOLDS: number[]
  lootLabel: Text
  // graphics: Graphics
  constructor () {
    super()

    this.level = 0
    this.LEVEL_THRESHOLDS = [100, 300, 750, 1500]

    this.lootLabel = new Text('0', {
      fontFamily: '"Trebuchet MS", Helvetica, sans-serif',
      fontSize: 10,
      fill: 'white',
      stroke: 'black',
      strokeThickness: 1
    })

    this.lootLabel.x = 32
    this.lootLabel.anchor = new Point(0.5, 0)

    const loot = new Container()
    this.addChild(loot)

    // this.graphics = new Graphics()
    // this.graphics.alpha = 0.4
    // loot.addChild(this.graphics)
    loot.y = 70
    loot.addChild(this.lootLabel)
  }

  update (data: { level: number, loot: number }): void {
    if (data?.level !== undefined) { this.level = data.level }

    // this.graphics.clear()
    // this.graphics.beginFill(0x000000).drawRect(0, 0, 64, 16).endFill()

    if (data?.loot !== undefined) {
      // const progress = data.loot / this.LEVEL_THRESHOLDS[this.level]
      this.lootLabel.text = 'collected: ' + data.loot.toString()
      // this.graphics.beginFill(0x880088).drawRect(0, 0, 64 * progress, 16).endFill()
    }
  }
}
