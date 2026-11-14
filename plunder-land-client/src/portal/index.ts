import { PORTAL } from '../config'
import { loadCrazyGamesScript } from './crazygames'
import { Happy } from './happy'
import { pickPortalSdk } from './pick'

/**
 * This page's portal SDK (decision #62, g2-6a), picked once from `PORTAL`
 * (`config.ts`; `?portal=crazygames` tries it on our own site, where the SDK
 * reports `disabled` and this is the no-op). See `adapter.ts`.
 */
export const PORTAL_SDK = pickPortalSdk(PORTAL, loadCrazyGamesScript)

/**
 * When the portal celebrates (g2-6f, decision #62 Q5; `happy.ts`). Off
 * CrazyGames it has no storage, so it neither records nor calls anything.
 */
export const HAPPY = new Happy(PORTAL_SDK, () => {
  if (PORTAL !== 'crazygames') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
})
