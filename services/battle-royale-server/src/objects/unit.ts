import { GameObject } from './gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { Path } from '../utils/path'
import World from './world'
import type Buff from '../buffs/buff'
import { type IAIRoutine } from '../ai/airoutine'
import { type Archetype } from '../archetypes/archetypes'

// Below this squared magnitude a heading counts as zero (see the `direction` setter).
export const EPSILON = 1e-9

export class Unit extends GameObject {
  /**
   * Cells still to walk, first step first, and how far along we are.
   *
   * This is the whole of "where a unit is going" - there is no trajectory
   * object, the way there is no velocity object. `path` plus `pathIndex` is to
   * movement what `direction` plus `maxVelocity` already is to speed.
   *
   * A unit with no path keeps whatever direction was last set on it, which is
   * how the AI routines go on steering by `setDirectionTo` untouched.
   */
  path: Vector[] = []
  pathIndex: number = 0

  /**
   * The cells the unit was told to go to, in order, kept so the route can be
   * recomputed without the caller having to remember it - which is what
   * StoneWall needs when it drops terrain across somebody's path.
   *
   * A list rather than a single cell because a route can be built up leg by leg
   * (shift-click on the client). One waypoint is the ordinary case.
   */
  waypoints: Vector[] = []

  /**
   * Route distance still to be covered at dash speed (decision #34): Dash
   * sets it to `DASH_CELLS * Hex.SIZE` (135), and `routeBudget` spends it at
   * `DASH_MULTIPLIER` times the unit's speed. Distance, not time, so the
   * predicting client and the server cover the same stretch of route even
   * though the server starts it a tick later. Cleared by `stop()` (arrival, a
   * layer change, a stop); kept across a re-route.
   *
   * **Mirrored by `LocalPlayer.dashLeft`** and its `_routeBudget`;
   * `extract.spec.ts` walks both through a dash.
   */
  dashLeft: number = 0

  /** Dash speed, as a multiple of `maxVelocity` (#34: 2.5, today's peak). */
  static DASH_MULTIPLIER = 2.5
  /** Cells of route a dash covers at `DASH_MULTIPLIER` (#34). */
  static DASH_CELLS = 3

  /**
   * Where a mob is stepping to, set by its AI every tick (hex-cells P2,
   * decision #31 Q1): stop within `within` rings of `cell`, one neighbour at a
   * time (`step`). Undefined means stay. Players never have one; they route.
   */
  stepGoal: { cell: Vector, within: number } | undefined

  /**
   * The step in progress: the cell left and the cell being moved into, both
   * claimed in `World.STEPS` until the unit reaches `stepTo`'s centre.
   * Undefined when at rest.
   */
  stepFrom: Vector | undefined
  stepTo: Vector | undefined

  /**
   * True if the last step decision found no neighbour closer to the goal: the
   * unit is standing still short of it (a wall, or other mobs, in the way).
   * The AI reads it to give up on a wander goal.
   */
  stepBlocked: boolean = false

  /**
   * The way this unit last moved, kept when it stops. Skills aim along it.
   *
   * `direction` is movement: `stop()` zeroes it, because a unit with a heading
   * and no path walks. Aiming with it made a standing caster's fireball sit on
   * them as a mine, fired ranged and StoneWall at their own feet, and made Dash
   * do nothing. This is the heading with the stopping taken out (decision #16).
   *
   * Always unit length. It is updated by the `direction` setter below, so
   * every write - `setDirection`, `setDirectionTo`, the path re-aim - keeps
   * it current and none can forget to, and by `walkPath` and `step`, which set
   * it to the segment actually walked. So a walk ends facing along its last
   * step between two cell centres, which is one of the six directions and the
   * same on the predicting client (`LocalPlayer.facingIndex`): a standing
   * Dash goes that way on both sides. East until the unit first moves (Nick,
   * 2026-09-24).
   *
   * On the wire as `facing`, snapped to a `Hex.DIRECTIONS` index (see the
   * setter). Effects carry their own aim; this is for sprites (decision #21).
   */
  get facing (): Vector {
    return this._facing
  }

  /**
   * Marks `facing` dirty only when the snapped index changes. Every tick of a
   * walk re-aims `direction`, which writes this, and marking it on every write
   * would send two bytes per moving unit per tick for a value that changes only
   * when the route turns.
   */
  set facing (value: Vector) {
    this._facing = value
    const index = World.FACING_INDEX(value)
    if (index !== this._facingIndex) {
      this._facingIndex = index
      this.dirtyFields.add('facing')
    }
  }

