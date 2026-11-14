import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AD_MAX_MS, type CrazyAdModule, type CrazySdk, crazyGamesSdk } from '../../../../plunder-land-client/src/portal/crazygames'
import { withGameplayState } from '../../../../plunder-land-client/src/portal/adapter'
import { noPortalSdk } from '../../../../plunder-land-client/src/portal/none'
import { grantAnswerOf, refillNote, watchForPlays, type GrantAnswer } from '../../../../plunder-land-client/src/portal/adrefill'
import { adOffer, clockOf, onEnergy } from '../../../../plunder-land-client/src/net/energy'

/**
 * The rewarded ad through the portal adapter, and the refill's client flow
 * (g2-6d; CrazyGames' /sdk/video-ads and /requirements/ads, read
 * 2026-11-13): only `adFinished` rewards; every `adError` code reads as
 * something else; the sound is muted from `adStarted`, not the request, to
 * the end; one request at a time; `adsDisabled` ends ads for the page; an ad
 * blocker is reported, never rewarded. The server side is adrefill.spec.ts.
 */

type Callbacks = Parameters<CrazyAdModule['requestAd']>[1]

/** A fake SDK whose ad module records each request and lets the test answer it. */
function fakeSdk (options: { environment?: string, muteAudio?: boolean, hasAdblock?: () => Promise<boolean>, requestThrows?: boolean, noAd?: boolean } = {}): {
  sdk: CrazySdk
  requests: Callbacks[]
} {
  const requests: Callbacks[] = []
  const ad: CrazyAdModule = {
    requestAd: (type, callbacks) => {
      assert.equal(type, 'rewarded', 'an ad other than rewarded was requested')
      if (options.requestThrows === true) throw new Error('requestAd threw')
      requests.push(callbacks)
    }
  }
  if (options.hasAdblock !== undefined) ad.hasAdblock = options.hasAdblock
  const sdk: CrazySdk = {
    init: async () => {},
    environment: options.environment ?? 'crazygames',
    game: {
      loadingStart: () => {},
      loadingStop: () => {},
      gameplayStart: () => {},
      gameplayStop: () => {},
      settings: { muteAudio: options.muteAudio ?? false },
      addSettingsChangeListener: () => {}
    }
  }
  if (options.noAd !== true) sdk.ad = ad
  return { sdk, requests }
}

const quiet = { warn: () => {}, log: () => {} }

async function settle (): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('adFinished is the only reward; every adError code reads as something else', async () => {
  const cases: Array<[unknown, string]> = [
    [{ code: 'unfilled', message: 'No ad available' }, 'unavailable'],
    [{ code: 'adCooldown' }, 'unavailable'],
    [{ code: 'adblock' }, 'adblock'],
    [{ code: 'other' }, 'failed'],
    [{ code: 'somethingNew' }, 'failed'],
    [undefined, 'failed'],
    ['unfilled', 'failed'],
    [{ code: 'adsDisabled', message: 'Basic Launch' }, 'unavailable']
  ]
  for (const [error, expected] of cases) {
    const { sdk, requests } = fakeSdk()
    const portal = withGameplayState(crazyGamesSdk(async () => sdk, quiet))
    await portal.ready
    assert.equal(portal.adsAvailable(), true)
    const pending = portal.rewardedAd()
    await settle()
    assert.equal(requests.length, 1)
    requests[0].adStarted?.()
    requests[0].adError?.(error)
    // A late adFinished after an error rewards nothing.
    requests[0].adFinished?.()
    assert.equal(await pending, expected, JSON.stringify(error))
  }
  const { sdk, requests } = fakeSdk()
  const portal = crazyGamesSdk(async () => sdk, quiet)
  const pending = portal.rewardedAd()
  await settle()
  requests[0].adStarted?.()
  requests[0].adFinished?.()
  // A late error after the reward changes nothing.
  requests[0].adError?.({ code: 'other' })
  assert.equal(await pending, 'rewarded')
})

