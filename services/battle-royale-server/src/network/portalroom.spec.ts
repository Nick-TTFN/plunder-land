import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type CrazySdk, ROOM_GAP_MS, crazyGamesSdk, inviteLinkOf, inviteParamsOf } from '../../../../plunder-land-client/src/portal/crazygames'
import { type PortalRoom, type PortalSdk, withGameplayState } from '../../../../plunder-land-client/src/portal/adapter'
import { noPortalSdk } from '../../../../plunder-land-client/src/portal/none'
import { JoinInbox, RoomReporter, inviteCodeOf, inviteParamsFor, roomFor } from '../../../../plunder-land-client/src/portal/room'
import { PARTY_SHAPE, makeCode, runParty } from '../../../../plunder-land-client/src/ui/lobby/party'
import { invitesShown } from '../../../../plunder-land-client/src/net/portal'
import Multiplayer from './multiplayer'

/**
 * CrazyGames multiplayer, client half (g2-6e, decision #62 Q2 A, Q8): the
 * room is the party code the next run carries; the adapter's room members;
 * an invite's params joining like `?join=`; the SDK's invite link; nothing
 * of it on an offline launch (g2-6f's `updateRoom({ isJoinable: false })`
 * stands). Fake SDKs; the lobby (pixi, DOM) is not run here.
 */

const CLIENT_SRC = join(__dirname, '..', '..', '..', '..', 'plunder-land-client', 'src')

interface FakeOptions {
  environment?: string
  offline?: boolean
  instant?: boolean
  inviteParams?: unknown
  /** What `inviteLink` answers; a function to throw or see the params. */
  link?: unknown
  /** No g2-6e members (an older SDK). */
  bare?: boolean
  /**
   * `updateRoom` throttled as production's SDK 3.8.0 does (crazygames-sdk-v3.js
   * `throttledUpdateRoom`, read 2026-11-14): it goes out only when more than
   * 250 ms passed by `Date` since the last one that went out, else it throws
   * an error with `code: 'rateLimited'`. The `local` environment doesn't.
   */
  throttle?: boolean
}

interface Fake {
  sdk: CrazySdk
  calls: string[]
  rooms: unknown[]
  linkParams: unknown[]
  /** The SDK's join listener, once the adapter added it. */
  join: ((params: unknown) => void) | undefined
  /** `updateRoom` calls the throttle refused (each one threw `rateLimited`). */
  throttled: number
  /** When the throttle last let an `updateRoom` through (`Date.now()`); 0 = never. */
  roomAt: number
}

function fake (options: FakeOptions = {}): Fake {
  const out: Fake = { sdk: undefined as unknown as CrazySdk, calls: [], rooms: [], linkParams: [], join: undefined, throttled: 0, roomAt: 0 }
  const call = (name: string) => () => { out.calls.push(name) }
  const game: CrazySdk['game'] = {
    loadingStart: call('loadingStart'),
    loadingStop: call('loadingStop'),
    gameplayStart: call('gameplayStart'),
    gameplayStop: call('gameplayStop'),
    settings: {},
    addSettingsChangeListener: () => {},
    isOfflineMode: options.offline ?? false,
    updateRoom: (room) => {
      if (options.throttle === true) {
        const now = Date.now()
        if (!(now - out.roomAt > 250)) {
          out.throttled++
          throw Object.assign(new Error('updateRoom() call throttled, delay 250'), { code: 'rateLimited' })
        }
        out.roomAt = now
      }
      out.calls.push('updateRoom')
      out.rooms.push(room)
    }
  }
  if (options.bare !== true) {
    game.leftRoom = call('leftRoom')
    game.inviteParams = options.inviteParams ?? null
    game.isInstantMultiplayer = options.instant ?? false
    game.addJoinRoomListener = (listener) => { out.calls.push('addJoinRoomListener'); out.join = listener }
    game.inviteLink = (params) => {
      out.calls.push('inviteLink')
      out.linkParams.push(params)
      const link = options.link === undefined ? `https://www.crazygames.com/game/plunderbots?join=${String(params.join)}` : options.link
      return typeof link === 'function' ? (link as () => unknown)() : link
    }
  }
  out.sdk = { init: async () => {}, environment: options.environment ?? 'crazygames', game }
  return out
}

