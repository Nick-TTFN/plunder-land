/**
 * Energy (decision #48 step 7). Pixi-free, so the server's specs run it
 * (`network/energy.spec.ts` there).
 *
 * A run costs one play; an extraction gives it back; plays come back one per
 * `regenMs` while below `cap`. The server says where this account stands in
 * `account.energy` on connect, in `energy` after each spend and refund, and in
 * `start_refused { reason: 'energy', energy }` when READY found none left.
 * Every number is the server's; `nextInMs` is relative, so a wrong clock on
 * this machine doesn't matter. No view (an offline account, which plays free,
 * or a server from before energy) means no energy line.
 */

export interface EnergyView {
  stock: number
  cap: number
  /** Until the next play comes back; null at or above the cap. */
  nextInMs: number | null
  regenMs: number
  /**
   * The rewarded-video refill (g2-6d), only where the server offers it (a
   * portal in its `AD_REFILL_PORTALS`); absent, no button. `offered`: no
   * play left and both limits allow. `nextInMs`: no play left and a limit
   * (30 min apart, 3 per UTC day) is in the way, until it allows.
   */
  adRefill?: AdRefillView
}

export interface AdRefillView {
  offered: boolean
  nextInMs?: number
}

/** Why the server refused a start. Only `energy` today. */
export interface Refusal {
  reason: string
  energy: EnergyView | undefined
}

/**
 * The account's energy as last sent, when it arrived (for the countdown),
 * and who wants to hear when it changes (the lobby). Cleared on every
 * (re)connect, like `ACCOUNT`.
 */
export const ENERGY: { view: EnergyView | undefined, receivedAt: number, listeners: Set<() => void> } = { view: undefined, receivedAt: 0, listeners: new Set() }

/** Replace the energy view and tell the listeners. */
export function setEnergy (view: EnergyView | undefined, now: number): void {
  ENERGY.view = view
  ENERGY.receivedAt = now
  // forEach, not for-of: the client's tsconfig targets ES5 for typechecking.
  ENERGY.listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // One broken listener must not stop the others.
    }
  })
}

function count (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** An `energy` view (the event, or the field of `account` or `start_refused`), or undefined for a malformed one. */
export function onEnergy (data: unknown): EnergyView | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const stock = count(d.stock)
  const cap = count(d.cap)
  const regenMs = count(d.regenMs)
  const nextInMs = d.nextInMs === null ? null : count(d.nextInMs)
  if (stock === undefined || cap === undefined || cap < 1 || regenMs === undefined || regenMs < 1 || nextInMs === undefined) return undefined
  const view: EnergyView = { stock, cap, nextInMs, regenMs }
  // The refill's part is optional: a malformed one is dropped, never the view.
  const adRefill = adRefillOf(d.adRefill)
  if (adRefill !== undefined) view.adRefill = adRefill
  return view
}

function adRefillOf (data: unknown): AdRefillView | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { offered, nextInMs } = data as { offered?: unknown, nextInMs?: unknown }
  if (typeof offered !== 'boolean') return undefined
  if (nextInMs === undefined) return { offered }
  const ms = count(nextInMs)
  return ms === undefined ? { offered } : { offered, nextInMs: ms }
}

/**
 * What the lobby shows of the refill `elapsedMs` after the view arrived
 * (g2-6d): `button` (offered, still no play left), `wait` with the time left
 * (a limit in the way; once it has passed, the button, since the server's
 * limits are time-based and it decides again on the request), or `none`
 * (not offered here, plays left, or a limit with no time given).
 */
export type AdOffer = { kind: 'none' } | { kind: 'button' } | { kind: 'wait', inMs: number }

export function adOffer (view: EnergyView | undefined, elapsedMs: number): AdOffer {
  const ad = view?.adRefill
  if (view === undefined || ad === undefined) return { kind: 'none' }
  if (projectEnergy(view, elapsedMs).stock > 0) return { kind: 'none' }
  if (ad.offered) return { kind: 'button' }
  if (ad.nextInMs === undefined) return { kind: 'none' }
  const left = ad.nextInMs - Math.max(0, elapsedMs)
  return left > 0 ? { kind: 'wait', inMs: left } : { kind: 'button' }
}

/** `mm:ss`, or `h:mm:ss` from an hour, rounded up to the second. */
export function clockOf (ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number): string => (n < 10 ? '0' : '') + String(n)
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

/** A `start_refused` event, or undefined for a malformed one. */
export function onRefused (data: unknown): Refusal | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { reason, energy } = data as { reason?: unknown, energy?: unknown }
  if (typeof reason !== 'string') return undefined
  return { reason, energy: onEnergy(energy) }
}

/**
 * The view `elapsedMs` after it arrived: plays that have come back since,
 * up to the cap, as the server will count them. For showing only; the
 * server decides at READY.
 */
export function projectEnergy (view: EnergyView, elapsedMs: number): { stock: number, nextInMs: number | null } {
  if (view.nextInMs === null || view.stock >= view.cap) return { stock: view.stock, nextInMs: null }
  const elapsed = Math.max(0, elapsedMs)
  if (elapsed < view.nextInMs) return { stock: view.stock, nextInMs: view.nextInMs - elapsed }
  const regained = 1 + Math.floor((elapsed - view.nextInMs) / view.regenMs)
  const stock = Math.min(view.cap, view.stock + regained)
  if (stock >= view.cap) return { stock, nextInMs: null }
  return { stock, nextInMs: view.regenMs - (elapsed - view.nextInMs) % view.regenMs }
}

/** Whole minutes, rounded up, at least 1. */
function minutes (ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 60_000))}M`
}

/** The lobby's energy line, `elapsedMs` after the view arrived. */
export function energyLine (view: EnergyView, elapsedMs: number): string {
  const { stock, nextInMs } = projectEnergy(view, elapsedMs)
  if (stock === 0) return nextInMs === null ? 'NO PLAYS LEFT' : `NO PLAYS LEFT · NEXT IN ${minutes(nextInMs)}`
  const plays = `PLAYS ${stock}/${view.cap}`
  return nextInMs === null ? plays : `${plays} · +1 IN ${minutes(nextInMs)}`
}

/** Whether READY should wait: the last view, counted forward, has no play left. */
export function outOfPlays (view: EnergyView | undefined, elapsedMs: number): boolean {
  return view !== undefined && projectEnergy(view, elapsedMs).stock === 0
}
