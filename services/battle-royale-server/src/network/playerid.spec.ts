import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer, { type Connection } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import Timers from '../objects/timers'
import { GameObject } from '../objects/gameobject'
import Player from '../objects/player'
import { MemoryAccountStore, offlineAccount, PUBLIC_ID_SHAPE } from '../db/accounts'

/**
 * The player id, which becomes the Redis key `stats-${id}`.
 *
 * Since guest accounts (decision #48) it is the connection's account's
 * `publicId`, issued by the server, never anything the client sends: the
 * start's `id` is ignored, and `Multiplayer.ID_SHAPE` stays the guard every
 * issued id is checked against (bound-player-id, 2026-09-25). A raw name is
 * cut to `Player.NAME_RAW_MAX` UTF-16 units before sanitising, so its size
 * costs nothing.
 */

afterEach(() => {
  World.strict = false
})

// ---------------------------------------------------------------- issued ids

test('every issued id, persisted or offline, is 16 lowercase hex and passes ID_SHAPE', async () => {
  const store = new MemoryAccountStore()
  for (let i = 0; i < 5000; i++) {
    const { account } = await store.create()
    assert.match(account.publicId, PUBLIC_ID_SHAPE)
    assert.ok(Multiplayer.ID_SHAPE.test(account.publicId), account.publicId)
    const offline = offlineAccount()
    assert.match(offline.publicId, PUBLIC_ID_SHAPE)
    assert.ok(Multiplayer.ID_SHAPE.test(offline.publicId), offline.publicId)
    assert.equal(offline.persisted, false)
  }
  assert.equal(store.size, 5000)
})

// ---------------------------------------------------------------- refused ids

test('a start\'s id is kept only with ID_SHAPE: empty, oversized and odd-charset ids are dropped', () => {
  assert.equal(Multiplayer.parseStart({ id: 'a'.repeat(6) })?.id, 'a'.repeat(6))
  assert.equal(Multiplayer.parseStart({ id: '0123456789abcdef0123456789abcdef' })?.id, '0123456789abcdef0123456789abcdef')
  const bad = [
    '',
    'a'.repeat(5),
    'a'.repeat(33),
    'a'.repeat(1 << 20), // socket.io's default buffer cap is 1 MB
    'ABCDEF',
    '0x' + 'aB'.repeat(20), // a 2023 wallet address, deliberately not accepted
    'abc-12',
    'abc 12',
    'abcdef\n', // `$` without the m flag does not match before a trailing newline
    '\nabcdef',
    'abc*12', // a KEYS pattern
    'stats-abcdef',
    '../abcdef',
    'ghijkl',
    String.fromCodePoint(0xFF41, 0xFF42, 0xFF43, 0xFF44, 0xFF45, 0xFF46), // full-width abcdef
    'abcde' + String.fromCodePoint(0x0301) + 'f'
  ]
  for (const id of bad) {
    const start = Multiplayer.parseStart({ id, name: 'NOVA' })
    assert.ok(start !== undefined, 'a start is never refused for its id')
    assert.equal(start.id, undefined, JSON.stringify(id.slice(0, 40)))
    assert.equal(Multiplayer.parseStart(id), undefined, 'the bare-string form is gone')
  }
})

// ---------------------------------------------------------------- the join

function redisStub (keys: string[]): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async (key: string) => { keys.push(key); return 1 },
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    handshake: { query: {} },
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true,
    conn: { write: () => {}, close: () => { handlers.disconnect?.(undefined) } }
  } as unknown as Socket
  return { socket, fire: (event, data) => { handlers[event](data) } }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  World.strict = false
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
  GameObject.FreedIDs.length = 0
})

test('through Worlds, the player id is the account\'s, whatever id the start carried, and stats are keyed by it', async () => {
  const keys: string[] = []
  const worlds = new Worlds({ tickLengthMs: 250, cap: 10, idleMs: 300_000, redis: redisStub(keys) })
  for (const sent of ['abcdef', 'x'.repeat(1 << 20), undefined]) {
    const a = fakeSocket(`s-${String(sent).slice(0, 6)}`)
    const connection: Connection = worlds.onConnection(a.socket)
    a.fire('start_requested', { id: sent, name: 'NOVA' })
    await settle()
    const id = connection.account?.publicId as string
    assert.match(id, PUBLIC_ID_SHAPE)
    const player = connection.player as Player
    assert.ok(player !== undefined, 'the start was refused')
    assert.equal(player.playerId, id)
    assert.notEqual(player.playerId, sent)

    keys.length = 0
    const world = worlds.worldFor(connection) as World
    const multiplayer = world.multiplayer as Multiplayer
    await World.run(world, async () => { await multiplayer.updateStats(player) })
    assert.ok(keys.length > 0)
    for (const key of keys) assert.equal(key, `stats-${id}`)
  }
})

test('with World.strict on, a start with an id and no account is ignored (fail closed)', () => {
  const multiplayer = new Multiplayer(250, redisStub([]))
  const world = new World(4000)
  World.OBSTACLES.length = 0
  World.MOBS.length = 0
  World.BLOCKED.clear()
  const a = fakeSocket('s1')
  multiplayer.onConnect(a.socket)

  World.strict = true
  World.run(world, () => { a.fire('start_requested', { id: 'abcdef', name: 'NOVA' }) })
  assert.equal(World.run(world, () => World.PLAYERS.length), 0, 'a client-chosen id was played under in strict mode')

  // The spec-only fallback: off strict, the start's id joins.
  World.strict = false
  a.fire('start_requested', { id: 'abcdef', name: 'NOVA' })
  assert.equal(World.PLAYERS.length, 1)
  assert.equal((World.PLAYERS[0] as Player).playerId, 'abcdef')
})

