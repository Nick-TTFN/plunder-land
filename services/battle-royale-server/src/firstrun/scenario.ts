import World from '../objects/world'
import Mob from '../objects/mob'
import HandoffGate from './gate'
import { type Archetype, ARCHETYPES, LAYERS } from '../archetypes/archetypes'
import { encodeRuns } from '../objects/valleys'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * A first run's private map (decision #58): built into a `World` made with
 * `firstRun: true`, which has no valleys, gates, walls or refill of its own
 * (task retest-4). The content is Dez's strip (`ideas/retest-onboarding.md`
 * section 4, accepted as proposed in #58 addendum 2, Q9; task retest-5):
 * a bent strip of ground with valleys either side, and four beats along it.
 *
 * 1. The start: nothing within reach. (Dez's "glint" at the edge of vision has
 *    no art and is left out.)
 * 2. Three rocks (`ARCHETYPES.rock`: 24 HP, 3 loot each, inert).
 * 3. One Crawler that shoots back: the real archetype and numbers.
 * 4. One Compactor: the real archetype; its slam's cells are drawn ahead.
 * 5. The pad (`HandoffGate`) at the strip's end.
 *
 * Every mob guards the cell it is placed on (its guard's home), and nothing
 * refills (`World.firstRun`). Every number here is the scenario's; nothing
 * else reads them.
 */
export const FIRST_RUN = Object.freeze({
  /** The map, in world units: about 27 cells across, room for the strip. */
  mapSize: 1200,
  /** The strip's first centreline cell (axial), on the first layer: the start. */
  start: Object.freeze({ q: 3, r: 4 }),
  /**
   * The strip's centreline after the start: straight legs along
   * `Hex.DIRECTIONS[dir]`, `cells` each. 1 + 12 + 13 = 26 cells, indices 0-25,
   * bent once at 12.
   */
  legs: Object.freeze([Object.freeze({ dir: 0, cells: 12 }), Object.freeze({ dir: 1, cells: 13 })]),
  /** Rings of ground either side of the centreline: 2 makes the strip 5 cells wide. */
  halfWidth: 2,
  /**
   * The rocks: centreline index, then a step off it along `Hex.DIRECTIONS[side]`
   * (null: on the line), so the three don't stand in single file. The
   * nearest is 7 cells from the start: beyond a robot's vision (6) and its
   * shot (6), so nothing is within reach at the start (beat 1); Dez's "about
   * cell 6", one further.
   */
  rocks: Object.freeze([
    Object.freeze({ at: 7, side: null }),
    Object.freeze({ at: 8, side: 1 }),
    Object.freeze({ at: 8, side: 4 })
  ]),
  /**
   * The Crawler and the Compactor, by centreline index. The Crawler stands
   * at least 7 rings from every rock (its notice range is 5), so a player at
   * the rocks learns to shoot before anything shoots back (Jeremy's re-test,
   * 2026-11-05: at 12 the rocks were 4-5 rings away, inside its notice).
   * The Compactor is 9+ rings from where the Crawler fight happens.
   */
  crawlerAt: 16,
  compactorAt: 21,
  /** The pad: the centreline's last cell. */
  padAt: 25
})

/** The strip's centreline, start first, and every cell of the strip (`Hex.key`). */
export function firstRunStrip (): { line: Vector[], cells: Set<number> } {
  const line = [new Vector(FIRST_RUN.start.q, FIRST_RUN.start.r)]
  for (const leg of FIRST_RUN.legs) {
    for (let i = 0; i < leg.cells; i++) line.push(Hex.neighbour(line[line.length - 1], leg.dir))
  }
  const cells = new Set<number>()
  const w = FIRST_RUN.halfWidth
  for (const centre of line) {
    for (let dq = -w; dq <= w; dq++) {
      for (let dr = -w; dr <= w; dr++) {
        const cell = new Vector(centre.x + dq, centre.y + dr)
        if (Hex.distance(cell, centre) <= w && Hex.onMap(cell.x, cell.y, FIRST_RUN.mapSize)) cells.add(Hex.key(cell.x, cell.y))
      }
    }
  }
  return { line, cells }
}

/** A scenario mob of `archetype` on `cell`, carrying its loot and handicap (`Mob.handicap`) as a layer's spawn would (`World.placeMob`). */
function place (archetype: Archetype, cell: Vector, tag: number, lootMultiplier: number, handicap: number): Mob {
  const at = Hex.toPosition(cell)
  const mob = new Mob(at.x, at.y, tag, archetype, handicap)
  mob.loot = Math.round(archetype.loot * lootMultiplier)
  // Server-side only, as `placeMob` keeps it (no "+25" floated over it on sight).
  mob.dirtyFields.delete('loot')
  World.addUnit(World.MOBS, mob)
  return mob
}

/** Fills the current world, which must be a fresh first-run world, with the scenario. */
export function buildFirstRun (world: World): void {
  World.expect(world, 'buildFirstRun')
  if (!world.firstRun) throw new Error('buildFirstRun: not a first-run world')
  const tag = World.TAGS[0]
  const size = FIRST_RUN.mapSize
  const { line, cells } = firstRunStrip()

  // Valleys everywhere off the strip, on the first layer only (nobody
  // reaches the others): the world's own `VOIDS`, so `hello.voids` carries
  // them and the client draws and routes them as on any map.
  const voids = new Set<number>()
  for (const cell of Hex.mapCells(size)) {
    const key = Hex.key(cell.x, cell.y)
    if (cells.has(key)) continue
    voids.add(key)
    World.block(cell.x, cell.y, tag, null)
  }
  World.VOIDS.set(tag, voids)
  World.VOID_RUNS.set(tag, encodeRuns(voids, size))

  world.spawn = line[0]
  // Rocks are exact (3 each, single digits like layer 01 since 2026-11-06,
  // and their full 24 HP: the "two shots" beat); the NPCs carry layer 01's
  // loot and handicap, as there.
  for (const rock of FIRST_RUN.rocks) {
    const on = line[rock.at]
    place(ARCHETYPES.rock, rock.side === null ? on : Hex.neighbour(on, rock.side), tag, 1, 1)
  }
  const handicap = LAYERS[0].mobHandicap ?? 1
  place(ARCHETYPES.crawler, line[FIRST_RUN.crawlerAt], tag, LAYERS[0].lootMultiplier, handicap)
  place(ARCHETYPES.compactor, line[FIRST_RUN.compactorAt], tag, LAYERS[0].lootMultiplier, handicap)

  const pad = Hex.toPosition(line[FIRST_RUN.padAt])
  World.addObstacle(new HandoffGate(pad.x, pad.y, tag))
}
