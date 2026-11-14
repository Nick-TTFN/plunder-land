import test from 'node:test'
import assert from 'node:assert/strict'
import { handshakeAuth, linkOfferOf, onAccount, TOKEN_KEY, type TokenStorage } from '../../../../plunder-land-client/src/net/account'
import { type CrazySdk, type CrazyUserModule, crazyGamesSdk, portalUserOf } from '../../../../plunder-land-client/src/portal/crazygames'
import { withGameplayState, type PortalSdk } from '../../../../plunder-land-client/src/portal/adapter'
import { noPortalSdk } from '../../../../plunder-land-client/src/portal/none'
import { LINK, Relogin, answerLinkOffer, loginButtonShown, shownName } from '../../../../plunder-land-client/src/portal/identity'
import { callsign } from '../../../../plunder-land-client/src/utils/callsign'

/**
 * The CrazyGames login on the client (g2-6c; server g2-6b): the handshake's
 * `portalToken`, the `account` event's `portal` and `linkable`, the link
 * answer, a login while the page is open, and the lobby's name. Run against
 * fake SDKs; the browser wiring (`index.ts`, the lobby's DOM, READY held while
 * the link modal is open) is not run here.
 */

const GUEST_TOKEN = 'a'.repeat(43)
const ID = 'abcdef012345'

function memoryStorage (initial: Record<string, string> = {}): TokenStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => { data[k] = v },
    removeItem: (k) => { delete data[k] }
  }
}

/** The handshake's `auth` as socket.io would read it. */
async function authOf (auth: (cb: (data: object) => void) => void): Promise<Record<string, unknown>> {
  return await new Promise((resolve) => { auth((data) => { resolve(data as Record<string, unknown>) }) })
}

interface UserFake {
  available?: boolean
  user?: { username?: unknown, profilePictureUrl?: unknown } | null
  token?: () => Promise<string>
  link?: () => Promise<{ response?: unknown } | null>
  auth?: () => Promise<{ username?: unknown } | null>
}

/** A CrazyGames SDK with a user module; `calls` records each user-module call. */
function sdkWithUser (calls: string[], fake: UserFake = {}): CrazySdk & { login: (user: unknown) => void } {
  let authListener: ((user: never) => void) | undefined
  const user: CrazyUserModule = {
    isUserAccountAvailable: fake.available ?? true,
    getUser: async () => { calls.push('getUser'); return fake.user === undefined ? { username: 'Crazy.User_1', profilePictureUrl: 'https://images.crazygames.com/a.png' } : fake.user as never },
    getUserToken: async (options) => {
      calls.push(`getUserToken:${options.signingKeyType}`)
      return fake.token !== undefined ? await fake.token() : 'header.payload.signature'
    },
    addAuthListener: (listener) => { calls.push('addAuthListener'); authListener = listener as never },
    showAuthPrompt: async () => { calls.push('showAuthPrompt'); return fake.auth !== undefined ? await fake.auth() as never : { username: 'Crazy.User_1' } },
    showAccountLinkPrompt: async () => { calls.push('showAccountLinkPrompt'); return fake.link !== undefined ? await fake.link() : { response: 'yes' } }
  }
  return {
    init: async () => {},
    environment: 'crazygames',
    game: {
      loadingStart: () => {},
      loadingStop: () => {},
      gameplayStart: () => {},
      gameplayStop: () => {},
      settings: {},
      addSettingsChangeListener: () => {}
    },
    user,
    login: (u) => { authListener?.(u as never) }
  }
}

function adapter (fake: CrazySdk, warnings: string[] = []): PortalSdk {
  return withGameplayState(crazyGamesSdk(async () => fake, { log: () => {}, warn: (l) => warnings.push(l) }))
}

// ------------------------------------------------------------- handshake

test('handshake: a logged-out user (or no portal) sends no portalToken; a logged-in one sends a fresh IN_GAME_AUTH token each connect', async () => {
  const storage = memoryStorage({ [TOKEN_KEY]: GUEST_TOKEN })

  // Off a portal: the no-op SDK.
  assert.deepEqual(await authOf(handshakeAuth(() => storage, 'web', noPortalSdk())), { token: GUEST_TOKEN, portal: 'web' })

  // Logged out: CrazyGames answers userNotAuthenticated.
  const calls: string[] = []
  const out = adapter(sdkWithUser(calls, { token: async () => { throw Object.assign(new Error('x'), { code: 'userNotAuthenticated' }) } }))
  assert.deepEqual(await authOf(handshakeAuth(() => storage, 'crazygames', out)), { token: GUEST_TOKEN, portal: 'crazygames' })

  // Logged in: one token per handshake, asked for every time (never kept).
  const inCalls: string[] = []
  let n = 0
  const inSdk = adapter(sdkWithUser(inCalls, { token: async () => `t.${++n}.s` }))
  const auth = handshakeAuth(() => storage, 'crazygames', inSdk)
  assert.deepEqual(await authOf(auth), { token: GUEST_TOKEN, portal: 'crazygames', portalToken: 't.1.s' })
  assert.deepEqual(await authOf(auth), { token: GUEST_TOKEN, portal: 'crazygames', portalToken: 't.2.s' }, 'a reconnect asks again')
  assert.deepEqual(inCalls, ['addAuthListener', 'getUserToken:IN_GAME_AUTH', 'getUserToken:IN_GAME_AUTH'], 'the login listener at init, then one token per connect')
})

