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
  assert.deepEqual(account.loadouts, [], 'a new account has loadouts')
  assert.deepEqual(found, { publicId: account.publicId, persisted: true, xp: 0, loadouts: [] }, 'create then resolve gave another account')
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
  assert.deepEqual(await store.resolve(token), { publicId: account.publicId, persisted: true, xp: 92, loadouts: [] })
  assert.equal((await store.resolve(other.token))?.xp, 0, 'another account\'s XP moved')
  // Concurrent grants all count (one atomic step each).
  const totals = await Promise.all(Array.from({ length: 10 }, async () => await store.grant(other.account.publicId, 3)))
  assert.equal(Math.max(...totals), 30)
  assert.equal(new Set(totals).size, 10, 'two concurrent grants saw the same total')
  assert.equal((await store.resolve(other.token))?.xp, 30)
  await assert.rejects(store.grant('0123456789abcdef', 10), 'a grant to an unknown account succeeded')

  // Loadouts (decision #48 step 4): one row per (robot, index), replaced by a
  // second save, per account. The store stores; validation is the caller's.
  await store.saveLoadout(account.publicId, 'peep', 0, [4, 1, 2, 3])
  assert.deepEqual((await store.resolve(token))?.loadouts, [{ robot: 'peep', index: 0, skills: [4, 1, 2, 3] }])
  await store.saveLoadout(account.publicId, 'peep', 0, [1, 2, 3, 0])
  assert.deepEqual((await store.resolve(token))?.loadouts, [{ robot: 'peep', index: 0, skills: [1, 2, 3, 0] }], 'a second save did not replace the first')
  await store.saveLoadout(account.publicId, 'peep', 1, [2, 0, 0, 0])
  await store.saveLoadout(account.publicId, 'magnet', 0, [3, 0, 0, 1])
  assert.deepEqual((await store.resolve(token))?.loadouts, [
    { robot: 'magnet', index: 0, skills: [3, 0, 0, 1] },
    { robot: 'peep', index: 0, skills: [1, 2, 3, 0] },
    { robot: 'peep', index: 1, skills: [2, 0, 0, 0] }
  ], 'another (robot, index) is not a row of its own')
  assert.deepEqual((await store.resolve(other.token))?.loadouts, [], 'another account\'s loadouts moved')
  await assert.rejects(store.saveLoadout('0123456789abcdef', 'peep', 0, [1, 2, 3, 0]), 'a save to an unknown account succeeded')
  // Concurrent saves to one key: exactly one row, holding one of the values.
  const written = Array.from({ length: 10 }, (_, i) => [1 + (i % 8), 0, 0, 0])
  await Promise.all(written.map(async (skills) => { await store.saveLoadout(other.account.publicId, 'hopper', 0, skills) }))
  const rows = (await store.resolve(other.token))?.loadouts ?? []
  assert.equal(rows.length, 1, 'concurrent saves to one key made more than one row')
  assert.ok(written.some((skills) => JSON.stringify(skills) === JSON.stringify(rows[0].skills)), 'the row holds a value nobody wrote')
}
