import { TapHandler } from '../elements/taphandler'
import { Sprite, Point, Text, Container, Texture } from 'pixi.js'
import { Joystick } from './joystick'
import { PlayerStats } from './playerstats'
import { MiniMap } from './minimap'
import { type Skill } from '../../skills/skill'
import { ToolKit } from './toolkit'

export class HUD extends Container {
  controlsMap = new Map<string, TapHandler>()
  map: MiniMap | undefined
  joystick: Joystick | undefined
  playerStats: PlayerStats | undefined
  skillBar: Container | undefined
  constructor () {
    super()

    window.addEventListener('keydown', this.onKeyDown.bind(this), false)
    window.addEventListener('resize', this.updateLayout.bind(this))

    this.updateLayout()
  }

  setupGameUI (): void {
    this.map = new MiniMap(200, 200, 0.3)
    this.addChild(this.map)

    this.joystick = new Joystick(60)
    this.addChild(this.joystick)
  }

  setupStats (): void {
    if (this.playerStats != null) return
    this.playerStats = new PlayerStats()
    this.addChild(this.playerStats)
  }

  updateStats (data: { level: number, loot: number }): void {
    if (this.playerStats == null) return
    this.playerStats.update(data)
  }

  setupSkills (value: any[]): void {
    const keys = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i']

    this.skillBar = new Container()
    for (const skill of value) {
      const key = keys.shift()
      if (key === undefined) { continue }
      const btn = this.createSkillButton(skill, key, 60, 60)
      this.skillBar.addChild(btn)
    }

    this.updateLayout()
    this.addChild(this.skillBar)
  }

  createSkillButton (skill: Skill, key: string, width: number, height: number): TapHandler {
    const btn = new TapHandler(
      skill.execute.bind(skill),
      skill.cooldown,
      width,
      height,
      0x00000000
    )

    const bg = new Sprite(Texture.from('UI/elements/cell.png'))
    bg.anchor = ToolKit.CENTER_ANCHOR
    bg.scale = new Point(2, 2)
    btn.addChild(bg)

    const sprite = new Sprite(skill.uiTexture)
    sprite.anchor = ToolKit.CENTER_ANCHOR
    const scale = Math.min(
      width / skill.uiTexture.frame.width,
      height / skill.uiTexture.frame.height
    )
    sprite.scale = new Point(scale, scale)
    btn.addChild(sprite)
    const btnLabel = new Text(key.toUpperCase(), {
      fontFamily: 'Lilliput Steps',
      fontSize: 32,
      fill: '0xA39171',
      stroke: 'black',
      strokeThickness: 8
    })
    btnLabel.x = -btnLabel.width + 2
    btnLabel.y = height / 2 - btnLabel.height

    btn.addChild(btnLabel)
    this.controlsMap.set(key, btn)
    return btn
  }

  updateLayout (): void {
    if (this.map != null) {
      this.map.x = 20
      this.map.y = 20
    }

    if (this.joystick != null) {
      this.joystick.x = 120
      this.joystick.y = window.innerHeight - 120
    }

    if (this.playerStats != null) {
      this.playerStats.x = window.innerWidth - 84
      this.playerStats.y = 20
    }

    if (this.skillBar != null) {
      for (let i = 0; i < this.skillBar.children.length; i++) {
        this.skillBar.children[i].x = -80 * i
      }
      this.skillBar.x = window.innerWidth - 100
      this.skillBar.y = window.innerHeight - 100
    }
  }

  onKeyDown (e: { key: string }): void {
    this.invokeKeyBoundSkill(e.key)
  }

  invokeKeyBoundSkill (value: string): void {
    if (this.controlsMap.has(value)) {
      this.controlsMap.get(value)?.invoke()
    }
  }

  update (dt: number): void {
    if (this.map != null) this.map.update(dt)
  }

  clearGameUI (): void {
    if (this.map != null) {
      this.removeChild(this.map)
      this.map = undefined
    }

    if (this.joystick != null) {
      this.removeChild(this.joystick)
      this.joystick = undefined
    }

    if (this.playerStats != null) {
      this.removeChild(this.playerStats)
      this.playerStats = undefined
    }

    if (this.skillBar != null) {
      this.skillBar.removeChildren()
      this.removeChild(this.skillBar)
      this.skillBar = undefined
    }
  }
}
