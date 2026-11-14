import test from 'node:test'
import assert from 'node:assert/strict'
import { fullscreenButtonShown, invitesShown, portalFrom, privacyUrl, SITE_URL } from '../../../../plunder-land-client/src/net/portal'
import { handshakeAuth } from '../../../../plunder-land-client/src/net/account'
import { portalOf } from './visits'

/** The client's side of `portal` (#56): what it detects, and that the server reads what it sends. */

test('client: itch\'s embed reads itch, our own site web, ?portal= overrides', () => {
  assert.equal(portalFrom('v6p9d9t4.ssl.hwcdn.net', ''), 'web')
  assert.equal(portalFrom('html-classic.itch.zone', ''), 'itch')
  assert.equal(portalFrom('nick-gamedev.itch.io', ''), 'itch')
  assert.equal(portalFrom('plunder-land.nick-ttfn.workers.dev', ''), 'web')
  assert.equal(portalFrom('notitch.zone', ''), 'web', 'only itch.zone and its subdomains')
  assert.equal(portalFrom('plunder-land.nick-ttfn.workers.dev', '?portal=itch&server=x'), 'itch')
})

test('client: CrazyGames\' file host, iOS frame and apex read crazygames; a lookalike reads web', () => {
  assert.equal(portalFrom('x.game-files.crazygames.com', ''), 'crazygames')
  assert.equal(portalFrom('games.crazygames.com', ''), 'crazygames')
  assert.equal(portalFrom('crazygames.com', ''), 'crazygames')
  assert.equal(portalFrom('crazygames.com.evil.io', ''), 'web')
  assert.equal(portalFrom('notcrazygames.com', ''), 'web', 'only crazygames.com and its subdomains')
  assert.equal(portalFrom('plunder-land.nick-ttfn.workers.dev', '?portal=crazygames'), 'crazygames')
  assert.equal(portalFrom('x.game-files.crazygames.com', '?portal=web'), 'web', '?portal= still overrides')
})

test('client: invites hidden on itch, on CrazyGames only with their SDK\'s link (g2-6e); the privacy link leaves both for our site', () => {
  assert.equal(invitesShown('itch'), false)
  assert.equal(invitesShown('itch', 'https://x'), false, 'never on itch')
  assert.equal(invitesShown('crazygames'), false, 'no SDK link: hidden')
  assert.equal(invitesShown('crazygames', null), false)
  assert.equal(invitesShown('crazygames', 'https://www.crazygames.com/game/x?join=abcdef'), true)
  assert.equal(invitesShown('web'), true)
  assert.equal(privacyUrl('web'), '/privacy')
  assert.equal(privacyUrl('itch'), `${SITE_URL}/privacy`)
  assert.equal(privacyUrl('crazygames'), `${SITE_URL}/privacy`)
})

test('client: a fullscreen button wherever the browser can (no input mode in the rule), except on CrazyGames', () => {
  // g2-1: desktop and touch alike; the rule takes no touch flag at all.
  assert.equal(fullscreenButtonShown('web', true), true)
  assert.equal(fullscreenButtonShown('itch', true), true)
  assert.equal(fullscreenButtonShown('other', true), true)
  // #62: CrazyGames' rules prohibit a custom fullscreen button.
  assert.equal(fullscreenButtonShown('crazygames', true), false)
  // iPhone Safari: no Fullscreen API for a page (`fullscreenSupported` false), so none anywhere.
  assert.equal(fullscreenButtonShown('web', false), false)
  assert.equal(fullscreenButtonShown('itch', false), false)
  assert.equal(fullscreenButtonShown('crazygames', false), false)
})

test('the server takes crazygames as a portal of its own, not other', () => {
  assert.equal(portalOf({ portal: portalFrom('x.game-files.crazygames.com', '') }), 'crazygames')
})

test('the handshake carries the portal beside the token, and the server reads it', () => {
  const items = new Map<string, string>()
  const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) } }
  let sent: unknown
  handshakeAuth(() => storage, 'itch')((data) => { sent = data })
  assert.deepEqual(sent, { portal: 'itch' })
  assert.equal(portalOf(sent), 'itch')
  handshakeAuth(() => storage)((data) => { sent = data })
  assert.deepEqual(sent, {}, 'no portal given: as before')
  assert.equal(portalOf(sent), 'web')
})
