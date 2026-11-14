import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type CrazySdk, crazyGamesSdk } from '../../../../plunder-land-client/src/portal/crazygames'
import { noPortalSdk } from '../../../../plunder-land-client/src/portal/none'
import { pickPortalSdk } from '../../../../plunder-land-client/src/portal/pick'
import { type PortalSdk } from '../../../../plunder-land-client/src/portal/adapter'
import { OFFLINE_LINE, applyOfflineMode, lobbyContext, runContext, seedInputMode, touchForDevice } from '../../../../plunder-land-client/src/portal/platform'
import { HAPPY_KEY, Happy, type HappyStorage } from '../../../../plunder-land-client/src/portal/happy'
import { NOTICE_KEY, markPrivacyNoticeSeen, privacyNoticeShown } from '../../../../plunder-land-client/src/portal/notice'
import { INPUT_MODE, installInputMode, seedTouchMode } from '../../../../plunder-land-client/src/input/inputmode'
import { needsResume } from '../../../../plunder-land-client/src/audio/sfx'
import { io } from '../../../../plunder-land-client/node_modules/socket.io-client'

/**
 * CrazyGames platform fit (g2-6f, decision #62): the device type seeding the
 * input mode, an offline launch, the feedback context, happytime only on the
 * level-up and the first extraction (Q5), the new-player privacy notice (Q6),
 * iOS's interrupted audio, and the safe-area variables. Fake SDKs; the browser
 * wiring (`index.ts`, `game.ts`, the lobby) is not run here.
 */

const CLIENT_SRC = join(__dirname, '..', '..', '..', '..', 'plunder-land-client', 'src')

interface FakeOptions {
  environment?: string
  device?: unknown
  offline?: boolean
  /** No g2-6f members at all (an older SDK). */
  bare?: boolean
}

/** A fake `window.CrazyGames.SDK` recording each call; `args` keeps what the context calls were given. */
function fakeSdk (calls: string[], args: unknown[] = [], options: FakeOptions = {}): CrazySdk {
  const call = (name: string) => () => { calls.push(name) }
  const game: CrazySdk['game'] = {
    loadingStart: call('loadingStart'),
    loadingStop: call('loadingStop'),
    gameplayStart: call('gameplayStart'),
    gameplayStop: call('gameplayStop'),
    settings: {},
    addSettingsChangeListener: () => {}
  }
  if (options.bare !== true) {
    game.isOfflineMode = options.offline ?? false
    game.updateRoom = (room) => { calls.push('updateRoom'); args.push(room) }
    game.setGameContext = (context) => { calls.push('setGameContext'); args.push(context) }
    game.clearGameContext = call('clearGameContext')
    game.happytime = call('happytime')
  }
  const sdk: CrazySdk = { init: async () => {}, environment: options.environment ?? 'crazygames', game }
  if (options.device !== undefined) {
    sdk.user = {
      isUserAccountAvailable: false,
      systemInfo: { device: { type: options.device } },
      getUser: async () => null,
      getUserToken: async () => '',
      addAuthListener: () => {},
      showAuthPrompt: async () => null,
      showAccountLinkPrompt: async () => null
    }
  }
  return sdk
}

function crazy (calls: string[], args: unknown[], options: FakeOptions, warnings: string[] = []): PortalSdk {
  return crazyGamesSdk(async () => fakeSdk(calls, args, options), { log: () => {}, warn: (l) => warnings.push(l) })
}

// ------------------------------------------------------------ device type

test('device: mobile and tablet start in touch mode, desktop in desktop mode, anything else keeps the guess', () => {
  assert.equal(touchForDevice('mobile'), true)
  assert.equal(touchForDevice('tablet'), true)
  assert.equal(touchForDevice('desktop'), false)
  assert.equal(touchForDevice(undefined), undefined)
})

