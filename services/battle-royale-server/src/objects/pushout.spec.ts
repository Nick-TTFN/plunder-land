import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Obstacle from './obstacle'
import Mob from './mob'
import Player from './player'
import { ARCHETYPES } from '../archetypes/archetypes'

/**
 * `player-mob-nan`: a unit standing on exactly the centre of something solid.
 *
 * Every push-out normalises the vector between the two centres, and on the
 * same point that is 0/0. A NaN position never recovers: every later push-out,
 * clamp and distance test compares false against it. Both sides of a pair walk
 * to cell centres, so coincident centres are an ordinary event, not a freak:
 * a 200-bot run hit the mob case twice in five minutes.
 */

const DT = 0.25
const TOP = 0

beforeEach(() => {
  const redis = { on: () => redis, hincrby: async () => 0 } as unknown as Redis
  // eslint-disable-next-line no-new
  new Multiplayer(250, redis)
  World.mapSize = 4000
  World.BLOCKED.clear()
  World.OBSTACLES.length = 0
  World.PROJECTILES.length = 0
  World.CONSUMABLES.length = 0
  World.ITEMS.length = 0
  World.PLAYERS.length = 0
  World.MOBS.length = 0
  World.AREA_EFFECT.length = 0
  Timers.clear()
})

function assertPushedClear (player: Player, other: { position: { x: number, y: number }, radius: number }): void {
  const { x, y } = player.position
  assert.ok(Number.isFinite(x) && Number.isFinite(y), `position is (${x}, ${y})`)
  const distance = Math.hypot(x - other.position.x, y - other.position.y)
  // Pushed to touching, not left overlapping and not flung somewhere else.
  assert.ok(Math.abs(distance - (player.radius + other.radius)) < 1e-6, `ended ${distance} from its centre`)
}

test('a player on exactly a mob\'s point is pushed clear, not to NaN', () => {
  const player = new Player(1000, 1000, TOP, 'p1')
  World.PLAYERS.push(player)
  const mob = new Mob(1000, 1000, TOP, ARCHETYPES.gunner)
  World.MOBS.push(mob)

  player.update(DT)

  assertPushedClear(player, mob)
})

test('the coincident mob push-out goes along -x, as Unit.update\'s do', () => {
  // A fixed axis rather than a random one, so the answer is the same every
  // run and matches the obstacle and player push-outs in Unit.update.
  const player = new Player(1000, 1000, TOP, 'p1')
  World.PLAYERS.push(player)
  const mob = new Mob(1000, 1000, TOP, ARCHETYPES.gunner)
  World.MOBS.push(mob)

  player.update(DT)

  assert.deepEqual(
    { x: player.position.x, y: player.position.y },
    { x: 1000 - (mob.radius + player.radius), y: 1000 })
})

test('a player on exactly a rock\'s centre is pushed clear, not to NaN', () => {
  // Obstacle snaps to its cell's centre, so stand on wherever it landed.
  const rock = new Obstacle(1000, 1000, TOP)
  World.OBSTACLES.push(rock)
  const player = new Player(rock.position.x, rock.position.y, TOP, 'p1')
  World.PLAYERS.push(player)

  player.update(DT)

  assertPushedClear(player, rock)
})

test('a player on exactly another player\'s point is pushed clear, not to NaN', () => {
  const other = new Player(1000, 1000, TOP, 'p2')
  const player = new Player(1000, 1000, TOP, 'p1')
  World.PLAYERS.push(other, player)

  player.update(DT)

  assertPushedClear(player, other)
})

test('a mob on exactly a player\'s point is pushed clear, not to NaN', () => {
  // The other half of the mob pair: Unit.update's player push-out, run by the mob.
  const player = new Player(1000, 1000, TOP, 'p1')
  World.PLAYERS.push(player)
  const mob = new Mob(1000, 1000, TOP, ARCHETYPES.gunner)
  World.MOBS.push(mob)

  mob.update(DT)

  const { x, y } = mob.position
  assert.ok(Number.isFinite(x) && Number.isFinite(y), `position is (${x}, ${y})`)
})
