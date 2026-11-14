import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import Analytics from '../analytics'

/**
 * Invite links (decision #47): a start with a party code goes to the world of
 * a human in a run with the same code, under the cap; otherwise as before.
 */

afterEach(() => { World.strict = false })

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1, hsetnx: async () => 1, hget: async () => null, keys: async () => [], hgetall: async () => ({})
  }) as unknown as Redis
}

/** Let the account lookup and creation (memory store, decision #48) finish. */
async function settle (): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

function client (worlds: Worlds, name: string): { connection: Connection, start: (party?: unknown) => Promise<void> } {
  const handlers: Record<string, (data?: unknown) => void> = {}
  const socket = {
    id: name,
    handshake: { query: { frames: '1' } },
    on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
    emit: () => true,
    conn: { write: () => {}, close: () => { handlers.disconnect?.() } }
  } as unknown as Socket
  const connection = worlds.onConnection(socket)
  return { connection, start: async (party) => { handlers.start_requested({ id: 'abc123', name, party }); await settle() } }
}

/**
 * Two worlds of one human each, the inviter (party `cccccc`) in the newer one,
 * so fill-first alone would send anyone else to the older one.
 */
async function setup (): Promise<{ worlds: Worlds, older: World, inviters: World }> {
  const worlds = new Worlds({ privateRuns: false, tickLengthMs: 250, cap: 2, idleMs: 300_000, redis: redisStub() })
  const a = client(worlds, 'a')
  await a.start()
  await client(worlds, 'b').start()
  await client(worlds, 'c').start('cccccc')
  const older = worlds.worldFor(a.connection) as World
  const inviters = worlds.worlds[1]
  const player = a.connection.player
  assert.ok(player !== undefined && inviters !== older)
  World.run(older, () => { player.exit() })
  assert.deepEqual(worlds.worlds.map((w) => Worlds.activePlayers(w)), [1, 1], 'test setup: one human each')
  return { worlds, older, inviters }
}

test('a friend with the inviter\'s code joins the inviter\'s world, over fill-first', async () => {
  const { worlds, older, inviters } = await setup()
  const friend = client(worlds, 'friend')
  await friend.start('cccccc')
  assert.equal(worlds.worldFor(friend.connection), inviters)
  const stranger = client(worlds, 'stranger')
  await stranger.start()
  assert.equal(worlds.worldFor(stranger.connection), older, 'no code: fill-first, as before')
})

test('a full world, an unknown code, or a malformed one: fill-first', async () => {
  const { worlds, older, inviters } = await setup()
  await client(worlds, 'friend').start('cccccc')
  assert.equal(Worlds.activePlayers(inviters), 2, 'test setup: the inviter\'s world is full')
  const late = client(worlds, 'late')
  await late.start('cccccc')
  assert.equal(worlds.worldFor(late.connection), older, 'full: elsewhere')
  for (const party of ['zzzzzz', 'CCCCCC', 'c!', 42, 'x'.repeat(40)]) {
    const other = client(worlds, 'other')
    await other.start(party)
    assert.ok(worlds.worldFor(other.connection) !== undefined, `still starts with ${String(party)}`)
  }
  assert.equal(Multiplayer.parseStart({ id: 'abc123', party: 'CCCCCC' })?.party, undefined, 'only lowercase codes')
  assert.equal(Multiplayer.parseStart({ id: 'abc123', party: 'cccccc' })?.party, 'cccccc')
})

test('run_start counts the friends already there (party_size)', async () => {
  const sent: Array<Record<string, unknown>> = []
  const realPost = Analytics.post
  Analytics.post = async (_url, body) => { sent.push(JSON.parse(body).events[0].params) }
  process.env.GA_MEASUREMENT_ID = 'G-TEST'
  process.env.GA_API_SECRET = 'secret'
  try {
    const { worlds } = await setup()
    // The setup's own events go out after async Redis reads: let them land first.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
    sent.length = 0
    await client(worlds, 'friend').start('cccccc')
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
    // The friend's run_start; its connection's visit_start (network/visits.ts) is not counted.
    const starts = sent.filter((e) => e.party_size !== undefined)
    assert.equal(starts.length, 1)
    assert.equal(starts[0].party_size, 1)
  } finally {
    Analytics.post = realPost
    delete process.env.GA_MEASUREMENT_ID
    delete process.env.GA_API_SECRET
  }
})

test('the client\'s invite links: made, read, cleaned out of the address', async () => {
  const { makeCode, readInvite, inviteUrl, withoutInvite, parseStoredInvite } = await import('../../../../plunder-land-client/src/ui/lobby/party')
  const code = makeCode()
  assert.ok(Multiplayer.PARTY_SHAPE.test(code), `the server accepts ${code}`)
  const url = inviteUrl('https://x.dev', '/', '?server=http://localhost:8000', code, 'ROOK-421')
  const search = url.slice(url.indexOf('?'))
  assert.deepEqual(readInvite(search), { code, from: 'ROOK-421' })
  assert.equal(withoutInvite(search), '?server=http%3A%2F%2Flocalhost%3A8000', 'other params stay')
  assert.equal(readInvite('?join=NOPE!'), undefined)
  assert.equal(parseStoredInvite('{"code":"abcdef","from":"A"}')?.code, 'abcdef')
  assert.equal(parseStoredInvite('garbage'), undefined)
})

