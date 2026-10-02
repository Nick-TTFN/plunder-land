import { PROTOCOL } from '../utils/protocol'

/**
 * What a `welcome` (the server's protocol number, utils/protocol.ts) asks of
 * this page. Pixi-free, so the server's specs run it.
 *
 * A different number means the page is a client from another release: reload
 * to fetch the matching one. The server and the client deploy separately, so
 * the reloaded page can still be the old client for a minute or two; then it
 * tries again every `RETRY_MS`, at most `MAX_RELOADS` times per number, and
 * after that plays on rather than reload forever. The count lives in
 * sessionStorage (`KEY`), per tab.
 */
export const KEY = 'plunderland_reload'
export const RETRY_MS = 20000
export const MAX_RELOADS = 6

/** Reloads made for one server protocol number. */
export interface Pending {
  protocol: number
  reloads: number
}

export type Welcome =
  /** The numbers match, or the server sent none (from before `welcome`): forget any count. */
  | { action: 'match' }
  /** Reload after `delayMs`, having stored `next`. */
  | { action: 'reload', delayMs: number, next: Pending }
  /** Reloaded `MAX_RELOADS` times for this number and still behind: play on. */
  | { action: 'give-up', protocol: number }

export function decideWelcome (data: unknown, pending: Pending | null): Welcome {
  const protocol = (data as { protocol?: unknown } | null)?.protocol
  if (typeof protocol !== 'number' || protocol === PROTOCOL) return { action: 'match' }
  const reloads = pending?.protocol === protocol ? pending.reloads : 0
  if (reloads >= MAX_RELOADS) return { action: 'give-up', protocol }
  return { action: 'reload', delayMs: reloads === 0 ? 0 : RETRY_MS, next: { protocol, reloads: reloads + 1 } }
}

/** The stored count, or null if there is none or it is unreadable. */
export function readPending (raw: string | null): Pending | null {
  if (raw === null) return null
  try {
    const p = JSON.parse(raw)
    return typeof p?.protocol === 'number' && typeof p?.reloads === 'number' ? p : null
  } catch {
    return null
  }
}
