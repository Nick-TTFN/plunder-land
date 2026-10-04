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
  return { stock, cap, nextInMs, regenMs }
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
