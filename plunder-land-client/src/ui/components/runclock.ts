import { type Text } from 'pixi.js'
import { Panel } from './panel'
import { THEME } from '../theme'

/**
 * The mockup's top-centre clock: time in this run, mm:ss, from the moment the
 * run's own player was created (decision 3 of the HUD spec: client-only).
 * `start` begins a run's count; the HUD makes a new clock per run anyway.
 */
export class RunClock extends Panel {
  private readonly _text: Text
  private _startedAt = performance.now()
  private _shown = ''

  constructor () {
    super()
    this._text = Panel.text('00:00', THEME.titleSize + 6, THEME.text)
    this.body.addChild(this._text)
    this.body.y = 8
    this.resize(this._text.width + 2 * THEME.pad, this._text.height + 16)
  }

  start (): void {
    this._startedAt = performance.now()
  }

  /** Seconds since `start`. */
  get elapsed (): number {
    return (performance.now() - this._startedAt) / 1000
  }

  update (): void {
    const s = Math.floor(this.elapsed)
    const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    if (text !== this._shown) {
      this._shown = text
      this._text.text = text
    }
  }
}
