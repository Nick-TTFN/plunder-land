import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection, ThrottledLog } from './multiplayer'
import Worlds from './worlds'
import World from '../objects/world'
import type Player from '../objects/player'
import { type Account, type AccountStore, MemoryAccountStore } from '../db/accounts'
import type { EnergyRecord } from '../progress/energy'
import type { PaidSeason, SeasonBoard, SeasonCredit, SeasonView } from '../progress/seasons'
import { SKILL_SPECS } from '../archetypes/archetypes'
import { ARCHETYPE_INFO, type ArchetypeKey, SELECTABLE_ROBOTS } from '../utils/archetypes'
import { PROTOCOL } from '../utils/protocol'
import { SKILL_LIST, START_KIT, loadoutSlotsAt, skillById } from '../utils/skills'
import { xpToReach } from '../progress/xp'
import { Session } from '../../../../plunder-land-client/src/net/session'
import { slotsFor } from '../../../../plunder-land-client/src/net/loadout'
import { ACCOUNT, onAccount, setAccountInfo } from '../../../../plunder-land-client/src/net/account'

/**
 * Skill loadouts through `Worlds` with a memory store (decision #48 step 4):
 * which 4 skills a join plays (`kitFor`, never refused, the whole start kit
 * on any failure), what `hello.skills` says, which skill a `skill` press
 * runs, `save_loadout` / `loadout_saved`, and `account.loadouts`. The rules
 * themselves are pinned in progress/loadouts.spec.ts.
 */

let savedLog: ThrottledLog
const savedReport = Worlds.accountReport
let reported: unknown[] = []

beforeEach(() => {
  savedLog = Worlds.ACCOUNTS_LOG
  reported = []
  Worlds.ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000, () => Date.now(), () => {})
  Worlds.accountReport = (e) => { reported.push(e) }
  Worlds.accountSuccess()
})

afterEach(() => {
  Worlds.ACCOUNTS_LOG = savedLog
  Worlds.accountReport = savedReport
  Worlds.accountSuccess()
  World.strict = false
  setAccountInfo(undefined)
})

function redisStub (): Redis {
  return Object.assign(new EventEmitter(), {
    hincrby: async () => 1,
    hsetnx: async () => 1,
    hget: async () => null,
    keys: async () => [],
    hgetall: async () => ({})
  }) as unknown as Redis
}

class Client {
  readonly handlers: Record<string, (data?: unknown) => void> = {}
  readonly emitted: Array<[string, unknown]> = []
  readonly socket: Socket
  connection!: Connection

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: (event: string, data?: unknown) => { this.emitted.push([event, data]); return true },
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
  }

  start (extra: Record<string, unknown> = {}): void {
    this.handlers.start_requested({ id: 'abcdef', name: this.id, ...extra })
  }

  events (name: string): unknown[] {
    return this.emitted.filter(([event]) => event === name).map(([, data]) => data)
  }

  last (name: string): unknown {
    return this.events(name).at(-1)
  }
}

/** The memory store, whose saves can be held or made to fail. */
class SaveStore implements AccountStore {
  readonly inner = new MemoryAccountStore()
  saves: Array<[string, string, number, number[]]> = []
  mode: 'ok' | 'throw' = 'ok'
  gate: Promise<void> | undefined

  async resolve (token: string): Promise<Account | null> { return await this.inner.resolve(token) }
  async create (): Promise<{ account: Account, token: string }> { return await this.inner.create() }
  async grant (publicId: string, xp: number, credit?: SeasonCredit): Promise<number> { return await this.inner.grant(publicId, xp, credit) }
  async season (publicId: string, atMs: number): Promise<SeasonView> { return await this.inner.season(publicId, atMs) }
  async seasonBoard (atMs: number, limit: number): Promise<SeasonBoard> { return await this.inner.seasonBoard(atMs, limit) }
  async payDue (nowMs: number): Promise<PaidSeason[]> { return await this.inner.payDue(nowMs) }
  async spend (publicId: string, nowMs: number): Promise<{ ok: boolean, energy: EnergyRecord }> { return await this.inner.spend(publicId, nowMs) }
  async refund (publicId: string, nowMs: number): Promise<EnergyRecord> { return await this.inner.refund(publicId, nowMs) }
  async saveLoadout (publicId: string, robot: string, index: number, skills: number[]): Promise<void> {
    this.saves.push([publicId, robot, index, skills])
    if (this.gate !== undefined) await this.gate
    if (this.mode === 'throw') throw new Error('connection refused (stub)')
    await this.inner.saveLoadout(publicId, robot, index, skills)
  }

