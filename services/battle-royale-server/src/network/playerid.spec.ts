import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer from './multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import { GameObject } from '../objects/gameobject'
import Player from '../objects/player'

/**
 * bound-player-id: the id in `start_requested` becomes the Redis key
 * `stats-${id}`, so the server accepts only the shape the client makes
 * (`Multiplayer.ID_SHAPE`), and a raw name is cut to `Player.NAME_RAW_MAX`
 * UTF-16 units before sanitising, so its size costs nothing.
 */

const CLIENT_POPUP = join(__dirname, '../../../../plunder-land-client/src/ui/popups/gameenterpopup.ts')

/**
 * The client's generator (`GameEnterPopup.genRanHex`), run from its own source.
 * The popup imports pixi, so the module can't be loaded here; the expression
 * after the arrow is plain JavaScript, so it is lifted out and evaluated. The
 * whole line is pinned too, so a change to it fails here, not silently.
 */
const CLIENT_SOURCE = readFileSync(CLIENT_POPUP, 'utf8')
const CLIENT_GENERATOR_LINE = "genRanHex = (size: number): string => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')"
const GENERATOR_BODY = /^\s*genRanHex = \(size: number\): string => (.+)$/m.exec(CLIENT_SOURCE)?.[1]
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const genRanHex = new Function('size', `return ${GENERATOR_BODY ?? 'undefined'}`) as (size: number) => string

// ---------------------------------------------------------------- the client's ids

test('the client makes its id with genRanHex(6), and genRanHex is unchanged', () => {
  assert.ok(CLIENT_SOURCE.includes(CLIENT_GENERATOR_LINE), 'the client generator changed: check ID_SHAPE against it')
  assert.ok(GENERATOR_BODY !== undefined)
  // The one place an id is made, and the only length it is made at.
  assert.deepEqual(CLIENT_SOURCE.match(/genRanHex\(\d+\)/g), ['genRanHex(6)'])
  assert.match(genRanHex(6), /^[0-9a-f]{6}$/)
})

test('every id the client can generate is accepted, in both payload forms', () => {
  for (let i = 0; i < 5000; i++) {
    const id = genRanHex(6)
    assert.deepEqual(Multiplayer.parseStart({ id, name: 'NOVA' }), { id, name: 'NOVA' }, id)
    assert.deepEqual(Multiplayer.parseStart(id), { id }, id)
  }
})

test('the generator\'s extremes are accepted: random() at 0 and just under 1', () => {
  const random = Math.random
  try {
    Math.random = () => 0
    assert.equal(genRanHex(6), '000000')
    assert.ok(Multiplayer.parseStart(genRanHex(6)) !== undefined)
    Math.random = () => 1 - Number.EPSILON
    assert.equal(genRanHex(6), 'ffffff')
    assert.ok(Multiplayer.parseStart(genRanHex(6)) !== undefined)
  } finally {
    Math.random = random
  }
})

// ---------------------------------------------------------------- refused ids

test('ids of 6 to 32 lowercase hex digits are accepted; one either side is not', () => {
  assert.ok(Multiplayer.parseStart('a'.repeat(6)) !== undefined)
  assert.ok(Multiplayer.parseStart('0123456789abcdef0123456789abcdef') !== undefined)
  assert.equal(Multiplayer.parseStart('a'.repeat(5)), undefined)
  assert.equal(Multiplayer.parseStart('a'.repeat(33)), undefined)
})

test('empty, oversized and odd-charset ids are refused, in both payload forms', () => {
  const bad = [
    '',
    'a'.repeat(33),
    'a'.repeat(1 << 20), // socket.io's default buffer cap is 1 MB
    'ABCDEF', // the client only makes lowercase
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
    assert.equal(Multiplayer.parseStart(id), undefined, JSON.stringify(id.slice(0, 40)))
    assert.equal(Multiplayer.parseStart({ id, name: 'NOVA' }), undefined, JSON.stringify(id.slice(0, 40)))
  }
})

// ---------------------------------------------------------------- the join

function okRedis (keys: string[]): Redis {
  return { on: function () { return this }, hincrby: async (key: string) => { keys.push(key); return 1 } } as unknown as Redis
}

function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: () => true
  } as unknown as Socket
  return { socket, fire: (event, data) => { handlers[event](data) } }
}

beforeEach(() => {
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

test('a refused id joins nobody and leaves the connection free; a client id then joins, keyed stats-<id>', async () => {
  const keys: string[] = []
  const multiplayer = new Multiplayer(250, okRedis(keys))
  // eslint-disable-next-line no-new
  new World(4000)
  World.OBSTACLES.length = 0
  World.CONSUMABLES.length = 0
  World.MOBS.length = 0
  World.BLOCKED.clear()

  const a = fakeSocket('s1')
  multiplayer.onConnect(a.socket)
  a.fire('start_requested', { id: 'x'.repeat(1 << 20), name: 'NOVA' })
  a.fire('start_requested', 'NOT-HEX')
  a.fire('start_requested', { id: '' })
  assert.equal(World.PLAYERS.length, 0)

  const id = genRanHex(6)
  a.fire('start_requested', { id, name: 'NOVA' })
  assert.equal(World.PLAYERS.length, 1)
  const player = World.PLAYERS[0] as Player
  assert.equal(player.playerId, id)

  await multiplayer.updateStats(player)
  assert.ok(keys.length > 0)
  for (const key of keys) assert.equal(key, `stats-${id}`)
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
