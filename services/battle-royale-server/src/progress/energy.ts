import { ENERGY } from './xp'

/**
 * Energy (decision #48 step 7), the arithmetic both account stores share. No
 * pg, no `World`. The numbers are `ENERGY` in `progress/xp.ts`.
 *
 * A stock is stored with the time it was true (`asOfMs`) and regenerated
 * lazily on every read: below the cap, one play per whole `regenMs` since
 * `asOfMs`, never past the cap; at or above the cap, nothing, and the clock
 * starts again from the moment the stock falls below it. A new account has
 * no row: it reads as `ENERGY.start` from now, so accounts made before
 * energy shipped start full too.
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
  /**
   * The rewarded-video refill (g2-6d), only to a connection whose portal is
   * in `AD_REFILL_PORTALS`, on a persisted account and a store that can
   * refill. Absent means no button (an old server, another portal, the
   * switch off), which an old client never reads.
   */
  adRefill?: AdRefillView
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

/**
 * The rewarded-video refill's limits (decision #62 addendum 2026-11-13,
 * Dez's numbers, Nick "yes"; task g2-6d). A tunable, Dez's like `ENERGY`.
 * The server can't verify that an ad was watched (CrazyGames documents no
 * receipt for video ads), and any client can ask, so these limits are the
 * whole defence: per account, at most one refill per `cooldownMs` and
 * `perDay` per UTC day, and only with no play left. Pinned by
 * `progress/energy.spec.ts`.
 */
export const AD_REFILL = Object.freeze({
  /** At least this long between two refills of one account. */
  cooldownMs: 30 * 60_000,
  /** At most this many refills per account per UTC day. */
  perDay: 3
})

/**
 * An account's refills as stored (migration 11, columns of `energy`): the
 * last one's time, the UTC day `count` counts (`YYYY-MM-DD`) and that day's
 * count. `null` (no refill ever) reads as none.
 */
export interface AdRefillRecord {
  lastAtMs: number | null
  day: string | null
  count: number
}

/** Why a refill is refused by the limits. Append-only: GA `energy_ad_refused { reason }` reports them. */
export type AdRefillLimit = 'plays_left' | 'cooldown' | 'daily_cap'

/** What the energy view says about the refill (`EnergyView.adRefill`). */
export interface AdRefillView {
  /** The lobby may show the button: no play left and both limits allow. */
  offered: boolean
  /** With no play left and a limit in the way: until it allows again, relative like `nextInMs`. */
  nextInMs?: number
}

const DAY_MS = 86_400_000

/** `adRefillCheck`'s answer: `reason` (and, for a limit, `nextInMs`) only when refused. */
export interface AdRefillCheck {
  ok: boolean
  reason?: AdRefillLimit
  nextInMs?: number
}

/** The UTC day of `ms` as `YYYY-MM-DD` (Postgres `date` text). */
export function utcDay (ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The refills `ads` holds for `nowMs`'s UTC day. */
function countToday (ads: AdRefillRecord | null, nowMs: number): number {
  return ads !== null && ads.day === utcDay(nowMs) ? ads.count : 0
}

/**
 * Whether a refill is allowed at `nowMs`: refused with a play left (the
 * stock regenerated to `nowMs`), within `cooldownMs` of the last one, or
 * with `perDay` already today. A limit's refusal says how long until it
 * allows again (`nextInMs`; the day's cap until the next UTC midnight, or
 * the cooldown if that ends later). A last refill stamped in the future (a
 * server clock ahead) waits at most one cooldown.
 */
export function adRefillCheck (energy: EnergyRecord | null, ads: AdRefillRecord | null, nowMs: number): AdRefillCheck {
  if (energyAt(energy, nowMs).stock > 0) return { ok: false, reason: 'plays_left' }
  const cooldownLeft = ads === null || ads.lastAtMs === null
    ? 0
    : Math.min(AD_REFILL.cooldownMs, Math.max(0, ads.lastAtMs + AD_REFILL.cooldownMs - nowMs))
  if (countToday(ads, nowMs) >= AD_REFILL.perDay) {
    const untilMidnight = (Math.floor(nowMs / DAY_MS) + 1) * DAY_MS - nowMs
    return { ok: false, reason: 'daily_cap', nextInMs: Math.max(untilMidnight, cooldownLeft) }
  }
  if (cooldownLeft > 0) return { ok: false, reason: 'cooldown', nextInMs: cooldownLeft }
  return { ok: true }
}

/** `adRefillAt`'s answer: refused with `reason` and `ads` unchanged, or the new energy and refills. */
export interface AdRefillOutcome {
  ok: boolean
  reason?: AdRefillLimit
  energy: EnergyRecord
  /** `null` only when refused with none ever. */
  ads: AdRefillRecord | null
}

/**
 * One refill at `nowMs` if `adRefillCheck` allows: the stock to `ENERGY.cap`
 * (at the cap, so no regeneration clock runs) and the day's count up by one.
 * Refused: nothing changes, the energy regenerated to `nowMs`.
 */
export function adRefillAt (energy: EnergyRecord | null, ads: AdRefillRecord | null, nowMs: number): AdRefillOutcome {
  const check = adRefillCheck(energy, ads, nowMs)
  if (!check.ok) return { ok: false, reason: check.reason, energy: energyAt(energy, nowMs), ads }
  return {
    ok: true,
    energy: { stock: ENERGY.cap, asOfMs: nowMs },
    ads: { lastAtMs: nowMs, day: utcDay(nowMs), count: countToday(ads, nowMs) + 1 }
  }
}

/** The refill part of an energy view at `nowMs`: `nextInMs` only with no play left and a limit in the way. */
export function adRefillView (energy: EnergyRecord | null, ads: AdRefillRecord | null, nowMs: number): AdRefillView {
  const check = adRefillCheck(energy, ads, nowMs)
  if (check.ok) return { offered: true }
  return check.nextInMs === undefined ? { offered: false } : { offered: false, nextInMs: check.nextInMs }
}