  async close (): Promise<void> {}
}

async function settle (): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function makeWorlds (store: AccountStore, cap = 10): Worlds {
  return new Worlds({ tickLengthMs: 250, cap, idleMs: 300_000, redis: redisStub(), now: () => Date.now(), accounts: store })
}

/** An account at `level`, with rows written straight to the store (no save check). */
async function accountAt (store: SaveStore, level: number, rows: Array<[string, number, unknown]> = []): Promise<{ token: string, publicId: string }> {
  const { account, token } = await store.inner.create()
  if (xpToReach(level) > 0) await store.inner.grant(account.publicId, xpToReach(level))
  for (const [robot, index, skills] of rows) await store.inner.saveLoadout(account.publicId, robot, index, skills as number[])
  return { token, publicId: account.publicId }
}

/** Connect with `token`, let the lookup land, join with `start`. */
async function join (worlds: Worlds, token: string | undefined, start: Record<string, unknown>, name = 'a'): Promise<{ client: Client, player: Player, world: World }> {
  const client = new Client(name, token === undefined ? undefined : { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  client.start(start)
  await settle()
  const player = client.connection.player
  assert.ok(player !== undefined, 'the join was refused')
  const world = worlds.worldFor(client.connection) as World
  World.run(world, () => {
    World.MOBS.length = 0
    World.OBSTACLES.length = 0
  })
  return { client, player, world }
}

/** What a join played: ids, the classes in the slots, and hello.skills. */
function played (client: Client, player: Player): { ids: number[], classes: Array<string | null>, hello: unknown } {
  return {
    ids: [...player.skillIds],
    classes: player.skills.map((s) => s?.constructor.name ?? null),
    hello: (client.last('hello') as { skills?: unknown }).skills
  }
}

/** The classes a kit should build, by the server's table. */
function classesOf (kit: readonly number[]): Array<string | null> {
  return kit.map((id) => {
    const info = skillById(id)
    return info === undefined ? null : SKILL_SPECS[info.key].skill.name
  })
}

function expectKit (client: Client, player: Player, kit: readonly number[], why: string): void {
  assert.deepEqual(played(client, player), { ids: [...kit], classes: classesOf(kit), hello: [...kit] }, why)
}

// --- which loadout a join plays (criteria 2, 3) ------------------------------------

test('forged loadouts, per robot: every one plays exactly the start kit, and the join is never refused', async () => {
  // Each robot at the lowest level that has unlocked it (#48 step 5): below
  // that, the join plays Peep, which the lock tests in unlocks.spec.ts cover.
  const at = (robot: ArchetypeKey, level: number): number => Math.max(level, ARCHETYPE_INFO[robot].unlockLevel ?? 1)
  // One store and one world for every join here: building a world per join is slow.
  const store = new SaveStore()
  const worlds = makeWorlds(store, 1000)
  for (const robot of SELECTABLE_ROBOTS) {
    const low = at(robot, 1)
    const L10 = at(robot, 10)
    // The first skill still locked at the robot's lowest level, and IceBreath
    // (11) at level 10. Waddle opens at 12, when every skill is open, so it
    // has neither case.
    const lockedLow = SKILL_LIST.find((info) => info.unlockLevel > low)
    const forgedRows: Array<[string, number, unknown]> = [
      ...(lockedLow === undefined ? [] : [[`locked: ${lockedLow.key} at level ${low}`, low, [lockedLow.id, 1, 2, 3]] as [string, number, unknown]]),
      ...(L10 >= 11 ? [] : [['locked: IceBreath at level 10', L10, [8, 1, 2, 3]] as [string, number, unknown]]),
      ['a duplicate', L10, [1, 1, 3, 0]],
      ['an unknown id 9', L10, [9, 1, 2, 0]],
      ['an unknown id 255', L10, [255, 1, 2, 0]],
      ['3 entries', L10, [1, 2, 3]],
      ['5 entries', L10, [1, 2, 3, 0, 0]],
      ['a non-integer', L10, [1.5, 2, 3, 0]],
      ['a string id', L10, ['1', 2, 3, 0]],
      ['a negative', L10, [-1, 2, 3, 0]],
      ['all empty', L10, [0, 0, 0, 0]],
      ['not an array', L10, { 0: 4 }],
      ['a string', L10, '4,1,2,3']
    ]
    // A stored row that fails checkLoadout, at loadout 0.
    for (const [why, level, skills] of forgedRows) {
      const { token } = await accountAt(store, level, [[robot, 0, skills]])
      const { client, player } = await join(worlds, token, { robot, loadout: 0 })
      assert.equal(player.archetype.key, robot)
      expectKit(client, player, START_KIT, `${robot}: ${why}`)
    }
    // A valid row, but a forged `start.loadout`. The first index the level
    // lacks: 1 at level 9, 2 for Waddle (12).
    const L9 = at(robot, 9)
    const forgedIndex: Array<[string, number, unknown]> = [
      [`index ${loadoutSlotsAt(L9)} at level ${L9}`, L9, loadoutSlotsAt(L9)],
      ['index -1', 20, -1],
      ['index 1.5', 20, 1.5],
      ['index "0"', 20, '0'],
      ['index 99', 20, 99],
      ['index an object', 20, { index: 0 }],
      ['index null', 20, null]
    ]
    for (const [why, level, index] of forgedIndex) {
      const { token } = await accountAt(store, level, [[robot, 0, [4, 1, 2, 3]], [robot, 1, [4, 1, 2, 3]], [robot, 2, [4, 1, 2, 3]]])
      const { client, player } = await join(worlds, token, { robot, loadout: index })
      expectKit(client, player, START_KIT, `${robot}: ${why}`)
    }
    // And the valid row plays exactly itself, at a level that allows it.
    const { token } = await accountAt(store, at(robot, 11), [[robot, 0, [8, 6, 4, 1]]])
    const { client, player } = await join(worlds, token, { robot, loadout: 0 })
    expectKit(client, player, [8, 6, 4, 1], `${robot}: a valid loadout`)
    // Loadout 1 at level 10, with no `loadout` key meaning 0.
    const { token: token2 } = await accountAt(store, L10, [[robot, 0, [2, 0, 0, 0]], [robot, 1, [3, 6, 0, 4]]])
    const second = await join(worlds, token2, { robot, loadout: 1 })
    expectKit(second.client, second.player, [3, 6, 0, 4], `${robot}: loadout 1 at level ${L10}`)
    const third = await join(worlds, token2, { robot }, 'b')
    expectKit(third.client, third.player, [2, 0, 0, 0], `${robot}: no loadout key is loadout 0`)
  }
})

test('a forged robot plays Peep, with Peep\'s loadout', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  const { token } = await accountAt(store, 11, [['peep', 0, [8, 0, 0, 1]], ['grunt', 0, [6, 0, 0, 0]]])
  const { client, player } = await join(worlds, token, { robot: 'grunt', loadout: 0 })
  assert.equal(player.archetype.key, 'peep')
  expectKit(client, player, [8, 0, 0, 1], 'a forged robot')
})

test('the account\'s level decides, never Unit.level: level 2 plays Defend, level 1 the start kit', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  const two = await accountAt(store, 2, [['peep', 0, [4, 1, 2, 3]]])
  assert.equal(xpToReach(2), 40)
  const a = await join(worlds, two.token, { robot: 'peep', loadout: 0 })
  expectKit(a.client, a.player, [4, 1, 2, 3], 'level 2')
  assert.equal(a.player.skills[0]?.constructor.name, 'Defend')
  assert.equal(a.player.level, 1, 'the account level reached Unit.level')
  const one = await accountAt(store, 1, [['peep', 0, [4, 1, 2, 3]]])
  const b = await join(worlds, one.token, { robot: 'peep', loadout: 0 }, 'b')
  expectKit(b.client, b.player, START_KIT, 'level 1')
})

