import { INPUT_MODE } from '../input/inputmode'

/**
 * The rotate prompt (decision #59, mobile-4): in touch mode with the screen
 * taller than it is wide, a full-screen DOM overlay, "Rotate your device",
 * over everything, **in the lobby and in a run alike** (Nick, 2026-11-04: so
 * the phone is turned before landing in a level, not in a panic after). It
 * pauses nothing (there is no pause): a run goes on underneath, and the
 * lobby's portrait layout stays under it as a fallback. It takes every touch
 * while shown, so nothing underneath is pressed by accident.
 *
 * No `screen.orientation.lock`: it works only in fullscreen and not on iOS.
 * Re-checked on resize, on an orientation change and on a change of input
 * mode (a mouse press on a portrait touchscreen laptop hides it).
 */
const STYLE = `
.rp { position: fixed; inset: 0; z-index: 50; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
  background: #0B1220; color: #E6EEF5; font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; user-select: none;
  touch-action: none; text-align: center; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.rp.rp-on { display: flex; }
.rp-icon { width: 96px; height: 96px; }
.rp-title { font-size: 20px; letter-spacing: .16em; }
.rp-hint { font-size: 13px; letter-spacing: .08em; color: #8FA3B5; max-width: 260px; line-height: 1.5; }
`

/** A phone outline and a quarter-turn arrow, drawn inline (no sprite). */
const ICON = `<svg class="rp-icon" viewBox="0 0 96 96" fill="none" stroke="#33DBD3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
<rect x="30" y="14" width="36" height="62" rx="6"/><line x1="44" y1="68" x2="52" y2="68"/>
<path d="M78 40 A30 30 0 0 0 58 14"/><polyline points="72,38 78,40 82,34"/></svg>`

/** Whether the prompt should show: touch mode and portrait. */
export function wantsRotate (touch: boolean, width: number, height: number): boolean {
  return touch && height > width
}

let _root: HTMLDivElement | undefined

/** Show or hide the prompt for the window as it is now. */
export function refreshRotatePrompt (): void {
  if (_root === undefined) return
  _root.classList.toggle('rp-on', wantsRotate(INPUT_MODE.touch, window.innerWidth, window.innerHeight))
}

/** Add the overlay and follow the window from now on. Once per page. */
export function installRotatePrompt (): void {
  if (_root !== undefined || typeof document === 'undefined' || document.body === null) return
  const style = document.createElement('style')
  style.id = 'rotate-style'
  style.textContent = STYLE
  document.head.append(style)
  const root = document.createElement('div')
  root.className = 'rp'
  root.setAttribute('role', 'alert')
  root.innerHTML = `${ICON}<div class="rp-title">ROTATE YOUR DEVICE</div><div class="rp-hint">Plunderbots plays in landscape. Turn your phone sideways to continue.</div>`
  // Every press stops here: the game and the lobby under it get none.
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'click']) {
    root.addEventListener(type, (e) => { e.stopPropagation() })
  }
  document.body.append(root)
  _root = root
  window.addEventListener('resize', refreshRotatePrompt)
  window.addEventListener('orientationchange', refreshRotatePrompt)
  INPUT_MODE.listeners.add(refreshRotatePrompt)
  refreshRotatePrompt()
}
