import { Circle, Container, Graphics, Sprite, type Text, type Texture } from 'pixi.js'
import { Panel } from './panel'
import { THEME } from '../theme'
import { CooldownSweep } from './cooldownsweep'
import { type SkillCard, hintAlpha } from './skillpanel'
import { type Inventory } from './inventory'
import { type GearSlot, addItemTip } from './gearpanel'
import { type Rect } from './joystick'
import { ItemPickup } from '../../objects/itempickup'
import { skillFor } from '../../skills/catalog'
import { type GameObject } from '../../objects/gameobject'
import { tierTint } from '../../objects/gearpickup'
import { itemInSlot } from '../../utils/items'
import { type GearInstance, GEAR_FIRST_SLOT, GEAR_SLOTS } from '../../utils/gear'

/**
 * The radial's sizes and angles, in CSS pixels (never `HUD.scale`d: the 0.5
 * floor is what made the cards too small on a phone). Placeholder look and
 * provisional numbers for Nick's play (decision #59, mobile-3). Angles are
 * screen degrees round the primary's centre: 180 is left, 270 straight up.
 */
export const RADIAL = {
  /** Loadout slot 1's button. */
  PRIMARY: 92,
  /** Slots 2-4's. */
  SKILL: 60,
  /** The items' hot slot and its fan (medkit, bomb, gear keys 3-4). */
  ITEM: 48,
  /** The hot slot's open/close toggle. */
  TOGGLE: 34,
  /** The primary's distance in from the safe area's right and bottom edges. */
  EDGE: 24,
  /** Primary centre to a skill button's centre. */
  SKILL_RING: 88,
  /** Primary centre to an item button's centre. */
  ITEM_RING: 154,
  /** Slots 2, 3, 4, from the thumb's sweep along the bottom up to straight above. */
  SKILL_ANGLES: [180, 225, 270],
  /** The open fan: medkit, bomb, gear key 3, gear key 4. */
  ITEM_ANGLES: [180, 202.5, 225, 247.5],
  /** The collapsed hot slot. */
  HOT_ANGLE: 225,
  /** The toggle that opens the fan. */
  TOGGLE_ANGLE: 270,
  /** Space kept between the cluster, the bag row and anything they avoid. */
  GAP: 8
}

/**
 * One round button. Its press is a **`pointerdown` on the button itself**
 * (the container, not its background: pixi hit-tests every child, and a press
 * on the icon would otherwise miss), so a thumb that slides off before
 * lifting still casts, a tap doesn't wait for the release, and the press
 * never reaches the stage, so it never starts or ends the joystick.
 */
class RoundButton extends Container {
  protected readonly frame = new Graphics()
  protected readonly icon = new Container()
  protected readonly sweep: CooldownSweep
  protected readonly seconds: Text
  private _hint: Graphics | undefined
  private _secondsShown = -1

  constructor (readonly size: number, press: () => void) {
    super()
    const r = size / 2
    this.addChild(this.frame)
    this.icon.position.set(r, r)
    this.addChild(this.icon)
    this.sweep = new CooldownSweep(size, size, 0, true)
    this.addChild(this.sweep)
    this.seconds = Panel.text('', size >= RADIAL.PRIMARY ? THEME.titleSize : THEME.bodySize, THEME.text)
    this.seconds.anchor.set(0.5, 0.5)
    this.seconds.position.set(r, r)
    this.addChild(this.seconds)
    this.eventMode = 'static'
    this.cursor = 'pointer'
    // Only the circle presses: the box's corners fall through to the world.
    this.hitArea = new Circle(r, r, r)
    this.on('pointerdown', (e: { button?: number }) => {
      // A mouse's other buttons don't cast (touch and pen report 0).
      if (e.button !== undefined && e.button > 0) return
      press()
    })
    this.drawFrame(THEME.panelBorder, 1)
  }

  protected drawFrame (colour: number, width: number): void {
    const r = this.size / 2
    this.frame.clear()
      .beginFill(0x101A28, 0.85)
      .lineStyle(width, colour, 1)
      .drawCircle(r, r, r)
      .endFill()
  }

