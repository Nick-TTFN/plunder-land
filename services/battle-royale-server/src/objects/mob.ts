import { Unit } from './unit'
import { ObjectType } from './gameobject'
import Multiplayer from '../network/multiplayer'
import Timers from './timers'
import { type Archetype, ARCHETYPES, buildRoutines, buildSkills } from '../archetypes/archetypes'

/**
 * Any non-player unit: grunt, boss, and whatever else the archetype table says.
 * The kind is the archetype, not a subclass (decision #23).
 */
export default class Mob extends Unit {
  // Always set, by Unit's constructor; narrowed from Unit's optional one.
  declare archetype: Archetype

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

  onCollideWithPlayer (target: Unit): void {
    // No contact attack (the gunner). Nothing at all happens on touch: no
    // cooldown is armed and no `hit(0)` is dealt, so a touch cannot kill a
    // player already at 0 hp, credit a kill, or anything else a hit does.
    // The two bodies are still pushed apart by `Unit.update`.
    if (this.archetype.contact.damage <= 0) return

    if (this.canAttack) {
      Timers.schedule(this.archetype.contact.cooldownMs, () => { this.canAttack = true }, this)

      this.canAttack = false
      if (target.hit(this.archetype.contact.damage)) { this.onKill(target) }
    }
  }
}
