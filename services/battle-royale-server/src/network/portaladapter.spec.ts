import test from 'node:test'
import assert from 'node:assert/strict'
import { pickPortalSdk } from '../../../../plunder-land-client/src/portal/pick'
import { type CrazySdk, crazyGamesSdk } from '../../../../plunder-land-client/src/portal/crazygames'
import { withGameplayState } from '../../../../plunder-land-client/src/portal/adapter'
import { masterGain } from '../../../../plunder-land-client/src/audio/sfx'

/**
 * The portal adapter (decision #62, g2-6a): which implementation a portal
 * gets, and that the CrazyGames one never throws and never calls an SDK it
 * can't use. The browser parts (the script tag, the wiring in `game.ts` and
 * `index.ts`) are not run here.
 */

interface FakeOptions {
  environment?: string
  init?: () => Promise<void>
  /** Every game method throws. */
  throwing?: boolean
  muteAudio?: boolean
}

/** A fake `window.CrazyGames.SDK` that records each call by name. */
function fakeSdk (calls: string[], options: FakeOptions = {}): CrazySdk & { change: (muteAudio: boolean) => void } {
  let listener: ((settings: { muteAudio?: boolean }) => void) | undefined
  const call = (name: string) => () => {
    calls.push(name)
    if (options.throwing === true) throw new Error(`${name} threw`)
  }
  return {
    init: options.init ?? (async () => { calls.push('init') }),
    environment: options.environment ?? 'crazygames',
    game: {
      loadingStart: call('loadingStart'),
      loadingStop: call('loadingStop'),
      gameplayStart: call('gameplayStart'),
      gameplayStop: call('gameplayStop'),
      settings: { muteAudio: options.muteAudio ?? false },
      addSettingsChangeListener: (l) => {
        calls.push('addSettingsChangeListener')
        if (options.throwing === true) throw new Error('addSettingsChangeListener threw')
        listener = l
      }
    },
    change: (muteAudio) => { listener?.({ muteAudio }) }
  }
}

/**
 * Every adapter method called once, as the game would. `blocked`: the SDK
 * script didn't load, which the rewarded ad reports as an ad blocker (g2-6d).
 */
async function callEverything (sdk: ReturnType<typeof pickPortalSdk>, blocked = false): Promise<void> {
  sdk.loadingStop()
  sdk.gameplayStart()
  sdk.gameplayStop()
  sdk.onMute(() => {})
  sdk.onLogin(() => {})
  assert.equal(await sdk.user(), null)
  assert.equal(await sdk.userToken(), null)
  assert.equal(await sdk.linkPrompt(), false)
  assert.equal(await sdk.rewardedAd(), blocked ? 'adblock' : 'unavailable')
  assert.equal(sdk.adsAvailable(), false)
  assert.equal(sdk.adBlocked(), blocked)
}

test('pick: no SDK script for web, itch or anything else; CrazyGames loads it once', async () => {
  for (const portal of ['web', 'itch', 'other', 'poki', '']) {
    let loads = 0
    const sdk = pickPortalSdk(portal, async () => { loads++; return undefined })
    await sdk.ready
    await callEverything(sdk)
    assert.equal(loads, 0, `${portal} loaded the CrazyGames script`)
  }
  let loads = 0
  const sdk = pickPortalSdk('crazygames', async () => { loads++; return undefined })
  await sdk.ready
  assert.equal(loads, 1)
})