test('no account (a single-world join through onConnect) and an offline account play the start kit', async () => {
  World.strict = false
  const multiplayer = new Multiplayer(250, redisStub())
  const world = new World(4000)
  const client = new Client('solo')
  multiplayer.onConnect(client.socket)
  client.start({ robot: 'magnet', loadout: 0 })
  const player = World.PLAYERS[World.PLAYERS.length - 1]
  expectKit(client, player, START_KIT, 'no account')
  world.close()

  const down: AccountStore = {
    resolve: async () => { throw new Error('down') },
    create: async () => { throw new Error('down') },
    grant: async () => { throw new Error('down') },
    saveLoadout: async () => { throw new Error('down') },
    season: async () => { throw new Error('down') },
    seasonBoard: async () => { throw new Error('down') },
    payDue: async () => { throw new Error('down') },
    spend: async () => { throw new Error('down') },
    refund: async () => { throw new Error('down') },
    close: async () => {}
  }
  const worlds = makeWorlds(down)
  const off = await join(worlds, undefined, { robot: 'peep', loadout: 0 })
  assert.equal(off.client.connection.account?.persisted, false)
  expectKit(off.client, off.player, START_KIT, 'offline')
})

// --- slot N fires skill N (criteria 4, 5) ------------------------------------------

test('server: a press on slot N runs the Nth equipped skill and no other, as bytes and as a bare number', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  const { token } = await accountAt(store, 11, [['peep', 0, [8, 6, 4, 1]]])
  const { client, player } = await join(worlds, token, { robot: 'peep', loadout: 0 })
  const ran: number[] = []
  player.skills.forEach((skill, slot) => { if (skill !== null) skill.execute = () => { ran.push(slot); return true } })
  const bytes = (slot: number): Buffer => {
    const b = Buffer.alloc(5)
    b.writeUInt8(slot, 0)
    b.writeInt16BE(player.cell.x + 2, 1)
    b.writeInt16BE(player.cell.y, 3)
    return b
  }
  for (let n = 0; n < 4; n++) {
    ran.length = 0
    client.handlers.skill(bytes(n))
    assert.deepEqual(ran, [n], `bytes, slot ${n}`)
    ran.length = 0
    client.handlers.skill(n)
    assert.deepEqual(ran, [n], `bare number, slot ${n}`)
  }
  ran.length = 0
  for (const slot of [4, 5, 6, 7, 255]) {
    client.handlers.skill(bytes(slot))
    client.handlers.skill(slot)
  }
  assert.deepEqual(ran, [], 'slots 4-7 or 255 ran a skill')

  // A start-kit join: slot 3 is empty and runs nothing.
  const fresh = await accountAt(store, 1)
  const b = await join(worlds, fresh.token, { robot: 'peep' }, 'b')
  const ranB: number[] = []
  b.player.skills.forEach((skill, slot) => { if (skill !== null) skill.execute = () => { ranB.push(slot); return true } })
  assert.equal(b.player.skills[3], null)
  b.client.handlers.skill(3)
  b.client.handlers.skill(bytes(3))
  assert.deepEqual(ranB, [], 'the empty slot ran something')
  b.client.handlers.skill(2)
  assert.deepEqual(ranB, [2])
})

