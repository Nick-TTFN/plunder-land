import assert from 'node:assert/strict'
import { type AccountStore, newToken, PUBLIC_ID_SHAPE, TOKEN_SHAPE } from './accounts'

/**
 * What every `AccountStore` must do (decision #48), run against the memory
 * store (accounts.spec.ts) and Postgres (pgstore.spec.ts). Test support only;
 * not imported by the server.
 */
export async function storeContract (store: AccountStore): Promise<void> {
  const { account, token } = await store.create()
  assert.match(token, TOKEN_SHAPE)
  assert.match(account.publicId, PUBLIC_ID_SHAPE)
  assert.equal(account.persisted, true)

  const found = await store.resolve(token)
  assert.equal(account.xp, 0, 'a new account has XP')
  assert.deepEqual(found, { publicId: account.publicId, persisted: true, xp: 0 }, 'create then resolve gave another account')
  assert.equal(await store.resolve(newToken()), null, 'an unknown token resolved')

  const other = await store.create()
  assert.notEqual(other.token, token)
  assert.notEqual(other.account.publicId, account.publicId)
  assert.equal((await store.resolve(other.token))?.publicId, other.account.publicId)
  assert.equal((await store.resolve(token))?.publicId, account.publicId)

  // XP (decision #48 step 3): grants add up, per account, and resolve reads them back.
  assert.equal(await store.grant(account.publicId, 87), 87)
  assert.equal(await store.grant(account.publicId, 0), 87, 'a grant of 0')
  assert.equal(await store.grant(account.publicId, 5), 92)
  assert.deepEqual(await store.resolve(token), { publicId: account.publicId, persisted: true, xp: 92 })
  assert.equal((await store.resolve(other.token))?.xp, 0, 'another account\'s XP moved')
  // Concurrent grants all count (one atomic step each).
  const totals = await Promise.all(Array.from({ length: 10 }, async () => await store.grant(other.account.publicId, 3)))
  assert.equal(Math.max(...totals), 30)
  assert.equal(new Set(totals).size, 10, 'two concurrent grants saw the same total')
  assert.equal((await store.resolve(other.token))?.xp, 30)
  await assert.rejects(store.grant('0123456789abcdef', 10), 'a grant to an unknown account succeeded')
}
