import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS, SETTINGS, SETTINGS_KEY, bindKey, bindable, densityFor, loadSettings, parseSettings, setSettings
} from '../../../../plunder-land-client/src/net/settings'
import { slotsFor } from '../../../../plunder-land-client/src/net/loadout'

/**
 * The client's settings (L3 without sound, plunder-land-client/src/net/settings.ts):
 * stored bindings and graphics read back whole, a bad field falls back alone,
 * no key ever does two things.
 */

const defaults = (): typeof DEFAULT_SETTINGS => parseSettings(null)

test('client settings: no storage, junk or an empty object is the defaults', () => {
  for (const raw of [null, '', 'not json', '42', 'null', '{}', '[]']) {
    assert.deepEqual(parseSettings(raw), { ...DEFAULT_SETTINGS, skillKeys: ['q', 'w', 'e', 'r'], itemKeys: ['1', '2', '3', '4', '5'] }, String(raw))
  }
})

test('client settings: a stored value reads back; each bad field falls back on its own', () => {
  const stored = { skillKeys: ['a', 's', 'd', 'f'], itemKeys: ['z', 'x', 'c', 'v', 'b'], density: '1', shadows: false, perfOverlay: true }
  assert.deepEqual(parseSettings(JSON.stringify(stored)), stored)
  assert.deepEqual(parseSettings(JSON.stringify({ ...stored, density: '3' })).density, 'auto')
  assert.deepEqual(parseSettings(JSON.stringify({ ...stored, shadows: 'no' })).shadows, true)
  assert.deepEqual(parseSettings(JSON.stringify({ ...stored, skillKeys: ['a', 's', 'd'] })).skillKeys, ['q', 'w', 'e', 'r'], 'three keys')
  assert.deepEqual(parseSettings(JSON.stringify({ ...stored, skillKeys: ['a', 's', 'd', 'Enter'] })).skillKeys, ['q', 'w', 'e', 'r'], 'a reserved key')
  assert.deepEqual(parseSettings(JSON.stringify({ ...stored, skillKeys: ['A', 'S', 'D', 'F'] })).skillKeys, ['a', 's', 'd', 'f'], 'stored upper case')
  // A key on two slots (an edited store): both groups back to the defaults, never a double binding.
  const clash = parseSettings(JSON.stringify({ ...stored, itemKeys: ['a', 'x', 'c', 'v', 'b'] }))
  assert.deepEqual([clash.skillKeys, clash.itemKeys], [['q', 'w', 'e', 'r'], ['1', '2', '3', '4', '5']])
})

test('client settings: binding a key in use swaps it, across skills and items; unbindable keys change nothing', () => {
  const s = defaults()
  assert.deepEqual(bindKey(s, 'skillKeys', 0, 'F').skillKeys, ['f', 'w', 'e', 'r'])
  assert.deepEqual(bindKey(s, 'skillKeys', 0, 'e').skillKeys, ['e', 'w', 'q', 'r'], 'within skills')
  const across = bindKey(s, 'itemKeys', 1, 'w')
  assert.deepEqual([across.skillKeys, across.itemKeys], [['q', '2', 'e', 'r'], ['1', 'w', '3', '4', '5']], 'across groups')
  for (const key of [' ', 'Enter', 'Escape', 'Shift', 'ArrowUp', 'F1', '']) {
    assert.equal(bindable(key), false, key)
    assert.equal(bindKey(s, 'skillKeys', 0, key), s, key)
  }
  assert.equal(bindKey(s, 'skillKeys', 9, 'x'), s, 'a slot past the end')
  // However it is bound, every key stays on exactly one slot.
  let t = defaults()
  for (const [g, i, k] of [['skillKeys', 0, '1'], ['itemKeys', 4, 'q'], ['skillKeys', 3, 'w'], ['itemKeys', 0, 'r']] as const) {
    t = bindKey(t, g, i, k)
    const all = [...t.skillKeys, ...t.itemKeys]
    assert.equal(new Set(all).size, 9, all.join())
  }
  assert.deepEqual(parseSettings(JSON.stringify(t)), t, 'and it reads back')
})

test('client settings: density, and the HUD\'s keys come from the settings for a kit only', () => {
  assert.equal(densityFor('auto', 3), 2)
  assert.equal(densityFor('auto', 1.5), 1.5)
  assert.equal(densityFor('auto', 0), 1)
  assert.equal(densityFor('1', 2), 1)
  assert.equal(densityFor('2', 1), 2)
  assert.deepEqual(slotsFor([1, 2, 3, 0], ['a', 's', 'd', 'f']).keys, ['a', 's', 'd', 'f'])
  assert.deepEqual(slotsFor([1, 2, 3, 0]).keys, ['q', 'w', 'e', 'r'])
  assert.equal(slotsFor(undefined, ['a', 's', 'd', 'f']).keys[0], 'q', 'the legacy eight keep their keys')
})

test('client settings: set stores and tells listeners; load reads it back; a throwing storage is survived', () => {
  const items = new Map<string, string>()
  const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v) } }
  let heard = 0
  const listener = (): void => { heard++ }
  SETTINGS.listeners.add(listener)
  try {
    const value = bindKey(defaults(), 'skillKeys', 0, 'z')
    setSettings(value, storage)
    assert.equal(heard, 1)
    assert.ok(items.has(SETTINGS_KEY))
    SETTINGS.value = defaults()
    loadSettings(storage)
    assert.deepEqual(SETTINGS.value.skillKeys, ['z', 'w', 'e', 'r'])
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    loadSettings(broken)
    assert.deepEqual(SETTINGS.value, defaults())
    setSettings(value, broken)
    assert.deepEqual(SETTINGS.value, value, 'in force even when storage refuses it')
  } finally {
    SETTINGS.listeners.delete(listener)
    SETTINGS.value = defaults()
  }
})
