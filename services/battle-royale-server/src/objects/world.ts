import Consumable from './consumable'
import Player from './player'
import Obstacle from './obstacle'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Random } from '../utils/random'
import Portal from './portal'
import { type GameObject } from './gameobject'
import Mob from './mob'
import { ARCHETYPES } from '../archetypes/archetypes'
import { type Unit } from './unit'
import type Area from '../area/area'
import Exit from './exit'
import Timers from './timers'
// Type-only: throwable.ts imports this module, so a value import would add
// another edge to the import cycle described in world.spec.ts.
import type Throwable from './throwable'

export default class World {
  /** How long loot dropped on death survives on the ground, in ms. */
  static DROPPED_LOOT_LIFETIME = 30000
  /** Bosses the world tries to keep alive, counted separately from mobs. */
  static BOSS_COUNT = 5

  static TAGS = [-1, 0]
  static mapSize: number

  /**
   * Blocked cells per plane, as `Hex.key` values.
   *
   * Sparse on purpose: about 270 obstacles sit in a grid of roughly 15,000
   * cells, so a Set costs a few hundred entries instead of one byte per cell
   * per plane. That matters because the plan is many worlds per box, and this
   * is per-world state.
   *
   * Kept in step by `Obstacle`, which blocks its cell on construction and
   * releases it on destroy. Nothing else may write to it - a cell blocked
   * without an obstacle to explain it is invisible in every log.
   */
  static BLOCKED: Map<number, Set<number>> = new Map()

  /** Solid things only: rocks, stone-wall stones, portals, exits. */
  static OBSTACLES: GameObject[] = []
  /**
   * Fireballs and icicles in flight. Their own list, not OBSTACLES: they are
   * not solid, they must not count toward the rock refill, and the tick is the
   * only thing that removes them (see `updateProjectiles`).
   */
  static PROJECTILES: Throwable[] = []
  static CONSUMABLES: Consumable[] = []
  static PLAYERS: Player[] = []
  static MOBS: Unit[] = []
  static AREA_EFFECT: Area[] = []

  // Iterated in place by the spatial queries. Previously they built a fresh
  // PLAYERS.concat(MOBS) array on every call.
  static UNIT_SOURCES: Unit[][] = [World.PLAYERS as unknown as Unit[], World.MOBS]

  // Skill defaults only. Unit stats (max HP, contact damage) are in the
  // archetype table, archetypes.ts.
  static config = {
    defend: 0.5,
    // Per second, applied as `fire * dt` and floored per tick by `hit()`, so it
    // must be a multiple of 4 at 250 ms ticks: 60/s is 15 a tick, 60 a cast.
    fire: 60,
    melee: 20,
    ranged: 12
  }

  constructor (size: number) {
    World.mapSize = size

    for (const tag of World.TAGS) {
      for (let i = 0; i < 10; i++) {
        const pos = this.getUnobstructedPosition(40, tag)
        if (pos === undefined) continue
        const to = -1 - tag // -1->0, 0->-1
        World.OBSTACLES.push(new Portal(pos.x, pos.y, to, tag))
      }
      for (let i = 0; i < 4; i++) {
        const pos = this.getUnobstructedPosition(40, tag)
        if (pos === undefined) continue
        World.OBSTACLES.push(new Exit(pos.x, pos.y, tag))
      }
    }
  }

  static createPlayer (playerId: string): Player {
    const player = new Player(
      Random.RangeInt(0, World.mapSize),
      Random.RangeInt(0, World.mapSize),
      World.TAGS[Random.RangeInt(0, World.TAGS.length)],
      playerId
    )
    World.PLAYERS.push(player)
    return player
  }