test('client: the server\'s hello gives the same ids in the same order on Q W E R; no skills key is the legacy eight, never the last kit', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  const { token } = await accountAt(store, 11, [['peep', 0, [8, 6, 4, 1]]])
  const { client, player } = await join(worlds, token, { robot: 'peep', loadout: 0 })
  // Through JSON, as socket.io carries it.
  Session.onHello(JSON.parse(JSON.stringify(client.last('hello'))))
  assert.deepEqual(slotsFor(Session.skills), { ids: [...player.skillIds], keys: ['q', 'w', 'e', 'r'] })
  assert.deepEqual(Session.skills, [8, 6, 4, 1])
  // A server from before loadouts, after a hello that had a kit.
  Session.onHello({ tick: 250, map: 4000 })
  assert.equal(Session.skills, undefined, 'Session kept the previous run\'s kit')
  assert.deepEqual(slotsFor(Session.skills), { ids: [1, 2, 3, 4, 5, 6, 7, 8], keys: ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i'] })
  Session.onHello({ tick: 250, map: 4000, skills: [1, 2, 3] })
  assert.equal(Session.skills, undefined, 'a malformed kit was kept')
})

test('two runs in two worlds with different kits: the client sees the second kit', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store, 1)
  const { token } = await accountAt(store, 11, [['peep', 0, [8, 6, 4, 1]]])
  const first = await join(worlds, token, { robot: 'peep', loadout: 0 })
  Session.onHello(first.client.last('hello') as never)
  assert.deepEqual(Session.skills, [8, 6, 4, 1])
  // A new loadout, saved mid-run; it plays from the next join.
  first.client.handlers.save_loadout({ robot: 'peep', index: 0, skills: [5, 7, 0, 2] })
  await settle()
  assert.equal((first.client.last('loadout_saved') as { ok: boolean }).ok, true)
  assert.deepEqual([...first.player.skillIds], [8, 6, 4, 1], 'a save changed the run in progress')
  World.run(first.world, () => { first.player.exit() })
  worlds.tickAll(250)
  await settle()
  // Someone else takes world A (cap 1), so the next run opens world B.
  const filler = await accountAt(store, 1)
  await join(worlds, filler.token, { robot: 'peep' }, 'filler')
  first.client.start({ robot: 'peep', loadout: 0 })
  await settle()
  const second = first.client.connection.player as Player
  assert.notEqual(second, first.player)
  assert.notEqual(worlds.worldFor(first.client.connection), first.world, 'the second run is in the same world')
  Session.onHello(first.client.last('hello') as never)
  assert.deepEqual(Session.skills, [5, 7, 0, 2])
  assert.deepEqual(slotsFor(Session.skills).ids, [...second.skillIds])
})