  /** `World.FACING_INDEX(facing)`, the value sent on the wire. */
  get facingIndex (): number {
    return this._facingIndex
  }

  private _facing: Vector = new Vector(1, 0)
  private _facingIndex: number = 0

  damageReduction: number = 0
  routines: IAIRoutine[] = []
  buffs: Buff[] = []
  canAttack: boolean = true
  target: GameObject | undefined
  // No `armor` field here: it is GameObject's accessor (see its comment).
  weapon: number = 0

  /**
   * The armor pool's refill clock (#16). `armorRefillAt` is the `Date.now()`
   * before which the pool does not refill; every hit that does damage pushes
   * it `archetype.armor.delayMs` ahead. `armorCarry` is the fraction of a
   * point earned but not yet added, so the pool stays a whole number while the
   * rate stays exact under a measured, jittering `dt`.
   */
  armorRefillAt: number = 0
  armorCarry: number = 0

  /**
   * What kind of unit this is (archetypes.ts). Undefined only for the bare
   * units the specs build as targets, which set their own hp.
   */
  archetype: Archetype | undefined

  /**
   * With an archetype, its stats are applied here - radius, maxHp, hp, speed,
   * loot - so they are in place before a subclass sends the create record.
   * That order is the point: the boss used to set its radius after Mob's
   * constructor had already sent a grunt-sized create.
   *
   * `radius` is only for bare units; with an archetype, its `body` is used.
   */
  constructor (
    objType: number,
    x: number,
    y: number,
    radius: number,
    tag: number,
    archetype?: Archetype
  ) {
    // Named `lifetime` before, but GameObject's fourth parameter is radius, so
    // that is what every caller was actually setting.
    super(objType, x, y, archetype?.body ?? radius, tag)
    this.direction = new Vector(0, 0)

    this.archetype = archetype
    if (archetype !== undefined) {
      this.maxHp = archetype.maxHp
      this.hp = archetype.maxHp
      this.maxVelocity = archetype.speed
      this.loot = archetype.loot

      // Only a unit with a pool sends one. A mob's is always 0/0, and the
      // client reads a missing field as 0, so its records stay as they were.
      if (archetype.armor.max > 0) {
        this.maxArmor = archetype.armor.max
        this.armor = archetype.armor.max
        for (const fields of [this.allFields, this.allFieldsOwn]) {
          fields.add('armor')
          fields.add('maxArmor')
        }
      }

      // Last, so it lands at the end of both records. Snapshot sets only: the
      // id never changes, so it is never dirty and never in a delta.
      this.allFields.add('archetype')
      this.allFieldsOwn.add('archetype')
    }
  }

  /**
   * The wire carries the snapped index, not the vector (see `facing`), and the
   * archetype's id, not the archetype.
   */
  serialise (fields: Set<string>): ReturnType<GameObject['serialise']> {
    const result = super.serialise(fields)
    if (result !== null && 'facing' in result) (result as Record<string, unknown>).facing = this._facingIndex
    if (result !== null && 'archetype' in result) (result as Record<string, unknown>).archetype = this.archetype?.id
    return result
  }

  get direction (): Vector {
    return super.direction
  }

  /**
   * A zero (or non-finite) vector means "stopped" and leaves `facing` alone;
   * anything else becomes the new facing. `getDirectionTo` a point the unit is
   * standing on is (0,0), so that case must not face it anywhere.
   */
  set direction (value: Vector) {
    super.direction = value
    if (value != null && value.getSquareMagnitude() > EPSILON) {
      this.facing = value.normalised()
    }
  }

  getDirectionTo (targetX: number, targetY: number): Vector {
    return new Vector(
      targetX - this.position.x,
      targetY - this.position.y
    ).normalised()
  }

  setDirection (directionX: number, directionY: number): void {
    this.direction = new Vector(directionX, directionY).normalised()
  }

  setDirectionTo (targetX: number, targetY: number): void {
    this.direction = this.getDirectionTo(targetX, targetY)
  }

  addAIRoutine (value: IAIRoutine): void {
    this.routines.push(value)
  }

  /** Refile in `World.UNITS` / `World.INTEREST` (see `GameObject.placed`). */
  protected placed (): void {
    World.unitMoved(this)
  }