/**
 * g2-9b (decision #62): a link is anyone's to craft, and the lobby shows its
 * `from` as JOIN <FROM>'S WORLD, so only a callsign is shown; anything else
 * reads A FRIEND (from ''), and the party code still works.
 */
test('an invite\'s from is shown only if it is a callsign', async () => {
  const { readInvite, inviteUrl, parseStoredInvite } = await import('../../../../plunder-land-client/src/ui/lobby/party')
  const { callsign, callsignOf, CALLSIGN_WORDS, CALLSIGN_NUMBERS } = await import('../../../../plunder-land-client/src/utils/callsign')
  const from = (value: string): string | undefined => readInvite('?join=abcdef&from=' + encodeURIComponent(value))?.from

  // Whatever the generator makes is shown, first and last word and number included.
  for (const name of [callsign('2579647bb7fd95c6'), 'ROOK-421', `${CALLSIGN_WORDS[0]}-100`, `${CALLSIGN_WORDS[CALLSIGN_WORDS.length - 1]}-999`]) {
    assert.equal(from(name), name, `${name} is shown`)
  }
  for (let i = 0; i < 2000; i++) {
    const name = callsignOf(Math.floor(Math.random() * 2 ** 32))
    assert.equal(from(name), name, `${name} (generated) is shown`)
  }
  assert.equal(CALLSIGN_NUMBERS, 900, 'test setup: numbers run 100 to 999')
  const made = inviteUrl('https://x.dev', '/', '', 'abcdef', 'HERON-338')
  assert.deepEqual(readInvite(made.slice(made.indexOf('?'))), { code: 'abcdef', from: 'HERON-338' }, 'the link INVITE copies reads back')

  const refused: Array<[string, string]> = [
    ['wrong word', 'PIRATE-421'],
    ['a word with its letters changed', 'ROOKS-421'],
    ['two digits', 'ROOK-42'],
    ['four digits', 'ROOK-4210'],
    ['below 100', 'ROOK-042'],
    ['lowercase', 'rook-421'],
    ['mixed case', 'Rook-421'],
    ['no dash', 'ROOK421'],
    ['a space for the dash', 'ROOK 421'],
    ['leading space', ' ROOK-421'],
    ['trailing newline', 'ROOK-421\n'],
    ['text after', 'ROOK-421 is a cheat'],
    ['two callsigns', 'ROOK-421-ROOK-421'],
    ['long string', 'X'.repeat(500)],
    ['a callsign inside a long string', 'ROOK-421'.repeat(20)],
    ['HTML', '<b>ROOK-421</b>'],
    ['script', '<img src=x onerror=alert(1)>'],
    ['emoji', 'ROOK-421\u{1F4A9}'],
    ['emoji alone', '\u{1F4A9}\u{1F4A9}'],
    ['fullwidth digits', 'ROOK-\uFF14\uFF12\uFF11'],
    ['free text', 'Zoë & co'],
    ['empty', '']
  ]
  for (const [why, value] of refused) {
    const invite = readInvite('?join=abcdef&from=' + encodeURIComponent(value))
    assert.deepEqual(invite, { code: 'abcdef', from: '' }, `${why}: A FRIEND, and the code still joins`)
  }
  assert.deepEqual(readInvite('?join=abcdef'), { code: 'abcdef', from: '' }, 'missing: A FRIEND, and the code still joins')
  assert.deepEqual(readInvite('?join=abcdef&from=ROOK-421&from=evil'), { code: 'abcdef', from: 'ROOK-421' }, 'the first from is the one read')
  assert.equal(readInvite('?join=NOPE!&from=ROOK-421'), undefined, 'a callsign does not rescue a bad code')

  // A stored invite (sessionStorage, maybe written by an older build) gets the same check.
  assert.deepEqual(parseStoredInvite('{"code":"abcdef","from":"ROOK-421"}'), { code: 'abcdef', from: 'ROOK-421' })
  assert.deepEqual(parseStoredInvite('{"code":"abcdef","from":"Zoë & co"}'), { code: 'abcdef', from: '' })
  assert.deepEqual(parseStoredInvite('{"code":"abcdef","from":42}'), { code: 'abcdef', from: '' })
  assert.deepEqual(parseStoredInvite('{"code":"abcdef"}'), { code: 'abcdef', from: '' })
  assert.equal(parseStoredInvite('{"code":"NOPE!","from":"ROOK-421"}'), undefined)
})