function crazy (f: Fake, warnings: string[] = []): PortalSdk {
  return withGameplayState(crazyGamesSdk(async () => f.sdk, { log: () => {}, warn: (l) => warnings.push(l) }))
}

/** Fake `setTimeout` and `Date` for this test; returns a clock that moves both by `ms`. */
function fakeClock (t: TestContext): (ms: number) => void {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  return (ms) => { t.mock.timers.tick(ms) }
}

const idsOf = (rooms: unknown[]): Array<[string | undefined, boolean | undefined]> =>
  rooms.map((r) => [(r as PortalRoom).roomId, (r as PortalRoom).isJoinable])

// ------------------------------------------------------------ the adapter

test('adapter: updateRoom reaches the SDK with the room, also when asked before ready', async (t) => {
  const tick = fakeClock(t)
  const f = fake()
  const sdk = crazy(f)
  sdk.updateRoom(roomFor('abc123', true))
  assert.deepEqual(f.rooms, [], 'not before init')
  await sdk.ready
  assert.deepEqual(f.rooms, [{ roomId: 'abc123', isJoinable: true, inviteParams: { join: 'abc123' } }])
  tick(ROOM_GAP_MS + 1)
  sdk.updateRoom(roomFor('abc123', false))
  assert.deepEqual(f.rooms[1], { roomId: 'abc123', isJoinable: false, inviteParams: { join: 'abc123' } }, 'past the window: at once')
  sdk.leftRoom()
  assert.ok(f.calls.includes('leftRoom'))
})

test('adapter: the room handed over is a copy (a later change of the caller\'s object sends nothing)', async () => {
  const f = fake()
  const sdk = crazy(f)
  await sdk.ready
  const room: PortalRoom = roomFor('abc123', true)
  sdk.updateRoom(room)
  room.inviteParams.join = 'zzzzzz'
  assert.deepEqual(f.rooms[0], { roomId: 'abc123', isJoinable: true, inviteParams: { join: 'abc123' } })
})

test('adapter: updateRoom throttled like production: two quick changes, the second goes out once the window is up', async (t) => {
  const tick = fakeClock(t)
  const f = fake({ throttle: true })
  const warnings: string[] = []
  const sdk = crazy(f, warnings)
  await sdk.ready
  sdk.updateRoom(roomFor('abc123', true))
  tick(10)
  sdk.updateRoom(roomFor('abc123', false))
  assert.deepEqual(idsOf(f.rooms), [['abc123', true]], 'held inside the window')
  tick(ROOM_GAP_MS - 10)
  assert.deepEqual(idsOf(f.rooms), [['abc123', true]], 'still held at exactly 250 ms (the SDK needs more)')
  tick(1)
  assert.deepEqual(idsOf(f.rooms), [['abc123', true], ['abc123', false]], 'the latest, once the window is up')
  assert.equal(f.throttled, 0, 'never called inside the window')
  assert.deepEqual(warnings, [])
  tick(10 * ROOM_GAP_MS)
  assert.equal(f.rooms.length, 2, 'nothing more')
})

test('adapter: three quick changes send only the latest after the first; the same before ready', async (t) => {
  const tick = fakeClock(t)
  const f = fake({ throttle: true })
  const sdk = crazy(f)
  // Before ready: three asks, one call, the latest.
  sdk.updateRoom(roomFor('aaa111', true))
  sdk.updateRoom(roomFor('bbb222', true))
  sdk.updateRoom(roomFor('ccc333', true))
  await sdk.ready
  assert.deepEqual(idsOf(f.rooms), [['ccc333', true]])
  sdk.updateRoom(roomFor('ccc333', false))
  tick(50)
  sdk.updateRoom(roomFor('ddd444', true))
  tick(50)
  sdk.updateRoom(roomFor('eee555', false))
  tick(ROOM_GAP_MS)
  assert.deepEqual(idsOf(f.rooms), [['ccc333', true], ['eee555', false]], 'only the latest of the three')
  assert.equal(f.throttled, 0)
  tick(10 * ROOM_GAP_MS)
  assert.equal(f.rooms.length, 2)
})