  /** A sprite of `texture` fitted into `fit` px, or nothing for undefined. */
  protected setIcon (texture: Texture | undefined, fit: number): void {
    this.icon.removeChildren()
    if (texture === undefined) return
    const sprite = new Sprite(texture)
    sprite.anchor.set(0.5, 0.5)
    sprite.scale.set(Math.min(fit / texture.frame.width, fit / texture.frame.height))
    this.icon.addChild(sprite)
  }

  /** The sweep for `left` (0..1) and the whole seconds still to wait. */
  protected setCooldown (left: number, msLeft: number): void {
    this.sweep.set(left)
    const s = msLeft > 0 ? Math.ceil(msLeft / 1000) : 0
    if (s === this._secondsShown) return
    this._secondsShown = s
    this.seconds.text = s > 0 ? String(s) : ''
  }

  /** The first run's hint: a pulsing ring outline round the button. */
  protected setHint (on: boolean, now: number): void {
    if (!on) {
      if (this._hint !== undefined) this._hint.visible = false
      return
    }
    if (this._hint === undefined) {
      const r = this.size / 2
      this._hint = new Graphics().lineStyle(3, THEME.accent, 1).drawCircle(r, r, r + 4)
      this.addChild(this._hint)
    }
    this._hint.visible = true
    this._hint.alpha = hintAlpha(now)
  }
}

/** A kit skill: drives its `SkillCard` (the same cooldown, key and cast as the card's). */
class SkillButton extends RoundButton {
  constructor (readonly card: SkillCard, size: number) {
    super(size, () => { card.tap() })
    this.setIcon(card.skill?.uiTexture, size * 0.55)
    if (size >= RADIAL.PRIMARY) this.drawFrame(THEME.accent, 2)
  }

  update (now: number): void {
    this.setCooldown(this.card.cooldownLeft(now), this.card.msLeft(now))
    // The card decides (ready, and picked by `HUD.update`'s first-run rule).
    this.setHint(this.card.hinted, now)
  }
}

/** One of the hot slot's items: what it shows, whether a press can use it, and the use. */
interface HotItem extends RoundButton {
  available: () => boolean
  use: () => void
  update: (now: number) => void
  setCurrent: (current: boolean) => void
}

/** Medkit or bomb: `Inventory.use` on its slot, with the count. The cluster decides what a press does. */
class ItemButton extends RoundButton implements HotItem {
  private readonly _count: Text
  private _countShown = -1
  private _current = false

  constructor (private readonly _inventory: Inventory, readonly slot: number, size: number, press: () => void) {
    super(size, press)
    this.setIcon(ItemPickup.icon(itemInSlot(slot)), size * 0.62)
    this._count = Panel.text('', THEME.smallSize, THEME.text)
    this._count.anchor.set(0.5, 0)
    this._count.position.set(size / 2, size - 14)
    this.addChild(this._count)
  }

  available (): boolean {
    return this._inventory.count(this.slot) > 0
  }

  use (): void {
    this._inventory.use(this.slot)
  }

  setCurrent (current: boolean): void {
    if (current === this._current) return
    this._current = current
    this.drawFrame(current ? THEME.accent : THEME.panelBorder, current ? 2 : 1)
  }

  update (): void {
    const n = this._inventory.count(this.slot)
    if (n === this._countShown) return
    this._countShown = n
    this._count.text = String(n)
    this.icon.alpha = n > 0 ? 1 : 0.3
  }
}

/** Gear key 3 or 4: drives its `GearSlot` (cooldown, cast), the long press shows the item's lines. */
class GearButton extends RoundButton implements HotItem {
  private _item: GearInstance | null | undefined
  private readonly _tip: { cancel: () => void }
  private _current = false

  constructor (readonly gear: GearSlot, size: number, press: () => void) {
    super(size, press)
    this._tip = addItemTip(this, size, () => gear.lines())
    // On top of its neighbours while pressed or hovered, so its tip is too.
    const raise = (): void => { this.parent?.setChildIndex(this, this.parent.children.length - 1) }
    this.on('pointerdown', raise)
    this.on('pointerover', raise)
  }

  /** A thumb may still be on it (a rebind at a run's end or start): stop its long press first. */
  destroy (options?: Parameters<Container['destroy']>[0]): void {
    this._tip.cancel()
    super.destroy(options)
  }

