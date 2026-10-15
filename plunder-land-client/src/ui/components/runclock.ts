import { Graphics, type Text } from 'pixi.js'
import { Panel } from './panel'
import { THEME } from '../theme'
import { Game } from '../../game'
import { bandOf, type LatencyBand } from '../../net/latency'

const BAND_COLOUR: Record<LatencyBand, number> = {
  good: THEME.hp,
  fair: THEME.loot,
  poor: THEME.danger,
  none: THEME.muted
}

/**
 * The mockup's top-centre clock: time in this run, mm:ss, from the moment the
 * run's own player was created (decision 3 of the HUD spec: client-only).
 * `start` begins a run's count; the HUD makes a new clock per run anyway.
 *
 * Under it, the round trip to the server (`Game.latency`), coloured green,
 * amber or red (`bandOf`); grey "--" while there is no reading.
 */
export class RunClock extends Panel {
  private readonly _text: Text
  private readonly _ping: Text
  private readonly _dot = new Graphics()
  private _startedAt = performance.now()
  private _shown = ''
  private _pingShown = ''
  private _band: LatencyBand | undefined

  constructor () {
    super()
    this._text = Panel.text('00:00', THEME.titleSize + 6, THEME.text)
    this.body.addChild(this._text)
    this._ping = Panel.text('-- ms', THEME.smallSize, THEME.muted)
    this._ping.y = this._text.height + 2
    this.body.addChild(this._dot, this._ping)
    this.body.y = 8
    this.resize(this._text.width + 2 * THEME.pad, this._ping.y + this._ping.height + 16)
    this.updatePing()
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
    this.updatePing()
  }

  private updatePing (): void {
    const ms = Game.latency.ms
    const text = ms === undefined ? '-- ms' : `${Math.min(ms, 9999)} ms`
    const band = bandOf(ms)
    if (text === this._pingShown && band === this._band) return
    this._pingShown = text
    this._ping.text = text
    if (band !== this._band) {
      this._band = band
      this._ping.style.fill = BAND_COLOUR[band]
      const r = 4
      this._dot.clear().beginFill(BAND_COLOUR[band]).drawCircle(r, 0, r).endFill()
    }
    // Dot and number centred together under the time.
    const gap = 6
    const rowW = 8 + gap + this._ping.width
    const left = (this._text.width - rowW) / 2
    this._dot.x = left
    this._dot.y = this._ping.y + this._ping.height / 2
    this._ping.x = left + 8 + gap
  }
}