test('device: the CrazyGames SDK\'s systemInfo is read once it is ready, whether or not accounts are available', async () => {
  for (const [device, want] of [['mobile', 'mobile'], ['tablet', 'tablet'], ['desktop', 'desktop'], ['watch', undefined], [42, undefined]] as const) {
    const sdk = crazy([], [], { device })
    assert.equal(sdk.deviceType(), undefined, 'nothing before ready')
    await sdk.ready
    assert.equal(sdk.deviceType(), want, String(device))
  }
  const noUser = crazy([], [], {})
  await noUser.ready
  assert.equal(noUser.deviceType(), undefined, 'an SDK without the user module: no device')
})

test('device: seeds the mode on CrazyGames only; off it (web, itch, the SDK disabled) nothing is seeded', async () => {
  const seeded: boolean[] = []
  assert.equal(await seedInputMode(crazy([], [], { device: 'mobile' }), (t) => seeded.push(t)), true)
  assert.equal(await seedInputMode(crazy([], [], { device: 'desktop' }), (t) => seeded.push(t)), false)
  assert.deepEqual(seeded, [true, false])
  for (const sdk of [noPortalSdk(), pickPortalSdk('web', async () => undefined), pickPortalSdk('itch', async () => undefined),
    crazy([], [], { device: 'mobile', environment: 'disabled' })]) {
    assert.equal(await seedInputMode(sdk, (t) => seeded.push(t)), undefined)
  }
  assert.deepEqual(seeded, [true, false], 'no seed off CrazyGames')
})

test('device: a seed sets the starting mode, but once a press has decided (#59) a seed changes nothing', () => {
  type Listener = (event: { pointerType: string }) => void
  let press: Listener | undefined
  const target = {
    matchMedia: () => ({ matches: true }),
    addEventListener: (_type: string, l: Listener) => { press = l }
  }
  installInputMode(target as unknown as Window)
  assert.equal(INPUT_MODE.touch, true, 'the coarse-pointer guess')
  assert.equal(seedTouchMode(false), true)
  assert.equal(INPUT_MODE.touch, false, 'the portal says desktop')
  press?.({ pointerType: 'touch' })
  assert.equal(INPUT_MODE.touch, true, 'a touch press decides')
  assert.equal(seedTouchMode(false), false, 'a seed after a press is ignored')
  assert.equal(INPUT_MODE.touch, true)
  press?.({ pointerType: 'mouse' })
  assert.equal(INPUT_MODE.touch, false, 'presses still decide after')
})

// ------------------------------------------------------------ offline

test('offline: isOfflineMode is read once ready, and the room is reported not joinable once', async () => {
  const calls: string[] = []
  const args: unknown[] = []
  const sdk = crazy(calls, args, { offline: true })
  assert.equal(sdk.offline(), false, 'false before ready')
  await sdk.ready
  assert.equal(sdk.offline(), true)
  assert.deepEqual(calls.filter((c) => c === 'updateRoom'), ['updateRoom'])
  assert.deepEqual(args, [{ isJoinable: false }])

  const online: string[] = []
  const on = crazy(online, [], { offline: false })
  await on.ready
  assert.equal(on.offline(), false)
  assert.ok(!online.includes('updateRoom'), 'an online launch reports no room')

  for (const sdk of [noPortalSdk(), crazy([], [], { offline: true, environment: 'disabled' })]) {
    await sdk.ready
    assert.equal(sdk.offline(), false, 'never offline off CrazyGames')
  }
})

test('offline: no more socket attempts once the SDK says offline, and the lobby shows; online nothing changes', async () => {
  const done: string[] = []
  const socket = {
    io: { reconnection: (on: boolean) => { done.push(`reconnection ${String(on)}`) } },
    disconnect: () => { done.push('disconnect') }
  }
  assert.equal(await applyOfflineMode(crazy([], [], { offline: true }), socket, () => { done.push('lobby') }), true)
  assert.deepEqual(done, ['reconnection false', 'disconnect', 'lobby'])
  done.length = 0
  assert.equal(await applyOfflineMode(crazy([], [], { offline: false }), socket, () => { done.push('lobby') }), false)
  assert.equal(await applyOfflineMode(noPortalSdk(), socket, () => { done.push('lobby') }), false)
  assert.deepEqual(done, [])
  assert.match(OFFLINE_LINE, /internet connection/)
})

