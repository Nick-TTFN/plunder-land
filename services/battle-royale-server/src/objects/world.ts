import Consumable from './consumable'
import ItemPickup from './itempickup'
import Player from './player'
import Obstacle from './obstacle'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Random } from '../utils/random'
import Portal from './portal'
import { type GameObject } from './gameobject'
import Mob from './mob'
import { type Archetype, type LayerSpec, ARCHETYPES, LAYERS, type Item } from '../archetypes/archetypes'
import { type Unit } from './unit'
import type Area from '../area/area'
import Exit from './exit'
import Timers from './timers'
// Type-only: throwable.ts imports this module, so a value import would add
// another edge to the import cycle described in world.spec.ts.
import type Throwable from './throwable'

/**
 * A player's status on the standings board. The values are the status bytes of
 * the `standings` event (`Multiplayer.buildStandings`), so they are
 * append-only.
 */
export enum Standing {
  ACTIVE = 0,
  EXTRACTED = 1,
  DEAD = 2
}

/** A player who has left the world, as the standings board remembers them. */
export interface FinishedPlayer {
  id: number
  name: string
  loot: number
  status: Standing
  /** `Date.now()` when they were recorded. */
  at: number
}

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
   * A portal leaves the player where it pushed them out, `Portal.RADIUS` +
   * their body from its centre (64 for a peep: 50 + 14), only now on the
   * other layer. Another portal there within twice that of the first one's
   * centre would catch them on arrival and send them on again in the same
   * tick. So the spacing is twice the arrival distance of the **largest robot
   * body** (`MAX_ROBOT_BODY`), plus `GATE_MARGIN`: 2 * (50 + 14) + 22 = 150
   * for today's table. Derived, not written down, so a bigger robot raises it
   * (gate-hygiene); only mobs are bigger today, and portals don't move mobs.
   *
   * Exits no longer push players out and no longer extract on contact: a
   * player extracts by standing on the exit's own cell (Player.onExit). An
   * exit at least `GATE_SPACING` from the portal is at least
   * `Portal.RADIUS + MAX_ROBOT_BODY + GATE_MARGIN` (86) from where the player
   * lands, and no cell reaches further than `Hex.SIZE` (45) from its centre
   * (its corners are about 26 out), so the arrival cell is never an exit's.
   * By the same sum, a player anywhere on an exit's cell is out of reach of
   * every portal on that layer. `gates.spec.ts` checks both for every robot.
   *
   * A getter because portal.ts sits in the import cycle world.spec.ts
   * describes: `Portal` may not be defined yet while this class is.
   */
  static get GATE_SPACING (): number {
    return 2 * (Portal.RADIUS + World.MAX_ROBOT_BODY) + World.GATE_MARGIN
  }

  /**
   * Headroom in `GATE_SPACING` over the least spacing that works, for a
   * same-tick shove on arrival (another player's push-out). 22 is what the
   * spacing carried when it was written down as 150 for a 14 body; keeping it
   * keeps today's layout unchanged.
   */
  static GATE_MARGIN = 22

  /**
   * The largest body among the robots (the player archetypes) in `ARCHETYPES`.
   * Portals move players only, so this is the body a portal hop allows for.
   */
  static get MAX_ROBOT_BODY (): number {
    let most = 0
    for (const archetype of Object.values(ARCHETYPES)) {
      if (archetype.kind === 'robot') most = Math.max(most, archetype.body)
    }
    return most
  }

  static mapSize: number

  /**
   * How long a player who extracted or died stays on the standings board, in
   * ms. Ten boards at one a second: long enough to be noticed, short enough
   * that the board is about who is playing now.
   */
  static FINISHED_LINGER_MS = 10_000
  /**
   * Hard cap on `FINISHED`, whatever the linger. Reached only if more than this
   * many players finish inside one linger window; the oldest go first.
   */
  static FINISHED_MAX = 64
  /**
   * Players who left `PLAYERS` recently, for the standings board. Oldest first.
   *
   * Eviction: an entry leaves at the first tick at least FINISHED_LINGER_MS
   * after it was added (`evictFinished`, top of `update`), or earlier when
   * FINISHED_MAX newer entries push it out (`finish`). Written only by those
   * two, so it is bounded by FINISHED_MAX even if the tick stalls.
   */
  static FINISHED: FinishedPlayer[] = []

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

  /**
   * Rocks, stone-wall stones, portals, exits. All solid, except that an exit
   * is a pad a player stands on (`GameObject.solidFor`).
   */
  static OBSTACLES: GameObject[] = []
  /**
   * Fireballs and icicles in flight. Their own list, not OBSTACLES: they are
   * not solid, they must not count toward the rock refill, and the tick is the
   * only thing that removes them (see `updateProjectiles`).
   */
  static PROJECTILES: Throwable[] = []
  static CONSUMABLES: Consumable[] = []
  /**
   * Usable items on the ground (decision #12). Their own list, not CONSUMABLES:
   * they are not loot and must not count toward a layer's loot cap. Removed by
   * pickup (`Player.update`) and expiry (`World.update`) only.
   */
  static ITEMS: ItemPickup[] = []
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
   * Joins on the top layer (#26), at a cell centre `spawnCell` picks. `name`
   * is the one the player typed, raw; Player's constructor sanitises it.
   */
  static createPlayer (playerId: string, name?: unknown): Player {
    const pos = Hex.toPosition(World.spawnCell(World.LAYERS[0].tag).cell)
    const player = new Player(pos.x, pos.y, World.LAYERS[0].tag, playerId, undefined, name)
    World.PLAYERS.push(player)
    return player
  }

  /**
   * Least hex distance (`Hex.distance`, in cells) from a new player's cell to
   * any exit, portal or boss on its layer, and to any other mob.
   * Provisional (`safe-spawn-placement`; Dez may retune). A random spawn used
   * to land close enough to an exit to extract within a second about one join
   * in 250.
   */
  static SPAWN_CLEARANCE = 3
  /** Random cells `spawnCell` tries before it falls back to a full scan. */
  static SPAWN_TRIES = 40

  /**
   * Where a new player on layer `tag` starts: a random cell that is on the
   * map, not blocked, and at least `SPAWN_CLEARANCE` cells from every gate
   * (portal or exit) and boss on the layer, and from every other live mob.
   *
   * Mobs are included because it is cheap (22 on layer 01) and a grunt on the
   * next cell attacks before the player has seen the screen. They are the soft
   * rule: mobs move, so the check only holds at the moment of joining, and
   * the fallback drops it before it drops anything else.
   *
   * After `SPAWN_TRIES` random cells, `fallback` is true and every cell of the
   * map is scanned instead: a random free cell clear of gates, bosses and mobs;
   * failing that, one clear of gates and bosses only; failing that, the free
   * cell furthest from the nearest gate or boss; and only if no cell at all is
   * free off a gate, the furthest cell regardless. It lands on a gate's own
   * cell only if every cell of the map holds one. In 10,000 spawns into fresh
   * worlds the scan never ran (`spawn.spec.ts`).
   */
  static spawnCell (tag: number): { cell: Vector, fallback: boolean } {
    const hazards: Vector[] = []
    const mobs: Vector[] = []
    for (const obj of World.OBSTACLES) {
      if (obj.tag === tag && (obj instanceof Portal || obj instanceof Exit)) hazards.push(Hex.toCell(obj.position))
    }
    for (const mob of World.MOBS) {
      if (mob.tag !== tag || mob.destroyed) continue
      if (mob.archetype === ARCHETYPES.boss) hazards.push(Hex.toCell(mob.position))
      else mobs.push(Hex.toCell(mob.position))
    }
    const nearest = (cell: Vector, from: Vector[]): number => {
      let best = Infinity
      for (const other of from) best = Math.min(best, Hex.distance(cell, other))
      return best
    }
    const n = World.SPAWN_CLEARANCE

    for (let attempt = 0; attempt < World.SPAWN_TRIES; attempt++) {
      const cell = Hex.toCell(new Vector(Random.RangeInt(0, World.mapSize), Random.RangeInt(0, World.mapSize)))
      if (World.isBlocked(cell.x, cell.y, tag)) continue
      if (nearest(cell, hazards) >= n && nearest(cell, mobs) >= n) return { cell, fallback: false }
    }

    // The scan. Bounds from the map's corners, padded by one; `onMap` trims.
    const low = Hex.toCell(new Vector(0, World.mapSize))
    const high = Hex.toCell(new Vector(World.mapSize, 0))
    const rMax = Hex.toCell(new Vector(World.mapSize, World.mapSize)).y + 1
    const clear: Vector[] = []
    const gateClear: Vector[] = []
    let furthestFree: Vector | undefined
    let furthestFreeDistance = -1
    let furthestAny: Vector | undefined
    let furthestAnyDistance = -1
    for (let r = -1; r <= rMax; r++) {
      for (let q = low.x - 1; q <= high.x + 1; q++) {
        if (!Hex.onMap(q, r, World.mapSize)) continue
        const cell = new Vector(q, r)
        const d = nearest(cell, hazards)
        if (d > furthestAnyDistance) { furthestAny = cell; furthestAnyDistance = d }
        if (World.isBlocked(q, r, tag)) continue
        if (d > furthestFreeDistance) { furthestFree = cell; furthestFreeDistance = d }
        if (d < n) continue
        gateClear.push(cell)
        if (nearest(cell, mobs) >= n) clear.push(cell)
      }
    }
    const pick = clear.length > 0 ? clear : gateClear
    if (pick.length > 0) return { cell: pick[Random.RangeInt(0, pick.length)], fallback: true }
    // A free cell on a gate (gates are not in BLOCKED) loses to a blocked cell
    // off it: a rock pushes the player out, a gate extracts or moves them. A
    // map with no cell centre on it at all is a configuration error.
    const last = furthestFreeDistance > 0 ? furthestFree : furthestAny
    if (last === undefined) throw new Error(`no cell on a ${World.mapSize}-unit map`)
    return { cell: last, fallback: true }
  }

  update (dt: number): void {
    // First, so work that fell due between ticks lands before anything moves,
    // exactly where a setTimeout firing between ticks used to leave it.
    Timers.run(Date.now())
    World.evictFinished(Date.now())

    for (let i = World.PLAYERS.length - 1; i >= 0; i--) {
      const player = World.PLAYERS[i]
      if (player.destroyed) {
        World.finish(player, Standing.DEAD)
        this.createLootFrom(player)
        this.createItemsFrom(player)
        World.PLAYERS.splice(i, 1)
        continue
      }
      if (player.exited) {
        World.finish(player, Standing.EXTRACTED)
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
    for (let i = World.ITEMS.length - 1; i >= 0; i--) {
      const item = World.ITEMS[i]
      if (item.expiresAt > 0 && now > item.expiresAt) {
        item.destroy()
        World.ITEMS.splice(i, 1)
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
    // Built only when a rock is due: that is one tick in most, and the scan
    // walks every obstacle.
    const keepOut = rocks < layer.rocks ? World.gateKeepOut(tag) : new Set<number>()
    while (rocks < layer.rocks) {
      const pos = this.getRockPosition(tag, keepOut)
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

    // Natural item pickups, one of each short kind a tick, like loot. A death
    // drop has an expiry and does not count.
    for (const { item, count } of layer.items) {
      let natural = 0
      for (const pickup of World.ITEMS) {
        if (pickup.tag === tag && pickup.kind === item && pickup.expiresAt === 0) natural++
      }
      if (natural >= count) continue
      const pos = this.getUnobstructedPosition(40, tag)
      if (pos !== undefined) World.ITEMS.push(new ItemPickup(pos.x, pos.y, tag, item))
    }
  }

  /**
   * Remember a player leaving `PLAYERS`, for the standings board. Their loot is
   * what they carried at the end: banked on an exit, dropped on a death.
   */
  static finish (player: Player, status: Standing, now: number = Date.now()): void {
    World.FINISHED.push({ id: player.id, name: player.name, loot: player.loot, status, at: now })
    if (World.FINISHED.length > World.FINISHED_MAX) {
      World.FINISHED.splice(0, World.FINISHED.length - World.FINISHED_MAX)
    }
  }

  /** Forget finished players whose linger is over. FINISHED is oldest first. */
  static evictFinished (now: number): void {
    let expired = 0
    while (expired < World.FINISHED.length && now - World.FINISHED[expired].at >= World.FINISHED_LINGER_MS) expired++
    if (expired > 0) World.FINISHED.splice(0, expired)
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

  /** How far from the body a dead player's items land, in rings (2 = 19 cells). */
  static DROP_RINGS = 2

  /**
   * Scatter a dead player's inventory: one pickup per item carried, each on a
   * random free cell centre within `DROP_RINGS` of the cell they died on, so
   * none lands inside a rock where it could never be reached. Each expires
   * after `DROPPED_LOOT_LIFETIME`, like dropped loot, for the same reason.
   * On the death cell itself if nothing around it is free.
   */
  createItemsFrom (player: Player): void {
    const carried = player.takeInventory()
    if (carried.length === 0) return

    const origin = player.cell
    const free: Vector[] = []
    const rings = World.DROP_RINGS
    for (let dq = -rings; dq <= rings; dq++) {
      const lo = Math.max(-rings, -dq - rings)
      const hi = Math.min(rings, -dq + rings)
      for (let dr = lo; dr <= hi; dr++) {
        if (!World.isBlocked(origin.x + dq, origin.y + dr, player.tag)) free.push(new Vector(origin.x + dq, origin.y + dr))
      }
    }
    if (free.length === 0) free.push(origin)

    for (const { item, count } of carried) {
      for (let n = 0; n < count; n++) this.dropItem(item, free[Random.RangeInt(0, free.length)], player.tag)
    }
  }

  private dropItem (item: Item, cell: Vector, tag: number): void {
    const at = Hex.toPosition(cell)
    World.ITEMS.push(new ItemPickup(at.x, at.y, tag, item, World.DROPPED_LOOT_LIFETIME))
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
   * Rings around a gate's cell that the rock refill leaves empty: 2 for
   * today's table (the gate's cell, its 6 neighbours and the 12 beyond).
   *
   * Gates are not in `BLOCKED` (they are walked into on purpose), so the
   * refill could not see them and put rocks on portal and exit cells
   * (gate-hygiene). A rock on an exit's cell sat on the pad, and one beside a
   * gate narrowed the way on to it.
   *
   * Derived: the fewest rings that keep every rock clear of a player held
   * against a portal, or put down by one on the other layer. Both stand
   * `Portal.RADIUS` + body from the portal's centre, so a rock must be a
   * further body + `Hex.RADIUS` (its collider) out: 50 + 14 + 14 + 22.5 =
   * 100.5 for a peep. Cells two steps away can be 78 from the centre (cells
   * are `Hex.SIZE` apart), three steps 119, so two rings. A bigger robot
   * raises it. Exits use the same rings; any ring at all keeps a pad
   * reachable from every side.
   *
   * A getter for the same import-cycle reason as `GATE_SPACING`.
   */
  static get GATE_ROCK_RINGS (): number {
    const clear = Portal.RADIUS + 2 * World.MAX_ROBOT_BODY + Hex.RADIUS
    for (let rings = 0; rings < 64; rings++) {
      if (World.ringDistance(rings + 1) >= clear) return rings
    }
    throw new Error(`no ring count keeps rocks ${clear} from a portal`)
  }

  /** The least distance from a cell's centre to the centre of a cell exactly `k` steps away. */
  static ringDistance (k: number): number {
    const origin = new Vector(0, 0)
    let least = Infinity
    for (let dq = -k; dq <= k; dq++) {
      for (let dr = -k; dr <= k; dr++) {
        const cell = new Vector(dq, dr)
        if (Hex.distance(origin, cell) !== k) continue
        least = Math.min(least, Hex.toPosition(cell).getMagnitude())
      }
    }
    return least
  }

  /**
   * `Hex.key`s of the cells on layer `tag` within `GATE_ROCK_RINGS` of a gate
   * cell: every portal and exit on the layer, and every portal on another
   * layer that leads here, at its own position, because that is where it puts
   * players down.
   */
  static gateKeepOut (tag: number): Set<number> {
    const cells = new Set<number>()
    const rings = World.GATE_ROCK_RINGS
    for (const gate of World.OBSTACLES) {
      // `to` is only meaningful on a portal: every object defaults it to 0,
      // which is also layer 01's tag.
      const here = (gate instanceof Portal || gate instanceof Exit) && gate.tag === tag
      const arrives = gate instanceof Portal && gate.to === tag && gate.tag !== tag
      if (!here && !arrives) continue
      const centre = Hex.toCell(gate.position)
      for (let dq = -rings; dq <= rings; dq++) {
        const lo = Math.max(-rings, -dq - rings)
        const hi = Math.min(rings, -dq + rings)
        for (let dr = lo; dr <= hi; dr++) cells.add(Hex.key(centre.x + dq, centre.y + dr))
      }
    }
    return cells
  }

  /**
   * Where the refill puts a world rock on layer `tag`: what
   * `getUnobstructedPosition(40, tag)` would pick, but never a cell in
   * `keepOut` (`gateKeepOut`). Its own function rather than a filter on the
   * shared one, which also places loot, items and mobs, none of which is
   * kept off gates. Bounded at 40 tries like it, and undefined after.
   */
  private getRockPosition (tag: number, keepOut: Set<number>): Vector | undefined {
    const rings = Math.ceil(40 / Hex.SIZE)

    for (let attempts = 0; attempts < 40; attempts++) {
      const cell = Hex.toCell(new Vector(
        Random.RangeInt(0, World.mapSize),
        Random.RangeInt(0, World.mapSize)
      ))

      if (keepOut.has(Hex.key(cell.x, cell.y))) continue
      if (World.isClear(cell.x, cell.y, tag, rings)) return Hex.toPosition(cell)
    }

    return undefined
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
