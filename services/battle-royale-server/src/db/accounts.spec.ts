import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hashToken, MemoryAccountStore, newToken, tokenOf, TOKEN_SHAPE } from './accounts'
import { gearContract, storeContract } from './storecontract'
import { MIGRATIONS } from './migrations'
import { openAccountStore } from './open'

/** The account store contract against the memory store, and the token helpers (decision #48). */

test('memory store: the store contract', async () => {
  await storeContract(new MemoryAccountStore())
})

test('memory store: the gear stash contract and dupe races 1-11, merge and scrap (decision #49)', async () => {
  let now = Date.parse('2026-10-05T12:00:00.000Z')
  const store = new MemoryAccountStore({ clock: () => now })
  await gearContract(store, {
    age: async (ms) => { now += ms },
    allRowIds: async () => [...store.stashRows.keys()]
  })
})

test('memory store: what is kept is the token\'s SHA-256, never the token', async () => {
  const store = new MemoryAccountStore()
  const { token } = await store.create()
  // Computed here, not through hashToken, so a broken hashToken shows.
  const sha256 = createHash('sha256').update(token).digest()
  assert.deepEqual(hashToken(token), sha256)
  assert.deepEqual(store.storedHashes, [sha256.toString('hex')])
  assert.ok(!store.storedHashes.some((stored) => stored.includes(token) || stored.includes(Buffer.from(token).toString('hex'))))
})

test('tokens: 32 random bytes as base64url; the handshake accepts only that shape', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 2000; i++) {
    const token = newToken()
    assert.match(token, TOKEN_SHAPE)
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    seen.add(token)
    assert.equal(tokenOf({ token }), token)
  }
  assert.equal(seen.size, 2000)
  for (const auth of [undefined, null, 'x', {}, { token: '' }, { token: 'a'.repeat(42) }, { token: 'a'.repeat(44) }, { token: 'a'.repeat(42) + '=' }, { token: 'a'.repeat(42) + '/' }, { token: ['a'.repeat(43)] }]) {
    assert.equal(tokenOf(auth), undefined, JSON.stringify(auth))
  }
})

test('migrations: versions ascend from 1 with no gaps or repeats', () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.version), MIGRATIONS.map((_, i) => i + 1))
  for (const m of MIGRATIONS) assert.ok(m.name !== '' && m.sql.trim() !== '')
})

test('no DATABASE_URL: the memory store, and one log line', () => {
  const lines: unknown[] = []
  const log = console.log
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
  try {
    const store = openAccountStore({})
    assert.ok(store instanceof MemoryAccountStore)
  } finally {
    console.log = log
  }
  assert.deepEqual(lines, ['accounts: in memory (no DATABASE_URL)'])
})