// --- save_loadout (criterion 6) ----------------------------------------------------------

test('save_loadout: every refusal answers ok false with kitFor\'s answer and writes nothing', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)

  // No account yet: a lobby before its first play.
  const none = new Client('none')
  none.connection = worlds.onConnection(none.socket)
  await settle()
  none.handlers.save_loadout({ robot: 'peep', index: 0, skills: [1, 2, 3, 0] })
  assert.deepEqual(none.last('loadout_saved'), { robot: 'peep', index: 0, ok: false, skills: [1, 2, 3, 0] })

  // Offline.
  const down = new SaveStore()
  down.inner.resolve = async () => { throw new Error('down') }
  const offWorlds = makeWorlds(down)
  const off = new Client('off', { token: 'A'.repeat(43) })
  off.connection = offWorlds.onConnection(off.socket)
  await settle()
  assert.equal(off.connection.account?.persisted, false)
  off.handlers.save_loadout({ robot: 'peep', index: 0, skills: [1, 2, 3, 0] })
  assert.deepEqual(off.last('loadout_saved'), { robot: 'peep', index: 0, ok: false, skills: [1, 2, 3, 0] })
  assert.deepEqual(down.saves, [])

  const { token } = await accountAt(store, 9, [['peep', 0, [2, 3, 0, 0]]])
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  const refusals: Array<[string, unknown, unknown]> = [
    ['an unknown robot', { robot: 'grunt', index: 0, skills: [1, 2, 3, 0] }, [1, 2, 3, 0]],
    ['a non-string robot', { robot: 7, index: 0, skills: [1, 2, 3, 0] }, [1, 2, 3, 0]],
    ['index 1 at level 9', { robot: 'peep', index: 1, skills: [1, 2, 3, 0] }, [1, 2, 3, 0]],
    ['a locked skill', { robot: 'peep', index: 0, skills: [8, 1, 2, 3] }, [2, 3, 0, 0]],
    ['a duplicate', { robot: 'peep', index: 0, skills: [1, 1, 2, 3] }, [2, 3, 0, 0]],
    ['an unknown id', { robot: 'peep', index: 0, skills: [9, 1, 2, 3] }, [2, 3, 0, 0]],
    ['3 entries', { robot: 'peep', index: 0, skills: [1, 2, 3] }, [2, 3, 0, 0]],
    ['5 entries', { robot: 'peep', index: 0, skills: [1, 2, 3, 0, 0] }, [2, 3, 0, 0]],
    ['a non-integer', { robot: 'peep', index: 0, skills: [1.5, 2, 3, 0] }, [2, 3, 0, 0]],
    ['a string id', { robot: 'peep', index: 0, skills: ['1', 2, 3, 0] }, [2, 3, 0, 0]],
    ['a negative', { robot: 'peep', index: 0, skills: [-1, 2, 3, 0] }, [2, 3, 0, 0]],
    ['all empty', { robot: 'peep', index: 0, skills: [0, 0, 0, 0] }, [2, 3, 0, 0]],
    ['not an object', 'peep', [1, 2, 3, 0]]
  ]
  for (const [why, data, skills] of refusals) {
    client.handlers.save_loadout(data)
    const answer = client.last('loadout_saved') as { ok: boolean, skills: unknown, busy?: boolean }
    assert.equal(answer.ok, false, why)
    assert.equal(answer.busy, undefined, why)
    assert.deepEqual(answer.skills, skills, why)
  }
  assert.deepEqual(store.saves, [], 'a refused save reached the store')
  assert.deepEqual((await store.inner.resolve(token))?.loadouts, [{ robot: 'peep', index: 0, skills: [2, 3, 0, 0] }])
})

