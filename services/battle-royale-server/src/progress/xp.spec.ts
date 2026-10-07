import test from 'node:test'
import assert from 'node:assert/strict'
import { levelOf, PROGRESSION, type RunResult, runXp, standingOf, xpToReach } from './xp'

/**
 * The XP formula and level curve against Dez's accepted v1 spec
 * (`ideas/meta-progression-numbers.md` sections 1-2, accepted by Nick on
 * 2026-10-02). Every number below is taken from that file, not from the code:
 * a change to `PROGRESSION` that isn't also a change to the spec fails here.
 */

function run (over: Partial<RunResult>): RunResult {
  return { extracted: false, loot: 0, playerKills: 0, mobKills: {}, deepestLayer: 1, seconds: 0, ...over }
}

test('the hard ceiling per run is 480 XP: (200 + 60 + 30 + 30) x 1.5', () => {
  const max = run({ extracted: true, loot: 5000, playerKills: 4, mobKills: { boss: 2 }, deepestLayer: 3, seconds: 300 })
  assert.equal(runXp(max), 480)
  // Far past every cap: still 480.
  assert.equal(runXp(run({ extracted: true, loot: 1e9, playerKills: 50, mobKills: { grunt: 99, gunner: 99, boss: 99 }, deepestLayer: 3, seconds: 1e6 })), 480)
})

test('quick extract (spawn, walk to the exit, extract, ~10 s, no loot): 2 XP', () => {
  assert.equal(runXp(run({ extracted: true, seconds: 10 })), 2)
})

test('the new-human estimate: ~1,000 banked, ~6 kill XP, ~12 time XP on 01, extracted: 87 ("call it 90")', () => {
  // 40 loot + 6 kills (3 grunts) + 0 depth + 12 time (120 s) = 58, x1.5 = 87.
  assert.equal(runXp(run({ extracted: true, loot: 1000, mobKills: { grunt: 3 }, seconds: 120 })), 87)
})

test('loot: 1 XP per 25 banked, capped at 200 (5,000 loot), only on an extraction', () => {
  // "Bot median banked 1653 -> 66 XP": the loot part alone, x1.5 on top.
  assert.equal(runXp(run({ extracted: true, loot: 1653 })), Math.round(1.5 * 66))
  assert.equal(runXp(run({ extracted: true, loot: 4999 })), Math.round(1.5 * 199))
  assert.equal(runXp(run({ extracted: true, loot: 5000 })), 300)
  assert.equal(runXp(run({ extracted: true, loot: 5001 })), 300)
  // A death loses the loot, and the loot's XP with it.
  assert.equal(runXp(run({ extracted: false, loot: 5000, seconds: 120 })), runXp(run({ extracted: false, seconds: 120 })))
})

test('kills: 10 per player (bots and humans alike, 4 counted), 2 per grunt or gunner, 10 per boss, mobs capped at 20', () => {
  // "4 bots x 10 = 40 (60 extracted) a run at most."
  assert.equal(runXp(run({ extracted: true, playerKills: 4 })), 60)
  assert.equal(runXp(run({ extracted: true, playerKills: 5 })), 60)
  assert.equal(runXp(run({ extracted: false, playerKills: 4 })), 20)
  // Mobs.
  assert.equal(runXp(run({ extracted: true, mobKills: { grunt: 1 } })), 3)
  assert.equal(runXp(run({ extracted: true, mobKills: { gunner: 2 } })), 6)
  assert.equal(runXp(run({ extracted: true, mobKills: { boss: 1 } })), 15)
  assert.equal(runXp(run({ extracted: true, mobKills: { grunt: 10 } })), 30)
  assert.equal(runXp(run({ extracted: true, mobKills: { grunt: 11 } })), 30, 'the mob cap is 20')
  assert.equal(runXp(run({ extracted: true, mobKills: { boss: 1, grunt: 5 } })), 30)
  // Players and mobs are capped separately: 40 + 20.
  assert.equal(runXp(run({ extracted: true, playerKills: 9, mobKills: { boss: 9 } })), 90)
})

test('depth: 15 per layer below 01 (01 = 0, 02 = 15, 03 = 30), paid on a death too', () => {
  assert.equal(runXp(run({ extracted: true, deepestLayer: 1 })), 0)
  assert.equal(runXp(run({ extracted: true, deepestLayer: 2 })), Math.round(1.5 * 15))
  assert.equal(runXp(run({ extracted: true, deepestLayer: 3 })), 45)
  assert.equal(runXp(run({ extracted: false, deepestLayer: 3 })), 15)
})

test('time: 1 per 10 s alive, capped at 30 (5 min): idling is worth at most 30, 45 extracted', () => {
  assert.equal(runXp(run({ extracted: true, seconds: 9 })), 0)
  assert.equal(runXp(run({ extracted: true, seconds: 299 })), Math.round(1.5 * 29))
  assert.equal(runXp(run({ extracted: true, seconds: 300 })), 45)
  assert.equal(runXp(run({ extracted: true, seconds: 3600 })), 45)
  assert.equal(runXp(run({ extracted: false, seconds: 3600 })), 15)
})

