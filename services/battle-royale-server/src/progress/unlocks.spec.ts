import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type Redis from 'ioredis'
import type { Socket } from 'socket.io'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer, { type Connection } from '../network/multiplayer'
import Worlds from '../network/worlds'
import World from '../objects/world'
import type Player from '../objects/player'
import { GameObject } from '../objects/gameobject'
import { type Account, type AccountStore, MemoryAccountStore } from '../db/accounts'
import { ARCHETYPE_INFO, type ArchetypeKey, SELECTABLE_ROBOTS, robotUnlocked } from '../utils/archetypes'
import {
  type Finish, DEFAULT_FINISH, FINISH_GROUPS, FINISH_PRESETS, PALETTE, PATTERNS,
  colourUnlocked, finishFromBytes, finishToBytes, lockFinish, patternUnlocked, swatchLevel
} from '../utils/finishes'
import { START_KIT } from '../utils/skills'
import { xpToReach } from './xp'
import { joinLevel, lockedStart } from './unlocks'
import { decodeRecord } from '../../../../plunder-land-client/src/net/records'
import { PICKABLE, ROSTER } from '../../../../plunder-land-client/src/ui/lobby/roster'
import {
  colourLock, mixColour, mixPattern, paintWish, patternLock, reshownRobot, robotLock,
  robotToStore, shownFinish, shownRobot, stepRobot, swatchLock, unlockedBetween, unlockedEntries
} from '../../../../plunder-land-client/src/ui/lobby/locks'

/**
 * Robot and finish locks by account level (decision #48 step 5): the table on
 * the mirrored rows, `lockFinish`, the join's lock (`lockedStart`, once, in
 * `Multiplayer.startRequested`) through `Worlds` with a memory store, bots
 * ignoring it, and the lobby's pixi-free half (`ui/lobby/locks.ts`).
 * `save_loadout`'s refusal is in network/loadouts.spec.ts.
 */

afterEach(() => {
  World.strict = false
})

const preset = (key: string): Finish => (FINISH_PRESETS.find((p) => p.key === key) as { finish: Finish }).finish

// --- 1. the table ------------------------------------------------------------------

test('the unlock table is Dez\'s section 3 v1', () => {
  assert.deepEqual(Object.values(ARCHETYPE_INFO).map((a) => [a.key, a.unlockLevel]), [
    ['peep', 1], ['periscope', 5], ['magnet', 3], ['hopper', 8], ['waddle', 12],
    ['grunt', null], ['boss', null], ['gunner', null],
    ['crawler', null], ['kiln', null], ['reactor', null], ['coil', null], ['compactor', null], ['brood', null], ['broodling', null]
  ])
  assert.deepEqual(PALETTE.map((c) => [c.id, c.label, c.unlockLevel]), [
    [1, 'MINT', 1], [2, 'CREAM', 1], [3, 'OLIVE', 2], [4, 'SAND', 1], [5, 'ICE', 4],
    [6, 'SKY', 5], [7, 'PEACH', 6], [8, 'CORAL', 7], [9, 'VIOLET', 9], [10, 'BONE', 10]
  ])
  assert.deepEqual(PATTERNS.map((p) => [p.id, p.label, p.unlockLevel]), [
    [0, 'PLAIN', 1], [1, 'ZEBRA', 1], [2, 'CHECKER', 7], [3, 'CAMO', 3]
  ])
  // The default finish is open to everyone.
  for (const g of FINISH_GROUPS) {
    assert.ok(colourUnlocked(DEFAULT_FINISH[g].colour, 1), `${g} colour`)
    assert.ok(patternUnlocked(DEFAULT_FINISH[g].pattern, 1), `${g} pattern`)
  }
  // "3 finishes" is 3 colours (Nick, #48 addendum), and 2 patterns.
  assert.deepEqual(PALETTE.filter((c) => colourUnlocked(c.id, 1)).map((c) => c.label), ['MINT', 'CREAM', 'SAND'])
  assert.deepEqual(PATTERNS.filter((p) => patternUnlocked(p.id, 1)).map((p) => p.label), ['PLAIN', 'ZEBRA'])
  // Each preset opens at the highest swatch level among its groups.
  const opens = FINISH_PRESETS.map((p) => [p.label, Math.max(...FINISH_GROUPS.map((g) => swatchLevel(p.finish[g].colour, p.finish[g].pattern) as number))])
  assert.deepEqual(opens, [['MINT', 1], ['FIELD', 3], ['WILD', 3], ['ARCTIC', 5], ['SUNSET', 7], ['ARCADE', 10]])
  assert.equal(swatchLevel(99, 0), undefined)
  assert.equal(swatchLevel(1, 99), undefined)
})