test('offline: a real socket.io client to nowhere makes no attempt after the offline answer', async () => {
  // Port 9 (discard) on loopback: nothing listens, every attempt fails at once.
  const socket = io('http://127.0.0.1:9', { transports: ['websocket'], reconnectionDelay: 20, reconnectionDelayMax: 20, randomizationFactor: 0 })
  let attempts = 0
  socket.io.on('reconnect_attempt', () => { attempts++ })
  try {
    // The SDK settles after the first attempt has failed, as on a slow init.
    await new Promise<void>((resolve) => { socket.once('connect_error', () => { resolve() }) })
    const sdk = crazy([], [], { offline: true })
    await applyOfflineMode(sdk, socket, () => {})
    const before = attempts
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(attempts, before, `attempts after the offline answer: ${attempts - before}`)
    assert.equal(socket.active, false)
  } finally {
    socket.close()
  }
})

// ------------------------------------------------------------ game context

test('context: a run\'s is { layer, robot, level, protocol, build } as strings; unknowns are left out', () => {
  assert.deepEqual(runContext({ layer: 3, robot: 'peep', level: 14, protocol: 11, build: 'abc1234' }),
    { layer: '3', robot: 'peep', level: '14', protocol: '11', build: 'abc1234' })
  assert.deepEqual(runContext({ layer: undefined, robot: undefined, level: Number.NaN, protocol: 11, build: ' ' }), { protocol: '11' })
  assert.deepEqual(lobbyContext({ layer: 2, robot: 'peep', level: 1, protocol: 11, build: 'dev' }), { protocol: '11', build: 'dev', level: '1' })
  for (const context of [runContext({ layer: 5, robot: 'waddle', level: 30, protocol: 11, build: 'dev' }), lobbyContext({ protocol: 11, build: 'dev' })]) {
    for (const value of Object.values(context)) assert.ok(typeof value === 'string' && value.length > 0)
  }
})

test('context: set and clear reach CrazyGames in order (a call before ready waits), copied; off it nothing is called', async () => {
  const calls: string[] = []
  const args: unknown[] = []
  const sdk = crazy(calls, args, {})
  const context = { protocol: '11', build: 'dev', level: '3' }
  sdk.setContext(context)
  context.level = 'changed later'
  await sdk.ready
  sdk.clearContext()
  sdk.setContext({ layer: '2', protocol: '11', build: 'dev' })
  assert.deepEqual(calls.filter((c) => c.endsWith('Context')), ['setGameContext', 'clearGameContext', 'setGameContext'])
  assert.deepEqual(args, [{ protocol: '11', build: 'dev', level: '3' }, { layer: '2', protocol: '11', build: 'dev' }])

  const disabled: string[] = []
  const off = crazy(disabled, [], { environment: 'disabled' })
  off.setContext({ protocol: '11' })
  off.clearContext()
  off.happytime()
  await off.ready
  assert.deepEqual(disabled, [], 'the SDK disabled: nothing is called')
})

test('context: an SDK without the g2-6f methods is warned once per method and never throws into the game', async () => {
  const warnings: string[] = []
  const sdk = crazy([], [], { bare: true }, warnings)
  await sdk.ready
  for (let i = 0; i < 3; i++) {
    sdk.setContext({ protocol: '11' })
    sdk.clearContext()
    sdk.happytime()
  }
  assert.equal(sdk.offline(), false)
  assert.equal(warnings.length, 3, warnings.join('\n'))
})

// ------------------------------------------------------------ happytime

function memoryStorage (): HappyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