test('handshake: isUserAccountAvailable false sends no portalToken and never calls the user module', async () => {
  const calls: string[] = []
  const sdk = adapter(sdkWithUser(calls, { available: false }))
  const auth = await authOf(handshakeAuth(() => memoryStorage(), 'crazygames', sdk))
  assert.deepEqual(auth, { portal: 'crazygames' })
  assert.equal(await sdk.user(), null)
  assert.equal(await sdk.linkPrompt(), false)
  assert.equal(await sdk.authPrompt(), false)
  assert.equal(sdk.accountsAvailable(), false)
  assert.deepEqual(calls, [], 'no user-module call where accounts are unavailable')
})

test('handshake: a token call that never answers connects without it after the wait; one too long is not sent', async () => {
  const sdk = adapter(sdkWithUser([], { token: async () => await new Promise<string>(() => {}) }))
  const started = Date.now()
  const auth = await authOf(handshakeAuth(() => memoryStorage(), 'crazygames', sdk, 30))
  assert.deepEqual(auth, { portal: 'crazygames' })
  assert.ok(Date.now() - started < 1000, 'waited past the timeout')

  const long = adapter(sdkWithUser([], { token: async () => 'x'.repeat(4097) }))
  assert.deepEqual(await authOf(handshakeAuth(() => memoryStorage(), 'crazygames', long)), { portal: 'crazygames' })
})

test('handshake: an SDK that never loads or reports disabled gives guest play (no token, no throw)', async () => {
  for (const load of [async () => undefined, async () => ({ ...sdkWithUser([]), environment: 'disabled' })]) {
    const sdk = withGameplayState(crazyGamesSdk(load as () => Promise<CrazySdk | undefined>, { log: () => {}, timeoutMs: 50 }))
    assert.deepEqual(await authOf(handshakeAuth(() => memoryStorage(), 'crazygames', sdk)), { portal: 'crazygames' })
  }
})

// --------------------------------------------------------------- account

test('account: a linked account (portal, no token) leaves the stored token alone and is marked linked', () => {
  const storage = memoryStorage({ [TOKEN_KEY]: GUEST_TOKEN })
  const info = onAccount({ id: ID, portal: 'crazygames', xp: 0, level: 1, levelAt: 0, nextAt: 100 }, storage)
  assert.equal(storage.data[TOKEN_KEY], GUEST_TOKEN)
  assert.equal(info?.portal, 'crazygames')
  assert.equal(info?.standing?.level, 1)
  // A guest's account is not marked.
  assert.equal(onAccount({ id: ID }, storage)?.portal, undefined)
  // Even a token beside `portal` is never stored (the server never sends one; a linked account is never entered with it).
  const other = memoryStorage()
  onAccount({ id: ID, portal: 'crazygames', token: 'b'.repeat(43) }, other)
  assert.equal(other.data[TOKEN_KEY], undefined)
})

test('account: the link accepted (portal on the offered id) drops the stored guest token; another id keeps it', () => {
  const storage = memoryStorage({ [TOKEN_KEY]: GUEST_TOKEN })
  // `taken`: the user was linked meanwhile to another account; this guest stays a guest.
  onAccount({ id: 'otheraccount', portal: 'crazygames' }, storage, ID)
  assert.equal(storage.data[TOKEN_KEY], GUEST_TOKEN)
  // The offer's own account, now linked.
  onAccount({ id: ID, portal: 'crazygames' }, storage, ID)
  assert.equal(storage.data[TOKEN_KEY], undefined)
  // A storage without removeItem, or one that throws, does not throw.
  assert.doesNotThrow(() => onAccount({ id: ID, portal: 'crazygames' }, { getItem: () => null, setItem: () => {} }, ID))
  assert.doesNotThrow(() => onAccount({ id: ID, portal: 'crazygames' }, { getItem: () => null, setItem: () => {}, removeItem: () => { throw new Error('blocked') } }, ID))
})

