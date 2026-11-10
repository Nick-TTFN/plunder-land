import test from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import { RESET_MARKER, resetRedisOnce } from './resetredis'

/** A Redis with just set NX, scan (MATCH, glob '*' only) and del, over a Map. */
function fakeRedis (keys: string[]): { redis: Redis, store: Map<string, string> } {
  const store = new Map(keys.map((k) => [k, '1']))
  const redis = {
    set: async (key: string, value: string, nx: string) => {
      assert.equal(nx, 'NX')
      if (store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    // One key per page, so the cursor loop is exercised. The cursor is the
    // last key returned (as real SCAN, deleting between pages skips nothing).
    scan: async (cursor: string, _m: string, match: string) => {
      const prefix = match.replace(/\*$/, '')
      const after = cursor === '0' ? '' : cursor.slice(1)
      const next = [...store.keys()].filter((k) => k.startsWith(prefix) && k > after).sort()[0]
      return next === undefined ? ['0', []] : ['k' + next, [next]]
    },
    del: async (...ks: string[]) => { let n = 0; for (const k of ks) if (store.delete(k)) n++; return n }
  } as unknown as Redis
  return { redis, store }
}

test('the Redis reset deletes every stats-* and player-* key once, and nothing else', async () => {
  const { redis, store } = fakeRedis(['stats-a1', 'stats-b2', 'stats-c3', 'player-a1', 'player-b2', 'season-x', 'other'])
  const lines: string[] = []
  assert.equal(await resetRedisOnce(redis, (l) => lines.push(l)), 5)
  assert.deepEqual([...store.keys()].filter((k) => k !== RESET_MARKER).sort(), ['other', 'season-x'])
  assert.ok(store.has(RESET_MARKER), 'no marker')
  assert.match(lines[0], /deleted 5 player keys/)

  // A second boot (or a second server on the same Redis): the marker is there, nothing runs.
  store.set('stats-new', '1')
  assert.equal(await resetRedisOnce(redis, () => {}), 0)
  assert.ok(store.has('stats-new'), 'a later player\'s stats were wiped by a second run')
})
