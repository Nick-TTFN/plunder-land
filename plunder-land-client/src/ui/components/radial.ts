import { Circle, Container, Graphics, Sprite, type Text, type Texture } from 'pixi.js'
import { Panel } from './panel'
import { THEME } from '../theme'
import { CooldownSweep } from './cooldownsweep'
import { type SkillCard, hintAlpha } from './skillpanel'
import { type Inventory } from './inventory'
import { GearBag, type GearSlot, addItemTip } from './gearpanel'
import { type Rect } from './joystick'
import { ItemPickup } from '../../objects/itempickup'
import { skillFor } from '../../skills/catalog'
import { type GameObject } from '../../objects/gameobject'
import { tierTint } from '../../objects/gearpickup'
import { itemInSlot } from '../../utils/items'
import { type GearInstance, GEAR_BAG, GEAR_FIRST_SLOT, GEAR_SLOTS } from '../../utils/gear'

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
  /** Medkit, bomb, gear keys 3-4 and BAG. */
  ITEM: 48,
  /** The primary's distance in from the safe area's right and bottom edges. */
  EDGE: 24,
  /** Primary centre to a skill button's centre. */
  SKILL_RING: 88,
  /** Primary centre to an item button's centre. */
  ITEM_RING: 154,
  /** Slots 2, 3, 4, from the thumb's sweep along the bottom up to straight above. */
  SKILL_ANGLES: [180, 225, 270],
  /** Medkit, bomb, gear key 3, gear key 4, BAG. */
  ITEM_ANGLES: [180, 202.5, 225, 247.5, 270],
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

/** Medkit or bomb: `Inventory.use` on its slot, with the count. */
class ItemButton extends RoundButton {
  private readonly _count: Text
  private _countShown = -1

