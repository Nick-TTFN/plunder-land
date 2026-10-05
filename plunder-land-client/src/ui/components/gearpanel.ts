import { Container, Graphics, Sprite, type Text } from 'pixi.js'
import { Panel } from './panel'
import { THEME } from '../theme'
import { SkillCard } from './skillpanel'
import { TouchAim } from '../../skills/touchaim'
import { Aim } from '../../skills/aim'
import { type Aimed, Skill } from '../../skills/skill'
import { skillFor } from '../../skills/catalog'
import { Game } from '../../game'
import { type GameObject } from '../../objects/gameobject'
import { tierTint } from '../../objects/gearpickup'
import { type GearInstance, type GearRoll, gearStatById, itemCooldownMs, rollValue } from '../../utils/gear'
import { skillById } from '../../utils/skills'

/** How long a press must be held on touch to show an item's lines instead of using it, ms. */
const LONG_PRESS_MS = 450

/** One roll in plain words, e.g. "+12% max HP" (placeholder copy, Claude's). */
export function rollLine (roll: GearRoll, tier: number, duplicate: boolean): string {
  const stat = gearStatById(roll.stat)
  if (stat === undefined) return ''
  const v = rollValue(roll.stat, tier, roll.q)
  const n = (x: number): string => String(Math.round(x * 10) / 10)
  switch (stat.key) {
    case 'hp': return `+${n(v)}% max HP`
    case 'armor': return `+${n(v)}% max armor`
    case 'speed': return `+${n(v)}% speed`
    case 'damage': return `+${n(v * 100)}% damage`
    case 'reach': return `+${n(v)} pickup reach`
    // A duplicate shares the kit's skill and its cooldown, which the roll
    // doesn't shorten (Nick 2026-10-05, #49; `DUPLICATE_CUTS_COOLDOWN`).
    case 'cooldown': return duplicate ? `-${n(v)}% cooldown (not on a shared skill)` : `-${n(v)}% cooldown`
  }
}

/** An item's card text: its tier and skill (or PART), whether it is already in the kit, and its rolls. */
export function itemLines (item: GearInstance, duplicate: boolean): string[] {
  const name = item.skill === 0 ? 'PART' : (skillById(item.skill)?.label ?? 'SKILL').toUpperCase()
  const lines = [`T${item.tier} ${name}`]
  if (item.skill !== 0 && duplicate) lines.push('ALREADY IN KIT')
  for (const roll of item.rolls) {
    const line = rollLine(roll, item.tier, duplicate)
    if (line !== '') lines.push(line)
  }
  if (item.skill === 0) lines.push('MERGE 3 FOR THE NEXT TIER')
  return lines
}

/**
 * An item's lines on hover (mouse) or a long press (touch), above whatever
 * `attach` is given. Hidden at rest, so it adds nothing to a panel's fitted
 * bounds.
 */
class ItemTip extends Container {
  private readonly _bg = new Graphics()
  private readonly _text: Text

  constructor () {
    super()
    this._text = Panel.text('', THEME.smallSize, THEME.text)
    this._text.x = 8
    this._text.y = 6
    this.addChild(this._bg, this._text)
    this.visible = false
    this.eventMode = 'none'
  }

  show (lines: string[], width: number): void {
    this._text.text = lines.join('\n')
    this._bg.clear()
      .beginFill(0x07101A, 0.95)
      .lineStyle(1, THEME.panelBorder, 1)
      .drawRoundedRect(0, 0, this._text.width + 16, this._text.height + 12, 5)
      .endFill()
    this.x = Math.round((width - (this._text.width + 16)) / 2)
    this.y = -this._text.height - 22
    this.visible = true
  }

  hide (): void {
    this.visible = false
  }
}

/** Hover and long-press show `tip` with `lines()`; true from a long press until the next tap, to stop that tap. */
function bindTip (target: Container, tip: ItemTip, width: number, lines: () => string[] | undefined): { longPressed: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let longPressed = false
  const show = (): void => {
    const l = lines()
    if (l !== undefined) tip.show(l, width)
  }
  target.on('pointerover', (e: { pointerType?: string }) => { if (e.pointerType === 'mouse') show() })
  target.on('pointerout', () => { tip.hide() })
  target.on('pointerdown', (e: { pointerType?: string }) => {
    longPressed = false
    if (e.pointerType !== 'touch') return
    clearTimeout(timer)
    timer = setTimeout(() => {
      longPressed = true
      show()
    }, LONG_PRESS_MS)
  })
  const release = (): void => {
    clearTimeout(timer)
    if (longPressed) tip.hide()
  }
  target.on('pointerup', release)
  target.on('pointerupoutside', release)
  return { longPressed: () => longPressed }
}

