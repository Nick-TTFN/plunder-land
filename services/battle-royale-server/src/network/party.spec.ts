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

function client (worlds: Worlds, name: string): { connection: Connection, start: (party?: unknown) => void } {
  const handlers: Record<string, (data?: unknown) => void> = {}
  const socket = {
    id: name,
    handshake: { query: { frames: '1' } },
    on: (event: string, cb: (data?: unknown) => void) => { handlers[event] = cb },
    emit: () => true,
    conn: { write: () => {}, close: () => { handlers.disconnect?.() } }
  } as unknown as Socket
  const connection = worlds.onConnection(socket)
  return { connection, start: (party) => { handlers.start_requested({ id: 'abc123', name, party }) } }
}

/**
 * Two worlds of one human each, the inviter (party `cccccc`) in the newer one,
 * so fill-first alone would send anyone else to the older one.
 */
function setup (): { worlds: Worlds, older: World, inviters: World } {
  const worlds = new Worlds({ tickLengthMs: 250, cap: 2, idleMs: 300_000, redis: redisStub() })
  const a = client(worlds, 'a')
  a.start()
  client(worlds, 'b').start()
  client(worlds, 'c').start('cccccc')
  const older = worlds.worldFor(a.connection) as World
  const inviters = worlds.worlds[1]
  const player = a.connection.player
  assert.ok(player !== undefined && inviters !== older)
  World.run(older, () => { player.exit() })
  assert.deepEqual(worlds.worlds.map((w) => Worlds.activePlayers(w)), [1, 1], 'test setup: one human each')
  return { worlds, older, inviters }
}

test('a friend with the inviter\'s code joins the inviter\'s world, over fill-first', () => {
  const { worlds, older, inviters } = setup()
  const friend = client(worlds, 'friend')
  friend.start('cccccc')
  assert.equal(worlds.worldFor(friend.connection), inviters)
  const stranger = client(worlds, 'stranger')
  stranger.start()
  assert.equal(worlds.worldFor(stranger.connection), older, 'no code: fill-first, as before')
})

test('a full world, an unknown code, or a malformed one: fill-first', () => {
  const { worlds, older, inviters } = setup()
  client(worlds, 'friend').start('cccccc')
  assert.equal(Worlds.activePlayers(inviters), 2, 'test setup: the inviter\'s world is full')
  const late = client(worlds, 'late')
  late.start('cccccc')
  assert.equal(worlds.worldFor(late.connection), older, 'full: elsewhere')
  for (const party of ['zzzzzz', 'CCCCCC', 'c!', 42, 'x'.repeat(40)]) {
    const other = client(worlds, 'other')
    other.start(party)
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
    const { worlds } = setup()
    // The setup's own events go out after async Redis reads: let them land first.
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
    sent.length = 0
    client(worlds, 'friend').start('cccccc')
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].party_size, 1)
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
  const url = inviteUrl('https://x.dev', '/', '?server=http://localhost:8000', code, 'Zoë & co')
  const search = url.slice(url.indexOf('?'))
  assert.deepEqual(readInvite(search), { code, from: 'Zoë & co' })
  assert.equal(withoutInvite(search), '?server=http%3A%2F%2Flocalhost%3A8000', 'other params stay')
  assert.equal(readInvite('?join=NOPE!'), undefined)
  assert.equal(readInvite('?join=abcdef&from=' + 'x'.repeat(40))?.from.length, 16, 'the name is cut to the server\'s length')
  assert.equal(parseStoredInvite('{"code":"abcdef","from":"A"}')?.code, 'abcdef')
  assert.equal(parseStoredInvite('garbage'), undefined)
})
