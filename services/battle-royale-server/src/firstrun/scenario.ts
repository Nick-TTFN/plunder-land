import World from '../objects/world'
import Consumable from '../objects/consumable'
import HandoffGate from './gate'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * A first run's private map (decision #58, task retest-4): built into a
 * `World` made with `firstRun: true`, which has no valleys, gates, walls or
 * refill of its own. **Placeholder content** until retest-5 builds Dez's
 * strip: the start, one harmless thing to take (a loot pickup), and the
 * handoff gate.
 *
 * Every number here is the scenario's; nothing else reads them.
 */
export const FIRST_RUN = Object.freeze({
  /** The map, in world units: about 27 cells across, room for retest-5's 24-cell strip. */
  mapSize: 1200,
  /** The start cell (axial), on the first layer. */
  start: Object.freeze({ q: 4, r: 12 }),
  /** The placeholder's loot pickup, cells east of the start, and its value. */
  lootAt: 4,
  loot: 25,
  /** The handoff gate, cells east of the start. */
  gateAt: 8
})

/** Fills the current world, which must be a fresh first-run world, with the scenario. */
export function buildFirstRun (world: World): void {
  World.expect(world, 'buildFirstRun')
  if (!world.firstRun) throw new Error('buildFirstRun: not a first-run world')
  const tag = World.TAGS[0]
  const start = new Vector(FIRST_RUN.start.q, FIRST_RUN.start.r)
  world.spawn = start
  const east = (cells: number): Vector => Hex.toPosition(new Vector(start.x + cells, start.y))

  const loot = east(FIRST_RUN.lootAt)
  World.PICKUPS.push(World.CONSUMABLES, new Consumable(loot.x, loot.y, tag, undefined, FIRST_RUN.loot))

  const gate = east(FIRST_RUN.gateAt)
  World.addObstacle(new HandoffGate(gate.x, gate.y, tag))
}