  update (dt: number): void {
    // First, so work that fell due between ticks lands before anything moves,
    // exactly where a setTimeout firing between ticks used to leave it.
    Timers.run(Date.now())

    for (let i = World.PLAYERS.length - 1; i >= 0; i--) {
      const player = World.PLAYERS[i]
      if (player.destroyed) {
        this.createLootFrom(player)
        World.PLAYERS.splice(i, 1)
        continue
      }
      if (player.exited) {
        World.PLAYERS.splice(i, 1)
        continue
      }
      player.update(dt)
    }

    // Expire dropped loot. Nothing else removes a consumable except pickup.
    const now = Date.now()
    for (let i = World.CONSUMABLES.length - 1; i >= 0; i--) {
      const consumable = World.CONSUMABLES[i]
      if (consumable.expiresAt > 0 && now > consumable.expiresAt) {
        consumable.destroy()
        World.CONSUMABLES.splice(i, 1)
      }
    }

    for (const area of World.AREA_EFFECT) {
      area.update(dt)
    }

    for (let i = World.MOBS.length - 1; i >= 0; i--) {
      const mob = World.MOBS[i]
      if (mob.destroyed) {
        this.createLootFrom(mob)
        World.MOBS.splice(i, 1)
        continue
      }
      mob.update(dt)
    }

    World.updateProjectiles(dt)

    while (World.OBSTACLES.length < 300) {
      const tag = World.TAGS[Random.RangeInt(0, 2)]
      const pos = this.getUnobstructedPosition(40, tag)
      // break, not continue: the loop tests OBSTACLES.length, so skipping
      // without adding one spins forever inside the tick.
      if (pos === undefined) break
      // -1 because we dont have obstacles in the air yet
      World.OBSTACLES.push(new Obstacle(pos.x, pos.y, tag))
    }

    if (World.CONSUMABLES.length < 300) {
      const tag = World.TAGS[Random.RangeInt(0, World.TAGS.length)]
      const pos = this.getUnobstructedPosition(40, tag)
      if (pos !== undefined) World.CONSUMABLES.push(new Consumable(pos.x, pos.y, tag))
    }

    // fill the map with NPC's
    if (World.MOBS.length < 50) {
      const tag = World.TAGS[Random.RangeInt(0, World.TAGS.length)]
      const pos = this.getUnobstructedPosition(40, tag)
      if (pos !== undefined) World.MOBS.push(new Mob(pos.x, pos.y, tag, ARCHETYPES.grunt))
    }

    // Bosses are counted separately. Both guards used to read MOBS.length, so
    // five spawned during the first few ticks and none was ever replaced once
    // the mob population had filled past ten.
    let bosses = 0
    for (const mob of World.MOBS) if (mob.archetype === ARCHETYPES.boss) bosses++

    if (bosses < World.BOSS_COUNT) {
      const tag = World.TAGS[Random.RangeInt(0, World.TAGS.length)]
      const pos = this.getUnobstructedPosition(40, tag)
      if (pos !== undefined) World.MOBS.push(new Mob(pos.x, pos.y, tag, ARCHETYPES.boss))
    }
  }

  /**
   * Fly every projectile one tick, and drop the ones that are gone.
   *
   * **This is the only place a projectile leaves the list.** Its skill's
   * `explode` used to splice it out, and `explode` runs inside the projectile's
   * own `update`, so it removed an entry from the list this loop was walking
   * forwards: the entry after it slid into its slot and skipped a tick of
   * movement. Walking backwards and splicing only index `i` cannot skip
   * anything. A projectile that expired on its lifetime timer was destroyed by
   * `Timers.run` at the top of this tick, and is swept here unflown.
   *
   * Between ticks the list therefore holds no destroyed projectile, which is
   * what lets the join snapshot copy it as it stands.
   */
  static updateProjectiles (dt: number): void {
    for (let i = World.PROJECTILES.length - 1; i >= 0; i--) {
      const projectile = World.PROJECTILES[i]
      if (!projectile.destroyed) projectile.update(dt)
      if (projectile.destroyed) World.PROJECTILES.splice(i, 1)
    }
  }

  createLootFrom (value) {
    const dropTier = Math.max(50, Math.floor(value.loot / 5))
    let lootLeft = value.loot

    while (lootLeft > 0) {
      const newDropValue = Math.min(
        lootLeft,
        Random.RangeInt(0.5 * dropTier, 1.5 * dropTier)
      )
      lootLeft -= newDropValue

      World.CONSUMABLES.push(
        new Consumable(
          value.position.x + Random.RangeInt(-100, 100),
          value.position.y + Random.RangeInt(-100, 100),
          value.tag,
          undefined,
          newDropValue,
          World.DROPPED_LOOT_LIFETIME
        )
      )
    }
  }

  /** True if this cell blocks movement on this plane, or is off the map. */
  static isBlocked (q: number, r: number, tag: number): boolean {
    if (!Hex.onMap(q, r, World.mapSize)) return true
    return World.BLOCKED.get(tag)?.has(Hex.key(q, r)) ?? false
  }

