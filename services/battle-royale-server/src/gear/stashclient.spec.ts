import test from 'node:test'
import assert from 'node:assert/strict'
import { stashEvent } from './stash'
import type { StashItem as ServerRow } from '../db/accounts'
import { BRING_LEVEL, GEAR_STATS, STASH_MAX, STASH_SOFT, type GearTier } from '../utils/gear'
import { SKILL_INFO } from '../utils/skills'
import {
  BRING_KEY, type BringStorage, type StashView, bringOpen, bringSlotOf, bringToSend, gearLine, inKit, onStash, parseBringMemory,
  placeBring, rememberBring, rememberedBring, shownBring, stashCount, stashWarning
} from '../../../../plunder-land-client/src/net/stash'

/**
 * The client's stash module (`plunder-land-client/src/net/stash.ts`, task
 * 49-4): it reads the server's own `stash` events (`stashEvent`), remembers
 * the bring pick per account, sends `bring` only when it can count, and
 * words the run card's gear row.
 */

const FIREBALL = SKILL_INFO.fireball.id
const ICICLE = SKILL_INFO.icicle.id
const RANGED = SKILL_INFO.ranged.id

function row (id: string, skill: number, carried = false, tier: GearTier = 1): ServerRow {
  const rolls = skill === 0 ? [] : [{ stat: GEAR_STATS.hp.id, q: 500 }]
  return { rowId: id, tier, skill, rolls, carried, source: 0 }
}

function view (...items: Array<[string, number]>): StashView {
  const decoded = onStash(stashEvent(items.map(([id, skill]) => row(id, skill))))
  assert.ok(decoded !== undefined)
  return decoded
}

function memoryStorage (): BringStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

test('onStash reads the server\'s event: stashed rows, away for carried ones, and run after a settle', () => {
  const event = stashEvent([row('3', FIREBALL), row('9', 0, false, 2), row('12', ICICLE, true)], { kept: 2, full: 1 })
  const decoded = onStash(JSON.parse(JSON.stringify(event)))
  assert.deepEqual(decoded, {
    items: [
      { id: '3', tier: 1, skill: FIREBALL, rolls: [{ stat: GEAR_STATS.hp.id, q: 500 }] },
      { id: '9', tier: 2, skill: 0, rolls: [] }
    ],
    away: 1,
    run: { kept: 2, full: 1 }
  })
  assert.equal(onStash(stashEvent([]))?.run, undefined, 'no run outside a settle')
})

test('onStash drops a row it can\'t read, not the view; rejects a malformed event', () => {
  const event = {
    items: [
      { id: '1', tier: 1, skill: FIREBALL, rolls: [[GEAR_STATS.hp.id, 2000], [250, 10]] },
      { id: '2', tier: 4, skill: FIREBALL, rolls: [] },
      { id: '3', tier: 1, skill: 250, rolls: [] },
      { id: 'x', tier: 1, skill: 0, rolls: [] },
      { id: '1', tier: 1, skill: 0, rolls: [] },
      null
    ],
    away: 0
  }
  assert.deepEqual(onStash(event)?.items, [{ id: '1', tier: 1, skill: FIREBALL, rolls: [{ stat: GEAR_STATS.hp.id, q: 1000 }] }],
    'q clamped, an unknown stat skipped; bad tier, unknown skill, bad id and a repeat left out')
  for (const bad of [undefined, null, 7, {}, { items: [] }, { items: {}, away: 0 }, { items: [], away: -1 }, { items: [], away: 0, run: { kept: 1 } }]) {
    assert.equal(onStash(bad), undefined, JSON.stringify(bad))
  }
  const many = { items: Array.from({ length: STASH_MAX + 5 }, (_, i) => ({ id: String(i + 1), tier: 1, skill: 0, rolls: [] })), away: 0 }
  assert.equal(onStash(many)?.items.length, STASH_MAX)
})

test('bring memory: per account, junk reads as nothing, storage that throws remembers nothing', () => {
  const storage = memoryStorage()
  assert.deepEqual(rememberedBring(storage, 'aa'), [null, null])
  rememberBring(storage, 'aa', ['3', null])
  rememberBring(storage, 'bb', [null, '7'])
  assert.deepEqual(rememberedBring(storage, 'aa'), ['3', null])
  assert.deepEqual(rememberedBring(storage, 'bb'), [null, '7'])
  assert.deepEqual(rememberedBring(storage, undefined), [null, null])
  assert.deepEqual(parseBringMemory('{"aa":["3","x"],"bb":7,"cc":[1,"9"]}'), { aa: ['3', null], cc: [null, '9'] })
  for (const junk of ['nope', '[]', 'null', '7']) assert.deepEqual(parseBringMemory(junk), {}, junk)
  const broken: BringStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.deepEqual(rememberedBring(broken, 'aa'), [null, null])
  rememberBring(broken, 'aa', ['1', '2'])
  storage.data.set(BRING_KEY, '{broken')
  rememberBring(storage, 'aa', ['5', null])
  assert.deepEqual(rememberedBring(storage, 'aa'), ['5', null], 'a broken memory is replaced')
})