test('happytime: on a level-up and on the account\'s first extraction ever, once per run end, nothing else', () => {
  let n = 0
  const storage = memoryStorage()
  const happy = new Happy({ happytime: () => { n++ } }, () => storage)
  happy.runStarted()
  happy.progress(false)
  happy.extracted(undefined)
  happy.extracted('')
  assert.equal(n, 0, 'no level-up, no account: nothing')
  happy.extracted('acc1')
  assert.equal(n, 1, 'the first extraction')
  happy.progress(true)
  assert.equal(n, 1, 'a level-up at the same run end: still one')
  happy.runStarted()
  happy.extracted('acc1')
  assert.equal(n, 1, 'a second extraction: nothing')
  happy.progress(true)
  assert.equal(n, 2, 'a level-up on a later run')
  happy.runStarted()
  happy.extracted('acc2')
  assert.equal(n, 3, 'another account\'s first')
  assert.deepEqual(JSON.parse(storage.data.get(HAPPY_KEY) ?? '[]'), ['acc1', 'acc2'])
})

test('happytime: storage missing, unreadable or refusing a write celebrates no extraction (never repeatedly)', () => {
  let n = 0
  const sdk = { happytime: () => { n++ } }
  new Happy(sdk, () => undefined).extracted('acc1')
  new Happy(sdk, () => ({ getItem: () => { throw new Error('no') }, setItem: () => {} })).extracted('acc1')
  new Happy(sdk, () => ({ getItem: () => null, setItem: () => { throw new Error('full') } })).extracted('acc1')
  assert.equal(n, 0)
  const garbled = memoryStorage()
  garbled.data.set(HAPPY_KEY, '{not json')
  new Happy(sdk, () => garbled).extracted('acc1')
  assert.equal(n, 1, 'a garbled record starts over')
})

test('happytime: the client calls it only through Happy, and never reportGameCompletedPercentage (Q5)', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) files.push(path)
    }
  }
  walk(CLIENT_SRC)
  const callers: string[] = []
  for (const file of files) {
    // Code only: a comment may name it to say it isn't called.
    const text = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    assert.ok(!text.includes('reportGameCompletedPercentage'), file)
    if (/\.happytime\(\)|\bhappytime\(\)/.test(text)) callers.push(file.slice(CLIENT_SRC.length + 1))
  }
  assert.deepEqual(callers.sort(), ['portal/adapter.ts', 'portal/happy.ts'])
})

// ------------------------------------------------------------ privacy notice

test('notice: shown with no token and not seen; gone once a token is stored or READY was pressed; storage that throws shows it', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
  assert.equal(privacyNoticeShown(storage, 'plunderland_token'), true)
  markPrivacyNoticeSeen(storage)
  assert.equal(data.get(NOTICE_KEY), '1')
  assert.equal(privacyNoticeShown(storage, 'plunderland_token'), false)
  data.clear()
  data.set('plunderland_token', 'x'.repeat(43))
  assert.equal(privacyNoticeShown(storage, 'plunderland_token'), false, 'a player who has played here')
  const throwing = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
  assert.equal(privacyNoticeShown(throwing, 'plunderland_token'), true)
  assert.equal(privacyNoticeShown(undefined, 'plunderland_token'), true)
  markPrivacyNoticeSeen(throwing)
  markPrivacyNoticeSeen(undefined)
})

// ------------------------------------------------------------ audio, safe areas

test('audio: a press resumes any state but running (iOS\'s interrupted included) on a visible page, never a closed one', () => {
  assert.equal(needsResume('suspended', false), true)
  assert.equal(needsResume('interrupted', false), true)
  assert.equal(needsResume('running', false), false)
  assert.equal(needsResume('closed', false), false)
  assert.equal(needsResume('interrupted', true), false, 'a hidden page waits')
})

test('safe areas: no bare env(safe-area-inset-*) in the client; each is the fallback of CrazyGames\' variable', () => {
  const bare: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (!path.endsWith('.ts')) continue
      // Code only: a comment may name env() to explain it.
      const code = readFileSync(path, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      const wrapped = code.replace(/var\(--safe-area-inset-(top|right|bottom|left), env\(safe-area-inset-\1, 0px\)\)/g, '')
      if (wrapped.includes('env(safe-area-inset')) bare.push(path.slice(CLIENT_SRC.length + 1))
    }
  }
  walk(CLIENT_SRC)
  assert.deepEqual(bare, [])
})
