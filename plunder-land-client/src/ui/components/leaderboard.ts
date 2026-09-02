import { Graphics, Point } from 'pixi.js'
import { ToolKit } from './toolkit'
import axios from 'axios'
import { SERVER_URL } from '../../config'

export class Leaderboard extends Graphics {
  label

  constructor () {
    super()
    this.label = ToolKit.createText('test', new Point(0, 0), 20)
    this.label.style.fill = 'black'
    this.label.anchor = ToolKit.TOP_LEFT_ANCHOR
    this.label.x = 10

    this.addChild(this.label)
    void this.refresh()

    window.addEventListener('resize', this.onResize.bind(this))
    this.onResize()
  }

  async refresh (): Promise<void> {
    // Keep polling even if a request fails: an unhandled rejection here used to
    // kill the refresh loop permanently for the rest of the session.
    try {
      const response = await axios.get(`${SERVER_URL}/stats`)
      this.setData(response.data)
    } catch (e) {
      console.warn('leaderboard', e)
    }

    setTimeout(() => { void this.refresh() }, 3000)
  }

  setData (value: Record<string, { kills: number, mobKills: number, bossKills: number, games: number, lootCollected: number, lifeTime: number }>): void {
    const lines = ['Leaderboard:']
    for (const playerId in value) {
      lines.push(`${playerId.slice(-6)}: kills: ${value[playerId].kills}`)
    }

    this.label.text = lines.join('\n')
    this
      .clear()
      .beginFill(0xA39171, 0.4)
      .drawRect(0, 0, this.label.width + 20, this.label.height + 10)
      .endFill()

    this.onResize()
  }

  onResize (): void {
    this.x = window.innerWidth - this.width - 10
    this.y = 10
  }
}
