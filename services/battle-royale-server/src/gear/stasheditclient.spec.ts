import test from 'node:test'
import assert from 'node:assert/strict'
// Before ./merge: loading rollGear first trips the import cycle (merge.spec.ts does the same).
import '../network/multiplayer'
import { MERGE_INPUTS as SERVER_INPUTS, mergeOutcome, mergedItem, parseMerge, parseScrap } from './merge'
import { stashEvent } from './stash'
import type { StashItem as ServerRow } from '../db/accounts'
import { GEAR_STATS, type GearTier } from '../utils/gear'
import { SKILL_INFO } from '../utils/skills'
import {
  MERGE_INPUTS, type StashItem, type StashView, keepChoices, keepFor, mergeCheck, mergeHeading, mergeMessage, onMerged,
  onScrapped, onStash, prunePicks, stashEditMessage, toggleMergePick
} from '../../../../plunder-land-client/src/net/stash'

/**
 * The client half of merge and scrap (`plunder-land-client/src/net/stash.ts`,
 * task 49-5): the STASH panel refuses what the server refuses, sends what
 * the server parses, and reads the server's answers.
 */

const FIREBALL = SKILL_INFO.fireball.id
const ICICLE = SKILL_INFO.icicle.id

function item (id: string, skill: number, tier: GearTier = 1): StashItem {
  return { id, tier, skill, rolls: skill === 0 ? [] : [{ stat: GEAR_STATS.hp.id, q: 500 }] }
}

function view (...items: StashItem[]): StashView {
  return { items, away: 0 }
}

test('mergeCheck agrees with the server\'s mergeOutcome on every tier and parts/skill mix, every keep', () => {
  assert.equal(MERGE_INPUTS, SERVER_INPUTS)
  let both = 0
  let refused = 0
  // Every tier per input (so mixed tiers too) and part or skill item per input.
  for (let code = 0; code < 6 ** 3; code++) {
    const inputs: StashItem[] = []
    let c = code
    for (let i = 0; i < 3; i++) {
      const tier = (1 + (c % 3)) as GearTier
      c = Math.floor(c / 3)
      const skill = c % 2 === 0 ? 0 : (i === 1 ? ICICLE : FIREBALL)
      c = Math.floor(c / 2)
      inputs.push(item(String(10 + i), skill, tier))
    }
    const v = view(...inputs, item('99', FIREBALL))
    const ids = inputs.map((x) => x.id)
    for (const keep of [null, '10', '11', '12', '99']) {
      const client = mergeCheck(v, ids, keep)
      // The client sends its own keep (the asked one when valid, else the first skill item).
      const sent = client.ok ? mergeMessage(client) : { ids, keep: keep ?? undefined }
      const parsed = parseMerge(JSON.parse(JSON.stringify(sent)))
      assert.ok(parsed !== undefined, 'the server parses what the client would send')
      const server = mergeOutcome(inputs.map((x) => ({ ...x, rowId: x.id })), parsed.keep, () => 0.5)
      if (client.ok) {
        assert.ok(server !== null, `client allows, server refuses: ${JSON.stringify(inputs)} keep ${String(keep)}`)
        if (client.keep !== null) assert.equal(server.skill, v.items.find((x) => x.id === client.keep)?.skill, 'the kept skill')
        both++
      } else {
        // A refusal only for the pick itself (a keep the client corrects never refuses).
        assert.equal(mergeOutcome(inputs.map((x) => ({ ...x, rowId: x.id })), undefined, () => 0.5), null,
          `client refuses, server allows: ${JSON.stringify(inputs)} (${(client as { reason: string }).reason})`)
        refused++
      }
    }
  }
  assert.ok(both > 0 && refused > 0)
})