test('robotUnlocked: selectable robots at their level; mobs and anything else never', () => {
  assert.ok(robotUnlocked('peep', 1))
  assert.ok(!robotUnlocked('magnet', 2))
  assert.ok(robotUnlocked('magnet', 3))
  assert.ok(!robotUnlocked('waddle', 11))
  assert.ok(robotUnlocked('waddle', 12))
  for (const key of ['grunt', 'boss', 'gunner', 'Peep', 7, null, undefined]) assert.ok(!robotUnlocked(key, Infinity), String(key))
})

// --- 2, 3. lockFinish, and the decoder never locks -------------------------------------

test('lockFinish: per group and per half, to that group\'s own default', () => {
  const g = (colour: number, pattern: number): { colour: number, pattern: number } => ({ colour, pattern })
  // Unlock levels in brackets: CORAL (7) + ZEBRA (1) on the head, SAND (1) + CHECKER (7) on the body, CORAL + CAMO (3) on the limbs.
  const f: Finish = { head: g(8, 1), body: g(4, 2), limbs: g(8, 3) }
  assert.deepEqual(lockFinish(f, 1), {
    head: g(2, 1), // the colour falls back to the head's CREAM, the open pattern stays
    body: g(4, 0), // the open colour stays, the pattern falls back to the body's PLAIN
    limbs: g(1, 0) // both fall back, to the limbs' MINT + PLAIN, not the head's CREAM + ZEBRA
  })
  assert.deepEqual(lockFinish(f, 3), { head: g(2, 1), body: g(4, 0), limbs: g(1, 3) })
  assert.deepEqual(lockFinish(f, 7), f)
  // At level 10 every finish is unchanged.
  for (const p of FINISH_PRESETS) assert.deepEqual(lockFinish(p.finish, 10), p.finish, p.key)
  for (const c of PALETTE) {
    for (const pat of PATTERNS) {
      const any: Finish = { head: g(c.id, pat.id), body: g(c.id, pat.id), limbs: g(c.id, pat.id) }
      assert.deepEqual(lockFinish(any, 10), any)
    }
  }
  assert.deepEqual(lockFinish(DEFAULT_FINISH, 1), DEFAULT_FINISH)
})

test('finishFromBytes never locks: ARCADE decodes as ARCADE whoever is looking', () => {
  const arcade = preset('arcade')
  assert.deepEqual(finishFromBytes(finishToBytes(arcade)), arcade)
  assert.notDeepEqual(lockFinish(arcade, 1), arcade, 'ARCADE is locked at level 1')
})

// --- the join's level ------------------------------------------------------------------

