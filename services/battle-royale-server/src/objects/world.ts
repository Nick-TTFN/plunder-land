import Consumable from './consumable'
import Player from './player'
import Obstacle from './obstacle'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Random } from '../utils/random'
import Portal from './portal'
import { type GameObject } from './gameobject'
import Mob from './mob'
import { type Archetype, type LayerSpec, LAYERS } from '../archetypes/archetypes'
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

  /**
   * The ground layers, top (01) first, and what each one holds. The numbers
   * live in `LAYERS` (archetypes.ts); this is only a handle on them.
   */
  static LAYERS: readonly LayerSpec[] = LAYERS
  /** Every layer's tag, in `LAYERS` order. Sent to clients as `hello.layers`. */
  static TAGS: number[] = LAYERS.map((layer) => layer.tag)

  /**
   * Least distance between the centres of two gates (portals and exits) that
   * a player could meet on the same layer: two on one layer, or a portal and
   * any gate on the layer it leads to.
   *
   * A portal leaves the player where it pushed them out, 64 from its centre
   * (its radius 50 + a peep's body 14), only now on the other layer. A gate
   * there within 128 of the portal's centre would catch them on arrival and
   * send them on again, or extract them, in the same tick. 150 clears that
   * with a margin.
   */
  static GATE_SPACING = 150
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

    // Portals chain the layers in order: 01 <-> 02 <-> 03. A layer's up
    // portals lead to the one before it in LAYERS, its down portals to the one
    // after. A count with no layer to lead to is a table error, not a portal to
    // nowhere.
    World.LAYERS.forEach((layer, i) => {
      const above = World.LAYERS[i - 1]
      const below = World.LAYERS[i + 1]
      if (layer.portalsUp > 0) {
        if (above === undefined) throw new Error(`layer ${layer.tag} has up portals but nothing above it`)
        for (let n = 0; n < layer.portalsUp; n++) this.placeGate(layer.tag, above.tag)
      }
      if (layer.portalsDown > 0) {
        if (below === undefined) throw new Error(`layer ${layer.tag} has down portals but nothing below it`)
        for (let n = 0; n < layer.portalsDown; n++) this.placeGate(layer.tag, below.tag)
      }
      for (let n = 0; n < layer.exits; n++) this.placeGate(layer.tag, undefined)
    })
  }

  /**
   * A portal to `to`, or an exit when `to` is undefined, at a free cell of
   * layer `tag` that keeps `GATE_SPACING` from every gate a player could meet
   * on either layer. Skipped, as a gate always was, if no such cell turns up.
   *
   * Gates are not in `BLOCKED` (they are walked into on purpose), so
   * `getUnobstructedPosition` cannot see them and the spacing is tested here.
   * Only the constructor places gates, before any rock exists.
   */
  private placeGate (tag: number, to: number | undefined): void {
    const reach = to === undefined ? [tag] : [tag, to]
    const sq = World.GATE_SPACING * World.GATE_SPACING

    for (let attempt = 0; attempt < 20; attempt++) {
      const pos = this.getUnobstructedPosition(40, tag)
      if (pos === undefined) continue

      const crowded = World.OBSTACLES.some((gate) => {
        if (!(gate instanceof Portal) && !(gate instanceof Exit)) return false
        // `to` is only meaningful on a portal: every object defaults it to 0,
        // which is also layer 01's tag.
        const gateReach = gate instanceof Portal ? [gate.tag, gate.to] : [gate.tag]
        if (!gateReach.some((t) => reach.includes(t))) return false
        return gate.position.sub(pos).getSquareMagnitude() < sq
      })
      if (crowded) continue

      World.OBSTACLES.push(to === undefined ? new Exit(pos.x, pos.y, tag) : new Portal(pos.x, pos.y, to, tag))
      return
    }
  }

  /**
   * Joins on the top layer (#26). Where on it is still any random point:
   * safe placement is `safe-spawn-placement`. `name` is the one the player
   * typed, raw; Player's constructor sanitises it.
   */
  static createPlayer (playerId: string, name?: unknown): Player {
    const player = new Player(
      Random.RangeInt(0, World.mapSize),
      Random.RangeInt(0, World.mapSize),
      World.LAYERS[0].tag,
      playerId,
      undefined,
      name
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

    for (const layer of World.LAYERS) this.refillLayer(layer)
  }

  /**
   * A world rock: an `Obstacle` with no lifetime. StoneWall stones are
   * Obstacles too but always timed, so casting a wall does not stop the refill
   * (balance pass: "the count should not move when someone casts StoneWall").
   */
  static isRock (obj: GameObject): boolean {
    return obj instanceof Obstacle && !(obj.lifetime > 0)
  }

  /**
   * Top a layer back up to its `LAYERS` numbers: rocks all at once, then at
   * most one natural pickup and one mob of each short archetype per tick.
   *
   * Every count is per layer. The rock refill used to pick
   * `TAGS[RangeInt(0, 2)]` and fill to a world-wide 300 that included the
   * gates, so a third layer would have got no rocks at all; mobs and pickups
   * were world totals on random layers.
   *
   * Bosses and gunners are counted by archetype, as they were: both guards
   * once read MOBS.length, so five bosses spawned in the first few ticks and
   * none was ever replaced once the population had filled past ten. Each
   * archetype now has its own count, so grunts no longer fill whatever the
   * others leave, and the total never sits above the table's sum.
   */
  private refillLayer (layer: LayerSpec): void {
    const tag = layer.tag

    let rocks = 0
    for (const obj of World.OBSTACLES) if (obj.tag === tag && World.isRock(obj)) rocks++
    while (rocks < layer.rocks) {
      const pos = this.getUnobstructedPosition(40, tag)
      // break, not continue: nothing else ends this loop, so skipping without
      // adding one spins forever inside the tick.
      if (pos === undefined) break
      World.OBSTACLES.push(new Obstacle(pos.x, pos.y, tag))
      rocks++
    }

    // Natural pickups only: a death drop has an expiry, and does not count.
    let natural = 0
    for (const c of World.CONSUMABLES) if (c.tag === tag && c.expiresAt === 0) natural++
    if (natural < layer.naturalLoot) {
      const pos = this.getUnobstructedPosition(40, tag)
      if (pos !== undefined) {
        // The radius is drawn here rather than by Consumable, because the loot
        // is derived from it and must be in place before the create goes out.
        // Same range as Consumable's own default. The cast is because that
        // parameter's `= undefined` default types it as undefined; the
        // constructor reads it as a number (`radius || RangeInt(15, 25)`).
        const radius = Random.RangeInt(15, 25)
        World.CONSUMABLES.push(new Consumable(
          pos.x, pos.y, tag, radius as unknown as undefined, Math.round(radius * layer.lootMultiplier)
        ))
      }
    }

    // Mobs never change layer (portals move players only, #26), so a mob
    // counts where it spawned.
    for (const { archetype, count } of layer.mobs) {
      let alive = 0
      for (const mob of World.MOBS) {
        if (mob.tag === tag && mob.archetype === archetype && !mob.destroyed) alive++
      }
      if (alive < count) this.spawnMob(archetype, layer)
    }
  }

  /** One mob of `archetype` on `layer`, carrying the layer's loot, if a free spot turns up. */
  private spawnMob (archetype: Archetype, layer: LayerSpec): void {
    const pos = this.getUnobstructedPosition(40, layer.tag)
    if (pos === undefined) return
    const mob = new Mob(pos.x, pos.y, layer.tag, archetype)
    mob.loot = Math.round(archetype.loot * layer.lootMultiplier)
    // A mob's loot is server-side only: it is not in its create record
    // (`allFields`), and nothing else ever marks it. Left dirty, the next
    // update would send it, and the client floats any loot change over a unit
    // as a "+88" the moment it comes into view.
    mob.dirtyFields.delete('loot')
    World.MOBS.push(mob)
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

  /**
   * The first unit standing on `cells` (a `Hex.line`), walking the line in
   * order: the unit on the earliest cell, and of several on that cell the one
   * whose centre is nearest `from`. A unit is on a cell if the cell under its
   * centre is, as in `FIND_IN_CELLS`, so a big unit whose body spills into a
   * line cell is not on it. `exclude` (the caster) and destroyed units are
   * skipped. Undefined if nobody is on the line.
   *
   * This is `RangedAttack`'s hit test (decision #25). The client's port is
   * `firstOnLine` in `plunder-land-client/src/vfx/cells.ts`, checked against
   * this by `effectcells.spec.ts`.
   */
  static FIRST_ON_LINE (
    cells: Vector[],
    from: Vector,
    tag: number,
    typeMask: number,
    exclude?: Unit
  ): Unit | undefined {
    const order = new Map<number, number>()
    cells.forEach((cell, i) => {
      const key = Hex.key(cell.x, cell.y)
      if (!order.has(key)) order.set(key, i)
    })

    let first: Unit | undefined
    let firstIndex = Infinity
    let firstSq = Infinity
    for (const source of World.UNIT_SOURCES) {
      for (const unit of source) {
        if (unit === exclude || unit.destroyed) continue
        if (unit.tag !== tag) continue
        if ((unit.type & typeMask) === 0) continue
        const cell = Hex.toCell(unit.position)
        const index = order.get(Hex.key(cell.x, cell.y))
        if (index === undefined || index > firstIndex) continue
        const sq = unit.position.sub(from).getSquareMagnitude()
        if (index < firstIndex || sq < firstSq) {
          first = unit
          firstIndex = index
          firstSq = sq
        }
      }
    }
    return first
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