test('account: an offer is recognised only with linkable true on a persisted account', () => {
  assert.equal(linkOfferOf({ id: ID, linkable: true, xp: 5 }), ID)
  assert.equal(linkOfferOf({ id: ID }), undefined)
  assert.equal(linkOfferOf({ id: ID, linkable: 'true' }), undefined)
  assert.equal(linkOfferOf({ id: ID, linkable: true, offline: true }), undefined)
  assert.equal(linkOfferOf({ linkable: true }), undefined)
  assert.equal(linkOfferOf(null), undefined)
})

// ------------------------------------------------------------ link offer

test('link: yes sends accept true and remembers the id; no or a modal error sends a decline; LINK.open holds READY meanwhile', async () => {
  const sent: boolean[] = []
  const seen: Array<string | undefined> = []
  const listener = (): void => { seen.push(LINK.open) }
  LINK.listeners.add(listener)
  try {
    LINK.accepted = undefined
    await answerLinkOffer(ID, adapter(sdkWithUser([])), (a) => sent.push(a))
    assert.deepEqual(sent, [true])
    assert.equal(LINK.accepted, ID)
    assert.deepEqual(seen, [ID, undefined], 'open while the modal is up, closed after')

    LINK.accepted = undefined
    await answerLinkOffer(ID, adapter(sdkWithUser([], { link: async () => ({ response: 'no' }) })), (a) => sent.push(a))
    const warnings: string[] = []
    await answerLinkOffer(ID, adapter(sdkWithUser([], { link: async () => { throw Object.assign(new Error('x'), { code: 'showAccountLinkPromptInProgress' }) } }), warnings), (a) => sent.push(a))
    await answerLinkOffer(ID, adapter(sdkWithUser([], { link: async () => { throw Object.assign(new Error('x'), { code: 'unexpectedError' }) } }), warnings), (a) => sent.push(a))
    await answerLinkOffer(ID, adapter(sdkWithUser([], { link: async () => null })), (a) => sent.push(a))
    await answerLinkOffer(ID, { linkPrompt: async () => { throw new Error('a raw throw') } }, (a) => sent.push(a))
    assert.deepEqual(sent, [true, false, false, false, false, false])
    assert.equal(LINK.accepted, undefined, 'a decline accepts nothing')
    assert.equal(warnings.length, 1, `a documented "no" (in progress) is not warned, an unexpected error is: ${warnings.join(' | ')}`)
    assert.equal(LINK.open, undefined)
  } finally {
    LINK.listeners.delete(listener)
    LINK.accepted = undefined
  }
})

test('link: a second offer while the modal is open is not answered twice', async () => {
  let answer: (v: { response: string }) => void = () => {}
  const sdk = adapter(sdkWithUser([], { link: async () => await new Promise((resolve) => { answer = resolve }) }))
  const sent: boolean[] = []
  const first = answerLinkOffer(ID, sdk, (a) => sent.push(a))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(LINK.open, ID)
  await answerLinkOffer('second00000', sdk, (a) => sent.push(a))
  assert.deepEqual(sent, [], 'the second offer waits for the open modal')
  answer({ response: 'yes' })
  await first
  assert.deepEqual(sent, [true])
  assert.equal(LINK.open, undefined)
  LINK.accepted = undefined
})

test('link: an emit that throws still closes the modal state', async () => {
  await assert.rejects(answerLinkOffer(ID, { linkPrompt: async () => false }, () => { throw new Error('socket') }))
  assert.equal(LINK.open, undefined)
})

// ------------------------------------------------------------- adapter

test('adapter: user and picture as read; the picture only over https; nonsense users are none', async () => {
  assert.deepEqual(await adapter(sdkWithUser([])).user(), { username: 'Crazy.User_1', avatar: 'https://images.crazygames.com/a.png' })
  assert.equal(await adapter(sdkWithUser([], { user: null })).user(), null, 'logged out')
  assert.deepEqual(portalUserOf({ username: 'abcdef', profilePictureUrl: 'http://x/a.png' }), { username: 'abcdef', avatar: undefined })
  assert.deepEqual(portalUserOf({ username: 'abcdef', profilePictureUrl: 'javascript:alert(1)' }), { username: 'abcdef', avatar: undefined })
  assert.deepEqual(portalUserOf({ username: 'abcdef', profilePictureUrl: 'not a url' }), { username: 'abcdef', avatar: undefined })
  for (const raw of [null, undefined, 'user', {}, { username: '' }, { username: '   ' }, { username: 7 }]) assert.equal(portalUserOf(raw), null)
  // getUser rejecting reads as logged out.
  const failing = sdkWithUser([])
  ;(failing.user as CrazyUserModule).getUser = async () => { throw new Error('x') }
  assert.equal(await adapter(failing).user(), null)
})

