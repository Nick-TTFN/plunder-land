import test from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import '../network/multiplayer'
import { MERGE_INPUTS, PART_MERGE_SKILL_CHANCE, mergeOutcome, parseMerge, parseScrap, stashEditsOf } from './merge'
import { seeded } from '../db/storecontract'
import { MemoryAccountStore } from '../db/accounts'
import { SKILL_LIST } from '../utils/skills'
import { GEAR_STATS, type GearInstance, type GearTier, Q_MAX, rollCount } from '../utils/gear'

/**
 * Task 49-5 (decision #49, spec section 5): the merge rule. The store half
 * (one transaction, stashed rows only, refusals change nothing) is in
 * db/storecontract.ts `mergeAndScrap`, on both stores.
 */

function part (tier: GearTier, rowId?: string): GearInstance {
  return { tier, skill: 0, rolls: [], ...(rowId !== undefined ? { rowId } : {}) }
}

function skillItem (tier: GearTier, skill: number, rowId?: string): GearInstance {
  const rolls = Array.from({ length: rollCount(tier) }, (_, i) => ({ stat: i + 1, q: 500 }))
  return { tier, skill, rolls, ...(rowId !== undefined ? { rowId } : {}) }
}

const SKILLS = SKILL_LIST.map((s) => s.id)

/** A well-formed result: tier, rolls on distinct stats rollable at that tier, qualities in range. */
function checkRolls (item: GearInstance): void {
  if (item.skill === 0) {
    assert.deepEqual(item.rolls, [], 'a part with rolls')
    return
  }
  assert.equal(item.rolls.length, rollCount(item.tier), 'roll count at the result tier')
  assert.equal(new Set(item.rolls.map((r) => r.stat)).size, item.rolls.length, 'a stat rolled twice')
  for (const r of item.rolls) {
    const stat = Object.values(GEAR_STATS).find((s) => s.id === r.stat)
    assert.ok(stat !== undefined && stat.ranges[item.tier - 1] !== null, `stat ${r.stat} can't roll at T${item.tier}`)
    assert.ok(Number.isInteger(r.q) && r.q >= 0 && r.q <= Q_MAX)
  }
}

test('merge rule table: tier, kind and refusals', () => {
  const r = seeded(1)
  // Any skill item: a skill item one tier up.
  for (const tier of [1, 2] as GearTier[]) {
    for (const inputs of [
      [skillItem(tier, 3), part(tier), part(tier)],
      [part(tier), part(tier), skillItem(tier, 3)],
      [skillItem(tier, 3), skillItem(tier, 3), skillItem(tier, 3)]
    ]) {
      const out = mergeOutcome(inputs, undefined, r)
      assert.ok(out !== null)
      assert.deepEqual([out.tier, out.skill], [tier + 1, 3])
      checkRolls(out)
      assert.equal(out.rowId, undefined, 'the result carries an input\'s row id')
    }
  }
  // Parts only: one tier up (T3 stays), a part or a skill item.
  for (const tier of [1, 2, 3] as GearTier[]) {
    for (let i = 0; i < 200; i++) {
      const out = mergeOutcome([part(tier), part(tier), part(tier)], undefined, r)
      assert.ok(out !== null)
      assert.equal(out.tier, Math.min(3, tier + 1))
      if (tier === 3) assert.ok(out.skill > 0, '3 T3 parts gave a part')
      if (out.skill > 0) assert.ok(SKILLS.includes(out.skill))
      checkRolls(out)
    }
  }
  // Refused.
  assert.equal(mergeOutcome([skillItem(3, 2), part(3), part(3)], undefined, r), null, 'a T3 mix with a skill item')
  assert.equal(mergeOutcome([skillItem(3, 2), skillItem(3, 2), skillItem(3, 2)], undefined, r), null, '3 T3 skill items')
  assert.equal(mergeOutcome([part(1), part(1), part(2)], undefined, r), null, 'mixed tiers')
  assert.equal(mergeOutcome([skillItem(1, 1), skillItem(2, 1), skillItem(1, 1)], undefined, r), null, 'mixed tiers with skills')
  assert.equal(mergeOutcome([part(1), part(1)], undefined, r), null, '2 inputs')
  assert.equal(mergeOutcome([part(1), part(1), part(1), part(1)], undefined, r), null, '4 inputs')
  assert.equal(mergeOutcome([part(1, '5'), part(1, '5'), part(1, '6')], undefined, r), null, 'one row twice')
  assert.equal(MERGE_INPUTS, 3)
})

