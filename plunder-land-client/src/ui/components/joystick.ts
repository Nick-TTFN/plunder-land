import { Container, Graphics } from 'pixi.js'
import { THEME } from '../theme'

/** Base ring radius, CSS pixels. */
const BASE_RADIUS = 56
/** Knob radius, CSS pixels. */
const KNOB_RADIUS = 24
/** The ghost's alpha at rest: there to show where the stick lives, no more. */
const GHOST_ALPHA = 0.22
const ACTIVE_ALPHA = 0.6

export interface Rect { x: number, y: number, width: number, height: number }

/**
 * The left-thumb joystick's drawing and its one pointer (decision #59,
 * mobile-2). **Floating:** a press in its zone (`layout`) puts the base under
 * the thumb; at rest a faint ghost base sits bottom left so players see where
 * it lives. Drawn in screen pixels, unscaled by the HUD. Never a hit target
 * (`eventMode` none): presses reach the stage, which hands them here
 * (`index.ts`), so it consumes no other control's events.
 *
 * It follows one `pointerId` only; every other pointer is ignored, so the
 * right thumb's presses work during a drag. The direction maths is in
 * `input/stick.ts`.
 */
export class Joystick extends Container {
  /** The pointer driving it, or undefined at rest. */
  pointerId: number | undefined

  private readonly _base = new Graphics()
  private readonly _knob = new Graphics()
  private _zone: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private _ghostX = 0
  private _ghostY = 0
  private _shown = false
  private _baseX = 0
  private _baseY = 0
  /**
   * The last deflection drawn, so a re-layout while the stick is held (the
   * HUD re-lays itself on standings updates, about once a second) keeps the
   * knob where the thumb is instead of snapping it home.
   */
  private _dx = 0
  private _dy = 0

  constructor () {
    super()
    this.eventMode = 'none'
    this._base.lineStyle(3, THEME.text, 0.9)
    this._base.beginFill(THEME.panelFill, 0.35)
    this._base.drawCircle(0, 0, BASE_RADIUS)
    this._base.endFill()
    this._knob.beginFill(THEME.text, 0.85)
    this._knob.drawCircle(0, 0, KNOB_RADIUS)
    this._knob.endFill()
    this.addChild(this._base, this._knob)
    this.visible = false
  }

  /**
   * Where it may start (`zone`: the left of the screen under the top HUD band,
   * inside the safe area) and where the ghost rests (its centre), and whether
   * it is shown at all (touch mode, in a run).
   */
  layout (zone: Rect, ghostX: number, ghostY: number, shown: boolean): void {
    this._zone = zone
    this._ghostX = ghostX
    this._ghostY = ghostY
    this._shown = shown
    this._draw(this._dx, this._dy)
  }

  /** True if (x, y) is inside the zone a press may start the stick in. */
  inZone (x: number, y: number): boolean {
    const z = this._zone
    return this._shown && x >= z.x && x < z.x + z.width && y >= z.y && y < z.y + z.height
  }

  /** A press: take this pointer if it is in the zone and no other is held. */
  tryStart (pointerId: number, x: number, y: number): boolean {
    if (this.pointerId !== undefined || !this.inZone(x, y)) return false
    this.pointerId = pointerId
    this._baseX = x
    this._baseY = y
    this._draw(0, 0)
    return true
  }

  /**
   * A move of `pointerId` to (x, y): the stick's deflection from the base in
   * CSS pixels, or undefined if that is not the stick's pointer.
   */
  move (pointerId: number, x: number, y: number): { dx: number, dy: number } | undefined {
    if (pointerId !== this.pointerId) return undefined
    const dx = x - this._baseX
    const dy = y - this._baseY
    this._draw(dx, dy)
    return { dx, dy }
  }

  /** The stick's pointer is up (or cancelled, or the mode changed). True if it was held. */
  end (pointerId?: number): boolean {
    if (this.pointerId === undefined) return false
    if (pointerId !== undefined && pointerId !== this.pointerId) return false
    this.pointerId = undefined
    this._draw(0, 0)
    return true
  }

  private _draw (dx: number, dy: number): void {
    this._dx = dx
    this._dy = dy
    this.visible = this._shown
    if (!this._shown) return
    if (this.pointerId === undefined) {
      this.alpha = GHOST_ALPHA
      this._base.position.set(this._ghostX, this._ghostY)
      this._knob.position.set(this._ghostX, this._ghostY)
      return
    }
    this.alpha = ACTIVE_ALPHA
    const length = Math.sqrt(dx * dx + dy * dy)
    const k = length > BASE_RADIUS ? BASE_RADIUS / length : 1
    this._base.position.set(this._baseX, this._baseY)
    this._knob.position.set(this._baseX + dx * k, this._baseY + dy * k)
  }

  /** The ghost's distance in from the safe area's corner, to its centre. */
  static readonly INSET = BASE_RADIUS + 24
}
