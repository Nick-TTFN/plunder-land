import test from 'node:test'
import assert from 'node:assert/strict'
import Multiplayer from './multiplayer'

/** An effect's lifetime on the wire is an int8 of tenths: clamped, never a throw inside the tick. */
test('effect lifetime: tenths of a second, clamped to 0..127', () => {
  assert.equal(Multiplayer.effectLifetime(1200), 12)
  assert.equal(Multiplayer.effectLifetime(99), 0)
  assert.equal(Multiplayer.effectLifetime(12_700), 127)
  assert.equal(Multiplayer.effectLifetime(12_800), 127, 'threw ERR_OUT_OF_RANGE before')
  assert.equal(Multiplayer.effectLifetime(60_000), 127)
  assert.equal(Multiplayer.effectLifetime(-500), 0)
  assert.equal(Multiplayer.effectLifetime(Number.NaN), 0)
  // Every value fits the byte it is written into.
  for (const ms of [0, 100, 12_799, 12_800, 1e9]) Buffer.alloc(1).writeInt8(Multiplayer.effectLifetime(ms))
})
