/**
 * Where this client runs (#56): `web` on our own site, `itch` inside itch's
 * embed (served from `*.itch.zone`), later `crazygames` and `poki`. Sent in
 * the handshake (`handshakeAuth`); the server puts it on every analytics
 * event, and reads anything outside its allowlist as `other`. `?portal=`
 * overrides it, to try a portal's behaviour on our own site.
 *
 * Pixi-free and `window`-free: callers pass the location in.
 */

export type Portal = string

export function portalFrom (hostname: string, search: string): Portal {
  const forced = new URLSearchParams(search).get('portal')
  if (forced !== null && forced !== '') return forced
  if (/(^|\.)itch\.(zone|io)$/.test(hostname)) return 'itch'
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
 * itch.zone, not the itch page (Nick, 2026-10-14: hide for now).
 */
export function invitesShown (portal: Portal): boolean {
  return portal !== 'itch'
}
