import Consumable from './consumable'
import ItemPickup from './itempickup'
import Player from './player'
import Obstacle from './obstacle'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Random } from '../utils/random'
import Portal from './portal'
import { GameObject, IdPool, ObjectType } from './gameobject'
import Mob from './mob'
import { type Archetype, type LayerSpec, ARCHETYPES, LAYERS, type Item } from '../archetypes/archetypes'
import { ARCHETYPE_INFO, SELECTABLE_ROBOTS } from '../utils/archetypes'
import { type Unit } from './unit'
import type Area from '../area/area'
import Exit from './exit'
import Timers from './timers'
// Type-only: throwable.ts imports this module, so a value import would add
// another edge to the import cycle described in world.spec.ts.
import type Throwable from './throwable'
import { CellIndex } from '../utils/cellindex'
import { carveValleys, encodeRuns } from './valleys'
import { placeWalls } from './walls'
// Read inside functions only (the interest bucket size): multiplayer imports
// this module, so its default export is not defined yet while this one loads.
import Multiplayer from '../network/multiplayer'

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
  /** A bot (decision #47): its standings row is flagged. */
  bot?: boolean
}

/** How a world is built (`new World(size, options)`). */
export interface WorldOptions {
  /**
   * The Multiplayer this world sends through, and whose connections are its
   * clients. Default: the current world's, which is what a spec that assigns
   * `Multiplayer.Instance` before `new World()` expects. The server always
   * passes one (`Worlds`), because objects the constructor makes (portals,
   * exits) are sent through it before the constructor returns.
   */
  multiplayer?: Multiplayer
  /** No valleys and no gates: only the default world (`World.current` before any `new World()`). */
  empty?: boolean
}

/**
 * Work reached the wrong world: no world was current (`World.strict`), or a
 * world or its Multiplayer was used while another was current. Counted in
 * `World.wrongWorld` as well as thrown, so it shows up even where a catch
 * swallows it (`Multiplayer.guarded`, the tick's own try/catch).
 */