  /**
   * True if this unit can't walk into cell (q, r) of its layer. A unit whose
   * archetype `passesObstacles` (Hopper, decisions #15, #16 H2-H3, #44) is
   * stopped only by void and the map edge: it routes and dashes through
   * walls and StoneWall stones, and may stop on one (#23). Everyone else, by
   * any blocked cell. **Mirrored by the client's `Game.blocksLocal`.**
   */
  blocks (q: number, r: number): boolean {
    if (this.archetype?.passesObstacles === true) return World.isVoid(q, r, this.tag)
    return World.isBlocked(q, r, this.tag)
  }

  /** The cell this unit is standing in. */
  get cell (): Vector {
    return Hex.toCell(this.position)
  }

  /**
   * Route to a destination cell, replacing any path in progress.
   *
   * An unreachable destination - blocked, outside the search window, or walled
   * off - leaves the unit standing still rather than drifting toward it, which
   * is the honest answer and the one the client predicts too.
   */
  setDestination (q: number, r: number): void {
    this.setWaypoints([new Vector(q, r)])
  }

  setWaypoints (cells: Vector[]): void {
    this.waypoints = cells
    this.repath()
  }

  /**
   * Recompute the route through the standing waypoints from wherever we are.
   *
   * Legs are searched one at a time and concatenated. A leg that cannot be
   * reached ends the route there rather than skipping to the next waypoint,
   * because walking a route with a hole in it is worse than stopping short of
   * one - and the client, running the same thing, stops in the same place.
   */
  repath (): void {
    if (this.waypoints.length === 0) return

    this.path = []
    let from = this.cell

    for (const waypoint of this.waypoints) {
      const leg = Path.find(
        from,
        waypoint,
        (cq, cr) => this.blocks(cq, cr)
      )
      if (leg.length === 0) break
      for (const cell of leg) this.path.push(cell)
      from = waypoint
    }
    this.endAtPortal()

    this.pathIndex = 0

    // Give up rather than retry forever. A destination that cannot be reached
    // now will not become reachable by asking again next tick, and a unit
    // silently re-searching every tick is the cost blow-up this design exists
    // to avoid.
    if (this.path.length === 0) this.stop()
  }

  /**
   * Drop the path, the waypoints and the heading, and stand still.
   * `facing` is kept: a stopped unit still faces the way it was going.
   */
  stop (): void {
    this.path = []
    this.pathIndex = 0
    this.waypoints = []
    this.dashLeft = 0
    this.direction = new Vector(0, 0)
  }

  /**
   * True if a route must end on this cell of the unit's layer: a portal that
   * would take it somewhere else (`Player`). Nothing for other units.
   */
  stopsOn (q: number, r: number): boolean {
    return false
  }

  /**
   * Cut the route after its first cell that `stopsOn` (hex-cells P2). A
   * player entering a portal cell is moved to the portal's arrival cell on
   * the other layer (`Player.hopPortal`), so nothing past it on this layer can
   * be walked; ending the route there also means a tick of dash speed can't
   * carry the player clean across the portal cell without ever standing in it.
   * **Mirrored by `LocalPlayer._endAtPortal`**: the client walks to the
   * portal's centre and waits there for the new layer's tag.
   */
  endAtPortal (): void {
    for (let i = 0; i < this.path.length; i++) {
      if (this.stopsOn(this.path[i].x, this.path[i].y)) {
        this.path.length = i + 1
        return
      }
    }
  }

  /**
   * Start a dash (decision #34). On a route: the next `DASH_CELLS` cells of it
   * at `DASH_MULTIPLIER` times the speed, or to the route's end if that comes
   * first. Standing: a route of up to `DASH_CELLS` cells straight along the
   * facing (snapped to one of the six), stopping before a rock, a stone or the
   * map's edge, and at a portal; its last cell becomes the destination, so a
   * re-plan to the old destination cannot undo it. False, and nothing
   * changes, if a standing dash has no free cell ahead: the skill then spends
   * no cooldown.
   *
   * **Mirrored by `LocalPlayer.dash`**, which the client runs on the press.
   */
  dash (): boolean {
    if (this.path.length === 0) {
      const cells = this.dashCells()
      if (cells.length === 0) return false
      this.path = cells
      this.pathIndex = 0
      this.waypoints = [cells[cells.length - 1]]
    }
    this.dashLeft = Unit.DASH_CELLS * Hex.SIZE
    return true
  }

