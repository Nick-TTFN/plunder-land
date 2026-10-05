import type { AccountStore, GearStore, StashItem } from '../db/accounts'
import { type GearInstance, GEAR_SLOTS } from '../utils/gear'

/**
 * The stash in play (decision #49, task 49-4): what `Worlds` needs beside the
 * store and the ledger. Pixi-free and world-free.
 */

/** A `start_requested.bring` entry as the client sends it: a stash row id in decimal. */
export const BRING_SHAPE = /^[0-9]{1,19}$/

/**
 * `start_requested.bring`: up to `GEAR_SLOTS` (2) stash row ids, entry 0 for
 * key 3 and entry 1 for key 4. An entry that isn't a decimal string (null,
 * '', a number, junk) is an empty slot, and so is a repeat of an earlier id;
 * entries past 2 are dropped. Positions are kept, so `[null, '7']` asks for
 * row 7 in key 4. Undefined when nothing usable was asked for (or `bring`
 * wasn't an array). Never a reason to refuse a join.
 */
export function parseBring (value: unknown): Array<string | null> | undefined {
  if (!Array.isArray(value)) return undefined
  const out: Array<string | null> = []
  let any = false
  for (let i = 0; i < GEAR_SLOTS; i++) {
    const id = value[i]
    if (typeof id === 'string' && BRING_SHAPE.test(id) && !out.includes(id)) {
      out.push(id)
      any = true
    } else {
      out.push(null)
    }
  }
  return any ? out : undefined
}

/**
 * The store's gear half, when it has one. `GearStore` is a separate interface
 * (49-3): several specs wrap `AccountStore` without it, and both real stores
 * (memory, pg) implement both. A store without every method plays with no
 * stash: nothing is carried in and nothing is written at a run's end.
 */
export function gearStoreOf (store: AccountStore): (AccountStore & GearStore) | undefined {
  const s = store as Partial<GearStore>
  const methods: Array<keyof GearStore> = ['loadStash', 'settleGear', 'discardGear', 'uncarry', 'heartbeat', 'releaseHolder']
  return methods.every((m) => typeof s[m] === 'function') ? store as AccountStore & GearStore : undefined
}

/** One stashed item as the `stash` event carries it. */
export interface StashEventItem {
  id: string
  tier: number
  skill: number
  rolls: Array<[number, number]>
}

/**
 * What a run's end did with the gear it took out, for the run card: `kept`
 * rows now in the stash (moved or inserted), `full` found items the
 * `STASH_MAX` ceiling turned away.
 */
export interface StashRunResult {
  kept: number
  full: number
}

/** The `stash` event (server -> client, JSON, additive). */
export interface StashEvent {
  items: StashEventItem[]
  /** Rows of the account carried right now (in a run here or elsewhere) or awaiting return. */
  away: number
  /** After a run's settle only. */
  run?: StashRunResult
}

/** `stash { items, away, run? }` from the account's rows (`loadStash` or `settleGear`'s `stash`). */
export function stashEvent (rows: readonly StashItem[], run?: StashRunResult): StashEvent {
  const items: StashEventItem[] = []
  let away = 0
  for (const row of rows) {
    if (row.carried) {
      away++
      continue
    }
    items.push({ id: row.rowId, tier: row.tier, skill: row.skill, rolls: row.rolls.map((r) => [r.stat, r.q]) })
  }
  const event: StashEvent = { items, away }
  if (run !== undefined) event.run = run
  return event
}

/** Counts for `run_end` (append-only params, Nick's #49 question 5). */
export interface GearCounts {
  /** Items equipped from the stash at the start. */
  brought: number
  /** Items carried at the end that the run didn't bring (caches, mobs, other players' drops). */
  found: number
  /** Items the run's end sent to the stash (0 on a death, offline, or for a bot). */
  kept: number
}

/** The lineage (stash row) ids among `items`, each once. */
export function lineageOf (items: ReadonlyArray<GearInstance | null | undefined>): string[] {
  const ids = new Set<string>()
  for (const item of items) if (item?.rowId !== undefined) ids.add(item.rowId)
  return [...ids]
}