// ---------------------------------------------------------------- the raw name cut

/** sanitiseName with the cut switched off: the reference a cut name must match. */
function uncut (raw: string): string {
  const max = Player.NAME_RAW_MAX
  Player.NAME_RAW_MAX = Infinity
  try {
    return Player.sanitiseName(raw)
  } finally {
    Player.NAME_RAW_MAX = max
  }
}

test('every name within NAME_RAW_MAX sanitises exactly as it did without the cut', () => {
  // Everything sanitising treats specially: marks, markup, controls, zero-width
  // and bidi characters, blank letters, full-width forms, spaces and emoji pairs.
  const alphabet = [
    'a', 'Z', '7', ' ', '\t', '\n', '<', '&', '"', '`',
    String.fromCodePoint(0x0301), String.fromCodePoint(0x0308), String.fromCodePoint(0x200B),
    String.fromCodePoint(0x202E), String.fromCodePoint(0x3164), String.fromCodePoint(0xFF1C),
    String.fromCodePoint(0xFF2E), String.fromCodePoint(0xA0), String.fromCodePoint(0x1F916),
    String.fromCodePoint(0xFDFA), String.fromCodePoint(0), 'e'
  ]
  for (let i = 0; i < 2000; i++) {
    let raw = ''
    const target = Math.floor(Math.random() * (Player.NAME_RAW_MAX + 1))
    while (true) {
      const next = alphabet[Math.floor(Math.random() * alphabet.length)]
      if (raw.length + next.length > target) break
      raw += next
    }
    assert.ok(raw.length <= Player.NAME_RAW_MAX)
    assert.equal(Player.sanitiseName(raw), uncut(raw), JSON.stringify(raw))
  }
  // The limit is not so tight that a padded name loses letters: 200 units of
  // stripped padding between two halves still keeps both.
  const padded = 'NO' + String.fromCodePoint(0x200B).repeat(196) + 'VA'
  assert.equal(Player.sanitiseName(padded), 'NOVA')
  // Exactly at the limit.
  const atLimit = 'R' + ' '.repeat(Player.NAME_RAW_MAX - 2) + 'K'
  assert.equal(Player.sanitiseName(atLimit), uncut(atLimit))
  assert.equal(Player.sanitiseName(atLimit), 'R K')
})

test('a name over NAME_RAW_MAX is sanitised from its first NAME_RAW_MAX units only', () => {
  // The kept part lies entirely in padding the sanitiser strips, so a cut in
  // the wrong place shows: 'LATE' arrives only past the limit.
  const raw = String.fromCodePoint(0x200B).repeat(Player.NAME_RAW_MAX) + 'LATE'
  assert.equal(uncut(raw), 'LATE')
  assert.equal(Player.sanitiseName(raw), '')
  const head = 'NOVA' + ' '.repeat(Player.NAME_RAW_MAX - 4)
  assert.equal(Player.sanitiseName(head + 'x'.repeat(1 << 20)), 'NOVA')
})

test('the cut never leaves half a surrogate pair', () => {
  const robot = String.fromCodePoint(0x1F916) // two UTF-16 units
  const raw = 'a'.repeat(Player.NAME_RAW_MAX - 1) + robot
  const cut = Player.precut(raw)
  assert.equal(cut.length, Player.NAME_RAW_MAX - 1)
  assert.equal(cut, 'a'.repeat(Player.NAME_RAW_MAX - 1))
  // A pair that ends exactly at the limit is kept whole.
  const fits = 'a'.repeat(Player.NAME_RAW_MAX - 2) + robot + 'b'
  assert.equal(Player.precut(fits), 'a'.repeat(Player.NAME_RAW_MAX - 2) + robot)
})

test('a 1 MB name costs about what a name at the limit does', () => {
  // Marks, markup and spaces, so every regex has work at every position.
  const unit = 'A' + String.fromCodePoint(0x0301) + ' <b>'
  const huge = unit.repeat(Math.ceil((1 << 20) / unit.length))
  const atLimit = huge.slice(0, Player.NAME_RAW_MAX)
  const perCall = (s: string, n: number): number => {
    const start = process.hrtime.bigint()
    for (let i = 0; i < n; i++) Player.sanitiseName(s)
    return Number(process.hrtime.bigint() - start) / 1e6 / n
  }
  perCall(atLimit, 50) // warm up
  const limitMs = perCall(atLimit, 200)
  const hugeMs = perCall(huge, 200)
  // Measured 2026-09-25: about 0.02 ms each, against about 30 ms uncut. The
  // bound is loose so a loaded machine does not fail it; the uncut cost is
  // over ten times the bound.
  assert.ok(hugeMs < Math.max(10 * limitMs, 2), `1 MB name took ${hugeMs.toFixed(3)} ms, a limit-length one ${limitMs.toFixed(3)} ms`)
  assert.equal(Player.sanitiseName(huge), Player.sanitiseName(atLimit))
})