test('guard: an SDK whose every method throws never throws into the game, and warns once per method', async () => {
  const calls: string[] = []
  const warnings: string[] = []
  const sdk = withGameplayState(crazyGamesSdk(async () => fakeSdk(calls, { throwing: true }), { warn: (l) => warnings.push(l), log: () => {} }))
  await sdk.ready
  await callEverything(sdk)
  sdk.gameplayStart()
  sdk.gameplayStop()
  assert.deepEqual(calls, ['init', 'loadingStart', 'addSettingsChangeListener', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart', 'gameplayStop'], 'the calls were still made')
  assert.equal(warnings.length, 5, `one warning per method: ${warnings.join(' | ')}`)
})

test('guard: init or the environment throwing, a missing script, or another environment: the SDK is never called', async () => {
  const cases: Array<[string, (calls: string[]) => Promise<CrazySdk | undefined>]> = [
    ['init rejects', async (calls) => fakeSdk(calls, { init: async () => { throw new Error('init') } })],
    ['init throws synchronously', async (calls) => fakeSdk(calls, { init: () => { throw new Error('init') } })],
    ['environment disabled', async (calls) => fakeSdk(calls, { environment: 'disabled', throwing: true })],
    ['environment unknown', async (calls) => fakeSdk(calls, { environment: 'elsewhere' })],
    ['environment getter throws', async (calls) => Object.defineProperty(fakeSdk(calls), 'environment', { get: () => { throw new Error('env') } })],
    ['script blocked', async () => undefined],
    ['load rejects', async () => { throw new Error('load') }]
  ]
  for (const [name, load] of cases) {
    const calls: string[] = []
    const warnings: string[] = []
    const sdk = withGameplayState(crazyGamesSdk(async () => await load(calls), { warn: (l) => warnings.push(l), log: () => {} }))
    sdk.loadingStop()
    sdk.gameplayStart()
    await sdk.ready
    await callEverything(sdk, name === 'script blocked')
    assert.deepEqual(calls.filter((c) => c !== 'init'), [], `${name}: the SDK was called`)
    assert.deepEqual(warnings, [], `${name}: warned`)
  }
})

test('timeout: an init that never answers gives up after the timeout; the game is not held', async () => {
  const calls: string[] = []
  const sdk = crazyGamesSdk(async () => fakeSdk(calls, { init: async () => await new Promise<void>(() => {}) }), { timeoutMs: 20, log: () => {} })
  const started = Date.now()
  sdk.loadingStop()
  await sdk.ready
  assert.ok(Date.now() - started < 1000, 'ready waited past the timeout')
  sdk.gameplayStart()
  assert.deepEqual(calls, [], 'a call reached an SDK that never initialised')
})

test('local: calls made before ready reach the SDK in order, a handoff sends no second start, and each is logged', async () => {
  const calls: string[] = []
  const logged: string[] = []
  const sdk = withGameplayState(crazyGamesSdk(async () => fakeSdk(calls, { environment: 'local' }), { log: (l) => logged.push(l) }))
  sdk.loadingStop()
  sdk.loadingStop()
  sdk.gameplayStop() // the first lobby: nothing to stop
  sdk.gameplayStart()
  sdk.gameplayStart() // a handoff's hello
  await sdk.ready
  sdk.gameplayStop() // the run card
  sdk.gameplayStop() // the lobby after it
  sdk.gameplayStart() // the next run
  assert.deepEqual(calls, ['init', 'loadingStart', 'addSettingsChangeListener', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart'])
  assert.deepEqual(logged, ['loadingStart', 'settings', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart'].map((n) => `portal sdk: ${n}`))
})

test('mute: the portal\'s muteAudio at init and on each change reaches the listener; the volume is restored after', async () => {
  const calls: string[] = []
  const fake = fakeSdk(calls, { muteAudio: true })
  const sdk = crazyGamesSdk(async () => fake, { log: () => {} })
  const early: boolean[] = []
  sdk.onMute((m) => early.push(m))
  await sdk.ready
  assert.deepEqual(early, [true], 'muted at init')
  const late: boolean[] = []
  sdk.onMute((m) => late.push(m))
  assert.deepEqual(late, [true], 'a listener added while muted hears it at once')
  fake.change(false)
  fake.change(false)
  fake.change(true)
  assert.deepEqual(early, [true, false, true], 'only changes')
  assert.deepEqual(late, [true, false, true])

  // Sfx's side: silent while muted at every level, the level's gain after.
  for (const level of [0, 1, 2, 3] as const) assert.equal(masterGain(level, true), 0)
  assert.deepEqual([0, 1, 2, 3].map((l) => masterGain(l as 0 | 1 | 2 | 3, false)), [0, 0.35, 0.65, 1])
})

test('mute: an unmuted portal never calls the listener', async () => {
  const sdk = crazyGamesSdk(async () => fakeSdk([], { muteAudio: false }), { log: () => {} })
  const heard: boolean[] = []
  sdk.onMute((m) => heard.push(m))
  await sdk.ready
  sdk.onMute((m) => heard.push(m))
  assert.deepEqual(heard, [])
})