test('adapter: a rateLimited throw anyway (the SDK called from elsewhere) is retried after the window with the latest room, unwarned', async (t) => {
  const tick = fakeClock(t)
  const f = fake({ throttle: true })
  const warnings: string[] = []
  const sdk = crazy(f, warnings)
  await sdk.ready
  f.roomAt = Date.now() // as if a call had just gone out
  sdk.updateRoom(roomFor('abc123', true))
  assert.equal(f.throttled, 1, 'test setup: the SDK refused it')
  assert.deepEqual(f.rooms, [])
  tick(ROOM_GAP_MS + 1)
  assert.deepEqual(idsOf(f.rooms), [['abc123', true]], 'retried')
  // Refused again, and a newer room asked meanwhile: the newer one goes.
  f.roomAt = Date.now() + ROOM_GAP_MS
  tick(ROOM_GAP_MS + 1)
  sdk.updateRoom(roomFor('abc123', false))
  assert.equal(f.throttled, 2)
  sdk.updateRoom(roomFor('zzz999', true))
  tick(2 * ROOM_GAP_MS + 2)
  assert.deepEqual(idsOf(f.rooms), [['abc123', true], ['zzz999', true]])
  assert.deepEqual(warnings, [], 'a throttle is not a failure')
})

test('adapter: an offline launch sends nothing more with the throttled SDK either, however long it waits', async (t) => {
  const tick = fakeClock(t)
  const f = fake({ throttle: true, offline: true })
  const sdk = crazy(f)
  sdk.updateRoom(roomFor('abc123', true))
  await sdk.ready
  sdk.updateRoom(roomFor('abc123', true))
  tick(10)
  sdk.updateRoom(roomFor('zzz999', true))
  tick(10 * ROOM_GAP_MS)
  sdk.updateRoom(roomFor('zzz999', true))
  tick(10 * ROOM_GAP_MS)
  assert.deepEqual(f.rooms, [{ isJoinable: false }])
  assert.equal(f.throttled, 0)
})

test('adapter: an offline launch sends its one isJoinable false and no room call after it, reads no invite and makes no link', async () => {
  const f = fake({ offline: true, inviteParams: { join: 'abc123' }, instant: true })
  const sdk = crazy(f)
  // Asked before ready and after: neither goes out.
  sdk.updateRoom(roomFor('abc123', true))
  await sdk.ready
  sdk.updateRoom(roomFor('abc123', true))
  sdk.leftRoom()
  const reporter = new RoomReporter(sdk)
  reporter.report('abc123', true)
  assert.deepEqual(f.rooms, [{ isJoinable: false }], 'only g2-6f\'s, never undone')
  assert.equal(f.calls.filter((c) => c === 'updateRoom').length, 1)
  assert.ok(!f.calls.includes('leftRoom'))
  assert.equal(await sdk.inviteParams(), null)
  assert.equal(sdk.inviteLink(inviteParamsFor('abc123')), null)
  assert.ok(!f.calls.includes('inviteLink'), 'the SDK is not even asked')
  assert.ok(!f.calls.includes('addJoinRoomListener'), 'no join listener offline')
  assert.equal(invitesShown('crazygames', sdk.inviteLink(inviteParamsFor('abc123'))), false, 'INVITE hidden offline')
})

test('adapter: invite params are read once ready, string values only; anything else is null', async () => {
  const read = async (raw: unknown): Promise<Record<string, string> | null> => await crazy(fake({ inviteParams: raw })).inviteParams()
  assert.deepEqual(await read({ join: 'abc123' }), { join: 'abc123' })
  assert.deepEqual(await read({ join: 'abc123', n: 4, o: {}, x: 'y' }), { join: 'abc123', x: 'y' })
  assert.equal(await read(null), null, 'not launched from an invite')
  assert.equal(await read(undefined), null)
  assert.equal(await read('join=abc123'), null)
  assert.equal(await read(['abc123']), null)
  assert.equal(await read({ join: 42 }), null)
  assert.equal(inviteParamsOf({ join: 'x'.repeat(257) }), null, 'an overlong value is dropped')
  const many: Record<string, string> = {}
  for (let i = 0; i < 40; i++) many[`k${i}`] = 'v'
  assert.equal(Object.keys(inviteParamsOf(many) ?? {}).length, 16, 'at most 16 kept')
})

