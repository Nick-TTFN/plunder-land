import { Container, Graphics, Sprite, type Text } from 'pixi.js'
import { Game } from '../../game'
import { Aim } from '../../skills/aim'
import { Hex } from '../../utils/hex'
import { Vector } from '../../utils/vector'
import { INVENTORY_SLOTS, itemInSlot } from '../../utils/items'
import { TextEffect } from '../elements/texteffect'
import { ItemPickup } from '../../objects/itempickup'
import { Panel } from './panel'
import { THEME } from '../theme'
import { GearBag, GearSlot } from './gearpanel'
import { type GearInstance, GEAR_BAG, GEAR_FIRST_SLOT, GEAR_SLOTS } from '../../utils/gear'

const SLOT = 58
const SLOT_GAP = 8
/** The item icon's width in a slot; the art is 40 wide, which crowds the count. */
const ICON = 36

/**
 * The five inventory slots, as in the mockup: a card per slot with its key
 * (1-5) on a tab, the item's icon, and the count. Keys 1-5 or a tap use one.
 * Lives in the status panel (`StatusPanel`).
 *
 * Slots are fixed per kind (utils/items.ts), so key 1 is always the medkit and
 * key 2 always the bomb, whether or not one is carried; slots 3-5 have no kind
 * yet and show empty. Icons are the arena art, the same drawing as the
 * ground pickup (`ItemPickup.icon`).
 */
export class Inventory extends Container {
  private _counts: number[] = new Array<number>(INVENTORY_SLOTS).fill(0)
  private readonly _countTexts: Text[] = []
  private readonly _icons: Container[] = []
  /** Keys 3 and 4: the gear slots (decision #49), in place of two empty item slots. */
  readonly gear: GearSlot[] = []
  /** The bag of 4, under the slots. */
  readonly bag = new GearBag(GEAR_BAG)

  constructor () {
    super()
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
      if (slot >= GEAR_FIRST_SLOT && slot < GEAR_FIRST_SLOT + GEAR_SLOTS) {
        const gear = new GearSlot(slot, String(slot + 1))
        gear.x = slot * (SLOT + SLOT_GAP)
        gear.y = 10
        this.gear.push(gear)
        // Its count text and icon are never drawn; kept so slot indices line up.
        this._countTexts[slot] = Panel.text('', THEME.bodySize, THEME.text)
        this._icons[slot] = new Container()
        continue
      }
      const card = new Container()
      card.x = slot * (SLOT + SLOT_GAP)
      card.y = 10
      const bg = new Graphics()
        .beginFill(0x101A28, 1)
        .lineStyle(1, THEME.panelBorder, 1)
        .drawRoundedRect(0, 0, SLOT, SLOT, 5)
        .endFill()
      // On the slot, not its background: a press on the item's icon or count
      // hit those and bubbled past the background (as on the skill cards).
      card.eventMode = 'static'
      card.cursor = 'pointer'
      card.on('pointertap', () => { this.use(slot) })
      card.addChild(bg)

      const tab = new Graphics()
        .beginFill(THEME.panelFill, 1)
        .lineStyle(1, THEME.panelBorder, 1)
        .drawRoundedRect(SLOT / 2 - 11, -10, 22, 18, 4)
        .endFill()
      card.addChild(tab)
      const key = Panel.text(String(slot + 1), THEME.smallSize, THEME.text)
      key.anchor.set(0.5, 0.5)
      key.x = SLOT / 2
      key.y = -1
      card.addChild(key)

      const info = itemInSlot(slot)
      const icon = new Container()
      const texture = ItemPickup.icon(info)
      if (texture !== undefined) {
        const sprite = new Sprite(texture)
        sprite.anchor.set(0.5, 0.5)
        sprite.scale.set(ICON / texture.frame.width)
        icon.addChild(sprite)
      }
      icon.x = SLOT / 2 - 3
      icon.y = SLOT / 2 + 2
      card.addChild(icon)
      this._icons[slot] = icon

      const count = Panel.text('', THEME.bodySize, THEME.text)
      count.anchor.set(1, 1)
      count.x = SLOT - 5
      count.y = SLOT - 3
      card.addChild(count)
      this._countTexts[slot] = count

      this.addChild(card)
    }
    this.bag.y = 10 + SLOT + 10
    this.addChild(this.bag)
    // The gear slots last, so a slot's hover lines draw over its neighbours.
    for (const gear of this.gear) this.addChild(gear)
    this.redraw()
  }

  /**
   * The own player's `carried` field (decision #49): entries 0-1 into the
   * gear slots, 2-5 into the bag. `kit` is the run's skill ids, for which an
   * item is a duplicate (its skill already in the kit, or in an earlier gear
   * slot: the server's `Player.equipGear` shares that instance).
   */
  updateGear (carried: ReadonlyArray<GearInstance | null>, kit: readonly number[]): void {
    this.gear.forEach((slot, i) => {
      const item = carried[i] ?? null
      const earlier = carried.slice(0, i).some((other) => other !== null && item !== null && other.skill === item.skill)
      slot.setItem(item, item !== null && (kit.includes(item.skill) || earlier))
    })
    this.bag.set(carried.slice(GEAR_SLOTS), kit)
  }

  /** Each gear slot's cooldown text, every frame. */
  tick (now: number): void {
    for (const slot of this.gear) slot.update(now)
  }

  /** The `inventory` field, as the server sent it: a count per slot. */
  update (counts: number[]): void {
    this._counts = counts.slice(0, INVENTORY_SLOTS)
    this.redraw()
  }

  private redraw (): void {
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
      const count = this._counts[slot] ?? 0
      const hasKind = itemInSlot(slot) !== undefined
      const text = hasKind ? String(count) : ''
      if (this._countTexts[slot].text !== text) this._countTexts[slot].text = text
      this._icons[slot].alpha = count > 0 ? 1 : 0.3
    }
  }

  /**
   * Use the item in a 0-based slot: the `use_item` message, in the same bytes
   * as a skill press (`Aim.message`). An item that aims sends the cell under
   * the mouse, or no aim (the server then throws along facing). An aim the
   * client can already see is out of range is not sent; the server checks
   * again against its own position, and may still refuse one at the edge.
   */
  use (slot: number): void {
    const gear = this.gear[slot - GEAR_FIRST_SLOT]
    if (gear !== undefined) {
      gear.invoke()
      return
    }
    const info = itemInSlot(slot)
    if (info === undefined || (this._counts[slot] ?? 0) <= 0 || Game.PLAYER === undefined) return

    let cell: Vector | undefined
    if (info.aimRange !== null) {
      cell = Aim.cell()
      if (cell !== undefined) {
        const own = Hex.toCell(new Vector(Game.LOCAL.x, Game.LOCAL.y))
        if (Hex.distance(own, cell) > info.aimRange) {
          new TextEffect('TOO FAR', Game.CONTAINER, Game.LOCAL.x, Game.LOCAL.y - 40, 24, 'orange', 300) // eslint-disable-line no-new
          return
        }
      }
    }

    Game.socket.emit('use_item', Aim.message(slot, cell))
  }
}