test('adsDisabled: no ads for the rest of the page; the SDK is never asked again', async () => {
  const { sdk, requests } = fakeSdk()
  const portal = crazyGamesSdk(async () => sdk, quiet)
  const first = portal.rewardedAd()
  await settle()
  requests[0].adError?.({ code: 'adsDisabled' })
  assert.equal(await first, 'unavailable')
  assert.equal(portal.adsAvailable(), false)
  assert.equal(await portal.rewardedAd(), 'unavailable')
  assert.equal(requests.length, 1, 'the SDK was asked again after adsDisabled')
  // unfilled is not adsDisabled: ads stay available.
  const other = fakeSdk()
  const again = crazyGamesSdk(async () => other.sdk, quiet)
  const p = again.rewardedAd()
  await settle()
  other.requests[0].adError?.({ code: 'unfilled' })
  await p
  assert.equal(again.adsAvailable(), true)
})

test('mute: from adStarted (not the request) until the end; a portal mute already on stays on', async () => {
  for (const end of ['finished', 'error'] as const) {
    const { sdk, requests } = fakeSdk()
    const portal = withGameplayState(crazyGamesSdk(async () => sdk, quiet))
    const heard: boolean[] = []
    portal.onMute((m) => { heard.push(m) })
    await portal.ready
    const pending = portal.rewardedAd()
    await settle()
    assert.deepEqual(heard, [], 'muted at the request')
    requests[0].adStarted?.()
    assert.deepEqual(heard, [true])
    if (end === 'finished') requests[0].adFinished?.()
    else requests[0].adError?.({ code: 'other' })
    await pending
    assert.deepEqual(heard, [true, false], `not unmuted after ${end}`)
  }
  // An error before the ad started: never muted.
  const quietAd = fakeSdk()
  const unstarted = crazyGamesSdk(async () => quietAd.sdk, quiet)
  const told: boolean[] = []
  unstarted.onMute((m) => { told.push(m) })
  const p = unstarted.rewardedAd()
  await settle()
  quietAd.requests[0].adError?.({ code: 'unfilled' })
  await p
  assert.deepEqual(told, [])
  // The portal muted the game already: the ad changes nothing the listener hears.
  const muted = fakeSdk({ muteAudio: true })
  const portal = crazyGamesSdk(async () => muted.sdk, quiet)
  const heard: boolean[] = []
  portal.onMute((m) => { heard.push(m) })
  await portal.ready
  const q = portal.rewardedAd()
  await settle()
  muted.requests[0].adStarted?.()
  muted.requests[0].adFinished?.()
  await q
  assert.deepEqual(heard, [true])
})

test('one request at a time: a second call while one is pending gets the same answer, and the SDK is asked once', async () => {
  const { sdk, requests } = fakeSdk()
  const portal = withGameplayState(crazyGamesSdk(async () => sdk, quiet))
  const a = portal.rewardedAd()
  const b = portal.rewardedAd()
  await settle()
  assert.equal(requests.length, 1)
  requests[0].adFinished?.()
  assert.deepEqual(await Promise.all([a, b]), ['rewarded', 'rewarded'])
  // Once it ended, the next click is a new request.
  const c = portal.rewardedAd()
  await settle()
  assert.equal(requests.length, 2)
  requests[1].adError?.({ code: 'unfilled' })
  assert.equal(await c, 'unavailable')
})

test('ad blockers: a blocked SDK script, hasAdblock, or an adblock answer report it; never a reward', async () => {
  // The script didn't load (onerror resolves no SDK).
  const blocked = crazyGamesSdk(async () => undefined, quiet)
  await blocked.ready
  assert.equal(blocked.adBlocked(), true)
  assert.equal(blocked.adsAvailable(), false)
  assert.equal(await blocked.rewardedAd(), 'adblock')
  // Another environment (our own site with ?portal=crazygames): no SDK, no blocker.
  const disabled = fakeSdk({ environment: 'disabled' })
  const off = crazyGamesSdk(async () => disabled.sdk, quiet)
  await off.ready
  assert.equal(off.adBlocked(), false)
  assert.equal(off.adsAvailable(), false)
  assert.equal(await off.rewardedAd(), 'unavailable')
  assert.equal(disabled.requests.length, 0)
  // The portal's own check.
  const checked = fakeSdk({ hasAdblock: async () => true })
  const withCheck = crazyGamesSdk(async () => checked.sdk, quiet)
  await withCheck.ready
  await settle()
  assert.equal(withCheck.adBlocked(), true)
  const clean = fakeSdk({ hasAdblock: async () => false })
  const noBlocker = crazyGamesSdk(async () => clean.sdk, quiet)
  await noBlocker.ready
  await settle()
  assert.equal(noBlocker.adBlocked(), false)
  // A check that rejects throws nothing into the game.
  const broken = fakeSdk({ hasAdblock: async () => { throw new Error('nope') } })
  const brokenCheck = crazyGamesSdk(async () => broken.sdk, quiet)
  await brokenCheck.ready
  await settle()
  assert.equal(brokenCheck.adBlocked(), false)
})

