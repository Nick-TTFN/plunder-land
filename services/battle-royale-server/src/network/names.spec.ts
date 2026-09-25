import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
import Multiplayer from './multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import { GameObject } from '../objects/gameobject'
import Player from '../objects/player'

/**
 * player-names: `start_requested` carries `{ id, name }`, the server keeps a
 * sanitised, capped copy of the name (or a callsign from the id), and the name
 * goes to other clients in the `name` field of the player's create record.
 *
 * Special characters are built with String.fromCodePoint rather than written as
 * escapes or literals, so what each case tests is visible and survives editors.
 */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)

const ZWSP = cp(0x200B)
const ZWNJ = cp(0x200C)
const ZWJ = cp(0x200D)
const WORD_JOINER = cp(0x2060)
const BOM = cp(0xFEFF)
const RLO = cp(0x202E) // right-to-left override
const PDF = cp(0x202C) // pop directional formatting
const LRI = cp(0x2066)
const PDI = cp(0x2069)
const RLM = cp(0x200F)
const HANGUL_FILLER = cp(0x3164)
const BRAILLE_BLANK = cp(0x2800)
const ACUTE = cp(0x0301) // combining acute accent

// ---------------------------------------------------------------- sanitising

test('a 200-character name is cut to NAME_MAX (16) code points', () => {
  assert.equal(Player.NAME_MAX, 16)
  const name = Player.sanitiseName('A'.repeat(200))
  assert.equal(name, 'A'.repeat(16))
})

test('the cap counts code points, so an astral character is never split in half', () => {
  const robot = cp(0x1F916)
  const name = Player.sanitiseName(robot.repeat(40))
  assert.equal(Array.from(name).length, 16)
  assert.equal(name, robot.repeat(16))
  // Every UTF-16 unit is part of a whole pair.
  assert.equal(name.length, 32)
})

test('markup-significant characters are stripped', () => {
  assert.equal(Player.sanitiseName('<b>Bob</b>'), 'bBob/b')
  assert.equal(Player.sanitiseName('<script>alert(1)</script>'), 'scriptalert(1)/s')
  assert.equal(Player.sanitiseName('Tom & "Jerry" `x` \'y\''), 'Tom Jerry x y')
})

test('full-width markup is folded by NFKC first, then stripped', () => {
  // U+FF1C / U+FF1E are the full-width < and >.
  assert.equal(Player.sanitiseName(cp(0xFF1C) + 'b' + cp(0xFF1E) + 'hi'), 'bhi')
  // Full-width letters become plain ones.
  assert.equal(Player.sanitiseName(cp(0xFF2E, 0xFF2F, 0xFF36, 0xFF21)), 'NOVA')
})

test('control characters are stripped, and NUL never reaches the NUL-terminated wire field', () => {
  assert.equal(Player.sanitiseName('A' + cp(0) + 'B' + cp(7) + 'C' + cp(0x1B) + '[31mD' + cp(0x7F) + cp(0x9B)), 'ABC[31mD')
  assert.ok(!Player.sanitiseName('x' + cp(0) + 'y').includes(cp(0)))
})

test('tabs and line breaks become single spaces, not glue', () => {
  assert.equal(Player.sanitiseName('Bob\nSmith'), 'Bob Smith')
  assert.equal(Player.sanitiseName('Bob\r\n\t Smith'), 'Bob Smith')
  assert.equal(Player.sanitiseName('Bob' + cp(0x2028) + 'Smith'), 'Bob Smith')
})

test('zero-width characters are stripped', () => {
  assert.equal(Player.sanitiseName('N' + ZWSP + 'O' + ZWNJ + 'V' + ZWJ + 'A' + WORD_JOINER + BOM), 'NOVA')
})

test('bidi controls are stripped, so a name cannot reverse itself or what follows', () => {
  assert.equal(Player.sanitiseName(RLO + 'KOOR' + PDF), 'KOOR')
  assert.equal(Player.sanitiseName(LRI + 'x' + PDI + RLM + 'y'), 'xy')
})

test('letters that render as nothing are stripped, and a name of only them is no name', () => {
  assert.equal(Player.sanitiseName('A' + HANGUL_FILLER + 'B'), 'AB')
  assert.equal(Player.sanitiseName(HANGUL_FILLER.repeat(5) + BRAILLE_BLANK), '')
})

test('combining marks are capped at two in a row', () => {
  const zalgo = 'a' + ACUTE.repeat(30) + 'b'
  // NFKC composes the first mark into the letter (U+00E1), and two more stay.
  assert.equal(Player.sanitiseName(zalgo), cp(0xE1) + ACUTE + ACUTE + 'b')
  // Marks on a letter with no precomposed form: exactly two survive.
  assert.equal(Player.sanitiseName('q' + ACUTE.repeat(9)), 'q' + ACUTE + ACUTE)
})

