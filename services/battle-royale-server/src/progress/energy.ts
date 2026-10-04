import { ENERGY } from './xp'

/**
 * Energy (decision #48 step 7), the arithmetic both account stores share. No
 * pg, no `World`. The numbers are `ENERGY` in `progress/xp.ts`.
 *
 * A stock is stored with the time it was true (`asOfMs`) and regenerated
 * lazily on every read: below the cap, one play per whole `regenMs` since
 * `asOfMs`, never past the cap; at or above the cap, nothing, and the clock
 * starts again from the moment the stock falls below it. A new account has
 * no row: it reads as `ENERGY.start` (6) from now, so accounts made before
 * energy shipped start at 6 too.
 *
 * A run costs one play (`spendAt`), refused at 0. An extraction or a run the
 * server cut short gives it back (`refundAt`, `Worlds`). A refund is +1
 * whatever the stock, so it can lift it above the cap: a run spent at the
 * cap restarts the 30-minute clock, and one longer than that regenerates a
 * play before its refund lands, ending at cap + 1. It needs a 30-minute run
 * and gives at most one play over the cap (a stock above the cap starts no
 * clock). Kept on purpose (Nick, #48 step 7, 2026-10-04): the meta is a
 * greedy baseline with the occasional fair surprise, and this edge only ever
 * favours the player. Don't clamp it.
 */

/** A stock as stored: the plays left and when that was true. */
export interface EnergyRecord {
  stock: number
  asOfMs: number
}

/** What a client is told (`account.energy`, `energy`, `start_refused.energy`). */
export interface EnergyView {
  stock: number
  cap: number
  /** Until the next play comes back, relative so a wrong client clock doesn't matter; null at or above the cap. */
  nextInMs: number | null
  regenMs: number
}

/** The record as of `nowMs`: plays regenerated since `asOfMs` added, up to the cap. `null` is a new account. */
export function energyAt (record: EnergyRecord | null, nowMs: number): EnergyRecord {
  if (record === null) return { stock: ENERGY.start, asOfMs: nowMs }
  if (record.stock >= ENERGY.cap) return { stock: record.stock, asOfMs: nowMs }
  // Another server's clock may be a little behind the one that wrote it.
  const regained = Math.floor(Math.max(0, nowMs - record.asOfMs) / ENERGY.regenMs)
  if (record.stock + regained >= ENERGY.cap) return { stock: ENERGY.cap, asOfMs: nowMs }
  return { stock: record.stock + regained, asOfMs: record.asOfMs + regained * ENERGY.regenMs }
}

/**
 * One play spent at `nowMs`, or refused with none left. A stock at or above
 * the cap was settled to `asOfMs = nowMs`, so falling below it starts the
 * clock now; below it, the part of a regeneration already waited carries over.
 */
export function spendAt (record: EnergyRecord | null, nowMs: number): { ok: boolean, record: EnergyRecord } {
  const settled = energyAt(record, nowMs)
  if (settled.stock < 1) return { ok: false, record: settled }
  return { ok: true, record: { stock: settled.stock - 1, asOfMs: settled.asOfMs } }
}

/** One play given back at `nowMs` (an extraction, a run the server cut short). */
export function refundAt (record: EnergyRecord | null, nowMs: number): EnergyRecord {
  const settled = energyAt(record, nowMs)
  return { stock: settled.stock + 1, asOfMs: settled.asOfMs }
}

/** The view of a record at `nowMs`. */
export function energyView (record: EnergyRecord | null, nowMs: number): EnergyView {
  const settled = energyAt(record, nowMs)
  const nextInMs = settled.stock >= ENERGY.cap
    ? null
    : Math.min(ENERGY.regenMs, Math.max(0, settled.asOfMs + ENERGY.regenMs - nowMs))
  return { stock: settled.stock, cap: ENERGY.cap, nextInMs, regenMs: ENERGY.regenMs }
}
