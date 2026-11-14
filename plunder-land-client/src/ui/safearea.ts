/**
 * The screen's safe-area insets in CSS pixels (a notch, rounded corners, the
 * home bar), for the touch controls (decision #59: the joystick here, mobile-3
 * and mobile-4 after it). Read from `env(safe-area-inset-*)` on a hidden probe
 * element, which reports them only because the viewport meta asks for
 * `viewport-fit=cover` (`assets/index.html`). All 0 where there are none.
 *
 * Every inset is `var(--safe-area-inset-X, env(safe-area-inset-X, 0px))`
 * (g2-6f): CrazyGames' SDK sets those variables on the page, inside its app,
 * to the part of the inset over the game's iframe, where `env()` is wrong
 * (always 0 on Android; on iOS blind to where the iframe sits). Off
 * CrazyGames nothing sets them and `env()` is read as before.
 *
 * `refreshSafeArea` re-reads them; call it on resize (a rotation changes them,
 * and CrazyGames updates its variables "when the device rotates").
 */
export const SAFE_AREA = { top: 0, right: 0, bottom: 0, left: 0 }

let _probe: HTMLDivElement | undefined

function probe (): HTMLDivElement | undefined {
  if (_probe !== undefined) return _probe
  if (typeof document === 'undefined' || document.body === null) return undefined
  const el = document.createElement('div')
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:0', 'height:0',
    'visibility:hidden', 'pointer-events:none',
    'padding-top:var(--safe-area-inset-top, env(safe-area-inset-top, 0px))',
    'padding-right:var(--safe-area-inset-right, env(safe-area-inset-right, 0px))',
    'padding-bottom:var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))',
    'padding-left:var(--safe-area-inset-left, env(safe-area-inset-left, 0px))'
  ].join(';')
  document.body.appendChild(el)
  _probe = el
  return el
}

/** Re-read the insets. Safe to call before the body exists (it reads 0 then). */
export function refreshSafeArea (): typeof SAFE_AREA {
  const el = probe()
  if (el === undefined) return SAFE_AREA
  const style = window.getComputedStyle(el)
  const px = (value: string): number => {
    const n = parseFloat(value)
    return Number.isFinite(n) ? n : 0
  }
  SAFE_AREA.top = px(style.paddingTop)
  SAFE_AREA.right = px(style.paddingRight)
  SAFE_AREA.bottom = px(style.paddingBottom)
  SAFE_AREA.left = px(style.paddingLeft)
  return SAFE_AREA
}