/**
 * A gear slot, key 3 or 4 (decision #49, 49-2): the equipped item's skill
 * icon in a frame tinted by tier, its cooldown, and its lines on hover or a
 * long press. Its key or a tap sends `use_item` with the slot (2 or 3) and
 * the aim, in the same bytes as a skill press (`Aim.message`); the server
 * casts the slot's skill through the same `Skill.execute` a kit press uses.
 *
 * **Extends `SkillCard` only so touch aiming works unchanged**: `index.ts`
 * casts an armed card on a world tap if it is a `SkillCard`. It is built as
 * an empty card and draws itself; every method `index.ts`, `TouchAim` and the
 * HUD call is overridden here, so nothing of the parent's drawing is used.
 *
 * The cooldown is the client's estimate, as on the skill cards: the client
 * skill class's cooldown times the item's own cooldown roll, or, for a
 * duplicate (its skill already in the kit or the other slot), the kit's
 * cooldown unchanged (`itemCooldownMs`). A duplicate's card and the kit card
 * keep separate timers here; the server shares one.
 */
export class GearSlot extends SkillCard {
  static readonly SIZE = 58
  private _item: GearInstance | null = null
  private _gearSkill: Skill | null = null
  private _duplicate = false
  private _cooldownMs = 0
  private _gearReadyAt = 0
  private _gearArmed = false
  private _gearShown = ''
  private readonly _frame = new Graphics()
  private readonly _iconHolder = new Container()
  private readonly _cd: Text
  private readonly _tip = new ItemTip()
  private readonly _press: { longPressed: () => boolean }

  /** `slot` is the inventory slot, 2 or 3; `label` the key printed on its tab. */
  constructor (readonly slot: number, label: string) {
    super(null, label)
    // The empty card's own drawing goes: this one is a slot, not a skill card.
    this.removeChildren()
    this.alpha = 1
    const S = GearSlot.SIZE

    this.addChild(this._frame)
    const tab = new Graphics()
      .beginFill(THEME.panelFill, 1)
      .lineStyle(1, THEME.panelBorder, 1)
      .drawRoundedRect(S / 2 - 11, -10, 22, 18, 4)
      .endFill()
    this.addChild(tab)
    const key = Panel.text(label, THEME.smallSize, THEME.text)
    key.anchor.set(0.5, 0.5)
    key.x = S / 2
    key.y = -1
    this.addChild(key)
    this._iconHolder.x = S / 2
    this._iconHolder.y = S / 2 + 1
    this.addChild(this._iconHolder)
    this._cd = Panel.text('', THEME.smallSize, THEME.text)
    this._cd.anchor.set(0.5, 1)
    this._cd.x = S / 2
    this._cd.y = S - 2
    this.addChild(this._cd)
    this.addChild(this._tip)
    this.drawFrame()

    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.on('pointertap', (e: { pointerType?: string }) => {
      if (this._press.longPressed()) return
      this.tap(e.pointerType)
    })
    this._press = bindTip(this, this._tip, S, () => this._item !== null ? itemLines(this._item, this._duplicate) : undefined)
  }

  get item (): GearInstance | null {
    return this._item
  }

  /**
   * The item in this slot, from the `carried` field. Gear only arrives mid-run
   * (nothing leaves a slot but death), so a slot that already holds an item
   * keeps its cooldown.
   */
  setItem (item: GearInstance | null, duplicate: boolean): void {
    if (item === null) {
      this._item = null
      this._gearSkill = null
    } else if (this._item === null || this._item.skill !== item.skill || this._item.tier !== item.tier) {
      this._item = item
      this._gearSkill = skillFor(item.skill, (Game.PLAYER ?? undefined) as unknown as GameObject)
      this._gearReadyAt = 0
    } else {
      this._item = item
    }
    this._duplicate = duplicate
    const base = (this._gearSkill?.cooldown ?? 0) * 1000
    this._cooldownMs = item !== null ? itemCooldownMs(base, item, duplicate) : 0
    this._iconHolder.removeChildren()
    const texture = this._gearSkill?.uiTexture
    if (texture !== undefined) {
      const icon = new Sprite(texture)
      icon.anchor.set(0.5, 0.5)
      icon.scale.set(Math.min(30 / texture.frame.width, 30 / texture.frame.height))
      icon.y = -6
      this._iconHolder.addChild(icon)
    }
    this.drawFrame()
    this._gearShown = ''
    if (item === null) this._tip.hide()
  }

  private drawFrame (): void {
    const S = GearSlot.SIZE
    const tint = this._item !== null ? tierTint(this._item.tier) : THEME.panelBorder
    this._frame.clear()
      .beginFill(0x101A28, 1)
      .lineStyle(this._item !== null ? 2 : 1, tint, 1)
      .drawRoundedRect(0, 0, S, S, 5)
      .endFill()
    if (this._gearArmed) this._frame.lineStyle(2, THEME.accent, 1).drawRoundedRect(-2, -2, S + 4, S + 4, 6)
  }

