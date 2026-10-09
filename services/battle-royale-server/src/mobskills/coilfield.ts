import { type IAIRoutine } from '../ai/airoutine'
import { type CoilFieldSpec } from '../archetypes/archetypes'
import { NPC_EFFECT } from '../archetypes/npceffects'
import FieldSlow from '../buffs/fieldslow'
import Multiplayer from '../network/multiplayer'
import { type GameObject, ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import World from '../objects/world'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

/**
 * The Coil Tripod's slowing field (decision #51, task l1-3): a mob skill run
 * as a routine, after the Coil's guard.
 *
 * A **charge** starts when the guard's target (a live player on the Coil's
 * layer) is within the field's `rings` of the Coil, at most once per
 * `cooldownMs` start to start. It follows the approved clip:
 *
 * - **Tell** (`tellMs`, the clip's gather + release): nothing is slowed yet.
 * - **Hold** (`holdMs`): on every tick of it, every live player standing
 *   within `rings` of the field's cell gets a `FieldSlow` of `slow` ending
 *   `tailMs` after the hold ends. One `World.FIND_IN_CELLS` per Coil per
 *   tick of the hold (19 cells at 2 rings), never a walk over players; six
 *   per charge at 250 ms ticks. A player who walks on mid-hold is caught; one
 *   who walks off keeps the slow to the same end. Every charge's slows end
 *   together, so a hold refreshes nothing but another Coil's slow.
 * - **Cool** (`coolMs`): nothing.
 *
 * The Coil stays **planted** from the charge's start to the end of the cool,
 * as the clip is (its legs are still in charge mode): this routine clears
 * the step goal its guard set this tick, and a step already under way ends on
 * the cell it was entering, which is why that cell is the field's. The field
 * stays on that cell for the whole charge.
 *
 * On the wire: effect 13 (`NPC_EFFECT.coilPulse`) once when the charge
 * starts, on the field's cell, lasting tell + hold (`effectAt`, to every
 * viewer on the layer who sees the cell), so the client can play the gather
 * as the tell; and effect 16 (`slowed`) on a player when a slow starts on it,
 * or when a later one extends it after more than half its announced time
 * (`FieldSlow.apply`). The speed itself goes out as field 27 (`speed`), which
 * the client predicts with.
 *
 * A Coil killed mid-charge stops at once (a dead unit is not updated, and
 * nothing here is a timer): no slow lands after its death, and those already
 * applied run out on their own.
 */
export default class CoilField implements IAIRoutine {
  readonly owner: Unit
  readonly spec: CoilFieldSpec
  /** The field's size in rings: the mirrored `attack` disc's. */
  readonly rings: number
  /** When the charge under way began, or undefined when none is. */
  chargeAt: number | undefined = undefined
  /** When the last charge began: the cooldown runs from here. */
  lastChargeAt = -Infinity
  /** The field's cell for the charge under way. */
  cell: Vector | undefined = undefined

  constructor (owner: Unit, spec: CoilFieldSpec, rings: number) {
    this.owner = owner
    this.spec = spec
    this.rings = rings
  }

  update (dt: number): void {
    const now = Date.now()
    const spec = this.spec

    if (this.chargeAt !== undefined) {
      const t = now - this.chargeAt
      if (t < spec.tellMs + spec.holdMs + spec.coolMs) {
        this.owner.stepGoal = undefined
        if (t >= spec.tellMs && t < spec.tellMs + spec.holdMs) {
          this.pulse(this.chargeAt + spec.tellMs + spec.holdMs + spec.tailMs, now)
        }
        return
      }
      this.chargeAt = undefined
      this.cell = undefined
    }

    if (now - this.lastChargeAt < spec.cooldownMs) return
    const target = this.owner.target
    if (target == null || !CoilField.slowable(target) || target.tag !== this.owner.tag) return
    if (Hex.distance(this.owner.cell, Hex.toCell(target.position)) > this.rings) return

    this.chargeAt = now
    this.lastChargeAt = now
    this.cell = this.owner.stepTo ?? this.owner.cell
    this.owner.stepGoal = undefined
    Multiplayer.Instance.effectAt(NPC_EFFECT.coilPulse, this.owner.id, spec.tellMs + spec.holdMs, this.cell, this.owner.tag)
  }

  /** One tick of the hold: slow every live player on the field until `until`. */
  private pulse (until: number, now: number): void {
    const cell = this.cell
    if (cell === undefined) return
    for (const unit of World.FIND_IN_CELLS(cell, this.rings, this.owner.tag, ObjectType.Player)) {
      if (!CoilField.slowable(unit)) continue
      if (FieldSlow.apply(unit, this.spec.slow, until, now)) {
        Multiplayer.Instance.effect(NPC_EFFECT.slowed, unit, until - now)
      }
    }
  }

  /** A player still in the run: not dead (found until the sweep), not extracted. */
  private static slowable (unit: GameObject): boolean {
    return !unit.destroyed && (unit as { exited?: boolean }).exited !== true
  }
}
