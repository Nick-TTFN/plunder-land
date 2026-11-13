import { PORTAL } from '../config'
import { loadCrazyGamesScript } from './crazygames'
import { pickPortalSdk } from './pick'

/**
 * This page's portal SDK (decision #62, g2-6a), picked once from `PORTAL`
 * (`config.ts`; `?portal=crazygames` tries it on our own site, where the SDK
 * reports `disabled` and this is the no-op). See `adapter.ts`.
 */
export const PORTAL_SDK = pickPortalSdk(PORTAL, loadCrazyGamesScript)
