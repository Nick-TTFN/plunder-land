import { type IAIRoutine } from '../ai/airoutine'
import { type Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import Mob from '../objects/mob'
import World from '../objects/world'
import Timers, { type Timer } from '../objects/timers'
import Multiplayer from '../network/multiplayer'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { type Archetype } from '../archetypes/archetypes'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

/**
 * The Brood carrier's stream (decision #51, task l1-7), as an archetype
 * routine spec.
 */
export interface BroodSpec {
  kind: 'brood'
  /** What it releases: the Broodling row (passed in, so this module reads no table). */
  child: Archetype
  /** One release per interval while it has a target. */
  intervalMs: number
  /** Most released children alive at once; a release while at it is skipped. */
  cap: number
  /** Effect 19's lifetime: the Brood's `spawn` clip, which the client plays. Looks only. */
  releaseMs: number
  /** How long it stands still from a release, in ms on the tick (#52 lane 2). */
  holdMs: number
}

/**
 * Releases a Broodling every `intervalMs` while it has a target, if fewer
 * than `cap` of the ones it released are alive (counted `!destroyed`). It
 * keeps its distance by its guard (a `retreat` band, as the Kiln's), which
 * runs before this routine and picks the target.
 *
 * **The clock** is one `Timers` entry **owned by the Brood**, so its death
 * stops the stream at once. It is armed on the first tick the Brood has a
 * live, unextracted player as its target, so the first release comes
 * `intervalMs` after it notices someone; each release re-arms it while the
 * target lasts, so the stream keeps its cadence. A due timer that finds no
 * target releases nothing and is not re-armed; the next target arms it anew.
 * One at the cap re-arms without releasing, so a child's death is replaced at
 * the next beat, not at once.
 *
 * **Rest, release, hold** (#52 lane 2). A beat that finds the Brood at rest
 * (`stepTo` undefined) releases at once, as before. One that finds it
 * mid-step (and under the cap) leaves the release `pending`: from then on the routine clears
 * `stepGoal` every tick, so the step in progress lands on its centre, and it
 * releases on the first tick at rest (re-checking the target and the cap
 * then; no target there calls it off). The clock was already re-armed at the
 * beat, so the cadence holds. From a release it clears `stepGoal` every tick
 * until a `holdMs` timer owned by the Brood ends the hold; a release inside
 * a hold starts it afresh (one hold timer at a time). A pending release
 * runs inside the Brood's own update, so its child, appended to `MOBS`
 * behind the backward loop, first updates on the next tick (a beat's child
 * still updates in its own tick, l1-7 F6); its emerge hold makes that moot.
 *
 * **A release** puts a Broodling (`child`) on the free cell just outside the
 * Brood's body (ring 2 of its 7-cell body, ring-footprint) nearest its target
 * (`World.mobCellFree`; ties to the first in `World.ringCells` order),
 * through `World.addUnit(World.MOBS, …)`, never through `LAYERS`, and sends
 * effect 19 on the Brood, aimed at that cell. No free cell there skips the
 * beat. A child is a whole mob from then on: it
 * carries no loot (its row's 0), drops nothing, and keeps its own fuse when
 * the Brood dies (#51 Q12). The children still in their sockets (the client
 * draws them) die with it, which on the server is nothing: they are not units.
 */
export default class BroodRelease implements IAIRoutine {
  readonly owner: Unit
  readonly spec: BroodSpec
  /** What it has released, pruned of the dead at each release. */
  children: Unit[] = []
  /** A beat found it mid-step: release on the first tick at rest. */
  pending = false
  /** True from a release until `holdMs` after it. */
  holding = false
  private clock: Timer | undefined
  /** Ends the hold of the last release. */
  private holdTimer: Timer | undefined

  constructor (owner: Unit, spec: BroodSpec) {
    this.owner = owner
    this.spec = spec
  }

  /** Its released children still alive. */
  get live (): number {
    let n = 0
    for (const child of this.children) if (!child.destroyed) n++
    return n
  }

  update (dt: number): void {
    if (this.owner.destroyed) return
    if (this.pending) {
      this.owner.stepGoal = undefined
      if (this.owner.stepTo === undefined) {
        this.pending = false
        const targetCell = this.targetCell()
        if (targetCell !== undefined) this.tryRelease(targetCell)
      }
    }
    if (this.holding) this.owner.stepGoal = undefined
    if (this.clock !== undefined && !this.clock.done) return
    if (this.targetCell() === undefined) return
    this.arm()
  }

  private arm (): void {
    this.clock = Timers.schedule(this.spec.intervalMs, () => { this.beat() }, this.owner)
  }

  private beat (): void {
    const targetCell = this.targetCell()
    if (targetCell === undefined) return
    this.arm()
    if (this.atCap()) return
    if (this.owner.stepTo !== undefined) {
      this.pending = true
      return
    }
    this.tryRelease(targetCell)
  }

  /** Prunes the dead children; true if the live ones are at the cap. */
  private atCap (): boolean {
    this.children = this.children.filter((child) => !child.destroyed)
    return this.children.length >= this.spec.cap
  }

  /** Release toward `targetCell` unless at the cap, and hold if it did. */
  private tryRelease (targetCell: Vector): void {
    if (this.atCap()) return
    if (!this.release(targetCell)) return
    this.holding = true
    this.owner.stepGoal = undefined
    // A release inside the last one's hold (a pending release that waited
    // for a step, then the next beat at once: possible since the beat is
    // shorter than a step plus the hold) restarts the hold, so the old timer
    // must not end the new one.
    Timers.cancel(this.holdTimer)
    this.holdTimer = Timers.schedule(this.spec.holdMs, () => { this.holding = false }, this.owner)
  }

  /** The cell of its live, unextracted player target, or undefined. */
  private targetCell (): Vector | undefined {
    const target = this.owner.target
    if (target == null || target.destroyed || target.type !== ObjectType.Player) return undefined
    if ((target as { exited?: boolean }).exited === true) return undefined
    return Hex.toCell(target.position)
  }

  /**
   * True if a Broodling was put down. On the ring just outside the Brood's
   * body (ring-footprint): ring 2 for its 7-cell body, the neighbours for a
   * Brood without one (`World.ringCells` order, which for ring 1 is
   * `Hex.DIRECTIONS`).
   */
  private release (targetCell: Vector): boolean {
    const owner = this.owner
    const here = owner.cell
    let best: Vector | undefined
    let bestDistance = Infinity
    for (const cell of World.ringCells(here, owner.bodyRings + 1)) {
      if (!World.mobCellFree(cell.x, cell.y, owner.tag)) continue
      const distance = Hex.distance(cell, targetCell)
      if (distance < bestDistance) {
        best = cell
        bestDistance = distance
      }
    }
    if (best === undefined) return false

    const at = Hex.toPosition(best)
    const child = new Mob(at.x, at.y, owner.tag, this.spec.child)
    World.addUnit(World.MOBS, child)
    this.children.push(child)
    Multiplayer.Instance.effect(NPC_EFFECT.broodRelease, owner, this.spec.releaseMs, best)
    return true
  }
}