  /** As `SkillCard.tap`: on touch an aimed skill arms, and its card again casts along facing. */
  tap (pointerType: string | undefined): void {
    const skill = this._gearSkill
    if (this._item === null || skill === null) return
    const now = performance.now()
    if (pointerType === 'touch' && skill.aims && now >= this._gearReadyAt) {
      if (TouchAim.armed(now) === this) {
        TouchAim.disarm()
        this.invoke({ cell: undefined })
      } else {
        TouchAim.arm(this, now)
      }
      return
    }
    this.invoke(pointerType === 'touch' ? { cell: undefined } : undefined)
  }

  setArmed (armed: boolean): void {
    this._gearArmed = armed
    this._gearShown = ''
    this.drawFrame()
  }

  /** Inventory slot keys are fixed labels; settings rebind what presses them (`HUD.onKeyDown`). */
  setKey (_key: string): void {}

  /** `use_item` with this slot and the aim (the mouse's, a tapped cell, or none: along facing). */
  invoke (aim?: Aimed): void {
    if (this._item === null || this._gearSkill === null || Game.PLAYER === undefined) return
    const now = performance.now()
    if (now < this._gearReadyAt) return
    Game.socket.emit('use_item', Aim.message(this.slot, Skill.cellOf(aim)))
    this._gearReadyAt = now + this._cooldownMs
  }

  update (now: number): void {
    const left = this._gearReadyAt - now
    const text = this._item === null
      ? ''
      : this._item.skill === 0 ? '' : left > 0 ? `${Math.ceil(left / 1000)} s` : this._gearArmed ? 'TAP' : 'READY'
    if (text === this._gearShown) return
    this._gearShown = text
    this._cd.text = text
    this._cd.style.fill = left > 0 ? THEME.muted : THEME.ready
    this._iconHolder.alpha = left > 0 ? 0.4 : 1
  }
}

const BAG_ICON = 30
const BAG_GAP = 6

/**
 * The bag (decision #49): up to 4 items carried but not usable (found with
 * both slots full, parts, or anything a bot picks up), each a small frame
 * tinted by tier with its skill's icon, its lines on hover or a long press.
 * Placeholder look.
 */
export class GearBag extends Container {
  private readonly _cells: Container[] = []
  private readonly _items: Array<GearInstance | null> = []
  private _kit: readonly number[] = []

  constructor (size: number) {
    super()
    const label = Panel.text('BAG', THEME.smallSize, THEME.muted)
    label.y = (BAG_ICON - label.height) / 2
    this.addChild(label)
    for (let i = 0; i < size; i++) {
      const cell = new Container()
      cell.x = 44 + i * (BAG_ICON + BAG_GAP)
      cell.eventMode = 'static'
      const tip = new ItemTip()
      bindTip(cell, tip, BAG_ICON, () => {
        const item = this._items[i]
        return item !== null && item !== undefined ? itemLines(item, item.skill !== 0 && this._kit.includes(item.skill)) : undefined
      })
      cell.addChild(tip)
      this._cells.push(cell)
      this._items.push(null)
      this.addChild(cell)
    }
    this.set([], [])
  }

  /** The bag's entries (null = empty) and the kit's skill ids, for "ALREADY IN KIT". */
  set (items: ReadonlyArray<GearInstance | null>, kit: readonly number[]): void {
    this._kit = kit
    this._cells.forEach((cell, i) => {
      const item = items[i] ?? null
      this._items[i] = item
      // Keep the tip (the last child); redraw the rest.
      const tip = cell.children[cell.children.length - 1]
      cell.removeChildren()
      const frame = new Graphics()
        .beginFill(0x101A28, 1)
        .lineStyle(item !== null ? 2 : 1, item !== null ? tierTint(item.tier) : THEME.panelBorder, 1)
        .drawRoundedRect(0, 0, BAG_ICON, BAG_ICON, 4)
        .endFill()
      cell.addChild(frame)
      const texture = item !== null && item.skill !== 0 ? skillFor(item.skill, undefined as unknown as GameObject)?.uiTexture : undefined
      if (texture !== undefined) {
        const icon = new Sprite(texture)
        icon.anchor.set(0.5, 0.5)
        icon.scale.set(Math.min((BAG_ICON - 8) / texture.frame.width, (BAG_ICON - 8) / texture.frame.height))
        icon.x = icon.y = BAG_ICON / 2
        cell.addChild(icon)
      } else if (item !== null) {
        cell.addChild(new Graphics().beginFill(tierTint(item.tier), 1).drawCircle(BAG_ICON / 2, BAG_ICON / 2, 6).endFill())
      }
      if (tip !== undefined) cell.addChild(tip)
    })
  }
}