test('mergeCheck: the reasons, the keep and the preview', () => {
  const v = view(item('1', 0), item('2', 0), item('3', FIREBALL), item('4', ICICLE), item('5', 0, 2), item('6', FIREBALL, 3), item('7', 0, 3), item('8', 0, 3), item('9', 0, 3))
  assert.deepEqual(mergeCheck(v, [], null), { ok: false, reason: 'PICK 3 ITEMS OF ONE TIER' })
  assert.deepEqual(mergeCheck(v, ['1'], null), { ok: false, reason: 'PICK 2 MORE OF THE SAME TIER' })
  assert.deepEqual(mergeCheck(v, ['1', '2', '5'], null), { ok: false, reason: 'ALL 3 MUST BE THE SAME TIER' })
  assert.deepEqual(mergeCheck(v, ['6', '7', '8'], null), { ok: false, reason: 'T3 SKILL ITEMS CAN\'T MERGE · ONLY T3 PARTS' })
  assert.deepEqual(mergeCheck(undefined, ['1', '2', '3'], null), { ok: false, reason: 'NO STASH' })
  assert.equal(mergeCheck(v, ['1', '2', '404'], null).ok, false, 'a row no longer in the stash')

  const parts = mergeCheck(v, ['1', '2', '1'], null)
  assert.equal(parts.ok, false, 'a repeated id is one input')

  const p = mergeCheck(v, ['2', '1', '3'], null)
  assert.ok(p.ok)
  assert.equal(p.keep, '3', 'default keep: the first skill item')
  assert.deepEqual(p.ids, ['2', '1', '3'], 'order kept')
  assert.equal(p.preview, 'MAKES A T2 THROW FIREBALL · FRESH ROLLS')
  assert.deepEqual(mergeMessage(p), { ids: ['2', '1', '3'], keep: '3' })

  const k = mergeCheck(v, ['3', '4', '1'], '4')
  assert.ok(k.ok)
  assert.equal(k.keep, '4')
  assert.equal(k.preview, 'MAKES A T2 THROW ICICLE · FRESH ROLLS')
  const stale = mergeCheck(v, ['3', '1', '2'], '4')
  assert.ok(stale.ok)
  assert.equal(stale.keep, '3', 'a keep not among the inputs falls back to the first skill item')

  const only = mergeCheck(view(item('1', 0), item('2', 0), item('3', 0)), ['1', '2', '3'], '3')
  assert.ok(only.ok)
  assert.equal(only.keep, null, 'parts only: no keep')
  assert.deepEqual(mergeMessage(only), { ids: ['1', '2', '3'] }, 'and none sent')
  assert.equal(only.preview, 'MAKES A T2 PART · OR, BY CHANCE, A SKILL ITEM')
  const t3 = mergeCheck(v, ['7', '8', '9'], null)
  assert.ok(t3.ok)
  assert.equal(t3.preview, 'MAKES A T3 SKILL ITEM · ALWAYS')
})

test('keepChoices: one per skill, in pick order; keepFor falls back to the first', () => {
  const a = item('1', FIREBALL)
  const b = item('2', 0)
  const c = item('3', FIREBALL)
  const d = item('4', ICICLE)
  assert.deepEqual(keepChoices([b, a, c]).map((x) => x.id), ['1'])
  assert.deepEqual(keepChoices([d, a, c]).map((x) => x.id), ['4', '1'])
  assert.deepEqual(keepChoices([b, b, b]), [])
  assert.equal(keepFor([b, d, a], null), '4')
  assert.equal(keepFor([b, d, a], '1'), '1')
  assert.equal(keepFor([b, d, a], '2'), '4', 'a part is never kept')
  assert.equal(keepFor([b, b, b], '2'), null)
})

test('toggleMergePick: in and out, at most 3, order kept; prunePicks drops rows gone from the stash', () => {
  let picked = toggleMergePick([], '5')
  picked = toggleMergePick(picked, '2')
  picked = toggleMergePick(picked, '9')
  assert.deepEqual(picked, ['5', '2', '9'])
  assert.deepEqual(toggleMergePick(picked, '7'), ['5', '2', '9'], 'a fourth changes nothing')
  assert.deepEqual(toggleMergePick(picked, '2'), ['5', '9'])
  assert.deepEqual(prunePicks(['5', '2', '9'], view(item('9', 0), item('5', 0))), ['5', '9'])
  assert.deepEqual(prunePicks(['5'], undefined), [])
})

