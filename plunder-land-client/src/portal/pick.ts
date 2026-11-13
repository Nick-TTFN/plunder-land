import { type PortalSdk, withGameplayState } from './adapter'
import { type CrazySdk, crazyGamesSdk } from './crazygames'
import { noPortalSdk } from './none'
import type { Portal } from '../net/portal'

/**
 * The adapter for a portal: CrazyGames' SDK on `crazygames` (whose script
 * `loadCrazyGames` adds, and is called only there), the no-op anywhere else.
 * Poki later is one more case. Pixi-free and `window`-free.
 */
export function pickPortalSdk (portal: Portal, loadCrazyGames: () => Promise<CrazySdk | undefined>): PortalSdk {
  return withGameplayState(portal === 'crazygames' ? crazyGamesSdk(loadCrazyGames) : noPortalSdk())
}