test('save_loadout: a save for a locked robot is refused; a valid save is stored, answered ok, and played by the next join on that connection', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  // Hopper opens at level 8 (#48 step 5): at 7 the same save is refused and writes nothing.
  const seven = await accountAt(store, 7)
  const early = new Client('early', { token: seven.token })
  early.connection = worlds.onConnection(early.socket)
  await settle()
  early.handlers.save_loadout({ robot: 'hopper', index: 0, skills: [5, 4, 0, 1] })
  await settle()
  assert.deepEqual(early.last('loadout_saved'), { robot: 'hopper', index: 0, ok: false, skills: [1, 2, 3, 0] })
  assert.deepEqual(store.saves, [], 'a save for a locked robot reached the store')
  assert.deepEqual((await store.inner.resolve(seven.token))?.loadouts, [])

  const { token, publicId } = await accountAt(store, 8)
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  client.handlers.save_loadout({ robot: 'hopper', index: 0, skills: [5, 4, 0, 1] })
  await settle()
  assert.deepEqual(client.last('loadout_saved'), { robot: 'hopper', index: 0, ok: true, skills: [5, 4, 0, 1] })
  assert.deepEqual(store.saves, [[publicId, 'hopper', 0, [5, 4, 0, 1]]])
  assert.deepEqual((await store.inner.resolve(token))?.loadouts, [{ robot: 'hopper', index: 0, skills: [5, 4, 0, 1] }])
  client.start({ robot: 'hopper', loadout: 0 })
  await settle()
  expectKit(client, client.connection.player as Player, [5, 4, 0, 1], 'the saved loadout')
})

