import * as Sentry from '@sentry/node'

/**
 * Error reporting (decision #46): Sentry when `SENTRY_DSN` is set (Railway),
 * otherwise the log alone, so a local run or a spec sends nothing.
 *
 * The errors that matter are ones the server already catches so the world
 * keeps running (a tick, a timer, a socket handler); Sentry only sees what
 * reaches `reportError`/`captureError`, plus anything uncaught.
 *
 * No tracing and no OpenTelemetry (both off by default in @sentry/node 11),
 * no module load-time hooks, and none of the integrations below: the hot path
 * is unchanged. It costs about 25-30 MB of RSS at idle (103 -> 126-135 MB,
 * measured 2026-10-02). At most `BUDGET` events per `WINDOW_MS`, so a throw every tick
 * can't use up the free tier's monthly quota in an hour.
 */
// Names as the SDK reports them (it logs what is left at start-up). SpanStreaming
// is added after this filter and stays; it is inert with tracing off.
const SKIPPED = new Set([
  'Http', 'NodeFetch', 'LocalVariables', 'LocalVariablesAsync', 'ChildProcess', 'WorkerThreads',
  'Express', 'Fastify', 'Hapi', 'Hono', 'Koa', 'SpanStreaming', 'ConversationId'
])
const BUDGET = 30
const WINDOW_MS = 10 * 60 * 1000

let windowStart = 0
let sentInWindow = 0

/** Whether one more event fits this window's budget. Exported for the spec. */
export function withinBudget (now: number): boolean {
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= BUDGET) return false
  sentInWindow++
  return true
}

export function initErrorReporting (): void {
  const dsn = process.env.SENTRY_DSN
  if (dsn === undefined || dsn === '') return
  const client = Sentry.init({
    dsn,
    // Railway's own variables: the deployed commit and the environment.
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? 'production',
    // No user fields (IP address and the like), cookies, headers, bodies or
    // query strings: dataCollection replaced sendDefaultPii in v11, and
    // userInfo defaults to on.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    enableRuntimeChannelInjection: false,
    integrations: (defaults) => defaults.filter((integration) => !SKIPPED.has(integration.name)),
    beforeSend: (event) => withinBudget(Date.now()) ? event : null
  })
  const names = client?.getOptions().integrations.map((integration) => integration.name) ?? []
  console.log(`sentry: on, release ${process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? '?'}, integrations ${names.join(' ')}`)
}

/** Log `e` under `where` and send it to Sentry. */
export function reportError (where: string, e: unknown): void {
  console.error(where, e)
  captureError(where, e)
}

/** Send `e` to Sentry only, for a site that logs through its own (throttled) log. */
export function captureError (where: string, e: unknown): void {
  Sentry.captureException(e, { tags: { where } })
}

/** Send what is queued before the process exits; at most `timeoutMs`. */
export async function flushErrors (timeoutMs: number): Promise<void> {
  await Sentry.flush(timeoutMs)
}