test('joinLevel: the account\'s level; an offline one is 1 whatever its XP; no account has no locks', () => {
  const account = (xp: number, persisted = true): Account => ({ publicId: '0123456789abcdef', persisted, xp, loadouts: [], energy: null })
  assert.equal(joinLevel(account(0)), 1)
  assert.equal(joinLevel(account(xpToReach(5))), 5)
  assert.equal(joinLevel(account(xpToReach(5) - 1)), 4)
  assert.equal(joinLevel(account(xpToReach(20), false)), 1)
  assert.equal(joinLevel(undefined), Infinity)
  assert.deepEqual(lockedStart(account(0), 'waddle', finishToBytes(preset('arcade'))), { robot: 'peep', finish: finishToBytes(lockFinish(preset('arcade'), 1)) })
  assert.deepEqual(lockedStart(undefined, 'waddle', finishToBytes(preset('arcade'))), { robot: 'waddle', finish: finishToBytes(preset('arcade')) })
  assert.deepEqual(lockedStart(account(xpToReach(12)), 'grunt', undefined), { robot: 'peep', finish: finishToBytes(DEFAULT_FINISH) })
})

// --- 4. joins through Worlds, strict ---------------------------------------------------

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
  readonly socket: Socket
  connection!: Connection

  constructor (readonly id: string, auth?: unknown) {
    this.socket = {
      id,
      handshake: { query: { frames: '1' }, auth },
      on: (event: string, cb: (data?: unknown) => void) => { this.handlers[event] = cb },
      emit: () => true,
      conn: { write: () => {}, close: () => { this.handlers.disconnect?.() } }
    } as unknown as Socket
  }
}

async function settle (): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** The memory store, optionally down for lookups (an offline account) whatever it holds. */
class Store extends MemoryAccountStore {
  down = false
  async resolve (token: string): Promise<Account | null> {
    if (this.down) throw new Error('down (stub)')
    return await super.resolve(token)
  }
}

async function accountAt (store: Store, level: number, rows: Array<[string, number, number[]]> = []): Promise<string> {
  const { account, token } = await store.create()
  if (xpToReach(level) > 0) await store.grant(account.publicId, xpToReach(level))
  for (const [robot, index, skills] of rows) await store.saveLoadout(account.publicId, robot, index, skills)
  return token
}

/** Join with `start`; what the player's own create says it plays, through the client's decoder. */
async function join (worlds: Worlds, token: string, start: Record<string, unknown>): Promise<{ archetype: number, finish: number[], player: Player }> {
  const client = new Client('a', { token })
  client.connection = worlds.onConnection(client.socket)
  await settle()
  client.handlers.start_requested({ id: 'abcdef', name: 'LOCK', ...start })
  await settle()
  const player = client.connection.player
  assert.ok(player !== undefined, 'the join was refused')
  const world = worlds.worldFor(client.connection) as World
  const own = World.run(world, () => player.serialiseBinary(player.allFieldsOwn))
  assert.ok(own !== null)
  const read = decodeRecord(new Uint8Array(own), GameObject.fieldOrder)
  return { archetype: read.archetype, finish: read.finish, player }
}

function makeWorlds (store: AccountStore): Worlds {
  return new Worlds({ tickLengthMs: 250, cap: 1000, idleMs: 300_000, redis: redisStub(), now: () => Date.now(), accounts: store })
}

test('a join plays the robot and finish the account\'s level allows, and is never refused', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  assert.ok(World.strict, 'Worlds runs strict')
  const id = (key: ArchetypeKey): number => ARCHETYPE_INFO[key].id
  const sunset = finishToBytes(preset('sunset'))
  assert.deepEqual(sunset, [8, 1, 7, 3, 7, 3])

  assert.equal((await join(worlds, await accountAt(store, 1), { robot: 'periscope' })).archetype, id('peep'), 'Periscope at level 1')
  assert.equal((await join(worlds, await accountAt(store, 5), { robot: 'periscope' })).archetype, id('periscope'), 'Periscope at level 5')
  assert.equal((await join(worlds, await accountAt(store, 4), { robot: 'magnet' })).archetype, id('magnet'), 'Magnet at level 4')
  assert.deepEqual((await join(worlds, await accountAt(store, 1), { finish: sunset })).finish, [2, 1, 1, 0, 1, 0], 'SUNSET at level 1')
  assert.deepEqual((await join(worlds, await accountAt(store, 7), { finish: sunset })).finish, sunset, 'SUNSET at level 7')
})

