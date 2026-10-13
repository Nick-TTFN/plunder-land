import { ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import Multiplayer from '../network/multiplayer'
import { NPC_EFFECT } from '../archetypes/npceffects'

/** Which ice skill chilled: each has its own freeze length. */
export type ChillSkill = 'icicle' | 'breath'

/**
 * A mob's chill and freeze (decision #54, task ice-1). A plain record on
 * `Unit.chill`, undefined until the first chill; not a `Buff`, because the
 * stacks and the lockout outlive the freeze.
 */
export interface ChillState {
  /**
   * One stack per caster that chilled it inside the window: the caster and
   * when its latest chill landed. A caster's second chill moves its own stack
   * later; it never adds a second one (distinct casters, Nick 2026-10-12).
   */
  stacks: Array<{ caster: Unit, at: number }>
  /** `Date.now()` before which it is frozen. */
  frozenUntil: number
  /** `Date.now()` before which a chill does nothing: the freeze, then `lockoutMs`. */
  lockoutUntil: number
}

/**
 * The ice numbers (Dez's ice pass, accepted by Nick 2026-10-12, #54). Server
 * only: the client is told a freeze's length in effect 21's lifetime and a
 * player's slow as speed (field 27).
 *
 * - `normal` / `boss`: per class of mob (`World.isSpawnHazard` is a boss).
 *   `threshold` distinct casters inside `windowMs` freeze it for `freezeMs`
 *   of the skill that landed the last stack; from the freeze's end, no
 *   stacks and no freeze for `lockoutMs`. A normal mob freezes on its first
 *   chill (threshold 1, so its window is never read) and has no lockout.
 * - `damageTaken`: weaker metal, the multiplier on every hit a frozen unit
 *   takes (`Unit.damageTaken`).
 * - `slow`: the one ice slow on a player (`FieldSlow`, kind `ice`): `factor`
 *   for `icicleMs` from an Icicle, and until `breathTailMs` after the last
 *   Ice Breath tick that hit.
 */
export const FREEZE = Object.freeze({
  normal: Object.freeze({
    threshold: 1,
    windowMs: 4000,
    freezeMs: Object.freeze({ icicle: 1500, breath: 1250 }),
    lockoutMs: 0
  }),
  boss: Object.freeze({
    threshold: 4,
    windowMs: 4000,
    freezeMs: Object.freeze({ icicle: 750, breath: 750 }),
    lockoutMs: 20000
  }),
  damageTaken: 1.5,
  slow: Object.freeze({ factor: 0.5, icicleMs: 2000, breathTailMs: 1000 })
})

/**
 * The one entry point for both ice skills: `caster` chills `unit` with
 * `skill` at `now`. Returns true if this chill froze it.
 *
 * Mobs only (players are slowed instead, by the skills). A destroyed unit, a
 * frozen one and one in its lockout get nothing. Otherwise: stacks older than
 * the window go, `caster`'s stack is added (or moved to `now` if it has one),
 * and at `threshold` stacks the unit freezes for the class's `freezeMs` of
 * `skill`, its stacks are cleared and the lockout runs to the freeze's end
 * plus `lockoutMs`. Effect 21 goes out once, at the freeze, on the mob, with
 * the freeze's length as lifetime: nothing extends a freeze, so there is no
 * refresh to send.
 *
 * Call it **before** the hit it comes with, so the freezing hit is boosted.
 */
export function chill (unit: Unit, caster: Unit, skill: ChillSkill, now: number = Date.now()): boolean {
  if (unit.type !== ObjectType.Mob || unit.destroyed) return false
  const state = unit.chill ?? (unit.chill = { stacks: [], frozenUntil: 0, lockoutUntil: 0 })
  if (now < state.lockoutUntil) return false

  const rule = World.isSpawnHazard(unit.archetype) ? FREEZE.boss : FREEZE.normal
  const stacks = state.stacks.filter((stack) => now - stack.at < rule.windowMs && stack.caster !== caster)
  stacks.push({ caster, at: now })
  if (stacks.length < rule.threshold) {
    state.stacks = stacks
    return false
  }

  const freezeMs = rule.freezeMs[skill]
  state.stacks = []
  state.frozenUntil = now + freezeMs
  state.lockoutUntil = state.frozenUntil + rule.lockoutMs
  Multiplayer.Instance.effect(NPC_EFFECT.frozen, unit, freezeMs)
  return true
}