test('a death (or a disconnect): half of kills + depth + time, rounded down, at least 5', () => {
  // "Suicide for the death floor: 5 XP a run."
  assert.equal(runXp(run({})), 5)
  assert.equal(runXp(run({ seconds: 95 })), 5)
  // 6 kills + 15 depth + 12 time = 33 -> 16.
  assert.equal(runXp(run({ mobKills: { grunt: 3 }, deepestLayer: 2, seconds: 120 })), 16)
  // The death ceiling: (60 + 30 + 30) / 2.
  assert.equal(runXp(run({ playerKills: 4, mobKills: { boss: 2 }, deepestLayer: 3, seconds: 300 })), 60)
})

test('an extraction is a x1.5 multiplier, not a flat bonus', () => {
  assert.equal(PROGRESSION.extractMultiplier, 1.5)
  for (const r of [run({ seconds: 70 }), run({ loot: 700, seconds: 50, deepestLayer: 2 }), run({ playerKills: 1, mobKills: { grunt: 1 } })]) {
    const base = runXp({ ...r, extracted: true })
    assert.equal(base, Math.round(1.5 * (Math.min(200, Math.floor(r.loot / 25)) + 10 * r.playerKills + 2 * (r.mobKills.grunt ?? 0) + 15 * (r.deepestLayer - 1) + Math.min(30, Math.floor(r.seconds / 10)))))
  }
})

// --- the level curve ---------------------------------------------------------

/** Dez's table: level, XP to the next, total to reach. */
const TABLE: Array<[number, number, number]> = [
  [1, 40, 0], [2, 180, 40], [3, 320, 220], [4, 460, 540], [5, 600, 1000],
  [6, 740, 1600], [7, 880, 2340], [8, 1020, 3220], [9, 1160, 4240], [10, 1300, 5400],
  [11, 1440, 6700], [12, 1580, 8140], [13, 1720, 9720], [14, 1860, 11440], [15, 2000, 13300],
  [16, 2140, 15300], [17, 2280, 17440], [18, 2420, 19720], [19, 2560, 22140], [20, 2700, 24700]
]

test('the curve matches the table: 40 + 140 (L-1) to the next level, 40 (L-1) + 70 (L-1)(L-2) to reach L', () => {
  for (const [level, toNext, total] of TABLE) {
    assert.equal(xpToReach(level), total, `total to reach ${level}`)
    assert.equal(xpToReach(level + 1) - xpToReach(level), toNext, `level ${level} to ${level + 1}`)
    assert.equal(xpToReach(level), 40 * (level - 1) + 70 * (level - 1) * (level - 2))
  }
})

test('levelOf: exactly at, just below and just above each threshold; no cap past 20', () => {
  for (const [level, , total] of TABLE) {
    assert.equal(levelOf(total), level, `${total} XP`)
    if (total > 0) assert.equal(levelOf(total - 1), level - 1, `${total - 1} XP`)
    assert.equal(levelOf(total + 1), level, `${total + 1} XP`)
  }
  assert.equal(levelOf(0), 1)
  assert.equal(levelOf(-5), 1)
  // The same rule continues: 21 at 24,700 + 2,700.
  assert.equal(levelOf(27_400), 21)
  assert.equal(levelOf(27_399), 20)
  for (let level = 1; level <= 500; level++) {
    assert.equal(levelOf(xpToReach(level)), level)
    assert.equal(levelOf(xpToReach(level + 1) - 1), level)
  }
})

test('the pacing table: Magnet (level 3) inside day 1, level 12 at 8,140', () => {
  assert.equal(levelOf(360), 3, 'day 1: 9 runs x 40')
  assert.equal(levelOf(1460), 5, 'day 3')
  assert.equal(levelOf(3560), 8, 'day 6')
  assert.equal(levelOf(8140), 12, 'day 11')
})

test('standingOf: level, where it began, where the next begins', () => {
  assert.deepEqual(standingOf(0), { xp: 0, level: 1, levelAt: 0, nextAt: 40 })
  assert.deepEqual(standingOf(87), { xp: 87, level: 2, levelAt: 40, nextAt: 220 })
  assert.deepEqual(standingOf(220), { xp: 220, level: 3, levelAt: 220, nextAt: 540 })
})

// #51 L1: the NPC roster's kill XP (Dez's drop table section 5, accepted).
test('kills: Crawler 1, Broodling 0, Compactor 2, Kiln 3, Coil 3, Reactor 10, Brood 12, under the same cap', () => {
  assert.equal(runXp(run({ extracted: true, mobKills: { crawler: 3 } })), 5) // round(1.5 x 3)
  assert.equal(runXp(run({ extracted: true, mobKills: { broodling: 40 } })), 0)
  assert.equal(runXp(run({ extracted: true, mobKills: { compactor: 1, kiln: 1, coil: 1 } })), 12) // 8 x 1.5
  assert.equal(runXp(run({ extracted: true, mobKills: { reactor: 1 } })), 15)
  assert.equal(runXp(run({ extracted: true, mobKills: { brood: 1 } })), 18)
  assert.equal(runXp(run({ extracted: true, mobKills: { brood: 1, reactor: 1 } })), 30, 'the mob cap is 20')
})