test('an SDK without an ad module, or whose requestAd throws: unavailable or failed, nothing thrown, the sound back', async () => {
  const noAd = fakeSdk({ noAd: true })
  const portal = crazyGamesSdk(async () => noAd.sdk, quiet)
  await portal.ready
  assert.equal(portal.adsAvailable(), false)
  assert.equal(await portal.rewardedAd(), 'unavailable')
  const throwing = fakeSdk({ requestThrows: true })
  const warnings: string[] = []
  const other = crazyGamesSdk(async () => throwing.sdk, { log: () => {}, warn: (l) => warnings.push(l) })
  const heard: boolean[] = []
  other.onMute((m) => { heard.push(m) })
  assert.equal(await other.rewardedAd(), 'failed')
  assert.equal(await other.rewardedAd(), 'failed')
  assert.equal(warnings.length, 1, 'warned more than once')
  assert.deepEqual(heard, [])
})

test(`an SDK that never calls back: failed after AD_MAX_MS (${AD_MAX_MS} ms), the sound back, and a late adFinished rewards nothing`, async (t) => {
  const { sdk, requests } = fakeSdk()
  const portal = crazyGamesSdk(async () => sdk, quiet)
  await portal.ready
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const heard: boolean[] = []
  portal.onMute((m) => { heard.push(m) })
  const pending = portal.rewardedAd()
  await settle()
  requests[0].adStarted?.()
  t.mock.timers.tick(AD_MAX_MS - 1)
  await settle()
  let done = false
  void pending.then(() => { done = true })
  await settle()
  assert.equal(done, false)
  t.mock.timers.tick(1)
  assert.equal(await pending, 'failed')
  requests[0].adFinished?.()
  assert.deepEqual(heard, [true, false])
})

test('off CrazyGames (the no-op): never an ad, no blocker, nothing to show', async () => {
  const none = withGameplayState(noPortalSdk())
  assert.equal(await none.rewardedAd(), 'unavailable')
  assert.equal(none.adsAvailable(), false)
  assert.equal(none.adBlocked(), false)
})

test('the click: only rewarded asks the server; every outcome is reported once; the answers read as the lobby\'s notes', async () => {
  for (const result of ['unavailable', 'adblock', 'failed'] as const) {
    const reported: string[] = []
    let asked = 0
    const outcome = await watchForPlays({ sdk: { rewardedAd: async () => result }, report: (r) => { reported.push(r) }, askGrant: async () => { asked++; return { ok: true } } })
    assert.equal(outcome, result)
    assert.deepEqual(reported, [result])
    assert.equal(asked, 0, `${result} asked for a refill`)
  }
  const answers: Array<[GrantAnswer | undefined, string]> = [
    [{ ok: true }, 'refilled'],
    [{ ok: false, reason: 'cooldown' }, 'limit'],
    [{ ok: false, reason: 'daily_cap' }, 'limit'],
    [{ ok: false, reason: 'plays_left' }, 'limit'],
    [{ ok: false, reason: 'error' }, 'refused'],
    [{ ok: false, reason: 'off' }, 'refused'],
    [undefined, 'no_answer']
  ]
  for (const [answer, expected] of answers) {
    const reported: string[] = []
    const outcome = await watchForPlays({ sdk: { rewardedAd: async () => 'rewarded' }, report: (r) => { reported.push(r) }, askGrant: async () => answer })
    assert.equal(outcome, expected, JSON.stringify(answer))
    assert.deepEqual(reported, ['rewarded'])
  }
  // Throws anywhere read as failures, never a rejection.
  assert.equal(await watchForPlays({ sdk: { rewardedAd: async () => { throw new Error('x') } }, report: () => { throw new Error('y') }, askGrant: async () => ({ ok: true }) }), 'failed')
  assert.equal(await watchForPlays({ sdk: { rewardedAd: async () => 'rewarded' }, report: () => {}, askGrant: async () => { throw new Error('z') } }), 'no_answer')
  assert.equal(refillNote('refilled'), 'Plays refilled')
  assert.equal(refillNote('unavailable'), 'No ad right now, try again later')
  assert.equal(refillNote('adblock'), 'Ads are blocked')
  assert.equal(refillNote('no_answer'), 'Couldn\'t add plays, try again later')
  assert.equal(refillNote('limit'), undefined)
  assert.deepEqual(grantAnswerOf({ ok: false, reason: 'cooldown' }), { ok: false, reason: 'cooldown' })
  assert.deepEqual(grantAnswerOf({ ok: true }), { ok: true })
  assert.equal(grantAnswerOf({ ok: 'yes' }), undefined)
  assert.equal(grantAnswerOf(null), undefined)
})

