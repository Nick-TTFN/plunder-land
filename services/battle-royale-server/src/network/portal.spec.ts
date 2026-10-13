import test from 'node:test'
import assert from 'node:assert/strict'
import { invitesShown, portalFrom, privacyUrl, SITE_URL } from '../../../../plunder-land-client/src/net/portal'
import { handshakeAuth } from '../../../../plunder-land-client/src/net/account'
import { portalOf } from './visits'

/** The client's side of `portal` (#56): what it detects, and that the server reads what it sends. */

test('client: itch\'s embed reads itch, our own site web, ?portal= overrides', () => {
  assert.equal(portalFrom('v6p9d9t4.ssl.hwcdn.net', ''), 'web')
  assert.equal(portalFrom('html-classic.itch.zone', ''), 'itch')
  assert.equal(portalFrom('nick-ttfn.itch.io', ''), 'itch')
  assert.equal(portalFrom('plunder-land.nick-ttfn.workers.dev', ''), 'web')
  assert.equal(portalFrom('notitch.zone', ''), 'web', 'only itch.zone and its subdomains')
  assert.equal(portalFrom('plunder-land.nick-ttfn.workers.dev', '?portal=itch&server=x'), 'itch')
})

test('client: invites hidden on itch only; the privacy link leaves itch for our site', () => {
  assert.equal(invitesShown('itch'), false)
  assert.equal(invitesShown('web'), true)
  assert.equal(privacyUrl('web'), '/privacy')
  assert.equal(privacyUrl('itch'), `${SITE_URL}/privacy`)
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
