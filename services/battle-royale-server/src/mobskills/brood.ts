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
 * **A release** puts a Broodling (`child`) on the free neighbour of the
 * Brood's cell nearest its target (`World.mobCellFree`; ties to the lowest
 * `Hex.DIRECTIONS` index), through `World.addUnit(World.MOBS, …)`, never
 * through `LAYERS`, and sends effect 19 on the Brood, aimed at that cell. No
 * free neighbour skips the beat. A child is a whole mob from then on: it
 * carries no loot (its row's 0), drops nothing, and keeps its own fuse when
 * the Brood dies (#51 Q12). The children still in their sockets (the client
 * draws them) die with it, which on the server is nothing: they are not units.
 */
export default class BroodRelease implements IAIRoutine {
  readonly owner: Unit
  readonly spec: BroodSpec
  /** What it has released, pruned of the dead at each release. */
  children: Unit[] = []
  private clock: Timer | undefined

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
    this.children = this.children.filter((child) => !child.destroyed)
    if (this.children.length >= this.spec.cap) return
    this.release(targetCell)
  }

  /** The cell of its live, unextracted player target, or undefined. */
  private targetCell (): Vector | undefined {
    const target = this.owner.target
    if (target == null || target.destroyed || target.type !== ObjectType.Player) return undefined
    if ((target as { exited?: boolean }).exited === true) return undefined
    return Hex.toCell(target.position)
  }

  private release (targetCell: Vector): void {
    const owner = this.owner
    const here = owner.cell
    let best: Vector | undefined
    let bestDistance = Infinity
    for (let i = 0; i < Hex.DIRECTIONS.length; i++) {
      const cell = Hex.neighbour(here, i)
      if (!World.mobCellFree(cell.x, cell.y, owner.tag)) continue
      const distance = Hex.distance(cell, targetCell)
      if (distance < bestDistance) {
        best = cell
        bestDistance = distance
      }
    }
    if (best === undefined) return

    const at = Hex.toPosition(best)
    const child = new Mob(at.x, at.y, owner.tag, this.spec.child)
    World.addUnit(World.MOBS, child)
    this.children.push(child)
    Multiplayer.Instance.effect(NPC_EFFECT.broodRelease, owner, this.spec.releaseMs, best)
  }
}