test('whitespace collapses and trims, including non-breaking and ideographic spaces', () => {
  assert.equal(Player.sanitiseName('   Rook    of   Hex  '), 'Rook of Hex')
  assert.equal(Player.sanitiseName(cp(0xA0) + 'a' + cp(0xA0, 0xA0) + 'b' + cp(0x3000)), 'a b')
})

test('the cut is trimmed again when it lands on a space', () => {
  // 15 letters, a space, then more: the 16th code point is the space.
  assert.equal(Player.sanitiseName('A'.repeat(15) + ' BCDEF'), 'A'.repeat(15))
})

test('an empty name, a name of only spaces, and a non-string are all no name', () => {
  assert.equal(Player.sanitiseName(''), '')
  assert.equal(Player.sanitiseName('      '), '')
  assert.equal(Player.sanitiseName(' ' + ZWSP + '\t\n ' + RLO), '')
  for (const raw of [undefined, null, 42, {}, ['NOVA'], true]) assert.equal(Player.sanitiseName(raw), '')
})

test('"YOU" is reserved, in any case, because every client labels its own robot YOU', () => {
  assert.equal(Player.sanitiseName('YOU'), '')
  assert.equal(Player.sanitiseName(' you '), '')
  assert.equal(Player.sanitiseName('Y' + ZWSP + 'o' + ZWSP + 'U'), '')
  assert.equal(Player.sanitiseName('YOUR MUM'), 'YOUR MUM')
})

test('ordinary names from other scripts survive untouched', () => {
  for (const name of ['NOVA', 'Zo' + cp(0xEB), cp(0x6771, 0x4EAC), cp(0x141) + 'ukasz', 'd' + cp(0x0301) + 'j', 'x_X-99']) {
    assert.equal(Player.sanitiseName(name), name.normalize('NFKC'))
  }
})

test('fuzz: whatever goes in, what comes out is short, trimmed and free of every stripped class', () => {
  let seed = 12345
  const rand = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32 }
  const blanks = cp(0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800)
  const banned = new RegExp(`[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\p{Cs}\\p{Zl}\\p{Zp}<>&"'\`${blanks}]`, 'u')
  for (let n = 0; n < 5000; n++) {
    let raw = ''
    const length = Math.floor(rand() * 60)
    for (let i = 0; i < length; i++) {
      // Half from the first 0x3000 (controls, markup, marks, bidi, spaces), half anywhere.
      const code = rand() < 0.5 ? Math.floor(rand() * 0x3000) : Math.floor(rand() * 0x110000)
      raw += (code >= 0xD800 && code <= 0xDFFF) ? String.fromCharCode(code) : cp(code)
    }
    const name = Player.sanitiseName(raw)
    assert.ok(Array.from(name).length <= Player.NAME_MAX, JSON.stringify(raw))
    assert.equal(name, name.trim())
    assert.ok(!banned.test(name), JSON.stringify(name))
    assert.ok(!/ {2}/.test(name))
    // Stable: sanitising a sanitised name changes nothing.
    assert.equal(Player.sanitiseName(name), name)
  }
})

// ---------------------------------------------------------------- callsigns

test('a callsign is a word and a two-digit number, and the same id always gets the same one', () => {
  for (const id of ['a1b2c3', 'ffffff', '000000', '', 'x'.repeat(500)]) {
    const first = Player.callsign(id)
    assert.match(first, /^[A-Z]+-[1-9][0-9]$/)
    assert.equal(Player.callsign(id), first)
    assert.ok(Player.CALLSIGNS.includes(first.split('-')[0]))
  }
  // Pinned (values computed independently, in Python, from the FNV-1a
  // definition), so a change to the hash that would rename every returning
  // player without a name shows up here.
  assert.equal(Player.callsign('a1b2c3'), 'JOLT-37')
  assert.equal(Player.callsign('ffffff'), 'JOLT-57')
})

test('callsigns spread across ids rather than piling onto a few', () => {
  const seen = new Set<string>()
  const words = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const c = Player.callsign(i.toString(16).padStart(6, '0'))
    seen.add(c)
    words.add(c.split('-')[0])
  }
  assert.ok(seen.size > 250, `only ${seen.size} distinct callsigns for 300 ids`)
  assert.equal(words.size, Player.CALLSIGNS.length)
})

test('displayName: the sanitised name, or the callsign when nothing is left', () => {
  assert.equal(Player.displayName('  NOVA ', 'abc123'), 'NOVA')
  assert.equal(Player.displayName('', 'abc123'), Player.callsign('abc123'))
  assert.equal(Player.displayName('   ', 'abc123'), Player.callsign('abc123'))
  assert.equal(Player.displayName(undefined, 'abc123'), Player.callsign('abc123'))
  assert.equal(Player.displayName('<>', 'abc123'), Player.callsign('abc123'))
})

