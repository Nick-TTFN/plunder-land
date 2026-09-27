import { Graphics, type Text } from 'pixi.js'
import { Panel, Bar } from './panel'
import { Inventory } from './inventory'
import { THEME } from '../theme'
import { Game } from '../../game'

const BAR_W = 230
const BAR_H = 12
const ROW = 30

/**
 * The mockup's top-left panel: the mode title and carried loot, the HP and
 * armor bars with their numbers, and the inventory slots. Reads the local
 * player every frame (`update`) and redraws only what changed, so no update
 * path has to remember to call it; `Game.hud.updateStats` and the inventory
 * update still arrive as before.
 */
export class StatusPanel extends Panel {
  readonly inventory = new Inventory()
  private readonly _lootLabel: Text
  private readonly _loot: Text
  private readonly _hpBar = new Bar(BAR_W, BAR_H, THEME.hp)
  private readonly _hpText: Text
  private readonly _armorBar = new Bar(BAR_W, BAR_H, THEME.armor)
  private readonly _armorText: Text
  private readonly _armorRow: Graphics
  private _shown = { loot: NaN, hp: NaN, maxHp: NaN, armor: NaN, maxArmor: NaN }

  constructor () {
    super('HEX / EXTRACTION')

    this._lootLabel = Panel.text('LOOT', THEME.smallSize, THEME.muted)
    this._loot = Panel.text('0', THEME.titleSize, THEME.loot)
    this._loot.anchor.set(1, 0)
    this.addChild(this._lootLabel, this._loot)

    const heart = StatusPanel.heart(THEME.hp)
    heart.y = BAR_H / 2
    this._hpBar.x = 26
    this._hpText = Panel.text('', THEME.bodySize, THEME.text)
    this._hpText.x = 26 + BAR_W + 14
    this._hpText.y = -4

    this._armorRow = StatusPanel.shield(THEME.armor)
    this._armorRow.y = ROW + BAR_H / 2
    this._armorBar.x = 26
    this._armorBar.y = ROW
    this._armorText = Panel.text('', THEME.bodySize, THEME.text)
    this._armorText.x = 26 + BAR_W + 14
    this._armorText.y = ROW - 4

    const label = Panel.text('INVENTORY', THEME.bodySize, THEME.muted)
    label.y = ROW * 2 + 14
    this.inventory.y = label.y + 32

    this.body.addChild(heart, this._hpBar, this._hpText, this._armorRow, this._armorBar, this._armorText, label, this.inventory)
    // Sized for the widest numbers it will show, so a 3-digit pool doesn't
    // run past the edge (update fills the real values straight after).
    this._hpText.text = this._armorText.text = '999 / 999'
    this.fit(360)
    this.layoutHeader()
    this.update()
  }

  private layoutHeader (): void {
    this._loot.x = this.panelWidth - THEME.pad
    this._loot.y = THEME.pad - 2
    this._lootLabel.x = this._loot.x - this._loot.width - 8 - this._lootLabel.width
    this._lootLabel.y = THEME.pad + 4
  }

  update (): void {
    const player = Game.PLAYER
    if (player === undefined) return
    const loot = player.loot ?? 0
    const hp = Math.max(0, player.hp ?? 0)
    const maxHp = player.maxHP
    const shown = this._shown
    if (loot !== shown.loot) {
      shown.loot = loot
      this._loot.text = loot.toLocaleString('en-US')
      this.layoutHeader()
    }
    if (hp !== shown.hp || maxHp !== shown.maxHp) {
      shown.hp = hp
      shown.maxHp = maxHp
      this._hpBar.setValue(hp, maxHp)
      this._hpText.text = `${Math.ceil(hp)} / ${maxHp}`
    }
    if (player.armor !== shown.armor || player.maxArmor !== shown.maxArmor) {
      shown.armor = player.armor
      shown.maxArmor = player.maxArmor
      // No pool, no row: a robot without armor shows only HP.
      const has = player.maxArmor > 0
      this._armorRow.visible = this._armorBar.visible = this._armorText.visible = has
      this._armorBar.setValue(player.armor, player.maxArmor)
      this._armorText.text = `${player.armor} / ${player.maxArmor}`
    }
  }

  /** Placeholder icons until the art pass. */
  static heart (colour: number): Graphics {
    return new Graphics()
      .beginFill(colour)
      .drawCircle(5, -2, 5)
      .drawCircle(13, -2, 5)
      .drawPolygon([0.5, 0, 17.5, 0, 9, 9])
      .endFill()
  }

  static shield (colour: number): Graphics {
    return new Graphics()
      .beginFill(colour)
      .drawPolygon([9, -9, 17, -6, 16, 3, 9, 9, 2, 3, 1, -6])
      .endFill()
  }
}