test('adapter: the invite link is the SDK\'s, asked with the params; null before ready, for a non-string, a throw (warned once), an older SDK', async () => {
  const f = fake()
  const sdk = crazy(f)
  assert.equal(sdk.inviteLink({ join: 'abc123' }), null, 'before ready')
  await sdk.ready
  assert.equal(sdk.inviteLink({ join: 'abc123' }), 'https://www.crazygames.com/game/plunderbots?join=abc123')
  assert.deepEqual(f.linkParams, [{ join: 'abc123' }])

  for (const bad of [undefined, null, 42, '', 'x'.repeat(3000), { url: 'x' }]) {
    const s = crazy(fake({ link: () => bad }))
    await s.ready
    assert.equal(s.inviteLink({ join: 'abc123' }), null, `null for ${String(bad)}`)
  }
  const warnings: string[] = []
  const throwing = crazy(fake({ link: () => { throw new Error('boom') } }), warnings)
  await throwing.ready
  assert.equal(throwing.inviteLink({ join: 'abc123' }), null)
  assert.equal(throwing.inviteLink({ join: 'abc123' }), null)
  assert.equal(warnings.filter((w) => w.includes('inviteLink')).length, 1, 'warned once')

  const old = crazy(fake({ bare: true }), warnings)
  await old.ready
  assert.equal(old.inviteLink({ join: 'abc123' }), null)
  assert.equal(await old.inviteParams(), null)
  assert.equal(old.instantMultiplayer(), false)
  assert.equal(inviteLinkOf('https://x'), 'https://x')
})

test('adapter: instant multiplayer is the SDK\'s flag, false before ready and off CrazyGames', async () => {
  const on = crazy(fake({ instant: true }))
  assert.equal(on.instantMultiplayer(), false, 'before ready')
  await on.ready
  assert.equal(on.instantMultiplayer(), true)
  const off = crazy(fake({ instant: false }))
  await off.ready
  assert.equal(off.instantMultiplayer(), false)
  assert.equal(noPortalSdk().instantMultiplayer(), false)
})

test('adapter: one SDK join listener feeds every onJoinRoom with the checked params; a throwing listener spares the rest', async () => {
  const f = fake()
  const warnings: string[] = []
  const sdk = crazy(f, warnings)
  const a: unknown[] = []
  const b: unknown[] = []
  sdk.onJoinRoom(() => { throw new Error('bad listener') })
  sdk.onJoinRoom((p) => { a.push(p) })
  await sdk.ready
  sdk.onJoinRoom((p) => { b.push(p) })
  assert.equal(f.calls.filter((c) => c === 'addJoinRoomListener').length, 1)
  f.join?.({ join: 'abc123', n: 5 })
  f.join?.('garbage')
  assert.deepEqual(a, [{ join: 'abc123' }])
  assert.deepEqual(b, [{ join: 'abc123' }])
  assert.equal(warnings.filter((w) => w.includes('join listener')).length, 1)
})

test('adapter: off CrazyGames (no SDK, disabled environment) every room member is inert', async () => {
  const none = noPortalSdk()
  none.updateRoom(roomFor('abc123', true))
  none.leftRoom()
  assert.equal(await none.inviteParams(), null)
  assert.equal(none.inviteLink({ join: 'abc123' }), null)
  const f = fake({ environment: 'disabled', inviteParams: { join: 'abc123' } })
  const disabled = crazy(f)
  disabled.updateRoom(roomFor('abc123', true))
  await disabled.ready
  disabled.updateRoom(roomFor('abc123', true))
  assert.equal(await disabled.inviteParams(), null)
  assert.equal(disabled.inviteLink({ join: 'abc123' }), null)
  assert.deepEqual(f.calls, [], 'no SDK call in a disabled environment')
})

// ------------------------------------------------------------ the room

test('room: the party code, joinable, its invite params carrying the code', () => {
  assert.deepEqual(roomFor('abc123', true), { roomId: 'abc123', isJoinable: true, inviteParams: { join: 'abc123' } })
  const code = makeCode()
  assert.ok(Multiplayer.PARTY_SHAPE.test(code) && PARTY_SHAPE.test(code), 'test setup: a code the server takes')
  assert.equal(inviteCodeOf(inviteParamsFor(code)), code, 'what an invite carries reads back')
})

