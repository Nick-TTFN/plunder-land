/**
 * Where this client runs (#56): `web` on our own site, `itch` inside itch's
 * embed (served from `*.itch.zone`), `crazygames` on CrazyGames (#62), later
 * `poki`. Sent in the handshake (`handshakeAuth`); the server puts it on
 * every analytics event, and reads anything outside its allowlist as `other`. `?portal=`
 * overrides it, to try a portal's behaviour on our own site.
 *
 * Pixi-free and `window`-free: callers pass the location in.
 */

export type Portal = string

export function portalFrom (hostname: string, search: string): Portal {
  const forced = new URLSearchParams(search).get('portal')
  if (forced !== null && forced !== '') return forced
  if (/(^|\.)itch\.(zone|io)$/.test(hostname)) return 'itch'
  // CrazyGames serves the game from `<slug>.game-files.crazygames.com` and
  // checks its own sitelock with `hostname.endsWith(".crazygames.com")`
  // (docs.crazygames.com/resources/html5/sitelock, read 2026-11-13). Their
  // iOS app runs the game inside `games.crazygames.com`, so this covers it.
  // The host of their QA preview (`crazygames.com/preview`) is unverified:
  // check it in g2-7.
  if (/(^|\.)crazygames\.com$/.test(hostname)) return 'crazygames'
  return 'web'
}

/**
 * Our own site, for what only it serves (the privacy page). A move to a
 * custom domain changes this (and loses browser-held identity, L8).
 */
export const SITE_URL = 'https://plunder-land.nick-ttfn.workers.dev'

/** The privacy page: our own path on our site, our site's address from anywhere else. */
export function privacyUrl (portal: Portal): string {
  return portal === 'web' ? '/privacy' : `${SITE_URL}/privacy`
}

/**
 * Whether the lobby offers invite links. Not on itch: a link is built from
 * the page's own address, which inside the embed is the bare game on
 * itch.zone, not the itch page (Nick, 2026-10-14: hide for now). Not on
 * CrazyGames for the same reason (the bare game on their file host, a
 * playable copy outside their page); their own invite links are a Full
 * Launch SDK feature (#62).
 */
export function invitesShown (portal: Portal): boolean {
  return portal !== 'itch' && portal !== 'crazygames'
}

/**
 * Whether the game offers its own fullscreen button, in the lobby and in runs
 * (g2-1): wherever the browser can (`supported`, `fullscreenSupported` in
 * `ui/fullscreen.ts`: false on iPhone Safari, which has no Fullscreen API for
 * a page), on every device, whatever the input mode. Not on CrazyGames: their
 * gameplay rules prohibit custom fullscreen buttons and their page provides
 * fullscreen itself (docs.crazygames.com/requirements/gameplay, read
 * 2026-11-13; decision #62).
 */
export function fullscreenButtonShown (portal: Portal, supported: boolean): boolean {
  return supported && portal !== 'crazygames'
}
