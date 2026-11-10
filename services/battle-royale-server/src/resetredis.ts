import type Redis from 'ioredis'

/**
 * The Redis half of the 2026-11-10 userbase reset (migration 9 is the
 * Postgres half; Nick: "reset userbase", everything): every player's
 * cumulative stats (`stats-<id>`) and first-seen day (`player-<id>`) are
 * deleted, **once per Redis**. `RESET_MARKER` is set with NX first, so a
 * second boot, or a second server on the same Redis, finds it and does
 * nothing. Not awaited by boot; a failure is logged and not retried (the
 * marker is already set), and the keys can then be cleared by hand.
 */
export const RESET_MARKER = 'reset-20261110'
const PATTERNS = ['stats-*', 'player-*']

export async function resetRedisOnce (redis: Redis, log: (line: string) => void = console.log): Promise<number> {
  const first = await redis.set(RESET_MARKER, new Date().toISOString(), 'NX')
  if (first !== 'OK') return 0
  let deleted = 0
  for (const match of PATTERNS) {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500)
      cursor = next
      if (keys.length > 0) deleted += await redis.del(...keys)
    } while (cursor !== '0')
  }
  log(`reset: deleted ${deleted} player keys from Redis (${PATTERNS.join(', ')})`)
  return deleted
}