export class WrongWorldError extends Error {}

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
   * Least hex distance, in rings, between the cells of two gates (portals and
   * exits) that a player could meet on the same layer: two on one layer, or a
   * portal and any gate on the layer it leads to (decision #34).
   *
   * A portal puts a player down on its arrival cell (`World.arrivalOf`, one
   * ring out) on the other layer (#31 Q3, #33). That cell must not be a gate
   * or next to one, which needs 3 rings. 4 is what the old 150-unit spacing
   * came to on cell centres (3 rings reach at most 135, 4 at least 156), so
   * the layout is unchanged. It was derived from the portal's push-out radius
   * and the largest robot body until hex-cells P2 deleted push-out.
   */
  static GATE_SPACING = 4

  mapSize: number

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
  FINISHED: FinishedPlayer[] = []

  /**
   * Blocked cells per plane: `Hex.key` to the obstacle that blocks it (a rock
   * or a StoneWall stone), or null for a cell blocked through `block` with no
   * obstacle named (only specs do that).
   *
   * Sparse on purpose: about 270 obstacles sit in a grid of roughly 15,000
   * cells, so a Map costs a few hundred entries instead of one byte per cell
   * per plane. That matters because the plan is many worlds per box, and this
   * is per-world state.
   *
   * Kept in step by `Obstacle`, which blocks its cell on construction and
   * releases it on destroy. Nothing else may write to it - a cell blocked
   * without an obstacle to explain it is invisible in every log.
   */
  BLOCKED: Map<number, Map<number, GameObject | null>> = new Map()

  /**
   * Each layer's valleys (`valleys.ts`): void cells, blocked with no blocker
   * in `BLOCKED` from the moment the world is built. `VOID_RUNS` is the same
   * set run-length encoded for `hello.voids`, built once.
   */
  VOIDS: Map<number, Set<number>> = new Map()
  VOID_RUNS: Map<number, number[]> = new Map()

  /**
   * Each layer's walls (`walls.ts`, decision #44): blocked with no blocker in
   * `BLOCKED`, like void, and kept apart here for what treats them
   * differently (Hopper walks through them; they stop shots). `WALL_RUNS` is
   * the set run-length encoded for `hello.walls`, built once.
   */
  WALLS: Map<number, Set<number>> = new Map()
  WALL_RUNS: Map<number, number[]> = new Map()

  /**
   * Rocks, stone-wall stones, portals, exits. Rocks and stones block their
   * cell (`BLOCKED`); portals and exits are cells a player walks onto and a
   * mob never enters (`GATES`, `mobCanEnter`). Nothing is pushed out of any
   * of them (hex-cells P2).
   */
  OBSTACLES: GameObject[] = []
  /**
   * Fireballs and icicles in flight. Their own list, not OBSTACLES: they are
   * not solid, they must not count toward the rock refill, and the tick is the
   * only thing that removes them (see `updateProjectiles`).
   */
  PROJECTILES: Throwable[] = []
  CONSUMABLES: Consumable[] = []
  /**
   * Usable items on the ground (decision #12). Their own list, not CONSUMABLES:
   * they are not loot and must not count toward a layer's loot cap. Removed by
   * pickup (`Player.update`) and expiry (`World.update`) only.
   */
  ITEMS: ItemPickup[] = []
  PLAYERS: Player[] = []
  MOBS: Unit[] = []
  AREA_EFFECT: Area[] = []

  // The two unit lists, for the few whole-list passes left (`block`'s
  // re-route) and as the membership of `UNITS`. Previously the spatial queries
  // built a fresh PLAYERS.concat(MOBS) array on every call.
  UNIT_SOURCES: Unit[][] = [this.PLAYERS as unknown as Unit[], this.MOBS]

  /**
   * Players and mobs by layer and cell (`Hex.key` of the cell under the
   * centre), hex-cells P1. Every unit query goes through it: `FIND_IN_CELLS`,
   * `NEAREST_IN_CELLS`, `FIRST_ON_LINE`, `UNITS_ON`, the projectile hit test
   * and StoneWall's occupancy check. Membership is `PLAYERS` and `MOBS`; see
   * `CellIndex` for how it stays exact. Add and remove units with `addUnit` /
   * `removeUnitAt`; a unit that moves or changes layer refiles itself
   * (`Unit.placed`).
   */
  UNITS = new CellIndex<Unit>(
    () => this.UNIT_SOURCES,
    (unit) => unit.tag,
    (unit) => World.cellKeyOf(unit.position)
  )

  /**
   * Players by layer and coarse square bucket, `World.INTEREST_BUCKET` on a
   * side: who might be sent an object's create, update or an effect
   * (`Multiplayer.create`, `update`, `effect`, `effectAt`). The 3 x 3 buckets
   * around a point hold every player whose view could contain it (server fog,
   * #48: up to the largest robot's vision + 2 rings; the 500 box for effects),
   * so the view test itself is unchanged; this only stops it running against
   * every connection. Membership is `PLAYERS`, kept by the same helpers as
   * `UNITS`. By layer since interest-filtered-broadcasts: every caller wants
   * one layer, and a layer change refiles the player (`unitMoved`).
   */
  INTEREST = new CellIndex<Player>(
    () => [this.PLAYERS],
    (player) => player.tag,
    (player) => World.bucketKeyOf(player.position.x, player.position.y)
  )

  /**
   * Loot (`CONSUMABLES`) and items (`ITEMS`) on the ground, by layer and cell.
   * Pickups are same-cell (decision #32). Add and remove through its `push` /
   * `removeAt` / `remove`, never on the lists directly.
   */
  PICKUPS = new CellIndex<Consumable | ItemPickup>(
    () => [this.CONSUMABLES, this.ITEMS],
    (pickup) => pickup.tag,
    (pickup) => World.cellKeyOf(pickup.position)
  )

  /**
   * Portals and exits, by layer and cell: the exit check (`Player.onExit`),
   * StoneWall's gate skip, a wander goal's and a drop's gate skip, spawn
   * clearance and the rock keep-out. Its list is `OBSTACLES`, filtered, so
   * every change to `OBSTACLES` goes through `addObstacle` /
   * `removeObstacleAt` / `removeObstacle`. By type code, not `instanceof`:
   * portal.ts and exit.ts import player.ts, which imports this module.
   */
  GATES = new CellIndex<GameObject>(
    () => [this.OBSTACLES],
    (gate) => gate.tag,
    (gate) => World.cellKeyOf(gate.position),
    (obj) => obj.type === ObjectType.Portal || obj.type === ObjectType.Exit
  )

  /** `Hex.key` of the cell under a world position. */
  static cellKeyOf (position: Vector): number {
    const cell = Hex.toCell(position)
    return Hex.key(cell.x, cell.y)
  }

  /**
   * The side of an `INTEREST` bucket, in world units: 585 with Periscope's
   * vision of 10 (server fog, #48; 630 while it was 11, Nick cut it to 10
   * on 2026-10-03 for the tick). A player's view
   * reaches an object at most `vision` + `Multiplayer.VIEW_MARGIN_RINGS` +
   * `VIEW_EXIT_RINGS` rings away (the leave radius, 12 for Periscope), cell
   * to cell. East-west that is 45 units a ring on this pointy-top grid (39
   * north-south), and each end may sit up to half a cell (22.5) off its
   * cell's centre, so the reach is at most (vision + 3) * `Hex.SIZE` on
   * either axis, and one bucket of that size each way covers it. Never less
   * than the 500 box (`Multiplayer.INTEREST_RADIUS`), which effects and a
   * viewer with no vision use. Derived from the largest vision in the
   * mirrored archetype table, so a robot that sees further widens it;
   * `interest.spec.ts` checks the cover with random off-centre positions.
   * Rejected (#48 task): capping the view at the old box (at vision 11
   * Periscope would have lost its 12th ring east-west only; moot at 10), and querying
   * 5 x 5 buckets.
   *
   * A getter worked out on first use, because `Multiplayer` (the 500) is not
   * defined yet while this module loads.
   */
  static get INTEREST_BUCKET (): number {
    if (World._interestBucket === undefined) {
      let maxVision = 0
      for (const key in ARCHETYPE_INFO) {
        const vision = ARCHETYPE_INFO[key as keyof typeof ARCHETYPE_INFO].vision
        if (vision !== null && vision > maxVision) maxVision = vision
      }
      World._interestBucket = Math.max(Multiplayer.INTEREST_RADIUS, (maxVision + 3) * Hex.SIZE)
    }
    return World._interestBucket
  }

  private static _interestBucket: number | undefined

  /** The `INTEREST` bucket holding a world position. */
  static bucketKeyOf (x: number, y: number): number {
    const size = World.INTEREST_BUCKET
    return Hex.key(Math.floor(x / size), Math.floor(y / size))
  }

  /**
   * The players on layer `tag` whose view could contain (x, y): the 3 x 3
   * `INTEREST` buckets around it. A bucket is at least as wide as the longest
   * reach on either axis (`INTEREST_BUCKET`), so such a player is never more
   * than one bucket away. Callers still run the view test.
   */
  static interestCandidates (x: number, y: number, tag: number): Player[] {
    const size = World.INTEREST_BUCKET
    const bx = Math.floor(x / size)
    const by = Math.floor(y / size)
    const result: Player[] = []
    // One sync for the nine lookups: `at` syncs on every call, and this runs
    // for every unit, projectile and pickup every tick.
    const buckets = World.INTEREST.buckets(tag)
    if (buckets.size === 0) return result
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get(Hex.key(bx + dx, by + dy))
        if (bucket !== undefined) for (const player of bucket) result.push(player)
      }
    }
    return result
  }

  /** Push `unit` onto `list` (PLAYERS or MOBS), indexed. The only way the server adds a unit. */
  static addUnit (list: Unit[], unit: Unit): void {
    World.UNITS.sync()
    World.INTEREST.sync()
    list.push(unit)
    World.UNITS.insert(unit)
    if (list === (World.PLAYERS as unknown as Unit[])) World.INTEREST.insert(unit as Player)
    World.UNITS.record()
    World.INTEREST.record()
  }

  /** Splice entry `index` out of `list` (PLAYERS or MOBS), unindexed. */
  static removeUnitAt (list: Unit[], index: number): void {
    World.UNITS.sync()
    World.INTEREST.sync()
    const [unit] = list.splice(index, 1)
    if (unit !== undefined) {
      World.UNITS.delete(unit)
      World.INTEREST.delete(unit as Player)
      World.releaseStep(unit)
    }
    World.UNITS.record()
    World.INTEREST.record()
  }

  /** A unit's position or layer changed (`Unit.placed`): refile it. */
  static unitMoved (unit: Unit): void {
    World.UNITS.moved(unit)
    World.INTEREST.moved(unit as Player)
  }

  /**
   * The pickups and StoneWall stones that have been through a pickup pass.
   * One that has not was created since the last pass, against wherever its
   * viewers stood at that moment, so it gets a whole `update` once
   * (`pickupPass`). Weak, so it goes with the object; shared by every world,
   * since an object belongs to one.
   */
  private static readonly _passed = new WeakSet<GameObject>()

  /**
   * Pickups and StoneWall stones into and out of view. They never move, so
   * what a client holds of them changes only when its viewpoint changes cell
   * (`Multiplayer.pickupViews`, per connection, which looks only round the
   * ones that did). Two kinds still get their own `Multiplayer.update`, which
   * settles them against every viewer: a dirty one (never, today: nothing
   * writes a wire field of a pickup after its create), and one created since
   * the last pass, whose create was decided against where its viewers stood
   * then. Until 2026-10-03 every pickup within 2 `INTEREST` buckets of one a
   * player had moved in had its update here (`PICKUP_WATCH_BUCKETS`): about
   * 190 a tick at 200-400 players, 0.2-0.3 ms of a 1.2-3.4 ms tick in
   * `tools/load/tickbench.cjs`.
   */
  static pickupPass (dt: number): void {
    const passed = World._passed
    for (const obj of World.CONSUMABLES) {
      if (obj.dirtyFields.size > 0 || !passed.has(obj)) {
        passed.add(obj)
        obj.update(dt)
      }
    }
    for (const obj of World.ITEMS) {
      if (obj.dirtyFields.size > 0 || !passed.has(obj)) {
        passed.add(obj)
        obj.update(dt)
      }
    }
    // StoneWall stones go only to connections in range too (`Multiplayer.isTerrain`),
    // and never move, so they come into and out of view here, like a pickup.
    for (const obj of World.OBSTACLES) {
      if (Multiplayer.isTerrain(obj)) continue
      if (obj.dirtyFields.size > 0 || !passed.has(obj)) {
        passed.add(obj)
        obj.update(dt)
      }
    }
    // Optional: a spec's stub Multiplayer may not have it.
    Multiplayer.Instance.pickupViews?.()
  }

  /** Push onto `OBSTACLES`, keeping `GATES` in step. */
  static addObstacle (obj: GameObject): void {
    World.GATES.push(World.OBSTACLES, obj)
  }

  /** Splice entry `index` out of `OBSTACLES`, keeping `GATES` in step. */
  static removeObstacleAt (index: number): void {
    World.GATES.removeAt(World.OBSTACLES, index)
  }

  /** Remove `obj` from `OBSTACLES` if it is there. */
  static removeObstacle (obj: GameObject): boolean {
    return World.GATES.remove(World.OBSTACLES, obj)
  }

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

  // Worlds (worlds-per-process, decision #39) ========

  /** This world's delayed work (`Timers`), active while the world is current. */
  readonly timers: Timers
  /** This world's object ids (`GameObject.id`, `FreedIDs`), active while the world is current. */
  readonly ids: IdPool
  /**
   * The Multiplayer this world's objects are sent through: `Multiplayer.Instance`
   * while this world is current. Set through `Multiplayer.Instance` or the
   * constructor, which also bind it (`Multiplayer.world`).
   */
  multiplayer: Multiplayer | undefined
  /** Set by `close`. A closed world is never current again. */
  closed = false

  private static _current: World | undefined

  /**
   * In the server (`Worlds`), true: between pieces of work no world is
   * current, and reaching for one throws a `WrongWorldError` instead of
   * quietly using whichever world ran last. False in specs, where the first
   * read makes a default world with no map, so that a spec that builds units
   * before any `new World()` still has lists to put them in.
   */
  static strict = false

  /** How many times the wrong-world guard has fired. Never reset by the server; specs read it. */
  static wrongWorld = 0

  /**
   * The world every `World.X` static accessor reads and writes, whose
   * `Timers` queue and id pool are active, and whose Multiplayer is
   * `Multiplayer.Instance`. In the server only `World.run` and the
   * constructor change it; a spec may set it.
   */
  static get current (): World {
    const world = World._current
    if (world !== undefined) return world
    if (World.strict) return World.wrong('no world is current: world state was reached outside World.run')
    // The default world adopts the queue and pool that were active before any
    // world existed, so a timer or an id from that time is not lost.
    return new World(0, { empty: true })
  }

  static set current (world: World) {
    World.enter(world)
  }

  /** The current world, or undefined if none is, without making the default one. */
  static peek (): World | undefined {
    return World._current
  }

  private static enter (world: World | undefined): void {
    if (world?.closed === true) World.wrong('a closed world was made current')
    World._current = world
    Timers.active = world?.timers
    GameObject.pool = world?.ids
  }

  /**
   * Make `world` current for `fn`, which must be synchronous, and restore the
   * previous one afterwards, whatever `fn` does. Work queued inside `fn` (a
   * promise continuation, a callback) runs after this returns, under another
   * world or none: capture what it needs before it is queued.
   */
  static run<T> (world: World, fn: () => T): T {
    const previous = World._current
    World.enter(world)
    try {
      return fn()
    } finally {
      World.enter(previous)
    }
  }

  /**
   * `new World(size, options)` without leaving it current: the previous
   * current world (or none) is restored, as `run` does. What `Worlds` uses.
   */
  static build (size: number, options: WorldOptions = {}): World {
    const previous = World._current
    try {
      return new World(size, options)
    } finally {
      World.enter(previous)
    }
  }

  /** Count and throw a `WrongWorldError`. */
  static wrong (message: string): never {
    World.wrongWorld++
    throw new WrongWorldError(message)
  }

  /** Throw a `WrongWorldError` unless `world` is current. */
  static expect (world: World, where: string): void {
    if (World._current !== world) World.wrong(`${where}: its world is not the current one`)
  }

  /**
   * Stop this world for good: its timers are dropped, its Multiplayer is
   * unbound, and it can never be current again. `Worlds` closes a world only
   * once no connection is attached to it, then drops every reference to it;
   * nothing outside the world's own objects holds one (no timer, interval or
   * listener), so it is collected (`worlds.spec.ts`).
   */
  close (): void {
    if (World._current === this) World.enter(undefined)
    this.closed = true
    this.timers.clear()
    if (this.multiplayer?.world === this) this.multiplayer.world = undefined
  }

  // The per-world state under its old static names: every `World.X` reads and
  // writes the current world's. The fields are declared further up, next to
  // their documentation.
  static get mapSize (): number { return World.current.mapSize }
  static set mapSize (value: number) { World.current.mapSize = value }
  static get FINISHED (): FinishedPlayer[] { return World.current.FINISHED }
  static set FINISHED (value: FinishedPlayer[]) { World.current.FINISHED = value }
  static get BLOCKED (): Map<number, Map<number, GameObject | null>> { return World.current.BLOCKED }
  static set BLOCKED (value: Map<number, Map<number, GameObject | null>>) { World.current.BLOCKED = value }
  static get VOIDS (): Map<number, Set<number>> { return World.current.VOIDS }
  static set VOIDS (value: Map<number, Set<number>>) { World.current.VOIDS = value }
  static get VOID_RUNS (): Map<number, number[]> { return World.current.VOID_RUNS }
  static set VOID_RUNS (value: Map<number, number[]>) { World.current.VOID_RUNS = value }
  static get WALLS (): Map<number, Set<number>> { return World.current.WALLS }
  static set WALLS (value: Map<number, Set<number>>) { World.current.WALLS = value }
  static get WALL_RUNS (): Map<number, number[]> { return World.current.WALL_RUNS }
  static set WALL_RUNS (value: Map<number, number[]>) { World.current.WALL_RUNS = value }
  static get OBSTACLES (): GameObject[] { return World.current.OBSTACLES }
  static set OBSTACLES (value: GameObject[]) { World.current.OBSTACLES = value }
  static get PROJECTILES (): Throwable[] { return World.current.PROJECTILES }
  static set PROJECTILES (value: Throwable[]) { World.current.PROJECTILES = value }
  static get CONSUMABLES (): Consumable[] { return World.current.CONSUMABLES }
  static set CONSUMABLES (value: Consumable[]) { World.current.CONSUMABLES = value }
  static get ITEMS (): ItemPickup[] { return World.current.ITEMS }
  static set ITEMS (value: ItemPickup[]) { World.current.ITEMS = value }
  static get PLAYERS (): Player[] { return World.current.PLAYERS }
  static set PLAYERS (value: Player[]) {
    const world = World.current
    world.PLAYERS = value
    world.UNIT_SOURCES = [value as unknown as Unit[], world.MOBS]
  }

  static get MOBS (): Unit[] { return World.current.MOBS }
  static set MOBS (value: Unit[]) {
    const world = World.current
    world.MOBS = value
    world.UNIT_SOURCES = [world.PLAYERS as unknown as Unit[], value]
  }

  static get AREA_EFFECT (): Area[] { return World.current.AREA_EFFECT }
  static set AREA_EFFECT (value: Area[]) { World.current.AREA_EFFECT = value }
  static get UNIT_SOURCES (): Unit[][] { return World.current.UNIT_SOURCES }
  static set UNIT_SOURCES (value: Unit[][]) { World.current.UNIT_SOURCES = value }
  static get UNITS (): CellIndex<Unit> { return World.current.UNITS }
  static set UNITS (value: CellIndex<Unit>) { World.current.UNITS = value }
  static get INTEREST (): CellIndex<Player> { return World.current.INTEREST }
  static set INTEREST (value: CellIndex<Player>) { World.current.INTEREST = value }
  static get PICKUPS (): CellIndex<Consumable | ItemPickup> { return World.current.PICKUPS }
  static set PICKUPS (value: CellIndex<Consumable | ItemPickup>) { World.current.PICKUPS = value }
  static get GATES (): CellIndex<GameObject> { return World.current.GATES }
  static set GATES (value: CellIndex<GameObject>) { World.current.GATES = value }
  static get STEPS (): Map<number, Map<number, Unit>> { return World.current.STEPS }
  static set STEPS (value: Map<number, Map<number, Unit>>) { World.current.STEPS = value }

  /**
   * A new world, made current and left current (the server's `Worlds`
   * restores the previous one itself). Every world is a new random map.
   */
  constructor (size: number, options: WorldOptions = {}) {
    const previous = World._current
    if (options.empty === true && previous === undefined) {
      // The default world: see `current`.
      this.timers = Timers.active ?? new Timers()
      this.ids = GameObject.pool ?? new IdPool()
    } else {
      this.timers = new Timers()
      this.ids = new IdPool()
    }
    const multiplayer = options.multiplayer ?? previous?.multiplayer
    if (multiplayer !== undefined) multiplayer.world = this
    this.multiplayer = multiplayer
    World.enter(this)

    this.mapSize = size
    if (options.empty === true) return

    // The valleys first: gates are placed on the ground they leave.
    for (const layer of World.LAYERS) {
      const voids = carveValleys(size, layer.voidShare)
      for (const cell of Hex.mapCells(size)) {
        if (voids.has(Hex.key(cell.x, cell.y))) World.block(cell.x, cell.y, layer.tag, null)
      }
      World.VOIDS.set(layer.tag, voids)
      World.VOID_RUNS.set(layer.tag, encodeRuns(voids, size))
    }

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

    // The walls last, on the ground the valleys left, clear of every gate's
    // disc (and so of every arrival cell).
    for (const layer of World.LAYERS) {
      const voids = World.VOIDS.get(layer.tag) ?? new Set<number>()
      const walls = placeWalls(size, voids, World.gateKeepOut(layer.tag), layer.wallShare)
      for (const cell of Hex.mapCells(size)) {
        if (walls.has(Hex.key(cell.x, cell.y))) World.block(cell.x, cell.y, layer.tag, null)
      }
      World.WALLS.set(layer.tag, walls)
      World.WALL_RUNS.set(layer.tag, encodeRuns(walls, size))
    }
  }

  /**
   * A portal to `to`, or an exit when `to` is undefined, at a free cell of
   * layer `tag` that keeps `GATE_SPACING` rings from every gate a player could
   * meet on either layer. Skipped, as a gate always was, if no such cell turns
   * up.
   *
   * A portal's site is also rejected if its arrival cell (`World.arrivalOf`)
   * is off the map, blocked or a gate on `to` (decision #33). The spacing
   * already keeps gates 3 rings from any arrival cell; the check is here so a
   * change to either cannot quietly put an arrival on a gate.
   *
   * Gates are not in `BLOCKED` (they are walked into on purpose), so
   * `getUnobstructedPosition` cannot see them and the spacing is tested here.
   * Only the constructor places gates, after the valleys and before anything
   * else.
   *
   * A gate's cell is `GATE_ROCK_RINGS` clear of void on its layer, and a
   * portal's cell is as clear on `to` too, which covers its arrival cell and
   * every neighbour of it: a pad is always reachable from every side and a
   * player never lands on the edge of a valley. 60 tries, not the 20 it had
   * with scattered rocks, because a third of every layer is void.
   */
  private placeGate (tag: number, to: number | undefined): void {
    const reach = to === undefined ? [tag] : [tag, to]

    for (let attempt = 0; attempt < 60; attempt++) {
      const pos = this.getUnobstructedPosition(tag)
      if (pos === undefined) continue
      const cell = Hex.toCell(pos)
      if (!World.isClear(cell.x, cell.y, tag, World.GATE_ROCK_RINGS)) continue
      if (to !== undefined && !World.isClear(cell.x, cell.y, to, World.GATE_ROCK_RINGS)) continue

      if (to !== undefined) {
        const arrival = World.arrivalOf(cell)
        if (World.isBlocked(arrival.x, arrival.y, to)) continue
        if (World.GATES_ON(arrival.x, arrival.y, to).length > 0) continue
      }

      const crowded = World.OBSTACLES.some((gate) => {
        if (!(gate instanceof Portal) && !(gate instanceof Exit)) return false
        // `to` is only meaningful on a portal: every object defaults it to 0,
        // which is also layer 01's tag.
        const gateReach = gate instanceof Portal ? [gate.tag, gate.to] : [gate.tag]
        if (!gateReach.some((t) => reach.includes(t))) return false
        return Hex.distance(Hex.toCell(gate.position), cell) < World.GATE_SPACING
      })
      if (crowded) continue

      World.addObstacle(to === undefined ? new Exit(pos.x, pos.y, tag) : new Portal(pos.x, pos.y, to, tag))
      return
    }
  }

  /**
   * Joins on the top layer (#26), at a cell centre `spawnCell` picks. `name`,
   * `finish` and `robot` are what the client sent, raw; Player's constructor
   * cleans the first two, `robotFor` the last. `kit` is the run's 4 skill
   * ids, already resolved (`kitFor`, or a bot's); it is not checked here.
   * Left out, the player gets the start kit (`Player`).
   */
  static createPlayer (playerId: string, name?: unknown, finish?: unknown, robot?: unknown, kit?: readonly number[]): Player {
    const pos = Hex.toPosition(World.spawnCell(World.LAYERS[0].tag).cell)
    const player = new Player(pos.x, pos.y, World.LAYERS[0].tag, playerId, World.robotFor(robot), name, finish, kit)
    World.addUnit(World.PLAYERS as unknown as Unit[], player)
    return player
  }

  /**
   * The robot a join asked for (robot-select, #42): the archetype of that key
   * if it is one a player may pick (`SELECTABLE_ROBOTS`), else Peep. A locked
   * robot, a mob, or anything else never refuses the join.
   */
  static robotFor (robot: unknown): Archetype {
    if (typeof robot === 'string' && (SELECTABLE_ROBOTS as readonly string[]).includes(robot)) {
      return ARCHETYPES[robot as keyof typeof ARCHETYPES]
    }
    return ARCHETYPES.peep
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
    for (const gates of World.GATES.buckets(tag).values()) {
      for (const gate of gates) hazards.push(Hex.toCell(gate.position))
    }
    // Once per join, and MOBS is the fixed mob population (81), not players.
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
    // Every World.X below is the current world's: ticking any other world
    // would run this one's clock over another's state. A spec's
    // `Object.create(World.prototype)` has no state of its own (no `timers`)
    // and is only a handle on the methods, so it ticks the current world, as
    // every world did before worlds-per-process.
    if (World._current !== this && this.timers !== undefined) World.expect(this, 'World.update')

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
        World.removeUnitAt(World.PLAYERS as unknown as Unit[], i)
        continue
      }
      if (player.exited) {
        World.finish(player, Standing.EXTRACTED)
        World.removeUnitAt(World.PLAYERS as unknown as Unit[], i)
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
        World.PICKUPS.removeAt(World.CONSUMABLES, i)
      }
    }
    for (let i = World.ITEMS.length - 1; i >= 0; i--) {
      const item = World.ITEMS[i]
      if (item.expiresAt > 0 && now > item.expiresAt) {
        item.destroy()
        World.PICKUPS.removeAt(World.ITEMS, i)
      }
    }

    for (const area of World.AREA_EFFECT) {
      area.update(dt)
    }

    for (let i = World.MOBS.length - 1; i >= 0; i--) {
      const mob = World.MOBS[i]
      if (mob.destroyed) {
        this.createLootFrom(mob)
        World.removeUnitAt(World.MOBS, i)
        continue
      }
      mob.update(dt)
    }

    World.updateProjectiles(dt)

    for (const layer of World.LAYERS) this.refillLayer(layer)

    // Pickups never move or change, so nothing else would tell a player who
    // walks up to one that it is there: their create goes only to players in
    // range (decision #35), and `Multiplayer.update` is where an object comes
    // into range and goes out of it. Units and projectiles get this from their
    // own update. Last, so a pickup taken or dropped this tick is settled.
    World.pickupPass(dt)
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
   * Top a layer back up to its `LAYERS` numbers: at most one natural pickup
   * and one mob of each short archetype per tick. (World rocks were refilled
   * here too until the valleys replaced them, tile art pass 2026-09-27.)
   *
   * Every count is per layer. Mobs and pickups were once world totals on
   * random layers.
   *
   * Bosses and gunners are counted by archetype, as they were: both guards
   * once read MOBS.length, so five bosses spawned in the first few ticks and
   * none was ever replaced once the population had filled past ten. Each
   * archetype now has its own count, so grunts no longer fill whatever the
   * others leave, and the total never sits above the table's sum.
   */
  private refillLayer (layer: LayerSpec): void {
    const tag = layer.tag

    // Natural pickups only: a death drop has an expiry, and does not count.
    let natural = 0
    for (const c of World.CONSUMABLES) if (c.tag === tag && c.expiresAt === 0) natural++
    if (natural < layer.naturalLoot) {
      const pos = this.getUnobstructedPosition(tag)
      if (pos !== undefined) {
        // The radius is drawn here rather than by Consumable, because the loot
        // is derived from it and must be in place before the create goes out.
        // Same range as Consumable's own default. The cast is because that
        // parameter's `= undefined` default types it as undefined; the
        // constructor reads it as a number (`radius || RangeInt(15, 25)`).
        const radius = Random.RangeInt(15, 25)
        World.PICKUPS.push(World.CONSUMABLES, new Consumable(
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
      const pos = this.getUnobstructedPosition(tag)
      if (pos !== undefined) World.PICKUPS.push(World.ITEMS, new ItemPickup(pos.x, pos.y, tag, item))
    }
  }

  /**
   * Remember a player leaving `PLAYERS`, for the standings board. Their loot is
   * what they carried at the end: banked on an exit, dropped on a death.
   */
  static finish (player: Player, status: Standing, now: number = Date.now()): void {
    World.FINISHED.push({ id: player.id, name: player.name, loot: player.loot, status, at: now, bot: player.bot !== undefined })
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

  /**
   * One mob of `archetype` on `layer`, carrying the layer's loot, if a free
   * spot turns up: a cell centre `getUnobstructedPosition` would pick that a
   * mob may also stand on (`mobCanEnter`: no gate, no arrival cell, no other
   * mob). Nothing pushes units apart any more (hex-cells P2), so a mob placed
   * on a gate or on another mob would stay there.
   */
  private spawnMob (archetype: Archetype, layer: LayerSpec): void {
    let pos: Vector | undefined
    for (let attempt = 0; attempt < 10 && pos === undefined; attempt++) {
      const candidate = this.getUnobstructedPosition(layer.tag)
      if (candidate === undefined) return
      const cell = Hex.toCell(candidate)
      if (World.mobCellFree(cell.x, cell.y, layer.tag)) pos = candidate
    }
    if (pos === undefined) return
    const mob = new Mob(pos.x, pos.y, layer.tag, archetype)
    mob.loot = Math.round(archetype.loot * layer.lootMultiplier)
    // A mob's loot is server-side only: it is not in its create record
    // (`allFields`), and nothing else ever marks it. Left dirty, the next
    // update would send it, and the client floats any loot change over a unit
    // as a "+88" the moment it comes into view.
    mob.dirtyFields.delete('loot')
    World.addUnit(World.MOBS, mob)
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

  /**
   * Scatter a dead unit's loot: drops worth about a fifth of it each (at least
   * 50 a tier), each on a random free cell centre within `DROP_RINGS` of the
   * cell it died on (`dropCells`), as items already were. Decision #32: a
   * pickup is same-cell now, and the old random offset of up to 100 units
   * each way could put a drop on a rock's cell, where nobody can ever stand.
   */
  createLootFrom (value: Unit): void {
    const dropTier = Math.max(50, Math.floor(value.loot / 5))
    let lootLeft = value.loot
    const free = lootLeft > 0 ? World.dropCells(value.cell, value.tag) : []

    while (lootLeft > 0) {
      const newDropValue = Math.min(
        lootLeft,
        Random.RangeInt(0.5 * dropTier, 1.5 * dropTier)
      )
      lootLeft -= newDropValue

      const at = Hex.toPosition(free[Random.RangeInt(0, free.length)])
      World.PICKUPS.push(World.CONSUMABLES, new Consumable(
        at.x,
        at.y,
        value.tag,
        undefined,
        newDropValue,
        World.DROPPED_LOOT_LIFETIME
      ))
    }
  }

  /** How far from the body a dead unit's loot and items land, in rings (2 = 19 cells). */
  static DROP_RINGS = 2

  /**
   * The cells a death drop may land on: every cell within `DROP_RINGS` of
   * `origin` that is on the map, not blocked (`isBlocked`: no rock or stone)
   * and not a portal's. A drop on a rock could never be reached, and a portal
   * is solid to players, so one on a portal's cell could never be stood on
   * either. Exit cells stay: players stand on them. The origin alone if
   * nothing around it qualifies.
   */
  static dropCells (origin: Vector, tag: number): Vector[] {
    const free: Vector[] = []
    const rings = World.DROP_RINGS
    for (let dq = -rings; dq <= rings; dq++) {
      const lo = Math.max(-rings, -dq - rings)
      const hi = Math.min(rings, -dq + rings)
      for (let dr = lo; dr <= hi; dr++) {
        const q = origin.x + dq
        const r = origin.y + dr
        if (World.isBlocked(q, r, tag)) continue
        if (World.GATES_ON(q, r, tag).some((gate) => gate.type === ObjectType.Portal)) continue
        free.push(new Vector(q, r))
      }
    }
    if (free.length === 0) free.push(origin)
    return free
  }

  /**
   * Scatter a dead player's inventory: one pickup per item carried, each on a
   * random cell of `dropCells`, so none lands inside a rock where it could
   * never be reached. Each expires after `DROPPED_LOOT_LIFETIME`, like dropped
   * loot, for the same reason.
   */
  createItemsFrom (player: Player): void {
    const carried = player.takeInventory()
    if (carried.length === 0) return

    const free = World.dropCells(player.cell, player.tag)
    for (const { item, count } of carried) {
      for (let n = 0; n < count; n++) this.dropItem(item, free[Random.RangeInt(0, free.length)], player.tag)
    }
  }

  private dropItem (item: Item, cell: Vector, tag: number): void {
    const at = Hex.toPosition(cell)
    World.PICKUPS.push(World.ITEMS, new ItemPickup(at.x, at.y, tag, item, World.DROPPED_LOOT_LIFETIME))
  }

  /**
   * True if this cell is void (a valley) on this plane, or off the map: all
   * that stops Hopper (`Unit.blocks`, decisions #16 H3 and #44).
   */
  static isVoid (q: number, r: number, tag: number): boolean {
    if (!Hex.onMap(q, r, World.mapSize)) return true
    return World.VOIDS.get(tag)?.has(Hex.key(q, r)) ?? false
  }

  /** True if this cell blocks movement on this plane, or is off the map. */
  static isBlocked (q: number, r: number, tag: number): boolean {
    if (!Hex.onMap(q, r, World.mapSize)) return true
    return World.BLOCKED.get(tag)?.has(Hex.key(q, r)) ?? false
  }

  /** Block a cell on `tag`, by `by` (the obstacle on it; `Obstacle` always names itself). */
  static block (q: number, r: number, tag: number, by: GameObject | null = null): void {
    let cells = World.BLOCKED.get(tag)
    if (cells === undefined) {
      cells = new Map()
      World.BLOCKED.set(tag, cells)
    }
    cells.set(Hex.key(q, r), by)

    // Anything already routed through this cell has to be re-routed now, or it
    // walks into the new wall and stands there pressing against it. Done here
    // rather than in StoneWall so no future caller can forget it. Cheap: units
    // without a path return from `pathCrosses` immediately, which is every unit
    // during the world's initial fill. A whole-list pass, but once per new
    // obstacle (a StoneWall stone, a rock refilled after a bomb), not per tick.
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
   * Rings around a gate's cell kept clear of void (and, before the valleys, of world rocks): 2 (the
   * gate's cell, its 6 neighbours and the 12 beyond), decision #34.
   *
   * Gates are not in `BLOCKED` (they are walked into on purpose), so the
   * refill could not see them and put rocks on portal and exit cells
   * (gate-hygiene). A rock on an exit's cell sat on the pad, and one beside a
   * gate narrowed the way on to it.
   *
   * 2 covers a portal's cell, its arrival cell one ring out (`World.arrivalOf`)
   * and every neighbour of the arrival cell, so a player put down by a portal
   * never lands in a rock and can always walk off. Exits use the same rings;
   * any ring at all keeps a pad reachable from every side. It was derived
   * from the push-out radii until hex-cells P2, and came to 2 then too.
   */
  static GATE_ROCK_RINGS = 2

  /**
   * `Hex.key`s of the cells on layer `tag` within `GATE_ROCK_RINGS` of a gate
   * cell: every portal and exit on the layer, and every portal on another
   * layer that leads here, centred on its own cell: its arrival cell here is
   * one ring out (`World.arrivalOf`), so 2 rings keep the arrival cell and all
   * its neighbours clear.
   */
  static gateKeepOut (tag: number): Set<number> {
    const cells = new Set<number>()
    const rings = World.GATE_ROCK_RINGS
    const gates: GameObject[] = []
    for (const layer of World.TAGS) {
      for (const bucket of World.GATES.buckets(layer).values()) gates.push(...bucket)
    }
    for (const gate of gates) {
      // `to` is only meaningful on a portal: every object defaults it to 0,
      // which is also layer 01's tag.
      const here = gate.tag === tag
      const arrives = gate.type === ObjectType.Portal && gate.to === tag && gate.tag !== tag
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
   * Rings of unblocked cells around a cell the world picks at random for a
   * pickup, an item, a mob or a gate (`getUnobstructedPosition`; `placeGate`
   * then asks for `GATE_ROCK_RINGS`): 1, the cell and its 6 neighbours. It was
   * a 40-unit clearance, `ceil(40 / Hex.SIZE)` rings, which is also 1.
   */
  static CLEAR_RINGS = 1

  /**
   * A free cell centre, `CLEAR_RINGS` clear of blocked cells, or undefined if
   * 40 tries found nothing.
   *
   * The clearance was a distance in world units tested against a scan of
   * every obstacle; it is a ring count tested with a Set lookup, so this is
   * both exact and much cheaper. It still runs inside the tick, so it still
   * cannot loop unbounded - StoneWall lets players add obstacles and density
   * is not fixed.
   *
   * It used to return the last candidate whether or not it collided, which
   * spawned things inside rocks and left the push-out to shove them out. Callers
   * now skip a tick instead; at roughly 2% occupancy the cap is never reached in
   * practice anyway.
   */
  getUnobstructedPosition (tag: number): Vector | undefined {
    const rings = World.CLEAR_RINGS

    for (let attempts = 0; attempts < 40; attempts++) {
      const cell = Hex.toCell(new Vector(
        Random.RangeInt(0, World.mapSize),
        Random.RangeInt(0, World.mapSize)
      ))

      if (World.isClear(cell.x, cell.y, tag, rings)) return Hex.toPosition(cell)
    }

    return undefined
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
    World.forKeysWithin(origin, rings, (key) => {
      for (const unit of World.UNITS.at(tag, key)) {
        if ((unit.type & typeMask) !== 0) result.push(unit)
      }
    })
    return result
  }

  /**
   * Call `fn` with the `Hex.key` of every cell within `rings` of `origin`
   * (`rings` 0 is the origin alone), and its distance in rings. Off-map cells
   * included: nothing is filed there, so they cost a lookup and find nothing.
   */
  static forKeysWithin (origin: Vector, rings: number, fn: (key: number, distance: number) => void): void {
    for (let dq = -rings; dq <= rings; dq++) {
      const lo = Math.max(-rings, -dq - rings)
      const hi = Math.min(rings, -dq + rings)
      for (let dr = lo; dr <= hi; dr++) {
        fn(Hex.key(origin.x + dq, origin.y + dr), (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2)
      }
    }
  }

  /**
   * The unit nearest `origin` by rings, within `rings` of it, of a type in
   * `typeMask`, on `tag`, that `accept` takes (default: any not destroyed).
   * Ties go to the lowest id, so the answer does not depend on the order units
   * were filed in. Undefined if there is none. Hex-cells P1: this is the AI's
   * notice test, which took the *last* match of a radius scan before.
   */
  static NEAREST_IN_CELLS (
    origin: Vector,
    rings: number,
    tag: number,
    typeMask: number,
    accept: (unit: Unit) => boolean = (unit) => !unit.destroyed
  ): Unit | undefined {
    let best: Unit | undefined
    let bestDistance = Infinity
    World.forKeysWithin(origin, rings, (key, distance) => {
      if (distance > bestDistance) return
      for (const unit of World.UNITS.at(tag, key)) {
        if ((unit.type & typeMask) === 0 || !accept(unit)) continue
        if (distance < bestDistance || (best !== undefined && unit.id < best.id)) {
          best = unit
          bestDistance = distance
        }
      }
    })
    return best
  }

  /** The units standing on cell (q, r) of layer `tag`, dead ones included until the sweep. Do not mutate. */
  static UNITS_ON (q: number, r: number, tag: number): readonly Unit[] {
    return World.UNITS.at(tag, Hex.key(q, r))
  }

  /** The portals and exits on cell (q, r) of layer `tag`. Do not mutate. */
  static GATES_ON (q: number, r: number, tag: number): readonly GameObject[] {
    return World.GATES.at(tag, Hex.key(q, r))
  }

  /** True if cell (q, r) of layer `tag` holds an exit. */
  static isExit (q: number, r: number, tag: number): boolean {
    return World.GATES_ON(q, r, tag).some((gate) => gate.type === ObjectType.Exit)
  }

  // Portals and cell stepping (hex-cells P2) ========

  /**
   * The `Hex.DIRECTIONS` index of a portal's arrival cell from the portal's
   * own cell: 0, East, for every portal (decision #33). The client's copy is
   * `LocalPlayer.ARRIVAL_DIRECTION`; the client never computes an arrival
   * itself, but it waits on the portal cell for the server's.
   */
  static ARRIVAL_DIRECTION = 0

  /**
   * Where a portal on `cell` puts a player down, on the layer it leads to.
   * Placement guarantees it is on the map, not a gate, and (through the rock
   * keep-out) never a rock; StoneWall and mob steps keep it clear of stones
   * and mobs (`isArrival`).
   */
  static arrivalOf (cell: Vector): Vector {
    return Hex.neighbour(cell, World.ARRIVAL_DIRECTION)
  }

  /**
   * The portal on cell (q, r) of layer `tag` that leads somewhere else, or
   * undefined. A portal to its own layer (only specs build one) takes nobody
   * anywhere, so it does not count.
   */
  static portalOn (q: number, r: number, tag: number): GameObject | undefined {
    for (const gate of World.GATES_ON(q, r, tag)) {
      if (gate.type === ObjectType.Portal && gate.to !== tag) return gate
    }
    return undefined
  }

  /**
   * True if cell (q, r) of layer `tag` is the arrival cell of a portal on
   * another layer that leads here. Kept clear like a gate cell: no StoneWall
   * stone and no mob steps onto one (#31 Q3). Players may stand and stack on
   * it. Two lookups, one per other layer.
   */
  static isArrival (q: number, r: number, tag: number): boolean {
    const d = Hex.DIRECTIONS[World.ARRIVAL_DIRECTION]
    for (const layer of World.TAGS) {
      if (layer === tag) continue
      for (const gate of World.GATES_ON(q - d.x, r - d.y, layer)) {
        if (gate.type === ObjectType.Portal && gate.to === tag) return true
      }
    }
    return false
  }

  /**
   * The cells claimed by mobs part-way through a step, by layer and `Hex.key`:
   * the cell a mob left and the cell it is moving into, both until it arrives
   * (decision #31 Q2, "holds both cells"). A mob at rest holds its own cell
   * through `UNITS` instead, so nothing here needs releasing when it stands
   * still. Written only by `claimStep` and `releaseStep`.
   *
   * A claim is honoured only while its mob is live, indexed and still
   * stepping (`mobHolds`), so a mob a spec empties out of `MOBS`, or one that
   * died mid-step, cannot leave a cell held for ever. `removeUnitAt` releases
   * a swept mob's claims so the map does not keep them either.
   */
  STEPS: Map<number, Map<number, Unit>> = new Map()

  /** Claim `from` and `to` on the mob's layer for a step. */
  static claimStep (unit: Unit, from: Vector, to: Vector): void {
    let cells = World.STEPS.get(unit.tag)
    if (cells === undefined) {
      cells = new Map()
      World.STEPS.set(unit.tag, cells)
    }
    cells.set(Hex.key(from.x, from.y), unit)
    cells.set(Hex.key(to.x, to.y), unit)
  }

  /** Drop whatever `unit` claimed for its step, if it is still the claimant. */
  static releaseStep (unit: Unit): void {
    const cells = World.STEPS.get(unit.tag)
    if (cells === undefined) return
    for (const cell of [unit.stepFrom, unit.stepTo]) {
      if (cell === undefined) continue
      const key = Hex.key(cell.x, cell.y)
      if (cells.get(key) === unit) cells.delete(key)
    }
  }

  /**
   * True if a mob other than `except` holds cell (q, r) of layer `tag`: one
   * stands on it (`UNITS`), or one is stepping out of or into it (`STEPS`).
   * Dead mobs hold nothing. Lookups only, never a scan.
   */
  static mobHolds (q: number, r: number, tag: number, except?: Unit): boolean {
    const key = Hex.key(q, r)
    const claimant = World.STEPS.get(tag)?.get(key)
    if (
      claimant !== undefined && claimant !== except && !claimant.destroyed &&
      claimant.stepTo !== undefined && World.UNITS.has(claimant)
    ) return true
    for (const unit of World.UNITS.at(tag, key)) {
      if (unit !== except && unit.type === ObjectType.Mob && !unit.destroyed) return true
    }
    return false
  }

  /**
   * True if `mob` may step onto cell (q, r) of its layer: on the map, not a
   * rock or stone, not a portal's or exit's cell, not a portal's arrival cell,
   * and not held by another mob. Players don't count: a mob may share a cell
   * with them (#31 Q2), though its chase stops a ring short of its target.
   */
  static mobCanEnter (q: number, r: number, mob: Unit): boolean {
    return World.mobCellFree(q, r, mob.tag, mob)
  }

  /** `mobCanEnter` for a cell of layer `tag`, ignoring `except`'s own hold (a spawn has none). */
  static mobCellFree (q: number, r: number, tag: number, except?: Unit): boolean {
    if (World.isBlocked(q, r, tag)) return false
    if (World.GATES_ON(q, r, tag).length > 0) return false
    if (World.isArrival(q, r, tag)) return false
    return !World.mobHolds(q, r, tag, except)
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
    // Cell by cell along the line: the first cell with anyone on it decides.
    // A cell repeated later in the line is already settled by then.
    for (const cell of cells) {
      let first: Unit | undefined
      let firstSq = Infinity
      for (const unit of World.UNITS_ON(cell.x, cell.y, tag)) {
        if (unit === exclude || unit.destroyed) continue
        if ((unit.type & typeMask) === 0) continue
        const sq = unit.position.sub(from).getSquareMagnitude()
        if (sq < firstSq) {
          first = unit
          firstSq = sq
        }
      }
      if (first !== undefined) return first
    }
    return undefined
  }
}