  available (): boolean {
    return this.gear.item !== null
  }

  use (): void {
    this.gear.tap()
  }

  setCurrent (current: boolean): void {
    if (current === this._current) return
    this._current = current
    this._item = undefined // redraw the frame on the next update
  }

  update (now: number): void {
    const item = this.gear.item
    if (item !== this._item) {
      this._item = item
      if (this._current) this.drawFrame(THEME.accent, 2)
      else this.drawFrame(item !== null ? tierTint(item.tier) : THEME.panelBorder, item !== null ? 2 : 1)
      this.icon.alpha = item !== null ? 1 : 0.3
      const texture = item !== null && item.skill !== 0 ? skillFor(item.skill, undefined as unknown as GameObject)?.uiTexture : undefined
      this.setIcon(texture, this.size * 0.58)
      if (item !== null && item.skill === 0) this.icon.addChild(new Graphics().beginFill(tierTint(item.tier), 1).drawCircle(0, 0, 6).endFill())
    }
    this.setCooldown(this.gear.cooldownLeft(now), this.gear.msLeft(now))
  }
}

/**
 * The hot slot's toggle (Nick, 2026-11-05, replacing the BAG button and its
 * bag row): opens the items' fan round the cluster, and closes it again.
 */
class HotToggle extends RoundButton {
  private readonly _label: Text

  constructor (size: number, press: () => void) {
    super(size, press)
    this._label = Panel.text('+', THEME.titleSize, THEME.text)
    this._label.anchor.set(0.5, 0.5)
    this._label.position.set(size / 2, size / 2)
    this.addChild(this._label)
  }

  setOpen (open: boolean): void {
    this._label.text = open ? '×' : '+'
    this.drawFrame(open ? THEME.accent : THEME.panelBorder, open ? 2 : 1)
  }
}

/**
 * The right-thumb cluster in touch mode (decision #59, mobile-3): **loadout
 * slot 1 is always the large primary** bottom right (so it changes only by
 * reordering the loadout), slots 2-4 on an arc round it toward the screen's
 * centre and up, and outside that **one hot slot** for the items (Nick,
 * 2026-11-05): it shows the last item used (medkit, bomb, gear key 3 or 4)
 * and a press uses it, or switches to the next one left if it has none; a
 * toggle opens all of them on the outer ring. The gear bag (carried parts)
 * is not shown in touch mode. An empty skill slot draws nothing.
 *
 * Every button drives the object the desktop HUD presses (`SkillCard`,
 * `Inventory.use`, `GearSlot`), which stay alive, hidden, in touch mode: so
 * cooldowns, key binds, `rekey` and casting are single-sourced, and a hybrid
 * (a touchscreen laptop) still casts from its keys. The first-run hint and
 * the cooldown sweep are the cards' own state, drawn here as a ring and a
 * round sweep.
 */
export class RadialCluster extends Container {
  private _skills: SkillButton[] = []
  private _items: HotItem[] = []
  /** The item the collapsed hot slot shows: the last one used. */
  private _current = 0
  private _open = false
  private readonly _toggle = new HotToggle(RADIAL.TOGGLE, () => { this.setOpen(!this._open) })
  private _cards: readonly SkillCard[] = []
  private _laid: (() => void) | undefined

  constructor () {
    super()
    this.visible = false
  }

