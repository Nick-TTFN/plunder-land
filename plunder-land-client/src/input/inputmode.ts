/**
 * Touch mode (decision #59, mobile-2): whether the controls are the touch ones
 * (the joystick, and mobile-3's buttons) or the desktop ones (click-to-move,
 * keys). One flag, read by the HUD and the input, with a change event. No pixi
 * here.
 *
 * It starts on for a coarse pointer (`(pointer: coarse)`), and after that **the
 * last kind of press decides** (Nick, 2026-11-04): a `pointerdown` of type
 * `touch` anywhere turns it on, one of type `mouse` turns it off, and a pen
 * changes nothing. So a touchscreen laptop starts in desktop mode and
 * switches the first time it is touched, and back on the next mouse click.
 *
 * On a portal that says what the device is (CrazyGames' system info, g2-6f)
 * that reading replaces the coarse-pointer guess once the SDK is ready
 * (`seedTouchMode`), unless a press has already decided; presses decide after.
 *
 * Not `HUD.phone()`, which is screen size: a tablet is touch at any size, and
 * a small desktop window is not touch. HUD *size* follows `HUD.phone()`;
 * *controls* follow this.
 */
export const INPUT_MODE = {
  touch: false,
  /** Called after every change of `touch`. */
  listeners: new Set<(touch: boolean) => void>()
}

/** Set touch mode, telling the listeners if it changed. */
export function setTouchMode (touch: boolean): void {
  if (INPUT_MODE.touch === touch) return
  INPUT_MODE.touch = touch
  // forEach, not for-of: the client's tsconfig targets ES5 without downlevelIteration.
  INPUT_MODE.listeners.forEach((listener) => {
    // One throwing listener must not stop the others (or the press).
    try { listener(touch) } catch (e) { console.error('touch mode listener failed', e) }
  })
}

/** The mode a `pointerdown` of this type implies, or undefined for no change. */
export function modeForPress (pointerType: string): boolean | undefined {
  if (pointerType === 'touch') return true
  if (pointerType === 'mouse') return false
  return undefined
}

let _installed = false
/** A press has set the mode: a later seed from the portal changes nothing (#59's rule wins). */
let _pressed = false

/**
 * The starting mode from a source better than the pointer guess (the portal's
 * device type, g2-6f). Ignored once a press has decided. Returns whether it
 * was applied.
 */
export function seedTouchMode (touch: boolean): boolean {
  if (_pressed) return false
  setTouchMode(touch)
  return true
}

/**
 * Read the starting mode and follow every press from now on. In the capture
 * phase on the window, so the mode is already right by the time pixi (or a
 * DOM menu) handles the same press. Once per page.
 */
export function installInputMode (target: Window = window): void {
  if (_installed) return
  _installed = true
  try {
    INPUT_MODE.touch = target.matchMedia('(pointer: coarse)').matches
  } catch {
    INPUT_MODE.touch = false
  }
  target.addEventListener('pointerdown', (event: PointerEvent) => {
    const touch = modeForPress(event.pointerType)
    if (touch === undefined) return
    _pressed = true
    setTouchMode(touch)
  }, { capture: true, passive: true })
}