test('room: reported on the lobby, again only on a change (code, full); never with another id across runs and handoffs', async (t) => {
  const tick = fakeClock(t)
  const f = fake()
  const sdk = crazy(f)
  await sdk.ready
  const room = new RoomReporter(sdk)
  // Lobby up: the code, joinable; its 250 ms full-banner redraws repeat it.
  for (let i = 0; i < 5; i++) room.report('abc123', true)
  assert.equal(f.rooms.length, 1)
  // The run and its two handoffs: the lobby is gone and nothing reports
  // (the source scan below holds that). The next lobby: the same code.
  for (let i = 0; i < 5; i++) room.report('abc123', true)
  assert.equal(f.rooms.length, 1, 'the next round keeps the room: no new call')
  // The server refuses starts (full): not joinable, then joinable again.
  // Each change a window apart, so the adapter's hold (g2-6e-1) sends each.
  tick(ROOM_GAP_MS + 1)
  room.report('abc123', false)
  tick(ROOM_GAP_MS + 1)
  room.report('abc123', true)
  // An invite accepted: the friend's code is the room now.
  tick(ROOM_GAP_MS + 1)
  room.report('zzz999', true)
  assert.deepEqual(idsOf(f.rooms), [
    ['abc123', true], ['abc123', false], ['abc123', true], ['zzz999', true]
  ])
})

test('room: only the lobby reports it; nothing outside the portal folder calls updateRoom or leftRoom (none in a run, none at a handoff)', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.ts$/.test(name)) files.push(path)
    }
  }
  walk(CLIENT_SRC)
  const rel = (path: string): string => path.slice(CLIENT_SRC.length + 1)
  const reporting = files.filter((p) => /PORTAL_ROOM\.report|\.reportRoom\(/.test(readFileSync(p, 'utf8'))).map(rel)
  assert.deepEqual(reporting, ['ui/lobby/lobby.ts'])
  // Outside the portal folder (the adapters, room.ts) nothing calls the room members directly.
  const game = files.filter((p) => !rel(p).startsWith('portal/'))
  const updating = game.filter((p) => /\.updateRoom\(/.test(readFileSync(p, 'utf8'))).map(rel)
  assert.deepEqual(updating, [], 'the game reports the room only through PORTAL_ROOM')
  const leaving = files.map(rel).filter((p) => p !== 'portal/adapter.ts' && p !== 'portal/crazygames.ts' && /\.leftRoom\(/.test(readFileSync(join(CLIENT_SRC, p), 'utf8')))
  assert.deepEqual(leaving, [], 'leftRoom is never called by the game (only passed through by the adapters)')
})

// ------------------------------------------------------------ joining

test('joining: a launch with invite params { join: abc123 } makes the run carry abc123', async () => {
  const sdk = crazy(fake({ inviteParams: { join: 'abc123' } }))
  const inbox = new JoinInbox()
  inbox.listen(sdk)
  await sdk.ready
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(inbox.latest, 'abc123')
  const own = 'mine00'
  // The lobby's invite is { code, from: '' } (A FRIEND), and its runs carry the code.
  assert.equal(runParty({ code: inbox.latest, from: '' }, own), 'abc123')
  assert.equal(runParty(undefined, own), own, 'no invite: this browser\'s own code')
})

test('joining: a malformed join, or none, is ignored', async () => {
  for (const params of [{ join: 'ABC123' }, { join: 'ab' }, { join: 'abc123!' }, { join: 'x'.repeat(13) }, { other: 'abc123' }, null]) {
    const sdk = crazy(fake({ inviteParams: params }))
    const inbox = new JoinInbox()
    const heard: string[] = []
    inbox.listeners.add((code) => heard.push(code))
    inbox.listen(sdk)
    await sdk.ready
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(inbox.latest, undefined, `ignored: ${JSON.stringify(params)}`)
    assert.deepEqual(heard, [])
  }
})

test('joining: a join while the page is open reaches the lobby, and stays for the next lobby until cancelled', async () => {
  const f = fake()
  const sdk = crazy(f)
  const inbox = new JoinInbox()
  inbox.listen(sdk)
  await sdk.ready
  const heard: string[] = []
  const lobby = (code: string): void => { heard.push(code) }
  inbox.listeners.add(lobby)
  f.join?.({ join: 'abc123' })
  assert.deepEqual(heard, ['abc123'])
  // Mid-run: no lobby listens; the next one reads `latest`.
  inbox.listeners.delete(lobby)
  f.join?.({ join: 'def456' })
  assert.equal(inbox.latest, 'def456')
  f.join?.({ join: 'BAD!' })
  assert.equal(inbox.latest, 'def456', 'a bad join changes nothing')
  inbox.clear()
  assert.equal(inbox.latest, undefined)
})