  static block (q: number, r: number, tag: number): void {
    let cells = World.BLOCKED.get(tag)
    if (cells === undefined) {
      cells = new Set()
      World.BLOCKED.set(tag, cells)
    }
    cells.add(Hex.key(q, r))

    // Anything already routed through this cell has to be re-routed now, or it
    // walks into the new wall and stands there pressing against it. Done here
    // rather than in StoneWall so no future caller can forget it. Cheap: units
    // without a path return from `pathCrosses` immediately, which is every unit
    // during the world's initial fill.
    for (const source of World.UNIT_SOURCES) {
      for (const unit of source) {
        if (unit.tag !== tag) continue
        if (unit.pathCrosses(q, r)) unit.repath()
      }
    }
  }

  static unblock (q: number, r: number, tag: number): void {
    World.BLOCKED.get(tag)?.delete(Hex.key(q, r))
  }

  /** True if the cell and everything within `rings` steps of it is free. */
  static isClear (q: number, r: number, tag: number, rings: number): boolean {
    for (let dq = -rings; dq <= rings; dq++) {
      const lo = Math.max(-rings, -dq - rings)
      const hi = Math.min(rings, -dq + rings)
      for (let dr = lo; dr <= hi; dr++) {
        if (World.isBlocked(q + dq, r + dr, tag)) return false
      }
    }
    return true
  }

  /**
   * A free cell centre, or undefined if 40 tries found nothing.
   *
   * `buffer` was a clearance in world units tested against a scan of every
   * obstacle; it is now a ring count tested with a Set lookup, so this is both
   * exact and much cheaper. It still runs inside the tick, so it still cannot
   * loop unbounded - StoneWall lets players add obstacles and density is not
   * fixed.
   *
   * It used to return the last candidate whether or not it collided, which
   * spawned things inside rocks and left the push-out to shove them out. Callers
   * now skip a tick instead; at roughly 2% occupancy the cap is never reached in
   * practice anyway.
   */
  getUnobstructedPosition (buffer: number, tag: number): Vector | undefined {
    const rings = Math.ceil(buffer / Hex.SIZE)

    for (let attempts = 0; attempts < 40; attempts++) {
      const cell = Hex.toCell(new Vector(
        Random.RangeInt(0, World.mapSize),
        Random.RangeInt(0, World.mapSize)
      ))

      if (World.isClear(cell.x, cell.y, tag, rings)) return Hex.toPosition(cell)
    }

    return undefined
  }

  static FIND_NEAREST_FN (
    owner: GameObject,
    maxAngle: number,
    targets: GameObject[]
  ): GameObject | undefined {
    let nearest = Number.MAX_SAFE_INTEGER
    let result: GameObject | undefined
    for (const player of targets) {
      if (player === owner) continue

      if (player.tag !== owner.tag) continue

      if (maxAngle) {
        const angle = owner.direction.getAngleTo(
          player.position.sub(owner.position).getAngle()
        )
        if (maxAngle < Math.abs(angle)) continue
      }

      if (result != null && Random.Chance(0.2))
      // 20% of going somewhere not closest
      { return result }

      const dpos = player.position.sub(owner.position)
      const sqDistance = dpos.getSquareMagnitude()
      if (dpos.getSquareMagnitude() < nearest) {
        nearest = sqDistance
        result = player
      }
    }
    return result
  }

  /**
   * Units standing within `rings` cells of `origin` (a cell, not a position):
   * `rings` 0 is the origin cell alone, 1 adds its 6 neighbours, 2 is 19 cells.
   * A unit is in the area if the cell under its centre is, so an area is
   * exactly the cells it covers, however big the unit.
   *
   * N rings is every cell whose centre is at most N * Hex.SIZE from the
   * origin's centre (the ring's corners are at N * 45, its flat sides at
   * N * 39), so "N cells" in the balance pass is N rings.
   */
  static FIND_IN_CELLS (
    origin: Vector,
    rings: number,
    tag: number,
    typeMask: number
  ): Unit[] {
    const result = new Array<Unit>()
    for (const source of World.UNIT_SOURCES) {
      for (const unit of source) {
        if (unit.tag !== tag) continue
        if ((unit.type & typeMask) === 0) continue
        if (Hex.distance(origin, Hex.toCell(unit.position)) <= rings) result.push(unit)
      }
    }
    return result
  }

