import { Container, Graphics, Text } from 'pixi.js'
import { THEME } from '../theme'
import { UnitBar } from './unitbar'

/**
 * A player's panel over its head: the name (YOU for your own robot), and
 * under it the hp bar and the armor bar (Nick, 2026-10-01: the YOU plate moved
 * above the robot, with the bars in it). Its bottom centre is at y = 0, so the
 * owner places it by the top of its head. The bars keep a fixed width; a long
 * name widens the box, not the bars. Placeholder look, like `namePlate`.
 */
export class UnitPanel extends Container {
  static readonly BAR_W = 40
  static readonly HP_H = 4
  static readonly ARMOR_H = 3
  static readonly PAD_X = 4
  static readonly PAD_Y = 2

  readonly hp = new UnitBar(UnitPanel.BAR_W, THEME.hp, UnitPanel.HP_H)
  readonly armor = new UnitBar(UnitPanel.BAR_W, THEME.armor, UnitPanel.ARMOR_H)
  private readonly bg = new Graphics()
  private readonly text = new Text('', { fontFamily: THEME.font, fontSize: 11, fontWeight: 'bold', fill: 0xBFE3FF })

  constructor () {
    super()
    this.eventMode = 'none'
    this.addChild(this.bg, this.text, this.hp, this.armor)
    this.setName('', false)
  }

  /** The name and whose it is: your own in the accent colour, others pale blue. */
  setName (value: string, own: boolean): void {
    const { PAD_X, PAD_Y, BAR_W, HP_H, ARMOR_H } = UnitPanel
    this.text.text = value
    this.text.style.fill = own ? THEME.accent : 0xBFE3FF
    const textH = value === '' ? 0 : Math.ceil(this.text.height)
    const w = Math.max(BAR_W, Math.ceil(this.text.width)) + 2 * PAD_X
    // The bars' 1 px dark frame sits outside them: leave room for it.
    const h = PAD_Y + textH + 1 + HP_H + 3 + ARMOR_H + 1 + PAD_Y
    const top = -h
    this.text.x = -Math.ceil(this.text.width) / 2
    this.text.y = top + PAD_Y
    this.hp.x = -BAR_W / 2
    this.hp.y = top + PAD_Y + textH + 1
    this.armor.x = -BAR_W / 2
    this.armor.y = this.hp.y + HP_H + 3
    this.bg.clear()
      .beginFill(THEME.panelFill, 0.8)
      .lineStyle(1, own ? THEME.accent : THEME.panelBorder, 0.9)
      .drawRoundedRect(-w / 2, top, w, h, 3)
      .endFill()
  }

  /** Armor over its pool; a unit without one shows an empty track. */
  setArmor (armor: number, maxArmor: number): void {
    this.armor.setValue(maxArmor > 0 ? armor / maxArmor : 0)
  }
}
