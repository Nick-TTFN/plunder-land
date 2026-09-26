import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type Redis from 'ioredis'
// See world.spec.ts: enter the module graph through multiplayer, as index.ts does.
import Multiplayer from '../network/multiplayer'
import World from './world'
import Timers from './timers'
import Obstacle from './obstacle'
import Exit from './exit'
import Mob from './mob'
import Player from './player'
import { ARCHETYPES } from '../archetypes/archetypes'

/**
 * Push-out is gone (hex-cells P2, decision #31): terrain blocks cells, units
 * don't. Players route only through free cells and mobs step only into free
 * ones, so nothing is ever shoved out of a rock, a gate or another unit.
 *
 * This file pinned the push-outs' coincident-centre case (`player-mob-nan`: a
 * 0/0 normalisation writing NaN into a position). With no push-out there is
 * no normalisation to divide by zero; these check that units sharing a point
 * stay where they are, finite, and that nothing moves a unit that is standing
 * still.
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

function assertStayed (unit: { position: { x: number, y: number } }, x: number, y: number): void {
  const at = unit.position
  assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y), `position is (${at.x}, ${at.y})`)
  assert.deepEqual([at.x, at.y], [x, y], 'something moved a unit that was standing still')
}

test('a player on exactly a mob\'s point stays there: players may share a cell with a mob', () => {
  const player = new Player(1000, 1000, TOP, 'p1')
  World.PLAYERS.push(player)
  const mob = new Mob(1000, 1000, TOP, ARCHETYPES.gunner)
  mob.routines.length = 0
  World.MOBS.push(mob)

  player.update(DT)
  mob.update(DT)

  assertStayed(player, 1000, 1000)
  assertStayed(mob, 1000, 1000)
})

test('a player on exactly another player\'s point stays there: players may stack', () => {
  const other = new Player(1000, 1000, TOP, 'p2')
  const player = new Player(1000, 1000, TOP, 'p1')
  World.PLAYERS.push(other, player)

  player.update(DT)
  other.update(DT)

  assertStayed(player, 1000, 1000)
  assertStayed(other, 1000, 1000)
})

test('a player on a rock\'s centre is not moved by it (it could only get there by being put there)', () => {
  // Obstacle snaps to its cell's centre, so stand on wherever it landed.
  const rock = new Obstacle(1000, 1000, TOP)
  World.OBSTACLES.push(rock)
  const player = new Player(rock.position.x, rock.position.y, TOP, 'p1')
  World.PLAYERS.push(player)

  player.update(DT)

  assertStayed(player, rock.position.x, rock.position.y)
})

test('a player standing on an exit off its centre is not pushed anywhere', () => {
  const exit = new Exit(1000, 1000, TOP)
  World.OBSTACLES.push(exit)
  const player = new Player(1005, 1000, TOP, 'p1')
  World.PLAYERS.push(player)

  player.update(DT)

  assertStayed(player, 1005, 1000)
})