  /**
   * The `Hex.DIRECTIONS` index nearest to a facing (a world-space vector).
   *
   * DIRECTIONS runs clockwise from East in screen space (y grows downward), so
   * index i sits at exactly i * 60 degrees of `atan2(y, x)`. A facing exactly
   * halfway between two directions - due South (0, 1), due North (0, -1), or
   * 30 degrees either side of East or West - **rounds clockwise**, to the higher
   * angle: South snaps to SW, North to NE. The small epsilon is what makes that
   * hold for halfway facings whose angle is not exactly representable. A zero
   * vector snaps to East (`atan2(0, 0)` is 0), which matches `Unit.facing`'s
   * default.
   */
  static FACING_INDEX (facing: Vector): number {
    const sixths = Math.atan2(facing.y, facing.x) / (Math.PI / 3)
    const index = Math.floor(sixths + 0.5 + 1e-9)
    return ((index % 6) + 6) % 6
  }

  /**
   * The cells of a breath cone: `rings` rings of the 120-degree hex wedge in
   * front of `origin` (a cell), facing along `Hex.DIRECTIONS[direction]`.
   *
   * **This expansion is the definition of a cone** (decision #20), not an
   * approximation of an angle test. Ring 1 is the origin's neighbours in
   * directions d-1, d and d+1. Every later ring is those same three forward
   * neighbours of every cell in the ring before it, deduplicated by `Hex.key`.
   * The origin is not in the cone. Ring k holds 2k + 1 cells, so 3 rings is 15
   * cells and 4 rings is 24.
   *
   * Returned ring by ring, each cell once. **The deduplication runs against
   * every cell seen so far, not just the ring being built**: two forward steps
   * can land back in an earlier ring (NE then SE is E), so a per-ring dedupe
   * leaves ring 2 with 6 cells, one of them from ring 1. The *set* comes out the
   * same either way (`balance.spec.ts` checks that against the literal per-ring
   * expansion), but ring k holds exactly the 2k + 1 cells at distance k only
   * with the whole-cone dedupe.
   */
  static CONE_CELLS (origin: Vector, direction: number, rings: number): Vector[] {
    const turns = [(direction + 5) % 6, direction, (direction + 1) % 6]
    const result = new Array<Vector>()
    const seen = new Set<number>([Hex.key(origin.x, origin.y)])
    let frontier = [origin]
    for (let ring = 1; ring <= rings; ring++) {
      const next = new Array<Vector>()
      for (const cell of frontier) {
        for (const turn of turns) {
          const neighbour = Hex.neighbour(cell, turn)
          const key = Hex.key(neighbour.x, neighbour.y)
          if (seen.has(key)) continue
          seen.add(key)
          next.push(neighbour)
        }
      }
      result.push(...next)
      frontier = next
    }
    return result
  }

  static FIND_AROUND (
    x: number,
    y: number,
    tag: number,
    radius: number,
    typeMask: number
  ) {
    const sqRadius = radius * radius
    const result = new Array<Unit>()
    for (const source of World.UNIT_SOURCES) {
      for (const units of source) {
        if (units.tag !== tag) continue

        if ((units.type & typeMask) === 0) continue

        const dx = units.position.x - x
        const dy = units.position.y - y
        const sqDistance = dx * dx + dy * dy

        if (sqDistance < sqRadius) {
          result.push(units)
        }
      }
    }
    return result
  }

  static FIND_BETWEEN_POINTS (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    tag: number,
    typeMask: number
  ) {
    const result = new Array<Unit>()

    const sqPointDistance = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)

    let minx = 0
    let maxx = 0

    let miny = 0
    let maxy = 0

    if (x1 <= x2) {
      minx = x1
      maxx = x2
    } else {
      minx = x2
      maxx = x1
    }

    if (y1 <= y2) {
      miny = y1
      maxy = y2
    } else {
      miny = y2
      maxy = y1
    }

    for (const source of World.UNIT_SOURCES) {
      for (const candidate of source) {
      if (candidate.tag !== tag) continue

      if ((candidate.type & typeMask) === 0) continue

      if (candidate.position.x + candidate.radius < minx) continue

      if (candidate.position.x - candidate.radius > maxx) continue

      if (candidate.position.y + candidate.radius < miny) continue

      if (candidate.position.y - candidate.radius > maxy) continue

      const sqRadius = candidate.radius * candidate.radius

      const triangleArea =
        (x2 - x1) * (y1 - candidate.position.y) -
        (y2 - y1) * (x1 - candidate.position.x)
      const sqDistance = (triangleArea * triangleArea) / sqPointDistance

      if (sqDistance < sqRadius) {
        result.push(candidate)
      }
      }
    }
    return result
  }
}