  /** A standing dash's route: see `dash`. */
  dashCells (): Vector[] {
    const direction = World.FACING_INDEX(this.facing)
    const cells: Vector[] = []
    let cell = this.cell
    for (let i = 0; i < Unit.DASH_CELLS; i++) {
      cell = Hex.neighbour(cell, direction)
      if (this.blocks(cell.x, cell.y)) break
      cells.push(cell)
      if (this.stopsOn(cell.x, cell.y)) break
    }
    return cells
  }

  /**
   * How far along its route the unit gets in `dt`: `maxVelocity * dt`, except
   * that the first `dashLeft` units of it go at `DASH_MULTIPLIER` times that
   * speed. Spends `dashLeft`. Exact however `dt` is sliced, so a client
   * predicting at frame rate covers the same distance as the server at tick
   * rate. **Mirrored by `LocalPlayer._routeBudget`.**
   */
  routeBudget (dt: number): number {
    const normal = dt * this.maxVelocity
    if (this.dashLeft <= 0) return normal
    const fast = Math.min(this.dashLeft, normal * Unit.DASH_MULTIPLIER)
    this.dashLeft -= fast
    return fast + normal - fast / Unit.DASH_MULTIPLIER
  }

  /**
   * Move to layer `tag`, and stop if that is a change.
   *
   * A route is planned against one layer's rocks, and the destination was
   * chosen on that layer's map, so it means nothing on another. Walking it on
   * from a portal's arrival spot crossed the new layer along cells nobody
   * chose (gate-hygiene). **Mirrored by `LocalPlayer.changeLayer`**, which the
   * client runs when the new tag reaches it; `extract.spec.ts` walks both.
   *
   * `Connection.lastWaypoints` is left alone on purpose: the client goes on
   * sending the old route until the tag reaches it, and `onPointer` ignores
   * those packets as repeats instead of planning them on the new layer.
   */
  changeLayer (tag: number): void {
    if (tag === this.tag) return
    this.tag = tag
    this.stop()
  }

  /** True if any cell still to be walked is this one. */
  pathCrosses (q: number, r: number): boolean {
    for (let i = this.pathIndex; i < this.path.length; i++) {
      if (this.path[i].x === q && this.path[i].y === r) return true
    }
    return false
  }

  /**
   * Aim `direction` at the next cell on the path.
   *
   * Arrival is "the cell I am standing in is that cell" rather than a distance
   * threshold, so there is no tuned epsilon and nothing to oscillate around.
   *
   * The look-ahead is deliberately one cell and no more. It exists for a single
   * case: a tick that covers a whole cell (and push-out, until hex-cells P2)
   * can carry a unit past a cell it never stood in, and without it the unit
   * turns round to collect one it has already passed. Scanning the rest of the route instead is what broke
   * multi-leg routes - an appended leg comes back through cells the unit is
   * standing in right now, and matching that later occurrence teleported the
   * index to the far side of the route, so the unit set off for the last leg's
   * destination while the first leg was still ahead of it. Two adjacent cells
   * are never equal, so a look-ahead of one cannot land on a duplicate.
   */
  static PATH_LOOKAHEAD = 1

  /**
   * Advance along the route by a distance budget, carrying what is left over
   * from one cell into the next, and finish exactly on the last cell's centre.
   *
   * Aiming at the next centre and taking one straight step per tick instead
   * would overshoot every centre by a different amount, so a unit came to rest
   * wherever it happened to cross into the final cell. Client and server crossed
   * at slightly different points, and the correction between the two was visible
   * as a slide at the end of every walk. Landing on the centre makes the resting
   * place the same number on both sides, so there is nothing left to correct.
   *
   * Each segment walked sets `facing`, so a walk ends facing along its last
   * step. Returns the new position; the caller still owns clamping.
   */
  walkPath (x: number, y: number, budget: number): { x: number, y: number } {
    while (budget > 0 && this.pathIndex < this.path.length) {
      const centre = Hex.toPosition(this.path[this.pathIndex])
      const dx = centre.x - x
      const dy = centre.y - y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > 0) this.facing = new Vector(dx / distance, dy / distance)

      if (distance <= budget) {
        x = centre.x
        y = centre.y
        budget -= distance
        this.pathIndex++
      } else {
        x += (dx / distance) * budget
        y += (dy / distance) * budget
        budget = 0
      }
    }

    if (this.pathIndex >= this.path.length) this.stop()

