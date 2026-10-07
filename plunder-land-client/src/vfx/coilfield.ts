/**
 * The Coil's pulse timing (decision #51, task l1-3), for drawing effect 13
 * (`NPC_EFFECT.coilPulse`). Imports nothing, so the server's
 * `mobskills/coilfield.spec.ts` loads it and holds it to the server's
 * `CoilFieldSpec` (tell and hold) and the mirrored `ARCHETYPE_INFO.coil.attack`
 * disc (rings).
 *
 * The server sends effect 13 once, when a charge starts, with a lifetime of
 * tell + hold: the first `tellMs` is the gather and release (nothing slowed
 * yet), the rest the live field. The approved clip's timings
 * (`codex_output/npc-refinements/coil-v4/tools/coil.mjs`).
 */
export const COIL_PULSE = Object.freeze({
  tellMs: 1500,
  holdMs: 1500,
  rings: 2
})

/**
 * Where a pulse is, `elapsed` ms after it arrived with `lifetime` ms: the
 * tell (0..1 through it) or the live field (0..1 through it), or over. The
 * tell's share is taken from the end, so a pulse that arrives late (a viewer
 * coming into range mid-tell) still shows the field for its full hold.
 */
export function coilPulsePhase (elapsed: number, lifetime: number): { phase: 'tell' | 'hold' | 'over', t: number } {
  const tell = Math.max(0, lifetime - COIL_PULSE.holdMs)
  if (elapsed >= lifetime) return { phase: 'over', t: 1 }
  if (elapsed < tell) return { phase: 'tell', t: elapsed / tell }
  const hold = lifetime - tell
  return { phase: 'hold', t: hold > 0 ? (elapsed - tell) / hold : 1 }
}