test('an offline account (store down) gets level-1 locks whatever XP the store holds', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  const token = await accountAt(store, 20)
  store.down = true
  const joined = await join(worlds, token, { robot: 'waddle', finish: finishToBytes(preset('arcade')) })
  assert.equal(joined.player.archetype.key, 'peep')
  assert.equal(joined.archetype, ARCHETYPE_INFO.peep.id)
  assert.deepEqual(joined.finish, finishToBytes(lockFinish(preset('arcade'), 1)))
})

test('a locked Waddle with a stored Waddle row plays Peep, with Peep\'s loadout', async () => {
  const store = new Store()
  const worlds = makeWorlds(store)
  // A row valid at level 1, saved before locks existed; Peep has none.
  const token = await accountAt(store, 1, [['waddle', 0, [3, 2, 1, 0]]])
  const { player } = await join(worlds, token, { robot: 'waddle', loadout: 0 })
  assert.equal(player.archetype.key, 'peep')
  assert.deepEqual([...player.skillIds], [...START_KIT])
})

// --- 6. bots ignore locks ------------------------------------------------------------------

test('bots ignore locks: World.createPlayer plays Waddle in ARCADE', () => {
  World.strict = false
  // eslint-disable-next-line no-new
  new Multiplayer(250, redisStub())
  const world = new World(4000)
  const arcade = preset('arcade')
  const player = World.createPlayer('b07b07', 'BOT', finishToBytes(arcade), 'waddle')
  assert.equal(player.archetype.key, 'waddle')
  assert.deepEqual(player.finish, arcade)
  world.close()
})

// --- 9. the lobby's half ---------------------------------------------------------------

test('lobby: the shown robot is the stored wish if unlocked, else Peep; never written back unless picked', () => {
  const entry = (key: string): typeof PICKABLE[number] => PICKABLE.find((e) => e.key === key) as typeof PICKABLE[number]
  assert.equal(shownRobot('waddle', 1).key, 'peep')
  assert.equal(shownRobot('waddle', 12).key, 'waddle')
  assert.equal(shownRobot('magnet', 3).key, 'magnet')
  assert.equal(shownRobot(null, 20).key, 'peep')
  assert.equal(shownRobot('grunt', 20).key, 'peep')
  // The fallback is not stored; a pick is, while it is shown.
  assert.equal(robotToStore(undefined, entry('peep')), undefined)
  assert.equal(robotToStore(entry('magnet'), entry('magnet')), 'magnet')
  assert.equal(robotToStore(entry('magnet'), entry('peep')), undefined, 'a pick locked again since')
  // After a level change the untouched wish is re-resolved; a pick stays.
  assert.equal(reshownRobot(undefined, 'magnet', 2).key, 'peep')
  assert.equal(reshownRobot(undefined, 'magnet', 3).key, 'magnet')
  assert.equal(reshownRobot(entry('periscope'), 'magnet', 5).key, 'periscope')
  assert.equal(reshownRobot(entry('periscope'), 'magnet', 4).key, 'peep', 'a pick locked by a curve change')
  // Left/right go over the unlocked robots only.
  assert.deepEqual(unlockedEntries(1).map((e) => e.key), ['peep'])
  assert.deepEqual(unlockedEntries(5).map((e) => e.key), ['peep', 'periscope', 'magnet'])
  assert.equal(stepRobot(entry('peep'), 1, 1).key, 'peep')
  assert.equal(stepRobot(entry('peep'), 1, 3).key, 'magnet')
  assert.equal(stepRobot(entry('peep'), -1, 3).key, 'magnet')
  assert.equal(stepRobot(entry('magnet'), 1, 8).key, 'hopper')
  assert.equal(stepRobot(entry('hopper'), 1, 8).key, 'peep')
})