  /**
   * This run's cards (`SkillPanel.cards`, slot order) and inventory, or
   * undefined for none (between runs). Rebuilds the buttons and closes the bag.
   */
  bind (cards: readonly SkillCard[] | undefined, inventory: Inventory | undefined): void {
    this._cards = cards ?? []
    for (const button of [...this._skills, ...this._items]) button.destroy({ children: true })
    this._skills = []
    this._items = []
    this.removeChildren()
    this._open = false
    this._toggle.setOpen(false)

    this._cards.forEach((card, slot) => {
      if (card.skill === null) return
      const button = new SkillButton(card, slot === 0 ? RADIAL.PRIMARY : RADIAL.SKILL)
      this._skills.push(button)
      this.addChild(button)
    })
    if (inventory !== undefined) {
      // Medkit (slot 0, key 1) and bomb (slot 1, key 2); then the gear keys.
      for (let slot = 0; slot < GEAR_FIRST_SLOT; slot++) {
        if (itemInSlot(slot) === undefined) continue
        const i = this._items.length
        this._items.push(new ItemButton(inventory, slot, RADIAL.ITEM, () => { this.press(i) }))
      }
      for (const gear of inventory.gear.slice(0, GEAR_SLOTS)) {
        const i = this._items.length
        this._items.push(new GearButton(gear, RADIAL.ITEM, () => { this.press(i) }))
      }
      for (const button of this._items) this.addChild(button)
      if (this._items.length > 0) this.addChild(this._toggle)
      this._current = Math.min(this._current, Math.max(0, this._items.length - 1))
      this.showCurrent()
    }
  }

  /**
   * A press on item `i`. Collapsed (only the hot slot shows): use it if it
   * has any left (a count above 0, or gear in the key), else switch to the
   * next item that has, without using it (Nick, 2026-11-05). Open: use the
   * pressed item if it can be used, make it the hot slot's and close the fan.
   */
  private press (i: number): void {
    const item = this._items[i]
    if (item === undefined) return
    if (!this._open) {
      if (item.available()) item.use()
      else this.advance()
      return
    }
    if (item.available()) item.use()
    this._current = i
    this.setOpen(false)
  }

  /** The next item after the current one that can be used; stays put if none can. */
  private advance (): void {
    const n = this._items.length
    for (let k = 1; k < n; k++) {
      const j = (this._current + k) % n
      if (this._items[j].available()) {
        this._current = j
        this.showCurrent()
        return
      }
    }
  }

  private setOpen (open: boolean): void {
    this._open = open
    this._toggle.setOpen(open)
    this.showCurrent()
  }

  /** Collapsed: only the current item, at the hot slot. Open: all of them on the fan, the current one outlined. */
  private showCurrent (): void {
    this._items.forEach((item, i) => {
      item.visible = this._open || i === this._current
      item.setCurrent(this._open && i === this._current)
    })
    this._laid?.()
  }

  /**
   * Place the cluster: the primary `RADIAL.EDGE` in from the safe area's
   * bottom right corner (`safe` is the screen inside the insets). The items
   * stay on the outer ring, open or not, so `_avoid` (the joystick's zone,
   * the top panels) is not needed any more; kept for `HUD`'s call. `shown`
   * is touch mode in a run.
   */
  layout (safe: Rect, _avoid: readonly Rect[], shown: boolean): void {
    this.visible = shown
    if (!shown) {
      if (this._open) this.setOpen(false)
      return
    }
    const cx = safe.x + safe.width - RADIAL.EDGE - RADIAL.PRIMARY / 2
    const cy = safe.y + safe.height - RADIAL.EDGE - RADIAL.PRIMARY / 2
    const at = (button: RoundButton, ring: number, degrees: number): void => {
      const a = degrees * Math.PI / 180
      button.x = Math.round(cx + ring * Math.cos(a) - button.size / 2)
      button.y = Math.round(cy + ring * Math.sin(a) - button.size / 2)
    }
    for (const button of this._skills) {
      const slot = this._cards.indexOf(button.card)
      if (slot === 0) at(button, 0, 0)
      else at(button, RADIAL.SKILL_RING, RADIAL.SKILL_ANGLES[slot - 1] ?? 270)
    }
    // The items: collapsed, the current one at the hot slot; open, every
    // one on the fan. The toggle sits at the top of the ring either way.
    const placeItems = (): void => {
      this._items.forEach((item, i) => {
        if (this._open) at(item, RADIAL.ITEM_RING, RADIAL.ITEM_ANGLES[i] ?? 270)
        else at(item, RADIAL.ITEM_RING, RADIAL.HOT_ANGLE)
      })
      at(this._toggle, RADIAL.ITEM_RING, RADIAL.TOGGLE_ANGLE)
    }
    this._laid = placeItems
    placeItems()
  }

  update (now: number): void {
    if (!this.visible) return
    for (const button of this._skills) button.update(now)
    for (const button of this._items) button.update(now)
  }
}