test('adapter: a login reaches every onLogin listener (registered before or after ready); a null user is not a login', async () => {
  const calls: string[] = []
  const fake = sdkWithUser(calls)
  const sdk = adapter(fake)
  const heard: string[] = []
  sdk.onLogin(() => heard.push('early'))
  await sdk.ready
  sdk.onLogin(() => { throw new Error('a broken listener') })
  sdk.onLogin(() => heard.push('late'))
  assert.deepEqual(calls, ['addAuthListener'], 'one SDK listener')
  fake.login(null)
  assert.deepEqual(heard, [])
  fake.login({ username: 'Crazy.User_1' })
  assert.deepEqual(heard, ['early', 'late'])
  fake.login({ username: 'Crazy.User_1' })
  assert.equal(await sdk.authPrompt(), true)
  assert.deepEqual(heard, ['early', 'late'], 'told once a page (a logout reloads it)')
  // Unavailable accounts: no SDK listener at all.
  const none: string[] = []
  await adapter(sdkWithUser(none, { available: false })).ready
  assert.deepEqual(none, [])
})

test('adapter: a login through the modal tells onLogin even if the SDK never calls its listener', async () => {
  const sdk = adapter(sdkWithUser([]))
  let heard = 0
  sdk.onLogin(() => { heard++ })
  assert.equal(await sdk.authPrompt(), true)
  assert.equal(heard, 1)
  const cancelled = adapter(sdkWithUser([], { auth: async () => { throw Object.assign(new Error('x'), { code: 'userCancelled' }) } }))
  let none = 0
  cancelled.onLogin(() => { none++ })
  await cancelled.authPrompt()
  assert.equal(none, 0)
})

test('adapter: a logged-out user\'s token call is not warned (userNotAuthenticated is an answer)', async () => {
  const warnings: string[] = []
  const sdk = adapter(sdkWithUser([], { token: async () => { throw Object.assign(new Error('x'), { code: 'userNotAuthenticated' }) } }), warnings)
  assert.equal(await sdk.userToken(), null)
  assert.deepEqual(warnings, [])
})

test('adapter: the login modal answers true only for a user; a cancel is false', async () => {
  assert.equal(await adapter(sdkWithUser([])).authPrompt(), true)
  assert.equal(await adapter(sdkWithUser([], { auth: async () => { throw Object.assign(new Error('x'), { code: 'userCancelled' }) } })).authPrompt(), false)
  assert.equal(await adapter(sdkWithUser([], { auth: async () => null })).authPrompt(), false)
})

// --------------------------------------------------------- relogin, lobby

test('relogin: in the lobby a login reconnects at once; in a run it waits for the next lobby, once', () => {
  let reconnects = 0
  const relogin = new Relogin(() => { reconnects++ })
  relogin.login() // before any lobby: the page is still loading
  assert.equal(reconnects, 0)
  relogin.lobbyShown()
  assert.equal(reconnects, 1, 'the first lobby reconnects')
  relogin.lobbyShown() // the lobby the reconnect made
  relogin.login()
  assert.equal(reconnects, 2, 'in the lobby: at once')
  relogin.lobbyShown()
  relogin.lobbyLeft() // READY
  relogin.login() // mid-run
  relogin.login()
  assert.equal(reconnects, 2, 'not mid-run')
  relogin.lobbyShown() // after the run card
  assert.equal(reconnects, 3, 'once, after the run')
  relogin.lobbyShown()
  assert.equal(reconnects, 3)
})

test('lobby: Log in only where the portal has accounts and nobody is logged in', () => {
  const user = { username: 'Crazy.User_1', avatar: undefined }
  assert.equal(loginButtonShown({ accountsAvailable: () => true }, null), true)
  assert.equal(loginButtonShown({ accountsAvailable: () => true }, user), false)
  assert.equal(loginButtonShown({ accountsAvailable: () => false }, null), false)
  assert.equal(loginButtonShown(noPortalSdk(), null), false, 'off a portal: never')
})

test('lobby: the username and picture only for an account the server says is linked; else the callsign', () => {
  const user = { username: 'Crazy.User_1', avatar: 'https://images.crazygames.com/a.png' }
  const guest = { id: ID, offline: false, standing: undefined, loadouts: undefined }
  assert.equal(shownName(undefined, user), undefined, 'hidden until announced')
  assert.deepEqual(shownName({ ...guest, portal: 'crazygames' }, user), { text: 'Crazy.User_1', avatar: user.avatar, portal: true })
  // CRAZYGAMES_GAME_ID unset: the server never links, the player is a guest to everyone.
  assert.deepEqual(shownName(guest, user), { text: callsign(ID), avatar: undefined, portal: false })
  assert.deepEqual(shownName({ ...guest, portal: 'crazygames' }, null), { text: callsign(ID), avatar: undefined, portal: false })
  assert.deepEqual(shownName({ ...guest, offline: true, portal: 'crazygames' }, user)?.portal, false)
})