function serverRow (rowId: string, skill: number, tier: GearTier): ServerRow {
  return { rowId, tier, skill, rolls: [{ stat: GEAR_STATS.damage.id, q: 700 }], carried: false, source: 2 }
}

test('onMerged reads the server\'s answers; the next stash shows the result and not the inputs', () => {
  const result = serverRow('40', ICICLE, 2)
  const ok = onMerged(JSON.parse(JSON.stringify({ ok: true, item: mergedItem(result) })))
  assert.deepEqual(ok, { ok: true, item: { id: '40', tier: 2, skill: ICICLE, rolls: [{ stat: GEAR_STATS.damage.id, q: 700 }] } })
  for (const reason of ['busy', 'invalid', 'store'] as const) assert.deepEqual(onMerged({ ok: false, reason }), { ok: false, reason })
  assert.deepEqual(onMerged({ ok: false, reason: 'later' }), { ok: false, reason: 'store' }, 'an unknown reason')
  assert.deepEqual(onMerged({ ok: false }), { ok: false, reason: 'store' })
  assert.equal(onMerged({ ok: true }), undefined)
  assert.equal(onMerged({ ok: true, item: { id: '1', tier: 4, skill: 0, rolls: [] } }), undefined)
  assert.equal(onMerged(null), undefined)
  assert.equal(onMerged({ reason: 'busy' }), undefined)

  // The stash that follows: the picks for merge (and for bring) are pruned by it.
  const after = onStash(stashEvent([serverRow('7', FIREBALL, 1), result]))
  assert.ok(after !== undefined)
  assert.deepEqual(prunePicks(['3', '4', '5'], after), [])
  assert.ok(after.items.some((x) => x.id === '40'))
})

test('onScrapped reads the server\'s answers', () => {
  assert.deepEqual(onScrapped({ id: '7', ok: true }), { id: '7', ok: true })
  assert.deepEqual(onScrapped({ id: '7', ok: false, reason: 'invalid' }), { id: '7', ok: false, reason: 'invalid' })
  assert.deepEqual(onScrapped({ id: null, ok: false, reason: 'invalid' }), { id: null, ok: false, reason: 'invalid' })
  assert.deepEqual(onScrapped({ id: '7', ok: false }), { id: '7', ok: false, reason: 'store' }, 'the spec\'s shape, without reason')
  assert.equal(onScrapped({ id: '7' }), undefined)
  assert.equal(onScrapped('7'), undefined)
  assert.equal(parseScrap(JSON.parse(JSON.stringify({ id: '7' }))), '7', 'the server parses what the panel sends')
})

test('mergeHeading: SURPRISE only when parts alone made a skill item', () => {
  const part = item('1', 0)
  assert.equal(mergeHeading([part, part, part], item('9', FIREBALL, 2)), 'SURPRISE: SKILL ITEM')
  assert.equal(mergeHeading([part, part, part], item('9', 0, 2)), 'NEW: T2 PART')
  assert.equal(mergeHeading([part, item('2', ICICLE), part], item('9', ICICLE, 2)), 'NEW: T2 THROW ICICLE')
  assert.equal(mergeHeading([item('7', 0, 3), item('8', 0, 3), item('9', 0, 3)], item('10', FIREBALL, 3)), 'SURPRISE: SKILL ITEM')
})

test('stashEditMessage: plain words per reason; store does not claim nothing changed', () => {
  assert.match(stashEditMessage('merge', 'busy'), /TRY AGAIN/)
  assert.match(stashEditMessage('merge', 'invalid'), /MERGE/)
  assert.match(stashEditMessage('scrap', 'invalid'), /SCRAPPED/)
  assert.doesNotMatch(stashEditMessage('merge', 'store'), /NOTHING CHANGED/)
})
