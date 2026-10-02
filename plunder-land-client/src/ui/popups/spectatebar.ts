import { Container, Graphics, type Text } from 'pixi.js'
import { Panel } from '../components/panel'
import { THEME } from '../theme'
import { HUD } from '../components/hud'

/**
 * Shown while a dead player spectates (decision #47): whom it watches, and
 * the way back to its run card or into the next run. At the top of the
 * screen, beside the popups rather than in their queue, so the run card can
 * stay up under it. Placeholder look, the HUD's panel kit.
 */
export class SpectateBar extends Container {
  private readonly _panel: Panel
  private readonly _name: Text

  constructor (onCard: () => void, onAgain: () => void) {
    super()
    const panel = this._panel = new Panel('SPECTATING')
    this._name = Panel.text('', THEME.bodySize, THEME.accent)
    panel.body.addChild(this._name)
    const card = SpectateBar.button('RUN CARD', 130, onCard, true)
    const again = SpectateBar.button('PLAY AGAIN', 150, onAgain, false)
    card.y = again.y = 30
    again.x = 140
    panel.body.addChild(card, again)
    panel.fit(300)
    panel.x = -panel.panelWidth / 2
    this.addChild(panel)
  }

  setTarget (name: string): void {
    this._name.text = name
  }

  /** At the top centre of a screen `height` CSS pixels tall, for a parent at its centre. */
  layout (height: number): void {
    this.scale.set(HUD.scale())
    this.y = -height / 2 + 16
  }

  private static button (label: string, width: number, onTap: () => void, quiet: boolean): Container {
    const button = new Container()
    const height = 34
    const bg = new Graphics()
      .beginFill(quiet ? 0x0B1A22 : 0x0F3340, 1)
      .lineStyle(quiet ? 1 : 2, quiet ? THEME.muted : THEME.accent, 1)
      .drawRoundedRect(0, 0, width, height, 6)
      .endFill()
    const text = Panel.text(label, THEME.bodySize, quiet ? THEME.text : THEME.accent)
    text.anchor.set(0.5, 0.5)
    text.x = width / 2
    text.y = height / 2
    button.addChild(bg, text)
    button.eventMode = 'static'
    button.cursor = 'pointer'
    button.on('pointertap', onTap)
    return button
  }
}