test('shown and sent: an id no longer in the stash, or a part, is dropped; nothing below level 3 or without a view', () => {
  const v = view(['3', FIREBALL], ['4', ICICLE], ['5', 0])
  assert.deepEqual(shownBring(['3', '4'], v), ['3', '4'])
  assert.deepEqual(shownBring(['9', '4'], v), [null, '4'], 'merged or lost')
  assert.deepEqual(shownBring(['5', null], v), [null, null], 'a part')
  assert.deepEqual(shownBring(['3', '3'], v), ['3', null], 'twice')
  assert.deepEqual(shownBring(['3', '4'], undefined), [null, null])
  assert.deepEqual(bringToSend(['3', '4'], v, BRING_LEVEL), ['3', '4'])
  assert.deepEqual(bringToSend([null, '4'], v, BRING_LEVEL), [null, '4'], 'positions kept: key 4 alone')
  assert.equal(bringToSend(['3', '4'], v, BRING_LEVEL - 1), undefined)
  assert.equal(bringToSend(['3', '4'], undefined, 20), undefined)
  assert.equal(bringToSend(['9', null], v, 20), undefined, 'nothing left to send')
  assert.equal(bringOpen(BRING_LEVEL - 1), false)
  assert.equal(bringOpen(BRING_LEVEL), true)
})

test('placing: a row moves between keys rather than being brought twice; null empties', () => {
  assert.deepEqual(placeBring([null, null], 0, '3'), ['3', null])
  assert.deepEqual(placeBring(['3', null], 1, '3'), [null, '3'])
  assert.deepEqual(placeBring(['3', '4'], 0, '4'), ['4', null])
  assert.deepEqual(placeBring(['3', '4'], 1, null), ['3', null])
  assert.deepEqual(placeBring(['3', '4'], 2, '9'), ['3', '4'], 'no third key')
  assert.equal(bringSlotOf(['3', '4'], '4'), 1)
  assert.equal(bringSlotOf(['3', '4'], '5'), -1)
})

test('IN KIT: the loadout\'s skill or the other key\'s; never a part', () => {
  const fire = { tier: 1 as const, skill: FIREBALL, rolls: [] }
  assert.equal(inKit(fire, [1, 2, RANGED, FIREBALL], undefined), true)
  assert.equal(inKit(fire, [1, 2, RANGED, 0], undefined), false)
  assert.equal(inKit(fire, [1, 2, RANGED, 0], { tier: 2, skill: FIREBALL, rolls: [] }), true)
  assert.equal(inKit({ tier: 1, skill: 0, rolls: [] }, [0, 0, 0, 0], undefined), false)
})

test('count and the warning from 12 items', () => {
  const some = view(['1', FIREBALL])
  assert.equal(stashCount(some), `1 / ${STASH_SOFT}`)
  assert.equal(stashCount({ ...some, away: 2 }), `1 / ${STASH_SOFT} · 2 AWAY`)
  assert.equal(stashWarning(some), undefined)
  const full = view(...Array.from({ length: STASH_SOFT }, (_, i): [string, number] => [String(i + 1), 0]))
  assert.match(stashWarning(full) ?? '', /KEEPS EVERYTHING/)
  assert.equal(stashWarning({ ...full, items: full.items.slice(1) }), undefined)
})

test('run card row: lost on a death or offline, kept from the settle, STASH FULL only when the ceiling cut', () => {
  assert.deepEqual(gearLine(false, 2, false, undefined, false), ['GEAR LOST', '2', 'danger'])
  assert.deepEqual(gearLine(false, 0, false, undefined, false), ['GEAR LOST', '0', 'text'])
  assert.deepEqual(gearLine(true, 2, true, undefined, false), ['GEAR LOST', '2', 'danger'], 'offline keeps nothing')
  assert.deepEqual(gearLine(true, 0, false, undefined, false), ['GEAR KEPT', '0', 'text'], 'nothing carried: no settle to wait for')
  assert.deepEqual(gearLine(true, 2, false, undefined, false), ['GEAR KEPT', '...', 'pending'])
  assert.deepEqual(gearLine(true, 2, false, undefined, true), ['GEAR KEPT', 'UNAVAILABLE', 'muted'])
  assert.deepEqual(gearLine(true, 2, false, { kept: 2, full: 0 }, true), ['GEAR KEPT', '2', 'loot'], 'a late settle still shows')
  assert.deepEqual(gearLine(true, 3, false, { kept: 2, full: 1 }, false), ['STASH FULL', 'KEPT 2 · LOST 1', 'danger'])
})