// ---------------------------------------------------------------- the payload

test('parseStart: the object form', () => {
  assert.deepEqual(Multiplayer.parseStart({ id: 'abc123', name: 'NOVA' }), { id: 'abc123', name: 'NOVA' })
  assert.deepEqual(Multiplayer.parseStart({ id: 'abc123' }), { id: 'abc123', name: undefined })
  // The name is passed on raw; Player cleans it.
  assert.deepEqual(Multiplayer.parseStart({ id: 'abc123', name: 7 }), { id: 'abc123', name: 7 })
})

test('parseStart: a bare string is the old form, the id alone (kept for one release)', () => {
  assert.deepEqual(Multiplayer.parseStart('abc123'), { id: 'abc123' })
})

test('parseStart: anything without a non-empty string id is ignored', () => {
  for (const bad of [undefined, null, '', 42, true, [], ['abc123'], {}, { name: 'NOVA' }, { id: 5 }, { id: '' }, { id: { toString: () => 'x' } }]) {
    assert.equal(Multiplayer.parseStart(bad), undefined, JSON.stringify(bad))
  }
})

// ---------------------------------------------------------------- the join

function okRedis (): Redis {
  return { on: function () { return this }, hincrby: async () => 1 } as unknown as Redis
}

interface Recorded { event: string, data: unknown }

/** A socket that keeps what it was sent, payloads included. */
function fakeSocket (id: string): { socket: Socket, fire: (event: string, data?: unknown) => void, sent: Recorded[] } {
  const handlers: Record<string, (data: unknown) => void> = {}
  const sent: Recorded[] = []
  const socket = {
    id,
    on: (event: string, cb: (data: unknown) => void) => { handlers[event] = cb },
    emit: (event: string, data: unknown) => { sent.push({ event, data }); return true }
  } as unknown as Socket
  return { socket, sent, fire: (event, data) => { handlers[event](data) } }
}

/** `[uint16 length][record]...`, the inverse of Multiplayer.packRecords. */
function unpack (buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let at = 0
  while (at < buf.length) {
    const length = buf.readUInt16BE(at)
    out.push(buf.subarray(at + 2, at + 2 + length))
    at += 2 + length
  }
  return out
}

/** Every record of `event` a socket was sent that belongs to object `id`. */
function recordsFor (sent: Recorded[], event: string, id: number): Buffer[] {
  const out: Buffer[] = []
  for (const s of sent) {
    if (s.event !== event) continue
    for (const record of unpack(s.data as Buffer)) {
      // Every record opens with the id field: index 0, then a uint16.
      if (record[0] === 0 && record.readUInt16BE(1) === id) out.push(record)
    }
  }
  return out
}

/** The `name` field as a record carries it: index, UTF-8 bytes, NUL. */
function nameField (name: string): Buffer {
  return Buffer.concat([Buffer.from([GameObject.fieldOrder.indexOf('name')]), Buffer.from(name, 'utf8'), Buffer.from([0])])
}

/**
 * Payload widths by field, as GameObject.serialiseBinary writes them. `name` is
 * the one variable-width field (NUL-terminated) and is handled in `nameIn`.
 */
const WIDTH: Record<string, number> = {
  id: 2, type: 1, position: 4, hp: 2, level: 1, loot: 2, tag: 1, to: 1, radius: 1,
  lifetime: 2, maxVelocity: 1, maxHp: 2, facing: 1, armor: 2, maxArmor: 2, archetype: 1
}

/**
 * The name a record carries, walking it field by field as the client does
 * (Game.unpackRecords), or undefined. Throws on a field it cannot size, so a
 * new field shows up here rather than as a misread.
 */
