import { Container, Point, type Sprite, type Text, Texture } from 'pixi.js'
import { TapHandler } from '../elements/taphandler'
import AnimationClip from '../../animation/animationclip'
import { ToolKit } from '../components/toolkit'

export default class GameEnterPopup extends Container {
  callback: (playerId: string) => Promise<void>
  bg: Sprite
  container: Container
  title: Text

  constructor (callback: (playerId: string) => Promise<void>) {
    super()
    this.callback = callback

    this.container = new Container()
    this.addChild(this.container)
    this.bg = ToolKit.createSprite(Texture.from('UI/elements/bg.png'), new Point(0, 0), new Point(2, 2), ToolKit.TOP_LEFT_ANCHOR)
    this.container.addChild(this.bg)

    this.container.x = -this.bg.width / 2
    this.container.y = -this.bg.height / 2

    this.title = ToolKit.createText('PLUNDERLAND', new Point(this.bg.width / 2, 35))
    this.container.addChild(this.title)

    const playerPanel = new Container()
    playerPanel.position = new Point((this.bg.width - playerPanel.width) / 2, 110)

    playerPanel.addChild(ToolKit.createSprite(Texture.from('UI/elements/cell.png'), new Point(0, 0), new Point(2, 2)))

    const playerAnim = new AnimationClip('player/idle/idle', 0.2, true)
    playerAnim.play()
    playerPanel.addChild(playerAnim)

    this.container.addChild(playerPanel)

    this.checkState()
  }

  genRanHex = (size: number): string => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

  checkState (): void {
    let playerId = localStorage.getItem('plunderland_player_id')

    if (playerId === null) {
      playerId = this.genRanHex(6)
      localStorage.setItem('plunderland_player_id', playerId)
    }

    this.title.text = playerId

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const startButton = new TapHandler(this.onStartClick.bind(this))

    startButton.addChild(ToolKit.createSprite(Texture.from('UI/elements/button.png'), new Point(0, 0), new Point(1, 1)))
    startButton.addChild(ToolKit.createText('start'))

    startButton.position = new Point((this.bg.width) / 2, (this.bg.height) - 45)
    this.container.addChild(startButton)
  }

  onStartClick (): void {
    const playerId = localStorage.getItem('plunderland_player_id')
    if (playerId !== null) void this.callback(playerId)
    this.parent?.removeChild(this)
  }
}
