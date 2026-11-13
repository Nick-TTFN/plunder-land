import type { PortalSdk } from './adapter'

/**
 * No portal SDK: our own site, itch, anything else, and CrazyGames when its
 * SDK can't be used. Every call does nothing and resolves at once.
 */
export function noPortalSdk (): PortalSdk {
  return {
    ready: Promise.resolve(),
    loadingStop: () => {},
    gameplayStart: () => {},
    gameplayStop: () => {},
    // Never muted by a portal: the listener is never called.
    onMute: () => {},
    user: async () => null,
    userToken: async () => null,
    onLogin: () => {},
    linkPrompt: async () => false,
    rewardedAd: async () => 'unavailable',
    adsAvailable: () => false
  }
}
