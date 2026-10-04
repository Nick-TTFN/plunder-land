/**
 * XP per run and the level curve (decision #48 step 3), as data. The numbers
 * are Dez's, accepted by Nick as v1 on 2026-10-02
 * (`ideas/meta-progression-numbers.md` sections 1-2); `xp.spec.ts` pins them
 * against that spec's worked examples. Change a number here, nowhere else.
 *
 * ```
 * lootXP  = min(200, floor(bankedLoot / 25))      extraction only
 * killXP  = 10 per player killed (human or bot), at most 4 counted
 *         + min(20, 2 per grunt or gunner + 10 per boss)
 * depthXP = 15 per layer below 01 reached
 * timeXP  = min(30, floor(secondsAlive / 10))
 *
 * extracted: round(1.5 x (lootXP + killXP + depthXP + timeXP))
 * died/left: max(5, floor((killXP + depthXP + timeXP) / 2))
 *
 * XP from level L to L+1 = 40 + 140 (L - 1); no level cap
 * ```
 *
 * The account level is its own number, derived from the account's XP by the
 * curve and never stored (Nick, #48 build call 6: a curve change re-levels
 * everyone). It is **not** `Unit.level`, which indexes the skills' damage
 * tables (`skills/skill.ts`) and stays 1.
 */
export const PROGRESSION = Object.freeze({
  loot: Object.freeze({ per: 25, cap: 200 }),
  kills: Object.freeze({
    /** Each player killed, a human and a bot alike (an alt is worth what a bot is). */
    player: 10,
    playerCounted: 4,
    /**
     * Each mob killed, by archetype key; a mob missing here pays `mobDefault`,
     * so a new mob type pays like a grunt until it is given a value.
     */
    mob: Object.freeze({ grunt: 2, gunner: 2, boss: 10 } as Record<string, number>),
    mobDefault: 2,
    mobCap: 20
  }),
  /** Per layer below 01 (layer number - 1), on the deepest layer reached. */
  depth: 15,
  time: Object.freeze({ perSeconds: 10, cap: 30 }),
  extractMultiplier: 1.5,
  death: Object.freeze({ share: 0.5, floor: 5 }),
  /** XP from level L to L + 1 is `first + step * (L - 1)`. */
  curve: Object.freeze({ first: 40, step: 140 })
})

/**
 * Weekly seasons (decision #48 step 6): Dez's v1, accepted by Nick on
 * 2026-10-02 (`ideas/meta-progression-numbers.md` section 4), pinned by
 * `progress/seasons.spec.ts`. A season runs Monday 00:00 UTC to the next; its
 * score is the banked loot of its extractions; the top places by share of the
 * ranked players are paid in XP at its end (`progress/seasons.ts`). Change a
 * number here, nowhere else.
 */
export const SEASON = Object.freeze({
  /** Ranked: at least this many runs in the season (any outcome) ... */
  minRuns: 3,
  /** ... and at least this many extractions ... */
  minExtractions: 1,
  /** ... and some banked loot (Dez: "a player with 0 banked loot can't place anyway"). */
  minBanked: 1,
  /** Season credit per run: banked loot on an extraction, capped (a run padded by an alt's drops). */
  creditCap: 6000,
  /** Highest tier first; places counted from rank 1. A player gets their highest tier only. */
  tiers: Object.freeze([
    Object.freeze({ top: 1 as const, share: 0.01, xp: 1000 }),
    Object.freeze({ top: 10 as const, share: 0.10, xp: 500 }),
    Object.freeze({ top: 25 as const, share: 0.25, xp: 250 })
  ])
})

/** What a run's XP is computed from: the values `run_end` reports. */
export interface RunResult {
  extracted: boolean
  /** Loot carried at the end: banked on an extraction, ignored otherwise. */
  loot: number
  /** Players killed, humans and bots. */
  playerKills: number
  /** Mobs killed, by archetype key. */
  mobKills: Readonly<Record<string, number>>
  /** The deepest layer reached as a layer number, 1 for layer 01 (`run_end`'s `deepest_layer`). */
  deepestLayer: number
  /** Seconds from the start to the end (`run_end`'s `seconds`). */
  seconds: number
}

/** The XP a run earns, by `PROGRESSION`. */
export function runXp (run: RunResult): number {
  const p = PROGRESSION
  const lootXp = run.extracted ? Math.min(p.loot.cap, Math.floor(Math.max(0, run.loot) / p.loot.per)) : 0
  let mobXp = 0
  for (const key in run.mobKills) mobXp += (p.kills.mob[key] ?? p.kills.mobDefault) * run.mobKills[key]
  const killXp = p.kills.player * Math.min(p.kills.playerCounted, run.playerKills) + Math.min(p.kills.mobCap, mobXp)
  const depthXp = p.depth * Math.max(0, run.deepestLayer - 1)
  const timeXp = Math.min(p.time.cap, Math.floor(Math.max(0, run.seconds) / p.time.perSeconds))
  if (run.extracted) return Math.round(p.extractMultiplier * (lootXp + killXp + depthXp + timeXp))
  return Math.max(p.death.floor, Math.floor((killXp + depthXp + timeXp) * p.death.share))
}

/** Total XP needed to reach `level` (1 needs 0): `40 (L-1) + 70 (L-1)(L-2)` at today's curve. */
export function xpToReach (level: number): number {
  const n = Math.max(0, level - 1)
  const { first, step } = PROGRESSION.curve
  return first * n + step * n * (n - 1) / 2
}

/** The level a total of `xp` gives: the highest whose `xpToReach` it has. No cap. */
export function levelOf (xp: number): number {
  // A first guess from the quadratic, then walked to the exact answer.
  const { first, step } = PROGRESSION.curve
  const a = step / 2
  const b = first - step / 2
  let level = 1 + Math.max(0, Math.floor((-b + Math.sqrt(b * b + 4 * a * Math.max(0, xp))) / (2 * a)))
  while (level > 1 && xpToReach(level) > xp) level--
  while (xpToReach(level + 1) <= xp) level++
  return level
}

/** An account's standing, as `account` and `progress` send it. */
export interface Standing {
  xp: number
  level: number
  /** Total XP at which `level` began. */
  levelAt: number
  /** Total XP at which the next level begins. */
  nextAt: number
}

export function standingOf (xp: number): Standing {
  const level = levelOf(xp)
  return { xp, level, levelAt: xpToReach(level), nextAt: xpToReach(level + 1) }
}