function nameIn (record: Buffer): string | undefined {
  let at = 0
  while (at < record.length) {
    const key = GameObject.fieldOrder[record[at++]]
    if (key === 'name') {
      const end = record.indexOf(0, at)
      assert.ok(end >= 0, 'name is NUL-terminated')
      return record.subarray(at, end).toString('utf8')
    }
    const width = WIDTH[key]
    assert.ok(width !== undefined, `no width for field ${key}`)
    at += width
  }
  return undefined
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

function setup (): Multiplayer {
  const multiplayer = new Multiplayer(250, okRedis())
  // eslint-disable-next-line no-new
  new World(4000)
  World.OBSTACLES.length = 0
  World.CONSUMABLES.length = 0
  World.MOBS.length = 0
  World.BLOCKED.clear()
  return multiplayer
}

function connect (multiplayer: Multiplayer, socketId: string): ReturnType<typeof fakeSocket> {
  const fake = fakeSocket(socketId)
  multiplayer.onConnect(fake.socket)
  return fake
}

const lastPlayer = (): Player => World.PLAYERS[World.PLAYERS.length - 1] as Player

test('a join with a name: the player carries the sanitised name, keyed by its id', () => {
  const multiplayer = setup()
  const a = connect(multiplayer, 's1')
  a.fire('start_requested', { id: 'abc123', name: '  <i>NOVA</i>  ' })
  const player = lastPlayer()
  assert.equal(player.playerId, 'abc123')
  assert.equal(player.name, 'iNOVA/i')
})

test('a join in the old bare-string form still works, and gets the id\'s callsign', () => {
  const multiplayer = setup()
  const a = connect(multiplayer, 's1')
  a.fire('start_requested', 'abc123')
  assert.equal(World.PLAYERS.length, 1)
  assert.equal(lastPlayer().playerId, 'abc123')
  assert.equal(lastPlayer().name, Player.callsign('abc123'))
})

test('a join with an empty or blank name gets the callsign, the same one on every reconnect', () => {
  const multiplayer = setup()
  const names: string[] = []
  for (const [i, name] of ['', '    ', undefined, ZWSP + RLO].entries()) {
    const fake = connect(multiplayer, `s${i}`)
    fake.fire('start_requested', { id: 'abc123', name })
    names.push(lastPlayer().name)
  }
  assert.deepEqual(names, names.map(() => Player.callsign('abc123')))
})

test('a malformed start is ignored and does not latch the connection: a good one after it joins', () => {
  const multiplayer = setup()
  const a = connect(multiplayer, 's1')
  a.fire('start_requested', { name: 'NOVA' })
  a.fire('start_requested', 42)
  a.fire('start_requested', null)
  assert.equal(World.PLAYERS.length, 0)
  a.fire('start_requested', { id: 'abc123', name: 'NOVA' })
  assert.equal(World.PLAYERS.length, 1)
  assert.equal(lastPlayer().name, 'NOVA')
  // And a second start on the same connection is still refused.
  a.fire('start_requested', { id: 'other', name: 'ROOK' })
  assert.equal(World.PLAYERS.length, 1)
})

test('the name reaches a client already in the world, in the newcomer\'s create record', () => {
  const multiplayer = setup()
  const a = connect(multiplayer, 's1')
  a.fire('start_requested', { id: 'aaaaaa', name: 'ROOK' })
  multiplayer.flushAll(1)

  const b = connect(multiplayer, 's2')
  b.fire('start_requested', { id: 'bbbbbb', name: 'Zo' + cp(0xEB) + ' <3' })
  const newcomer = lastPlayer()
  multiplayer.flushAll(2)

  const records = recordsFor(a.sent, 'create', newcomer.id)
  assert.equal(records.length, 1)
  assert.ok(records[0].includes(nameField('Zo' + cp(0xEB) + ' 3')), records[0].toString('hex'))
  assert.equal(nameIn(records[0]), 'Zo' + cp(0xEB) + ' 3')
})

test('a newcomer gets every existing player\'s name in its join snapshot', () => {
  const multiplayer = setup()
  const a = connect(multiplayer, 's1')
  a.fire('start_requested', { id: 'aaaaaa', name: 'ROOK' })
  const first = lastPlayer()
  multiplayer.flushAll(1)

  const b = connect(multiplayer, 's2')
  b.fire('start_requested', { id: 'bbbbbb' })

  const records = recordsFor(b.sent, 'create', first.id)
  assert.equal(records.length, 1)
  assert.equal(nameIn(records[0]), 'ROOK')
})

test('a player without a name is sent as its callsign, not its id', () => {
  const multiplayer = setup()
  const a = connect(multiplayer, 's1')
  a.fire('start_requested', { id: 'aaaaaa', name: 'ROOK' })
  multiplayer.flushAll(1)

  const b = connect(multiplayer, 's2')
  b.fire('start_requested', 'bbbbbb')
  const newcomer = lastPlayer()
  multiplayer.flushAll(2)

  const name = nameIn(recordsFor(a.sent, 'create', newcomer.id)[0])
  assert.equal(name, Player.callsign('bbbbbb'))
  assert.notEqual(name, 'bbbbbb')
})

test('stats stay keyed by id, never by the chosen name', async () => {
  const keys: string[] = []
  const redis = { on: function () { return this }, hincrby: async (key: string) => { keys.push(key); return 1 } } as unknown as Redis
  const multiplayer = new Multiplayer(250, redis)
  // eslint-disable-next-line no-new
  new World(4000)
  World.OBSTACLES.length = 0
  World.CONSUMABLES.length = 0
  World.MOBS.length = 0
  const a = connect(multiplayer, 's1')
  a.fire('start_requested', { id: 'abc123', name: 'NOVA' })
  await multiplayer.updateStats(lastPlayer())
  assert.ok(keys.length > 0)
  for (const key of keys) assert.equal(key, 'stats-abc123')
})