test('save_loadout: one write in flight per connection; a second meanwhile is busy and writes nothing', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  const { token } = await accountAt(store, 6)
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  let open!: () => void
  store.gate = new Promise((resolve) => { open = resolve })
  client.handlers.save_loadout({ robot: 'peep', index: 0, skills: [5, 0, 0, 0] })
  client.handlers.save_loadout({ robot: 'peep', index: 0, skills: [4, 0, 0, 0] })
  assert.deepEqual(client.events('loadout_saved'), [{ robot: 'peep', index: 0, ok: false, busy: true, skills: [1, 2, 3, 0] }])
  assert.equal(store.saves.length, 1, 'the busy save reached the store')
  open()
  await settle()
  assert.deepEqual(client.last('loadout_saved'), { robot: 'peep', index: 0, ok: true, skills: [5, 0, 0, 0] })
  // Free again once answered.
  store.gate = undefined
  client.handlers.save_loadout({ robot: 'peep', index: 0, skills: [4, 0, 0, 0] })
  await settle()
  assert.deepEqual(client.last('loadout_saved'), { robot: 'peep', index: 0, ok: true, skills: [4, 0, 0, 0] })
})

test('save_loadout: a store that rejects answers ok false, the account in memory is unchanged, and the next join plays the old loadout', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  const { token } = await accountAt(store, 6, [['peep', 0, [2, 0, 0, 0]]])
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  store.mode = 'throw'
  client.handlers.save_loadout({ robot: 'peep', index: 0, skills: [5, 0, 0, 0] })
  await settle()
  assert.deepEqual(client.last('loadout_saved'), { robot: 'peep', index: 0, ok: false, skills: [2, 0, 0, 0] })
  assert.deepEqual(client.connection.account?.loadouts, [{ robot: 'peep', index: 0, skills: [2, 0, 0, 0] }])
  assert.equal(reported.length, 1, 'the failure was not reported')
  client.start({ robot: 'peep', loadout: 0 })
  await settle()
  expectKit(client, client.connection.player as Player, [2, 0, 0, 0], 'the old loadout')
})

// --- account.loadouts (criterion 7) -------------------------------------------------------

test('account carries loadoutsFor for a persisted account, none offline; the client keeps them across a message without', async () => {
  const store = new SaveStore()
  const worlds = makeWorlds(store)
  const { token, publicId } = await accountAt(store, 15, [['magnet', 2, [6, 0, 0, 0]]])
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  const message = client.last('account') as { loadouts: Record<string, number[][]> }
  assert.deepEqual(Object.keys(message.loadouts), [...SELECTABLE_ROBOTS])
  for (const robot of SELECTABLE_ROBOTS) assert.equal(message.loadouts[robot].length, 3, robot)
  assert.deepEqual(message.loadouts.magnet, [[1, 2, 3, 0], [1, 2, 3, 0], [6, 0, 0, 0]])

  const down = new SaveStore()
  down.inner.resolve = async () => { throw new Error('down') }
  const off = new Client('off', { token: 'A'.repeat(43) })
  off.connection = makeWorlds(down).onConnection(off.socket)
  await settle()
  assert.equal((off.last('account') as { loadouts?: unknown }).loadouts, undefined, 'an offline account was sent loadouts')

  // Client: the grant's mid-run `account` has none; the previous ones stay.
  setAccountInfo(onAccount(JSON.parse(JSON.stringify(message)), undefined))
  assert.deepEqual(ACCOUNT.info?.loadouts?.magnet[2], [6, 0, 0, 0])
  setAccountInfo(onAccount({ id: publicId, xp: 9999, level: 15, levelAt: 9000, nextAt: 99999 }, undefined))
  assert.deepEqual(ACCOUNT.info?.loadouts?.magnet[2], [6, 0, 0, 0], 'a message without loadouts dropped them')
  // Never another account's.
  setAccountInfo(onAccount({ id: 'ffffffffffffffff', xp: 0, level: 1, levelAt: 0, nextAt: 40 }, undefined))
  assert.equal(ACCOUNT.info?.loadouts, undefined)
})

// --- PROTOCOL (criterion 9) ----------------------------------------------------------------

test('PROTOCOL is 6, and welcome sends it', async () => {
  // 6 since gear in the run (49-2): new field indices 25-27.
  assert.equal(PROTOCOL, 6)
  const client = new Client('a')
  makeWorlds(new SaveStore()).onConnection(client.socket)
  assert.deepEqual(client.events('welcome'), [{ protocol: 6 }])
})
