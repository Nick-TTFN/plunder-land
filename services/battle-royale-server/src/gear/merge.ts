import { rollGear } from '../archetypes/archetypes'
import { type AccountStore, ROW_ID_SHAPE, type StashEdits, type StashItem } from '../db/accounts'
import { type GearInstance, type GearTier, GEAR_TIERS } from '../utils/gear'

/**
 * Merge and scrap (decision #49, spec section 5, task 49-5). Pixi-free and
 * world-free: `mergeOutcome` is pure but for `random`, so a future ad-gated
 * reroll of a merge's result (Q11, **open, not built**) can call it again on
 * the same inputs without touching the store code.
 */

/**
 * Chance that a merge of three parts gives a skill item, by the inputs' tier
 * (spec section 5, judgement values: Dez, accepted by Nick 2026-10-04; T3 and
 * T4 from #51, Nick 2026-10-07, "Dez's numbers as a first value"). 3 T1
 * parts give a T2 skill item 15% of the time, else a T2 part; 3 T2 parts a T3
 * skill item 25%, else a T3 part; 3 T3 parts a T4 (Legendary) skill item 35%,
 * else a T4 part; **3 T4 parts always a T4 skill item** (the floor, and the
 * one merge that stays at its tier), so 81 T1 parts always reach a T4 skill
 * item.
 */
export const PART_MERGE_SKILL_CHANCE: Readonly<Record<GearTier, number>> = Object.freeze({ 1: 0.15, 2: 0.25, 3: 0.35, 4: 1 })

/** Inputs a merge takes. */
export const MERGE_INPUTS = 3

/**
 * What three stashed items merge into, or null when they can't merge (the
 * merge is refused and nothing changes):
 * - exactly 3 inputs, distinct row ids when they have them, one tier;
 * - **any skill item among them**: a skill item of the next tier with
 *   `keep`'s skill. `keep` is the row id of one of the skill-item inputs;
 *   absent (undefined or null) means the first skill item in input order.
 *   Any other `keep` is refused. At `GEAR_TIERS` (4) there is no next
 *   tier: refused.
 * - **parts only**: tier + 1 (tier 4 stays 4), a skill item with
 *   `PART_MERGE_SKILL_CHANCE` of the input tier, else a part. A `keep` with no
 *   skill input is refused (it names nothing the result could keep).
 *
 * The result's rolls are drawn fresh at its tier (`rollGear`); a surprise
 * skill is uniform over every skill, as a found one is. Inputs are taken in
 * the order the player listed them (`merge { ids }`), which only decides the
 * default keep. The result has no `rowId`: the store gives it its row.
 */
export function mergeOutcome (inputs: readonly GearInstance[], keep: string | null | undefined, random: () => number): GearInstance | null {
  if (inputs.length !== MERGE_INPUTS) return null
  const tier = inputs[0].tier
  if (!inputs.every((item) => item.tier === tier)) return null
  if (!Number.isInteger(tier) || tier < 1 || tier > GEAR_TIERS) return null
  const rowIds = inputs.map((item) => item.rowId).filter((id) => id !== undefined)
  if (new Set(rowIds).size !== rowIds.length) return null
  const skilled = inputs.filter((item) => item.skill > 0)
  if (keep !== undefined && keep !== null && (typeof keep !== 'string' || !ROW_ID_SHAPE.test(keep))) return null
  if (skilled.length > 0) {
    if (tier >= GEAR_TIERS) return null
    const kept = keep === undefined || keep === null ? skilled[0] : skilled.find((item) => item.rowId === keep)
    if (kept === undefined) return null
    const fresh = rollGear((tier + 1) as GearTier, 'skill', random)
    return Object.freeze({ tier: fresh.tier, skill: kept.skill, rolls: fresh.rolls })
  }
  if (keep !== undefined && keep !== null) return null
  const next = Math.min(GEAR_TIERS, tier + 1) as GearTier
  const skill = random() < PART_MERGE_SKILL_CHANCE[tier]
  return rollGear(next, skill ? 'skill' : 'part', random)
}

/**
 * `merge { ids, keep? }` as the client sends it: exactly 3 distinct row ids
 * (decimal strings, `ROW_ID_SHAPE`) and an optional keep (a row id, or
 * absent/null). Undefined when malformed; the merge is then refused
 * `invalid` without asking the store.
 */
export function parseMerge (data: unknown): { ids: string[], keep: string | undefined } | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { ids, keep } = data as { ids?: unknown, keep?: unknown }
  if (!Array.isArray(ids) || ids.length !== MERGE_INPUTS) return undefined
  if (!ids.every((id) => typeof id === 'string' && ROW_ID_SHAPE.test(id))) return undefined
  if (new Set(ids).size !== MERGE_INPUTS) return undefined
  if (keep !== undefined && keep !== null && (typeof keep !== 'string' || !ROW_ID_SHAPE.test(keep))) return undefined
  return { ids: [...ids] as string[], keep: typeof keep === 'string' ? keep : undefined }
}

/** `scrap { id }`: one row id, or undefined when malformed. */
export function parseScrap (data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { id } = data as { id?: unknown }
  return typeof id === 'string' && ROW_ID_SHAPE.test(id) ? id : undefined
}

/** A merge's result as `merged.item` carries it: the `stash` event's item shape. */
export function mergedItem (row: StashItem): { id: string, tier: number, skill: number, rolls: Array<[number, number]> } {
  return { id: row.rowId, tier: row.tier, skill: row.skill, rolls: row.rolls.map((r) => [r.stat, r.q]) }
}

/**
 * The store's merge and scrap, when it has them (both shipped stores do). A
 * store without them answers every merge and scrap `store`, like a store
 * without `GearStore` plays with no stash.
 */
export function stashEditsOf (store: AccountStore): (AccountStore & StashEdits) | undefined {
  const s = store as Partial<StashEdits>
  return typeof s.mergeGear === 'function' && typeof s.scrapGear === 'function' ? store as AccountStore & StashEdits : undefined
}
