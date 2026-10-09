import { Unit } from './unit'
import { ObjectType } from './gameobject'
import Multiplayer from '../network/multiplayer'
import Timers from './timers'
import World from './world'
import { type Archetype, type LayerPack, ARCHETYPES, buildRoutines, buildSkills } from '../archetypes/archetypes'
import GuardPosition from '../ai/guardposition'
import { type Vector } from '../utils/vector'

/**
 * Mobs spawned together from one `LayerPack` entry (decision #51, L1): a
 * Crawler pack and its escort Coil. They share one home (each member's
 * `GuardPosition.homePosition`) and one aggro (`GuardPosition.provoke`). Alive
 * while any member is: `World.refillLayer` replaces a pack only once every
 * member is dead (Q11).
 *
 * Held only by its members' `pack`, so it goes when the last of them leaves
 * `MOBS`; the world keeps no list of packs.
 */
export class MobPack {
  readonly entry: LayerPack
  readonly home: Vector
  readonly members: Mob[] = []

  constructor (entry: LayerPack, home: Vector) {
    this.entry = entry
    this.home = home
  }

  /** Add `mob` and give its guard the pack's home. */
  join (mob: Mob): void {
    this.members.push(mob)
    mob.pack = this
    for (const routine of mob.routines) {
      if (routine instanceof GuardPosition) routine.homePosition = this.home
    }
  }
}

/**
 * Any non-player unit: grunt, boss, and whatever else the archetype table says.
 * The kind is the archetype, not a subclass (decision #23).
 */
export default class Mob extends Unit {
  // Always set, by Unit's constructor; narrowed from Unit's optional one.
  declare archetype: Archetype
  /**
   * The pack it spawned in (`MobPack.join`), or undefined for a mob spawned
   * alone. Set after construction, never by a base constructor.
   */
  pack: MobPack | undefined = undefined
  /**
   * Takes over `hit` while set: the Broodling's fuse routine (task l1-7,
   * `mobskills/broodling.ts`), which goes off on any damaging hit, not only
   * a lethal one. Returns what `hit` returns: true if this hit destroyed the
   * mob, so the caller credits the kill. Set by a routine built in this
   * constructor's body, after this initialiser has run.
   */
  onHit: ((value: number) => boolean) | undefined = undefined
  /**
   * A Broodling set off by a damaging hit: the mobs its blast killed, waiting
   * for the `onKill` of whoever dealt that hit, which credits them too when
   * it is a player's (`Player.onKill`, Brood stream numbers 2026-10-09).
   * Undefined otherwise, and once credited. Set by the fuse after
   * construction, never by a base constructor.
   */
  blastKills: Unit[] | undefined = undefined

  /** `archetype` defaults to the grunt, which is what a plain `Mob` always was. */
  constructor (x: number, y: number, tag: number, archetype: Archetype = ARCHETYPES.grunt) {
    super(ObjectType.Mob, x, y, 0, tag, archetype)

    // The skills live only inside the routines that use them: a mob never
    // receives a slot index, so it has no `skills` list of its own.
    for (const routine of buildRoutines(this, archetype, buildSkills(this, archetype))) {
      this.addAIRoutine(routine)
    }

    Multiplayer.Instance.create(this)

    // After the create, not in Unit's constructor: see Archetype.level.
    if (archetype.level !== undefined) this.level = archetype.level
  }

  update (dt: number): void {
    super.update(dt)
    if (!this.destroyed) this.touch()
  }

  /** `Unit.hit`, unless a routine has hooked it (`onHit`). A corpse is never hit. */
  hit (value: number): boolean {
    if (this.onHit !== undefined && !this.destroyed) return this.onHit(value)
    return super.hit(value)
  }

  /**
   * Contact damage, after this tick's step: the mob's target if it is a live
   * player within `archetype.contact.rings` (1 for every mob, decision #32),
   * otherwise the lowest-id live player within them. A cell lookup
   * (`World.FIND_IN_CELLS`, 7 cells), not a scan of `PLAYERS`. At most one hit
   * per `contact.cooldownMs`, as before.
   */
  touch (): void {
    if (this.archetype.contact.damage <= 0 || !this.canAttack) return
    const near = World.FIND_IN_CELLS(this.cell, this.archetype.contact.rings, this.tag, ObjectType.Player)
      .filter((unit) => !unit.destroyed && (unit as { exited?: boolean }).exited !== true)
    if (near.length === 0) return
    const target = near.find((unit) => unit === this.target) ??
      near.reduce((a, b) => (b.id < a.id ? b : a))
    this.onCollideWithPlayer(target)
  }

  onCollideWithPlayer (target: Unit): void {
    // No contact attack (the gunner). Nothing at all happens on touch: no
    // cooldown is armed and no `hit(0)` is dealt, so a touch cannot kill a
    // player already at 0 hp, credit a kill, or anything else a hit does.
    if (this.archetype.contact.damage <= 0) return

    if (this.canAttack) {
      Timers.schedule(this.archetype.contact.cooldownMs, () => { this.canAttack = true }, this)

      this.canAttack = false
      if (target.hit(this.archetype.contact.damage)) { this.onKill(target) }
    }
  }
}