test('lobby: card and swatch lock levels are the mirrored table\'s', () => {
  for (const entry of ROSTER) {
    if (entry.robot === undefined) continue
    const at = ARCHETYPE_INFO[entry.robot].unlockLevel as number
    assert.equal(robotLock(entry, at - 1), at, entry.key)
    assert.equal(robotLock(entry, at), undefined, entry.key)
  }
  assert.deepEqual(PICKABLE.map((e) => e.key), [...SELECTABLE_ROBOTS])
  for (const c of PALETTE) {
    assert.equal(colourLock(c.id, c.unlockLevel - 1), c.unlockLevel, c.label)
    assert.equal(colourLock(c.id, c.unlockLevel), undefined, c.label)
  }
  for (const p of PATTERNS) {
    assert.equal(patternLock(p.id, p.unlockLevel - 1), p.unlockLevel, p.label)
    assert.equal(patternLock(p.id, p.unlockLevel), undefined, p.label)
  }
  assert.equal(swatchLock({ colour: 8, pattern: 3 }, 6), 7, 'CORAL + CAMO')
  assert.equal(swatchLock({ colour: 8, pattern: 3 }, 7), undefined)
  assert.equal(swatchLock({ colour: 4, pattern: 3 }, 2), 3, 'SAND + CAMO')
})

test('lobby: painting from the shown group never resurrects a hidden locked part', () => {
  const g = (colour: number, pattern: number): { colour: number, pattern: number } => ({ colour, pattern })
  // A level-10 player's wish, seen at level 1: the head's CHECKER is hidden.
  const wish: Finish = { head: g(9, 2), body: g(8, 3), limbs: g(10, 1) }
  assert.deepEqual(shownFinish(wish, 1), { head: g(2, 1), body: g(1, 0), limbs: g(1, 1) })
  // MIX a colour on the head: the shown pattern (the head's ZEBRA) is kept, not CHECKER.
  const colour = mixColour(wish, 1, 'head', 4)
  assert.deepEqual(colour.head, g(4, 1))
  assert.deepEqual(colour.body, wish.body, 'the other groups\' wishes are left alone')
  assert.deepEqual(colour.limbs, wish.limbs)
  // MIX a pattern on the body: the shown colour (MINT) is kept, not CORAL.
  assert.deepEqual(mixPattern(wish, 1, 'body', 1).body, g(1, 1))
  // A preset swatch sets the group whole.
  assert.deepEqual(paintWish(wish, 'limbs', g(2, 1)).limbs, g(2, 1))
  assert.deepEqual(paintWish(wish, 'limbs', g(2, 1)).head, wish.head)
  // Sent is what is shown.
  assert.deepEqual(shownFinish(wish, 10), wish)
})

// Multiplayer must be imported for the module graph (see world.spec.ts).
void Multiplayer

// --- the run card's level-up line (unlockedBetween) ------------------------------

test('client: a level-up names exactly what opened, robots first, from the same rows the locks read', () => {
  assert.deepEqual(unlockedBetween(1, 2), ['DEFEND', 'OLIVE'])
  assert.deepEqual(unlockedBetween(2, 3), ['MAGNET', 'CAMO'])
  assert.deepEqual(unlockedBetween(4, 5), ['PERISCOPE', 'SKY'])
  assert.deepEqual(unlockedBetween(9, 10), ['LOADOUT 2', 'BONE'])
  assert.deepEqual(unlockedBetween(12, 14), [], 'nothing opens at 13 or 14')
  assert.deepEqual(unlockedBetween(3, 3), [], 'no level-up')
  // Two levels at once name both levels' unlocks.
  assert.deepEqual(unlockedBetween(1, 3), ['MAGNET', 'DEFEND', 'OLIVE', 'CAMO'])
  // Level by level adds up to the whole range: nothing named twice or missed.
  const all = unlockedBetween(1, 20)
  assert.equal(new Set(all).size, all.length)
  const stepwise: string[] = []
  for (let l = 1; l < 20; l++) stepwise.push(...unlockedBetween(l, l + 1))
  assert.deepEqual([...stepwise].sort(), [...all].sort())
})
