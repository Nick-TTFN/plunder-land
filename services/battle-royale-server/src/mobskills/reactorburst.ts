import { type IAIRoutine } from '../ai/airoutine'
import { type Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import World from '../objects/world'
import Timers from '../objects/timers'
import Multiplayer from '../network/multiplayer'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

/**
 * The Reactor Spider's burst (decision #51, task l1-5), as an archetype
 * routine spec. Rings are `Hex.distance` and include the boundary.
 */
export interface ReactorBurstSpec {
  kind: 'reactorBurst'
  /** Plants once its target is at most this many rings from the cell it stands on (or is stepping into). */
  plantRings: number
  /** The burst's disc round the planted cell: the mirror's `attack.rings`, which the client draws. */
  rings: number
  /** Dealt to every player on the disc at each pulse. */
  damage: number
  /** Pulses in the release, evenly spaced from its start: `releaseMs / pulses` apart. */
  pulses: number
  /** The activation tell, effect 11, from the plant to the release. */
  activateMs: number
  /** The release, effect 12, during which the pulses land. */
  releaseMs: number
  /** Still planted after the release, no burst: the punish window. */
  settleMs: number
  /** From the end of the settle until it may plant again; it chases meanwhile. */
  cooldownMs: number
}

export type ReactorPhase = 'ready' | 'activate' | 'release' | 'settle' | 'cooldown'

/**
 * Chase, plant, activate, release, settle, cool down, chase again.
 *
 * **Chase** is the guard's (it runs before this routine and sets `stepGoal`).
 * Once the target is within `plantRings` of the cell the Reactor stands on,
 * or of the one it is stepping into, it **plants** on that cell: from then
 * until the settle ends this routine clears `stepGoal` every tick, after the
 * guard has set it, so the Reactor finishes the step in progress
 * (`Unit.step` always does) and takes no other. The tell and the burst are
 * drawn and dealt on the planted cell, so they are the cells it stands on
 * from at most one step after the plant.
 *
 * Every later moment is a `Timers` entry scheduled at the plant, each at its
 * own offset from the plant time (so lateness never accumulates) and **owned
 * by the Reactor**: its death cancels them all (`GameObject.destroy` calls
 * `Timers.cancelOwner`), so a Reactor killed during the tell or the release
 * stops at once, with no posthumous pulse. Timers run at the top of a tick, so
 * each moment lands on the first tick at or after it: with 250 ms ticks the
 * settle's 350 ms ends on the tick 500 ms after the release ends.
 *
 * The pulses hit **players only** (decision #51 Q6): `FIND_IN_CELLS` with the
 * player mask, not an `AREA_EFFECT` (those hit every unit, mobs included).
 * A kill is credited to the Reactor. Contact damage (`Mob.touch`) is separate
 * and goes on in every phase.
 */
export default class ReactorBurst implements IAIRoutine {
  readonly owner: Unit
  readonly spec: ReactorBurstSpec
  phase: ReactorPhase = 'ready'
  /** The planted cell, from the plant until the settle ends; undefined otherwise. */
  plantedCell: Vector | undefined
  /** `Date.now()` from which a cooling-down Reactor may plant again. */
  private readyAt = 0

  constructor (owner: Unit, spec: ReactorBurstSpec) {
    this.owner = owner
    this.spec = spec
  }

  get planted (): boolean {
    return this.phase === 'activate' || this.phase === 'release' || this.phase === 'settle'
  }

  update (dt: number): void {
    const owner = this.owner
    if (this.planted) {
      owner.stepGoal = undefined
      return
    }
    if (this.phase === 'cooldown') {
      if (Date.now() < this.readyAt) return
      this.phase = 'ready'
    }

    const target = owner.target
    if (target == null || target.destroyed || target.type !== ObjectType.Player) return
    if ((target as { exited?: boolean }).exited === true) return

    const cell = owner.stepTo ?? owner.cell
    if (Hex.distance(cell, Hex.toCell(target.position)) > this.spec.plantRings) return

    this.plant(cell)
    owner.stepGoal = undefined
  }

  private plant (cell: Vector): void {
    const owner = this.owner
    const spec = this.spec
    const t0 = Date.now()
    const at = (offsetMs: number, fn: () => void): void => {
      Timers.schedule(t0 + offsetMs - Date.now(), fn, owner)
    }

    this.phase = 'activate'
    this.plantedCell = cell
    Multiplayer.Instance.effectAt(NPC_EFFECT.reactorTell, owner.id, spec.activateMs, cell, owner.tag)

    at(spec.activateMs, () => {
      this.phase = 'release'
      Multiplayer.Instance.effectAt(NPC_EFFECT.reactorRelease, owner.id, spec.releaseMs, cell, owner.tag)
    })
    // Scheduled after the release timer, so on the same due it runs second.
    const interval = spec.releaseMs / spec.pulses
    for (let i = 0; i < spec.pulses; i++) {
      at(spec.activateMs + i * interval, () => { this.pulse(cell) })
    }
    at(spec.activateMs + spec.releaseMs, () => { this.phase = 'settle' })
    at(spec.activateMs + spec.releaseMs + spec.settleMs, () => {
      this.phase = 'cooldown'
      this.plantedCell = undefined
      this.readyAt = Date.now() + spec.cooldownMs
    })
  }

  /** `spec.damage` to every live, unextracted player on the disc round `cell`. */
  private pulse (cell: Vector): void {
    const owner = this.owner
    for (const unit of World.FIND_IN_CELLS(cell, this.spec.rings, owner.tag, ObjectType.Player)) {
      // A corpse stays filed until the next sweep; an extracted player until the next tick.
      if (unit.destroyed || (unit as { exited?: boolean }).exited === true) continue
      if (unit.hit(this.spec.damage)) owner.onKill(unit)
    }
  }
}