test('client: energy.adRefill is read when well formed, dropped (not the view) when not; the lobby\'s offer counts forward', () => {
  const base = { stock: 0, cap: 3, nextInMs: 30 * 60_000, regenMs: 30 * 60_000 }
  assert.deepEqual(onEnergy(base), base, 'an old server\'s view')
  assert.deepEqual(onEnergy({ ...base, adRefill: { offered: true } })?.adRefill, { offered: true })
  assert.deepEqual(onEnergy({ ...base, adRefill: { offered: false, nextInMs: 5000 } })?.adRefill, { offered: false, nextInMs: 5000 })
  assert.deepEqual(onEnergy({ ...base, adRefill: { offered: 'yes' } }), base)
  assert.deepEqual(onEnergy({ ...base, adRefill: { offered: false, nextInMs: -1 } })?.adRefill, { offered: false })
  // Offered: the button, until a play has regenerated.
  const offered = onEnergy({ ...base, adRefill: { offered: true } })
  assert.deepEqual(adOffer(offered, 0), { kind: 'button' })
  assert.deepEqual(adOffer(offered, 30 * 60_000), { kind: 'none' }, 'a play came back: no button')
  // A limit: the clock, then the button once it has passed (the server decides again).
  const waiting = onEnergy({ ...base, nextInMs: 50 * 60_000, adRefill: { offered: false, nextInMs: 90_000 } })
  assert.deepEqual(adOffer(waiting, 30_000), { kind: 'wait', inMs: 60_000 })
  assert.deepEqual(adOffer(waiting, 90_000), { kind: 'button' })
  // Plays left, no adRefill at all, or no view: nothing.
  assert.deepEqual(adOffer(onEnergy({ ...base, stock: 2, adRefill: { offered: false } }), 0), { kind: 'none' })
  assert.deepEqual(adOffer(onEnergy(base), 0), { kind: 'none' })
  assert.deepEqual(adOffer(undefined, 0), { kind: 'none' })
  assert.equal(clockOf(61_000), '01:01')
  assert.equal(clockOf(999), '00:01')
  assert.equal(clockOf(12.5 * 3_600_000), '12:30:00')
})

/** Every .ts file under `dir`. */
function sources (dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

test('rewarded only (decision #62): no midgame request and no banner call anywhere in the client', () => {
  const root = join(__dirname, '../../../../plunder-land-client/src')
  const files = sources(root)
  assert.ok(files.length > 50, `only ${files.length} client files found`)
  const offenders: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (/['"`]midgame['"`]/.test(text) || /request(Responsive)?Banner|clearBanner|\.banner\s*\./.test(text)) offenders.push(file)
    // The only requestAd call asks for 'rewarded'.
    for (const m of text.matchAll(/requestAd\(\s*([^,)]*)/g)) {
      if (m[1].trim() !== '\'rewarded\'') offenders.push(`${file}: requestAd(${m[1]})`)
    }
  }
  assert.deepEqual(offenders, [])
})
