import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { type Fog } from '../objects/fog'
import { Session } from './session'

/**
 * The pixi-free part of `Game.start`: everything a run knows about its world
 * goes before the next one, which may be in another world
 * (worlds-per-process, #39). The map (blocked cells, valleys, portals), the
 * fog's explored cells (its radius is kept until the own create sets the
 * new robot's), and `Session`'s per-run state. `runmap.spec.ts` plays a
 * client through two worlds with exactly this.
 */
export function resetForRun (map: RunMap, fog: Fog): void {
  map.reset()
  fog.reset(fog.radius)
  Session.reset()
}

/** An `ObjectType` on the wire: 1 obstacle (a StoneWall stone, or a rock), 8 portal. */
const OBSTACLE_TYPE = 1
const PORTAL_TYPE = 1 << 3

/**
 * What this client knows of the map it is playing on: the cells it routes
 * around and the portals a route ends on. `Game.BLOCKED`, `Game.VOIDS` and
 * `Game.PORTALS` are this (`Game.MAP`).
 *
 * **Per run, not per connection** (worlds-per-process, decision #39). A server
 * runs several worlds and puts each run in whichever has room, so the next
 * run on the same socket can be another world: another valley map, other
 * portals, and object ids that mean something else. `Game.start` calls
 * `reset` before every run and `hello` brings the new valleys, so nothing of
 * the last world's map is routed on. Before this, `BLOCKED` was never cleared
 * and a StoneWall stone from the last run stayed solid for ever.
 *
 * Pixi-free, so the server's specs can play a client through two worlds
 * (`runmap.spec.ts`).
 */
export class RunMap {
  /**
   * Blocked cells per layer, mirroring `World.BLOCKED` on the server, from the
   * obstacles the server sends (so only those in view: the server searches
   * the same bounded window).
   */
  blocked = new Map<number, Set<number>>()
  /** Each layer's valleys by tag, from `hello.voids` (`Session.voids`). */
  voids = new Map<number, Set<number>>()
  /** Each layer's walls by tag, from `hello.walls` (`Session.walls`, decision #44). Blocked like the valleys. */
  walls = new Map<number, Set<number>>()
  /** Portals per layer: `Hex.key` of the portal's cell to the tag it leads to. */
  portals = new Map<number, Map<number, number>>()

  /** Forget the whole map: a new run, perhaps in another world. */
  reset (): void {
    this.blocked = new Map()
    this.voids = new Map()
    this.walls = new Map()
    this.portals = new Map()
  }

  /** The valleys from a `hello`: `voids[i]` is layer `layers[i]`'s. Replaces any before. */
  setVoids (layers: readonly number[], voids: ReadonlyArray<Set<number>>): void {
    this.voids = new Map(layers.map((tag, i) => [tag, voids[i] ?? new Set<number>()]))
  }

  /** The walls from a `hello`: `walls[i]` is layer `layers[i]`'s. Replaces any before. */
  setWalls (layers: readonly number[], walls: ReadonlyArray<Set<number>>): void {
    this.walls = new Map(layers.map((tag, i) => [tag, walls[i] ?? new Set<number>()]))
  }

  /** True if the cell is a valley, a wall or blocked on `tag`. The map edge is the caller's (`Game.isBlocked`). */
  has (q: number, r: number, tag: number): boolean {
    const key = Hex.key(q, r)
    return this.voids.get(tag)?.has(key) === true || this.walls.get(tag)?.has(key) === true || this.blocked.get(tag)?.has(key) === true
  }

  block (q: number, r: number, tag: number): void {
    let cells = this.blocked.get(tag)
    if (cells === undefined) {
      cells = new Set()
      this.blocked.set(tag, cells)
    }
    cells.add(Hex.key(q, r))
  }

  unblock (q: number, r: number, tag: number): void {
    this.blocked.get(tag)?.delete(Hex.key(q, r))
  }

  addPortal (q: number, r: number, tag: number, to: number): void {
    let cells = this.portals.get(tag)
    if (cells === undefined) {
      cells = new Map()
      this.portals.set(tag, cells)
    }
    cells.set(Hex.key(q, r), to)
  }

  removePortal (q: number, r: number, tag: number): void {
    this.portals.get(tag)?.delete(Hex.key(q, r))
  }

  portalTo (q: number, r: number, tag: number | undefined): number | undefined {
    if (tag === undefined) return undefined
    return this.portals.get(tag)?.get(Hex.key(q, r))
  }

  /**
   * A created object's part in the map (`Game.onObjectCreated`): a portal's
   * cell leads somewhere, an obstacle's cell is blocked. Portals and exits
   * are cells players walk into on purpose, so they stay routable. Returns
   * the cell it touched, if any, for the caller's re-route checks.
   */
  created (data: { type?: number, position?: { x: number, y: number }, tag?: number, to?: number }): Vector | undefined {
    if (data.position === undefined || data.tag === undefined) return undefined
    const cell = Hex.toCell(new Vector(data.position.x, data.position.y))
    if (data.type === PORTAL_TYPE && data.to !== undefined) {
      this.addPortal(cell.x, cell.y, data.tag, data.to)
      return cell
    }
    if (data.type === OBSTACLE_TYPE) {
      this.block(cell.x, cell.y, data.tag)
      return cell
    }
    return undefined
  }
}