test('merge keep: the chosen skill input\'s skill, else the first skill item listed; anything else refused', () => {
  const r = seeded(2)
  const inputs = [part(1, '10'), skillItem(1, 4, '11'), skillItem(1, 7, '12')]
  assert.equal(mergeOutcome(inputs, '12', r)?.skill, 7)
  assert.equal(mergeOutcome(inputs, '11', r)?.skill, 4)
  assert.equal(mergeOutcome(inputs, undefined, r)?.skill, 4, 'absent keep is not the first skill item')
  assert.equal(mergeOutcome(inputs, null, r)?.skill, 4, 'null keep is not the first skill item')
  assert.equal(mergeOutcome([inputs[2], inputs[1], inputs[0]], undefined, r)?.skill, 7, 'the default follows the order listed')
  assert.equal(mergeOutcome(inputs, '10', r), null, 'keep names a part')
  assert.equal(mergeOutcome(inputs, '13', r), null, 'keep names no input')
  assert.equal(mergeOutcome(inputs, 'junk', r), null, 'a malformed keep')
  assert.equal(mergeOutcome([part(1, '1'), part(1, '2'), part(1, '3')], '1', r), null, 'a keep with no skill input')
  // A skill nobody could find still keeps (the store holds 0-255): the kept skill is copied, not checked.
  assert.equal(mergeOutcome([skillItem(1, 200, '1'), part(1, '2'), part(1, '3')], undefined, r)?.skill, 200)
})

test('merge rolls are drawn fresh at the result tier, never copied from the inputs', () => {
  const r = seeded(3)
  const inputs = [skillItem(1, 5, '1'), skillItem(1, 5, '2'), skillItem(1, 5, '3')]
  const frozen = JSON.stringify(inputs)
  const seen = new Set<string>()
  let copied = 0
  for (let i = 0; i < 2000; i++) {
    const out = mergeOutcome(inputs, '2', r)
    assert.ok(out !== null)
    checkRolls(out)
    seen.add(JSON.stringify(out.rolls))
    if (out.rolls.every((roll) => roll.q === 500)) copied++
  }
  assert.equal(JSON.stringify(inputs), frozen, 'the inputs were changed')
  assert.ok(seen.size > 1900, `only ${seen.size} distinct roll sets in 2000`)
  assert.ok(copied < 5, `${copied} results kept the inputs' qualities`)
  // T3 results can roll reach (T3-only); T2 never.
  const t3 = Array.from({ length: 2000 }, () => mergeOutcome([skillItem(2, 1), part(2), part(2)], undefined, r) as GearInstance)
  assert.ok(t3.some((o) => o.rolls.some((roll) => roll.stat === GEAR_STATS.reach.id)), 'no T3 result rolled reach')
  const t2 = Array.from({ length: 2000 }, () => mergeOutcome([skillItem(1, 1), part(1), part(1)], undefined, r) as GearInstance)
  assert.ok(!t2.some((o) => o.rolls.some((roll) => roll.stat === GEAR_STATS.reach.id)), 'a T2 result rolled reach')
})

