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
  assert.deepEqual(found, { publicId: account.publicId, persisted: true }, 'create then resolve gave another account')
  assert.equal(await store.resolve(newToken()), null, 'an unknown token resolved')

  const other = await store.create()
  assert.notEqual(other.token, token)
  assert.notEqual(other.account.publicId, account.publicId)
  assert.equal((await store.resolve(other.token))?.publicId, other.account.publicId)
  assert.equal((await store.resolve(token))?.publicId, account.publicId)
}
