import { type AccountStore, MemoryAccountStore } from './accounts'
import { PgAccountStore } from './pgstore'
import { ThrottledLog } from '../network/multiplayer'
import { captureError } from '../errors'

/** Store failures the store sees on its own (migrations, idle clients), throttled. */
const LOG = new ThrottledLog('accounts', 60_000)

/**
 * The server's account store: Postgres when `DATABASE_URL` is set, else the
 * memory store with one log line. On Railway (`RAILWAY_ENVIRONMENT_NAME`)
 * the memory store means every deploy forgets every account, so it is also
 * reported to Sentry, once.
 */
export function openAccountStore (env: NodeJS.ProcessEnv = process.env): AccountStore {
  const url = env.DATABASE_URL
  if (url === undefined || url === '') {
    console.log('accounts: in memory (no DATABASE_URL)')
    if (env.RAILWAY_ENVIRONMENT_NAME !== undefined && env.RAILWAY_ENVIRONMENT_NAME !== '') {
      captureError('accounts', new Error('accounts: in memory on Railway (no DATABASE_URL); every deploy forgets every account'))
    }
    return new MemoryAccountStore()
  }
  // Sentry gets the first failure of each run of failures, not one every
  // retry: a database down for an hour would otherwise spend the error budget.
  let failing = false
  const store = new PgAccountStore({
    connectionString: url,
    onError: (e) => {
      LOG.report(e)
      if (!failing) captureError('accounts', e)
      failing = true
    },
    onReady: (applied) => {
      failing = false
      console.log(`accounts: postgres ready${applied.length > 0 ? `, applied migrations ${applied.join(', ')}` : ''}`)
    }
  })
  store.start()
  return store
}
