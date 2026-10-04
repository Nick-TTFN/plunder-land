import { Container, Graphics, Sprite, Text } from 'pixi.js'
import { Panel } from './panel'
import { THEME } from '../theme'
import { type Aimed, type Skill } from '../../skills/skill'
import { TouchAim } from '../../skills/touchaim'

const CARD_W = 104
const CARD_H = 112
const CARD_GAP = 8

/**
 * One skill: its key, icon, name, and READY or the seconds left. A tap or its
 * key sends it (`invoke`). The cooldown shown is the client's own estimate from
 * `Skill.cooldown`, as the button timer it replaces was; the server decides,
 * and may refuse a press (a standing Dash with no free cell spends nothing).
 */
export class SkillCard extends Container {
  private _readyAt = 0
  /** Armed on touch, waiting for a tap on its target (`TouchAim`). */
  private _armed = false
  private readonly _ring = new Graphics()
  private readonly _status: Text
  private readonly _icon: Sprite | undefined
  private _shown = ''
  private readonly _keyText: Text

  /** `skill` null is an empty slot: its key and EMPTY, dimmed, not pressable. */
  constructor (readonly skill: Skill | null, private _key: string) {
    super()
    const bg = new Graphics()
      .beginFill(0x101A28, 1)
      .lineStyle(1, THEME.panelBorder, 1)
      .drawRoundedRect(0, 0, CARD_W, CARD_H, 6)
      .endFill()
    this.addChild(bg)

    const keyBox = new Graphics()
      .lineStyle(1, THEME.muted, 1)
      .drawRoundedRect(6, 6, 22, 22, 3)
    this.addChild(keyBox)
    const keyText = this._keyText = Panel.text(_key.toUpperCase(), THEME.smallSize, THEME.text)
    keyText.anchor.set(0.5, 0.5)
    keyText.x = 17
    keyText.y = 17
    this.addChild(keyText)

    if (skill === null) {
      // Placeholder until empty-slot art (Dez's missing-art list).
      this._status = Panel.text('EMPTY', THEME.smallSize, THEME.muted)
      this._status.anchor.set(0.5, 0.5)
      this._status.x = CARD_W / 2
      this._status.y = CARD_H / 2
      this.addChild(this._status)
      this.alpha = 0.45
      return
    }
    // On the card, not its background: a press on the icon or the name hit
    // those (pixi tests every child) and bubbled up past the background, so
    // only the card's empty edges cast.
    this.eventMode = 'static'
    this.cursor = 'pointer'
    this.on('pointertap', (e: { pointerType?: string }) => { this.tap(e.pointerType) })

    this._icon = new Sprite(skill.uiTexture)
    this._icon.anchor.set(0.5, 0.5)
    const size = 34
    const frame = skill.uiTexture.frame
    const scale = Math.min(size / frame.width, size / frame.height)
    this._icon.scale.set(scale, scale)
    this._icon.x = CARD_W / 2
    this._icon.y = 40
    this.addChild(this._icon)

    const name = new Text((skill.name ?? '').toUpperCase(), {
      fontFamily: THEME.font,
      fontSize: 11,
      fill: THEME.text,
      align: 'center',
      wordWrap: true,
      wordWrapWidth: CARD_W - 10
    })
    name.anchor.set(0.5, 0)
    name.x = CARD_W / 2
    name.y = 62
    this.addChild(name)

    this._status = Panel.text('READY', THEME.smallSize, THEME.ready)
    this._status.anchor.set(0.5, 1)
    this._status.x = CARD_W / 2
    this._status.y = CARD_H - 6
    this.addChild(this._status)

    this._ring.lineStyle(2, THEME.accent, 1).drawRoundedRect(1, 1, CARD_W - 2, CARD_H - 2, 6)
    this._ring.visible = false
    this.addChild(this._ring)
  }

  /**
   * A tap: on touch an aimed skill arms, and a second tap on its card casts
   * it along facing (`TouchAim`); anything else casts at once (on desktop
   * the mouse aims).
   */
  tap (pointerType: string | undefined): void {
    if (this.skill === null) return
    if (pointerType === 'touch' && this.skill.aims && performance.now() >= this._readyAt) {
      if (TouchAim.armed(performance.now()) === this) {
        TouchAim.disarm()
        this.invoke({ cell: undefined })
      } else {
        TouchAim.arm(this, performance.now())
      }
      return
    }
    this.invoke(pointerType === 'touch' ? { cell: undefined } : undefined)
  }

  setArmed (armed: boolean): void {
    this._armed = armed
    if (this.skill !== null) this._ring.visible = armed
    this._shown = ''
  }

  get key (): string {
    return this._key
  }

  /** A new key from settings, mid-run: the card keeps its cooldown. */
  setKey (key: string): void {
    this._key = key
    this._keyText.text = key.toUpperCase()
  }

  invoke (aim?: Aimed): void {
    if (this.skill === null) return
    const now = performance.now()
    if (now < this._readyAt) return
    this.skill.execute(aim)
    this._readyAt = now + (this.skill.cooldown ?? 0) * 1000
  }

  update (now: number): void {
    if (this.skill === null || this._icon === undefined) return
    const left = this._readyAt - now
    const text = left > 0 ? `${Math.ceil(left / 1000)} s` : this._armed ? 'TAP TARGET' : 'READY'
    if (text === this._shown) return
    this._shown = text
    this._status.text = text
    this._status.style.fill = left > 0 ? THEME.muted : THEME.ready
    this._icon.alpha = left > 0 ? 0.4 : 1
  }
}

/**
 * The mockup's bottom-left SKILLS panel: a card per slot, card i on `keys[i]`
 * (q w e r; q to i in the legacy fallback, `net/loadout.ts` `slotsFor`).
 * Card i's skill is slot i of `hello.skills`, and a press sends i (a wire
 * contract: the server indexes the same 4). An empty slot keeps its card, so
 * the keys keep their places. Wraps into rows to fit `maxWidth`.
 */
export class SkillPanel extends Panel {
  readonly cards: SkillCard[] = []
  /** Rows the last `wrap` needed. */
  rows = 1

  constructor (skills: Array<Skill | null>, keys: readonly string[]) {
    super('SKILLS')
    skills.forEach((skill, i) => {
      if (keys[i] === undefined) return
      const card = new SkillCard(skill, keys[i])
      this.cards.push(card)
      this.body.addChild(card)
    })
    this.wrap(Infinity)
  }

  /** Lay the cards out in as few rows as fit in `maxWidth` (panel width, padding included). */
  wrap (maxWidth: number): void {
    const perRow = Math.max(1, Math.min(this.cards.length, Math.floor((maxWidth - 2 * THEME.pad + CARD_GAP) / (CARD_W + CARD_GAP))))
    this.rows = Math.ceil(this.cards.length / perRow)
    this.cards.forEach((card, i) => {
      card.x = (i % perRow) * (CARD_W + CARD_GAP)
      card.y = Math.floor(i / perRow) * (CARD_H + CARD_GAP)
    })
    this.fit()
  }

  update (now: number): void {
    for (const card of this.cards) card.update(now)
  }
}
