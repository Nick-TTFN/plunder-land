import * as Sentry from '@sentry/browser'

/**
 * Error reporting (decision #46): Sentry, in production builds only, and not
 * when `?server=` points the page at another server (a developer's run).
 * Uncaught errors and unhandled rejections are reported by the SDK's own
 * handlers, which covers the render loop and every socket handler.
 *
 * The DSN is a public key (it can only send events), so it lives here. No user
 * fields (IP address and the like), cookies, headers, bodies or query strings
 * (`dataCollection`, which replaced sendDefaultPii in v11). At most `BUDGET`
 * events per page load, so one page throwing every frame can't use up the
 * free tier's monthly quota.
 */
declare const __PRODUCTION__: boolean
/** The commit the host built (WORKERS_CI_COMMIT_SHA), or '' outside a host build. */
declare const __RELEASE__: string

const DSN = 'https://5bac74aa4c13e141d945f4141bbfe8d5@o4512185885851648.ingest.de.sentry.io/4512185906167889'
const BUDGET = 20

let sent = 0

export function initErrorReporting (): void {
  if (!__PRODUCTION__) return
  if (new URLSearchParams(window.location.search).has('server')) return
  Sentry.init({
    dsn: DSN,
    release: __RELEASE__ === '' ? undefined : __RELEASE__,
    environment: 'production',
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'ConversationId'),
    beforeSend: (event) => sent++ < BUDGET ? event : null
  })
}
