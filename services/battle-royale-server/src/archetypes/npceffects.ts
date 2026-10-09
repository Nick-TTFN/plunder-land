/**
 * Effect type numbers for the NPC roster (decision #51, L1), assigned once
 * here for every L1 lane (task l1-1). The `effect` record's type byte, beside
 * 0-6 (skills and blasts) and the bomb's 7 and 8 (`items/bomb.ts`).
 *
 * **Append-only, like every wire number**: a lane may leave one unused, never
 * reuse or renumber one. The client keeps the same table in
 * `plunder-land-client/src/vfx/npceffects.ts`; `npceffects.spec.ts` holds the
 * two equal. An old client ignores a type it doesn't know.
 */
export const NPC_EFFECT = Object.freeze({
  /** Kiln lob: landing marker and arc, aimed at the landing cell (l1-4). */
  kilnLob: 9,
  /** Kiln blast on the landing cells (l1-4). */
  kilnBlast: 10,
  /** Reactor activation tell (l1-5). */
  reactorTell: 11,
  /** Reactor release (l1-5). */
  reactorRelease: 12,
  /** Coil pulse (l1-3). */
  coilPulse: 13,
  /** Compactor shockwave line, aimed at its tip (l1-6). */
  compactorShockwave: 14,
  /** Knockback, on the victim, aimed at its landing cell (l1-6). */
  knockback: 15,
  /** Slowed, on the victim (l1-3). */
  slowed: 16,
  /** Broodling primed (l1-7). */
  broodlingPrimed: 17,
  /** Broodling blast (l1-7). */
  broodlingBlast: 18,
  /** Brood releases a Broodling (l1-7). */
  broodRelease: 19
})
