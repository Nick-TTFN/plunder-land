import { Graphics, Sprite, Texture, type Text } from 'pixi.js'
import { Panel, Bar } from './panel'
import { Inventory } from './inventory'
import { THEME } from '../theme'
import { Game } from '../../game'

const BAR_W = 230
const BAR_H = 12
const ROW = 30

/**
 * The mockup's top-left panel: the mode title and carried loot, the HP and
 * armor bars with their numbers, and the inventory slots. On a phone
 * (`setCompact`, mobile-4) only the bars and their numbers. Reads the local
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
  private readonly _armorRow: Sprite
  private readonly _lootIcon = StatusPanel.icon('ui/hud_loot.png')
  private readonly _inventoryLabel: Text
  private _inventoryShown = true
  /**
   * The title is this panel's own, not `Panel`'s, so a phone can drop it
   * (`setCompact`); drawn where `Panel` draws one, with the same rule.
   */
  private readonly _heading: Text
  private readonly _rule = new Graphics()
  private _compact = false
  private _shown = { loot: NaN, hp: NaN, maxHp: NaN, armor: NaN, maxArmor: NaN }

  constructor () {
    super()
    this._heading = Panel.text('EXTRACTION', THEME.titleSize, THEME.text)
    this._heading.x = THEME.pad
    this._heading.y = THEME.pad - 2
    this.addChild(this._rule, this._heading)

    this._lootLabel = Panel.text('LOOT', THEME.smallSize, THEME.muted)
    this._loot = Panel.text('0', THEME.titleSize, THEME.loot)
    this._loot.anchor.set(1, 0)
    this.addChild(this._lootIcon, this._lootLabel, this._loot)

    const heart = StatusPanel.icon('ui/hud_heart.png')
    heart.y = BAR_H / 2
    this._hpBar.x = 26
    this._hpText = Panel.text('', THEME.bodySize, THEME.text)
    this._hpText.x = 26 + BAR_W + 14
    this._hpText.y = -4

    this._armorRow = StatusPanel.icon('ui/hud_shield.png')
    this._armorRow.y = ROW + BAR_H / 2
    this._armorBar.x = 26
    this._armorBar.y = ROW
    this._armorText = Panel.text('', THEME.bodySize, THEME.text)
    this._armorText.x = 26 + BAR_W + 14
    this._armorText.y = ROW - 4

    const label = this._inventoryLabel = Panel.text('INVENTORY', THEME.bodySize, THEME.muted)
    label.y = ROW * 2 + 14
    this.inventory.y = label.y + 32

    this.body.addChild(heart, this._hpBar, this._hpText, this._armorRow, this._armorBar, this._armorText, label, this.inventory)
    // Sized for the widest numbers it will show, so a 3-digit pool doesn't
    // run past the edge (update fills the real values straight after).
    this._hpText.text = this._armorText.text = '999 / 999'
    this.refit()
    this.update()
  }

  /** `Panel`'s header height with a title, and without one on a phone (`setCompact`). */
  get headerHeight (): number {
    // Read from Panel's constructor before this class's fields exist: titled then.
    // On a phone the header is just the carried loot (Nick, 2026-11-05: phones must show loot).
    return this._compact === true ? THEME.pad + THEME.titleSize + 6 : THEME.pad + THEME.titleSize + 16
  }

  /**
   * On a phone (`HUD.phone()`, mobile-4): the carried loot (icon and number,
   * no title or LOOT label) above the HP and armor bars with their numbers.
   * Loot stays: it is what an extraction run has at stake (Nick, 2026-11-05).
   * The inventory follows `setInventoryShown` either way.
   */
  setCompact (compact: boolean): void {
    if (compact === this._compact) return
    this._compact = compact
    this._heading.visible = this._lootLabel.visible = !compact
    this.body.y = this.headerHeight
    this.refit()
  }

  /**
   * Whether the inventory (items, gear keys 3-4 and the bag) is drawn here.
   * In touch mode it is not: the radial cluster (`radial.ts`) has those
   * buttons, and the panel shrinks to the bars. The inventory keeps its state
   * and its keys either way.
   */
  setInventoryShown (shown: boolean): void {
    if (shown === this._inventoryShown) return
    this._inventoryShown = shown
    this._inventoryLabel.visible = this.inventory.visible = shown
    this.refit()
  }

  /**
   * Refitted for the widest numbers, as the constructor did, so switching
   * back gives the same box whatever the bars read now; then the rule under
   * the title, as `Panel.resize` draws it.
   */
  private refit (): void {
    const hp = this._hpText.text
    const armor = this._armorText.text
    this._hpText.text = this._armorText.text = '999 / 999'
    this.fit(this._compact ? 0 : 360)
    this._hpText.text = hp
    this._armorText.text = armor
    this._rule.clear()
    if (!this._compact) {
      const y = this.headerHeight - 8
      this._rule.lineStyle(1, THEME.rule, 1).moveTo(THEME.pad, y).lineTo(this.panelWidth - THEME.pad, y)
    }
    this.layoutHeader()
  }

  private layoutHeader (): void {
    if (this._compact) {
      // Left-aligned in the compact header: icon, then the number.
      this._loot.anchor.set(0, 0)
      this._loot.x = THEME.pad + 22
      this._loot.y = THEME.pad - 2
      this._lootIcon.x = THEME.pad + 9
      this._lootIcon.y = this._loot.y + this._loot.height / 2
      return
    }
    this._loot.anchor.set(1, 0)
    this._loot.x = this.panelWidth - THEME.pad
    this._loot.y = THEME.pad - 2
    this._lootLabel.x = this._loot.x - this._loot.width - 8 - this._lootLabel.width
    this._lootLabel.y = THEME.pad + 4
    this._lootIcon.x = this._lootLabel.x - 14
    this._lootIcon.y = this._lootLabel.y + this._lootLabel.height / 2
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

  /**
   * An 18 px status glyph from the arena sheet, centred on (9, 0), where the
   * drawn placeholders sat, so the bars beside them didn't move.
   */
  static icon (name: string): Sprite {
    const sprite = new Sprite(Texture.from(name))
    sprite.anchor.set(0.5, 0.5)
    sprite.x = 9
    return sprite
  }
}
