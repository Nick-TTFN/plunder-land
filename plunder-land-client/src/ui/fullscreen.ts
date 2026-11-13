/**
 * Fullscreen for the whole page (Nick, 2026-11-05: a fullscreen button for
 * mobile; on every device since g2-1). The standard API with Safari's
 * `webkit` prefix. iPhone Safari has neither for anything but video, so
 * `fullscreenSupported` is false there and no button is shown (decision #62:
 * hidden on iPhone, which needs no case beyond this check); iPad Safari,
 * Android Chrome and desktop browsers have it. Inside an iframe (itch's
 * embed) it works only if the frame allows it. Whether a button is offered
 * at all: `fullscreenButtonShown` (`net/portal.ts`).
 */
interface WebkitDocument {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
interface WebkitElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

export function fullscreenSupported (): boolean {
  const doc = document as Document & WebkitDocument
  return doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true
}

export function isFullscreen (): boolean {
  const doc = document as Document & WebkitDocument
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null
}

/** Enter or leave fullscreen. Must run inside a user gesture (a tap or click handler). */
export function toggleFullscreen (): void {
  const doc = document as Document & WebkitDocument
  try {
    if (isFullscreen()) {
      if (typeof doc.exitFullscreen === 'function') void doc.exitFullscreen().catch(() => {})
      else void doc.webkitExitFullscreen?.()
      return
    }
    const root = document.documentElement as HTMLElement & WebkitElement
    if (typeof root.requestFullscreen === 'function') void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => {})
    else void root.webkitRequestFullscreen?.()
  } catch {
    // Refused (no gesture, a frame without permission): stay as we are.
  }
}

/** Call `listener` whenever fullscreen is entered or left (Esc included); returns its removal. */
export function onFullscreenChange (listener: () => void): () => void {
  document.addEventListener('fullscreenchange', listener)
  document.addEventListener('webkitfullscreenchange', listener)
  return () => {
    document.removeEventListener('fullscreenchange', listener)
    document.removeEventListener('webkitfullscreenchange', listener)
  }
}