test('parts-only odds over 100,000 seeded draws: T2 skill 15%, T3 skill 25%, T3 parts 100%; the surprise skill uniform', () => {
  const N = 100_000
  // Bands are about 4.4 standard deviations at N (0.0011 and 0.0014).
  const bands: Array<[GearTier, number, number]> = [[1, 0.15, 0.005], [2, 0.25, 0.006], [3, 1, 0]]
  for (const [tier, expected, band] of bands) {
    assert.equal(PART_MERGE_SKILL_CHANCE[tier], expected)
    const r = seeded(100 + tier)
    const bySkill = new Map<number, number>()
    let skills = 0
    for (let i = 0; i < N; i++) {
      const out = mergeOutcome([part(tier), part(tier), part(tier)], undefined, r) as GearInstance
      if (out.skill > 0) {
        skills++
        bySkill.set(out.skill, (bySkill.get(out.skill) ?? 0) + 1)
      }
    }
    const rate = skills / N
    assert.ok(Math.abs(rate - expected) <= band, `T${tier} parts: skill item rate ${rate}, want ${expected} +- ${band}`)
    // Uniform over the eight: each within 10% of its share (the smallest sample, T1's ~15,000, puts a share at ~1,875 +- 41).
    assert.deepEqual([...bySkill.keys()].sort((a, b) => a - b), [...SKILLS].sort((a, b) => a - b), `T${tier}: not every skill appeared`)
    for (const [skill, n] of bySkill) {
      const share = n / skills
      assert.ok(Math.abs(share - 1 / SKILLS.length) <= 0.1 / SKILLS.length, `T${tier}: skill ${skill} share ${share}`)
    }
  }
})

test('27 T1 parts always reach a T3 skill item (merging greedily, 2,000 seeds)', () => {
  for (let seed = 0; seed < 2000; seed++) {
    const r = seeded(seed)
    let pile: GearInstance[] = Array.from({ length: 27 }, () => part(1))
    let found = false
    for (let round = 0; round < 4 && !found; round++) {
      const next: GearInstance[] = []
      for (let i = 0; i + 2 < pile.length; i += 3) {
        const out = mergeOutcome(pile.slice(i, i + 3), undefined, r)
        if (out === null) break
        next.push(out)
      }
      pile = next
      found = pile.some((item) => item.tier === 3 && item.skill > 0)
    }
    assert.ok(found, `seed ${seed}: no T3 skill item from 27 T1 parts`)
  }
})

test('parseMerge and parseScrap: the shapes the client sends', () => {
  assert.deepEqual(parseMerge({ ids: ['1', '2', '3'] }), { ids: ['1', '2', '3'], keep: undefined })
  assert.deepEqual(parseMerge({ ids: ['1', '2', '3'], keep: '2' }), { ids: ['1', '2', '3'], keep: '2' })
  assert.deepEqual(parseMerge({ ids: ['1', '2', '3'], keep: null }), { ids: ['1', '2', '3'], keep: undefined })
  for (const bad of [
    null, 'x', 7, {}, { ids: ['1', '2'] }, { ids: ['1', '2', '3', '4'] }, { ids: ['1', '1', '2'] }, { ids: [1, 2, 3] },
    { ids: ['1', '2', '0'] }, { ids: ['1', '2', '-3'] }, { ids: ['1', '2', '3'], keep: 2 }, { ids: ['1', '2', '3'], keep: 'x' },
    { ids: ['1', '2', '1'.repeat(19)] }
  ]) assert.equal(parseMerge(bad), undefined, JSON.stringify(bad))
  assert.equal(parseScrap({ id: '42' }), '42')
  for (const bad of [null, {}, { id: 42 }, { id: '0' }, { id: 'x' }, '42']) assert.equal(parseScrap(bad), undefined, JSON.stringify(bad))
})

test('stashEditsOf: both shipped stores have merge and scrap; a wrapper without them has none', () => {
  assert.ok(stashEditsOf(new MemoryAccountStore()) !== undefined)
  const wrapper = { resolve: async () => null } as unknown as MemoryAccountStore
  assert.equal(stashEditsOf(wrapper), undefined)
})