    return { x, y }
  }

  /**
   * Re-aim after something has shoved us off the route, and nothing else.
   *
   * **It must never end the route.** Entering the last cell is not arriving at
   * it: `walkPath` finishes on the centre, and that is the whole point of it.
   * This used to advance the index past the end and `stop()` as soon as the
   * unit's cell matched the last cell, which is the moment it crosses the
   * boundary - so a walk came to rest wherever it entered the final cell,
   * roughly half a cell short of the middle. That was invisible while a cell
   * was 35 units and a tick's travel was also 35, because the two crossings
   * then fell in the same tick and `walkPath` always got to the centre first.
   * At 45 they no longer coincide and it stopped short every single time.
   *
   * So the index is capped at the last cell, and `walkPath` is the only thing
   * that ends a route.
   */
  followPath (): void {
    if (this.path.length === 0) return

    const here = this.cell
    const last = this.path.length - 1

    const limit = Math.min(this.path.length, this.pathIndex + Unit.PATH_LOOKAHEAD + 1)
    for (let i = this.pathIndex; i < limit; i++) {
      if (this.path[i].x === here.x && this.path[i].y === here.y) {
        this.pathIndex = Math.min(i + 1, last)
        break
      }
    }

    const centre = Hex.toPosition(this.path[this.pathIndex])
    this.setDirectionTo(centre.x, centre.y)
  }

  update (dt: number): void {
    for (const routine of this.routines) {
      routine.update(dt)
    }

    for (let i = this.buffs.length - 1; i >= 0; i--) {
      if (this.buffs[i].update(dt)) this.buffs.splice(i, 1)
    }

    if (this.direction == null) return

    let px = this.position.x
    let py = this.position.y

    // No push-out of any kind (hex-cells P2, decision #31): terrain blocks
    // cells, units don't. Players route only through unblocked cells and mobs
    // step only into free ones, so nothing ever needs shoving out of a rock,
    // a stone, a gate or another unit. The client's `LocalPlayer._step` lost
    // its push-out in the same change.
    if (this.stepGoal !== undefined || this.stepTo !== undefined) {
      // A mob, stepping cell to cell toward its AI's goal.
      const walked = this.step(px, py, dt * this.maxVelocity)
      px = walked.x
      py = walked.y
    } else if (this.path.length > 0) {
      // Following a route. `followPath` only re-aims the index; `walkPath`
      // does the moving, at dash speed for the first `dashLeft` of it.
      this.followPath()

      if (this.path.length > 0) {
        const walked = this.walkPath(px, py, this.routeBudget(dt))
        px = walked.x
        py = walked.y
      }
    } else {
      // No route and no step: a bare unit a spec steers by `direction`, or
      // standing still. No AI steers this way since P2.
      const step = dt * this.maxVelocity
      const dirSq = this.direction.x * this.direction.x + this.direction.y * this.direction.y
      if (dirSq > 0) {
        const inv = 1 / Math.sqrt(dirSq)
        px += this.direction.x * inv * step
        py += this.direction.y * inv * step
      }
    }

    for (const area of World.AREA_EFFECT) {
      if (area.tag !== this.tag) continue
      if (area.target === this) continue
      if (area.overlaps(this.position)) {
        const damage = area.getEffect(dt)
        this.hit(damage)
      }
    }

    // After every hit this tick can deal the unit itself, so a breath tick
    // landing now has already pushed the delay back.
    this.refillArmor(dt)

    px = px < 0 ? 0 : px
    px = px > World.mapSize ? World.mapSize : px

    py = py < 0 ? 0 : py
    py = py > World.mapSize ? World.mapSize : py

    if (this.position.x !== px || this.position.y !== py) {
      this.position = new Vector(px, py)
    }

    super.update(dt)
  }

  /**
   * Move a mob up to `budget` units by cell steps (decision #31 Q1), carrying
   * what is left at a centre into the next step so it keeps its speed. At a
   * centre it asks `chooseStep` for the next cell, claims that cell and the
   * one it is leaving (`World.claimStep`: "holds both cells"), and walks
   * straight to the new centre; both claims go when it gets there, and from
   * then on the index holds the cell it stands on. It always finishes a step
   * it has started, even if its goal changes: the claim is what keeps two
   * mobs out of one cell, and it is only released on arrival.
   */
  step (x: number, y: number, budget: number): { x: number, y: number } {
    this.stepBlocked = false
    while (budget > 0) {
      if (this.stepTo === undefined) {
        const next = this.chooseStep(x, y)
        if (next === undefined) break
        this.stepFrom = Hex.toCell(new Vector(x, y))
        this.stepTo = next
        World.claimStep(this, this.stepFrom, next)
      }

      const centre = Hex.toPosition(this.stepTo)
      const dx = centre.x - x
      const dy = centre.y - y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > 0) this.facing = new Vector(dx / distance, dy / distance)

      if (distance <= budget) {
        x = centre.x
        y = centre.y
        budget -= distance
        World.releaseStep(this)
        this.stepFrom = undefined
        this.stepTo = undefined
      } else {
        x += (dx / distance) * budget
        y += (dy / distance) * budget
        budget = 0
      }
    }
    return { x, y }
  }

  /**
   * The next cell for a mob standing at (x, y), or undefined to stay.
   *
   * Stay when there is no goal, or the goal is within `within` rings.
   * Otherwise, of the six neighbours a mob may enter (`World.mobCanEnter`:
   * not blocked, not a gate or arrival cell, not held by another mob), the one
   * nearest the goal by `Hex.distance`, ties to the lowest `Hex.DIRECTIONS`
   * index; and stay if none is nearer than where it stands, which is what
   * keeps a mob with a wall between it and its target still instead of
   * rocking between two cells. A mob off its cell's centre (only specs build
   * one) first walks to that centre.
   *
   * Greedy on purpose (#31 Q1). If mobs get stuck behind walls in play, the
   * upgrade is a breadth-first search to the goal over the same `mobCanEnter`
   * cells, run at a centre, taking the first cell of the route (`Path.find`
   * with `mobCanEnter` as the passability test) - rejected for now as a
   * search per mob per step.
   */
  private chooseStep (x: number, y: number): Vector | undefined {
    const goal = this.stepGoal
    if (goal === undefined) return undefined

    const here = Hex.toCell(new Vector(x, y))
    const centre = Hex.toPosition(here)
    if (Math.abs(centre.x - x) > EPSILON || Math.abs(centre.y - y) > EPSILON) return here

    const now = Hex.distance(here, goal.cell)
    if (now <= goal.within) return undefined

    let best: Vector | undefined
    let bestDistance = now
    for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
      const cell = Hex.neighbour(here, i)
      if (!World.mobCanEnter(cell.x, cell.y, this)) continue
      const distance = Hex.distance(cell, goal.cell)
      if (distance < bestDistance) {
        best = cell
        bestDistance = distance
      }
    }
    if (best === undefined) this.stepBlocked = true
    return best
  }

  maxHP (): number {
    return this.maxHp
  }

  /**
   * `archetype.armor.refillPerSec`, once `delayMs` has passed since the last
   * hit that did damage. A comparison against the clock, not a Timers entry:
   * it moves on every hit, and re-arming a timer per hit is churn for nothing.
   */
  private refillArmor (dt: number): void {
    if (this.armor >= this.maxArmor) {
      this.armorCarry = 0
      return
    }
    if (this.archetype === undefined || Date.now() < this.armorRefillAt) return

    this.armorCarry += this.archetype.armor.refillPerSec * dt
    const whole = Math.floor(this.armorCarry)
    if (whole <= 0) return
    this.armorCarry -= whole
    this.armor = Math.min(this.maxArmor, this.armor + whole)
  }

  hit (value: number): boolean {
    // A dead unit stays in its world list until the next tick sweeps it, and
    // FIND_IN_CELLS does not skip it, so a second hit in the same tick reached
    // the corpse and destroyed it again: its id was freed twice (two later
    // objects then share it) and the second killer was credited too.
    if (this.destroyed) return false

    // Defend first, then the armor pool, then hp (#16). The reduction is
    // clamped so a stacked one can never turn a hit into a heal.
    const multiplier = Math.max(0, Math.min(1, 1 - this.damageReduction))
    const damage = Math.floor(value * multiplier)

    let absorbed = 0
    if (damage > 0) {
      absorbed = Math.min(this.armor, damage)
      if (absorbed > 0) this.armor -= absorbed

      // Only a hit that did damage holds the refill off. One floored to zero
      // (a breath tick under Defend) must not keep a pool empty forever.
      this.armorRefillAt = Date.now() + (this.archetype?.armor.delayMs ?? 0)
      this.armorCarry = 0
    }
    this.hp -= damage - absorbed

    if (this.hp <= 0) {
      this.hp = 0
      super.destroy()
      return true
    }

    return false
  }

  /** A player is within this unit's contact range (`Mob.touch`). Nothing for most units. */
  onCollideWithPlayer (target: GameObject): void {}

  addBuff (value: Buff): void {
    // dont stack same buffs?
    this.buffs.push(value)
  }

  onKill (obj: GameObject): void {}
}