  constructor (private readonly _inventory: Inventory, readonly slot: number, size: number) {
    super(size, () => { _inventory.use(slot) })
    this.setIcon(ItemPickup.icon(itemInSlot(slot)), size * 0.62)
    this._count = Panel.text('', THEME.smallSize, THEME.text)
    this._count.anchor.set(0.5, 0)
    this._count.position.set(size / 2, size - 14)
    this.addChild(this._count)
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
class GearButton extends RoundButton {
  private _item: GearInstance | null | undefined
  private readonly _tip: { cancel: () => void }

  constructor (readonly gear: GearSlot, size: number) {
    super(size, () => { gear.tap() })
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

  update (now: number): void {
    const item = this.gear.item
    if (item !== this._item) {
      this._item = item
      this.drawFrame(item !== null ? tierTint(item.tier) : THEME.panelBorder, item !== null ? 2 : 1)
      const texture = item !== null && item.skill !== 0 ? skillFor(item.skill, undefined as unknown as GameObject)?.uiTexture : undefined
      this.setIcon(texture, this.size * 0.58)
      if (item !== null && item.skill === 0) this.icon.addChild(new Graphics().beginFill(tierTint(item.tier), 1).drawCircle(0, 0, 6).endFill())
    }
    this.setCooldown(this.gear.cooldownLeft(now), this.gear.msLeft(now))
  }
}

/**
 * The BAG button (decision #59: "OK for now, to be rethought"; Nick's idea is
 * a hot slot in the radial, `ideas/mobile-radial-hot-slot.md`). Self-contained
 * so it can be swapped out: it owns its own bag row (the desktop `GearBag`,
 * the same drawing and tips), fed by `set`, and a press opens the row or
 * closes it again. The cluster only places it and the row (`placeRow`).
 */
export class BagButton extends RoundButton {
  readonly row = new GearBag(GEAR_BAG)
  private readonly _count: Text

  constructor (size: number) {
    super(size, () => { this.toggle() })
    const label = Panel.text('BAG', THEME.smallSize, THEME.text)
    label.anchor.set(0.5, 0.5)
    label.position.set(size / 2, size / 2 - 5)
    this.addChild(label)
    this._count = Panel.text('', THEME.smallSize, THEME.muted)
    this._count.anchor.set(0.5, 0.5)
    this._count.position.set(size / 2, size / 2 + 10)
    this.addChild(this._count)
    this.row.visible = false
  }

  get open (): boolean {
    return this.row.visible
  }

  toggle (): void {
    this.row.visible = !this.row.visible
    this.drawFrame(this.row.visible ? THEME.accent : THEME.panelBorder, this.row.visible ? 2 : 1)
  }

  close (): void {
    if (this.row.visible) this.toggle()
  }

  /** The bag's entries (the `carried` field past the gear slots) and the kit's skill ids. */
  set (items: ReadonlyArray<GearInstance | null>, kit: readonly number[]): void {
    this.row.set(items, kit)
    const n = items.filter((item) => item !== null && item !== undefined).length
    this._count.text = `${n}/${GEAR_BAG}`
  }
}

function overlaps (a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * The right-thumb cluster in touch mode (decision #59, mobile-3): **loadout
 * slot 1 is always the large primary** bottom right (so it changes only by
 * reordering the loadout), slots 2-4 on an arc round it toward the screen's
 * centre and up, and outside that the medkit, the bomb, gear keys 3-4 and the
 * BAG button. An empty skill slot draws nothing.
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
  private _items: Array<ItemButton | GearButton> = []
  private readonly _bag = new BagButton(RADIAL.ITEM)
  private _cards: readonly SkillCard[] = []

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
    this._bag.close()

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
        this._items.push(new ItemButton(inventory, slot, RADIAL.ITEM))
      }
      for (const gear of inventory.gear.slice(0, GEAR_SLOTS)) this._items.push(new GearButton(gear, RADIAL.ITEM))
      for (const button of this._items) this.addChild(button)
      this.addChild(this._bag)
      this.addChild(this._bag.row)
    }
  }

  /** The bag's entries, from `HUD.updateGear` (the same data the desktop bag gets). */
  setBag (items: ReadonlyArray<GearInstance | null>, kit: readonly number[]): void {
    this._bag.set(items, kit)
  }

  get bag (): BagButton {
    return this._bag
  }

  /**
   * Place the cluster: the primary `RADIAL.EDGE` in from the safe area's
   * bottom right corner (`safe` is the screen inside the insets). The bag
   * row opens above the cluster where that is clear of `avoid` (the
   * joystick's zone, the minimap, the top panels), else to the cluster's
   * left along the bottom. `shown` is touch mode in a run.
   */
  layout (safe: Rect, avoid: readonly Rect[], shown: boolean): void {
    this.visible = shown
    if (!shown) {
      this._bag.close()
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
    const outer = [...this._items, this._bag]
    outer.forEach((button, i) => { at(button, RADIAL.ITEM_RING, RADIAL.ITEM_ANGLES[i] ?? 270) })

    // The bag row: just above the cluster, as far right as it is clear of
    // everything in `avoid`; else to the cluster's left along the bottom;
    // else (nothing is clear) above, right-aligned, whatever it covers.
    const row = this._bag.row.getLocalBounds()
    const top = cy - RADIAL.ITEM_RING - RADIAL.ITEM / 2
    const left = cx - RADIAL.ITEM_RING - RADIAL.ITEM / 2
    const box = (x: number, y: number): Rect => ({ x, y, width: row.width, height: row.height })
    const aboveY = top - RADIAL.GAP - row.height
    const xs = [safe.x + safe.width - RADIAL.GAP - row.width, ...avoid.map((r) => r.x - RADIAL.GAP - row.width)].sort((a, b) => b - a)
    const candidates = [...xs.map((x) => box(x, aboveY)), box(left - RADIAL.GAP - row.width, safe.y + safe.height - RADIAL.GAP - row.height)]
    const clear = (r: Rect): boolean =>
      r.x >= safe.x && r.y >= safe.y && r.x + r.width <= safe.x + safe.width && r.y + r.height <= safe.y + safe.height &&
      !avoid.some((a) => overlaps(a, r))
    const place = candidates.find(clear) ?? candidates[0]
    this._bag.row.x = Math.round(place.x - row.x)
    this._bag.row.y = Math.round(place.y - row.y)
  }

  update (now: number): void {
    if (!this.visible) return
    for (const button of this._skills) button.update(now)
    for (const button of this._items) button.update(now)
  }
}
