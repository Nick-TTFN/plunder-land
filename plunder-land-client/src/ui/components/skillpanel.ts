import { Container, Graphics, Sprite, Text } from 'pixi.js'
import { Panel } from './panel'
import { THEME } from '../theme'
import { type Skill } from '../../skills/skill'

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
  private readonly _status: Text
  private readonly _icon: Sprite
  private _shown = ''

  constructor (readonly skill: Skill, readonly key: string) {
    super()
    const bg = new Graphics()
      .beginFill(0x101A28, 1)
      .lineStyle(1, THEME.panelBorder, 1)
      .drawRoundedRect(0, 0, CARD_W, CARD_H, 6)
      .endFill()
    bg.eventMode = 'static'
    bg.cursor = 'pointer'
    bg.on('pointertap', () => { this.invoke() })
    this.addChild(bg)

    const keyBox = new Graphics()
      .lineStyle(1, THEME.muted, 1)
      .drawRoundedRect(6, 6, 22, 22, 3)
    this.addChild(keyBox)
    const keyText = Panel.text(key.toUpperCase(), THEME.smallSize, THEME.text)
    keyText.anchor.set(0.5, 0.5)
    keyText.x = 17
    keyText.y = 17
    this.addChild(keyText)

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
  }

  invoke (): void {
    const now = performance.now()
    if (now < this._readyAt) return
    this.skill.execute()
    this._readyAt = now + (this.skill.cooldown ?? 0) * 1000
  }

  update (now: number): void {
    const left = this._readyAt - now
    const text = left > 0 ? `${Math.ceil(left / 1000)} s` : 'READY'
    if (text === this._shown) return
    this._shown = text
    this._status.text = text
    this._status.style.fill = left > 0 ? THEME.muted : THEME.ready
    this._icon.alpha = left > 0 ? 0.4 : 1
  }
}

/**
 * The mockup's bottom-left SKILLS panel: a card for each of the player's
 * skills, keyed q w e r t y u i in `Player.skills` order (a wire contract:
 * the index pressed is the server's slot). Wraps into rows to fit `maxWidth`.
 */
export class SkillPanel extends Panel {
  readonly cards: SkillCard[] = []
  /** Rows the last `wrap` needed. */
  rows = 1

  constructor (skills: Skill[]) {
    super('SKILLS')
    const keys = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i']
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
