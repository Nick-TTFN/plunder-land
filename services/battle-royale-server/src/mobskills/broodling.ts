import { type IAIRoutine } from '../ai/airoutine'
import { type Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import World from '../objects/world'
import Timers from '../objects/timers'
import Multiplayer from '../network/multiplayer'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { type Vector } from '../utils/vector'

/** How long the client shows the blast (effect 18), in ms. Looks only. */
const BLAST_SHOW_MS = 500

/**
 * Rings within which a live player sets off the primed tell: adjacent or on
 * the same cell (#51 "detonates when adjacent", roster Q, Archie's call).
 */
export const PRIME_RINGS = 1

/**
 * The Broodling's fuse and blast (decision #51, task l1-7), as an archetype
 * routine spec. Rings are `Hex.distance` and include the boundary.
 */
export interface BroodlingSpec {
  kind: 'broodling'
  /** From the spawn to the blast, if nothing sets it off first. Lit in the constructor. */
  fuseMs: number
  /** The primed tell (effect 17): from a player coming adjacent to the blast. */
  tellMs: number
  /** Dealt to every live player **and mob** on the disc (#51: "can hurt nearby mobs"). */
  damage: number
  /** The blast's disc round its cell: the mirror's `attack.rings`, which the client draws. */
  rings: number
}

/** What a mob's `onHit` hook is (`Mob.onHit`); structural, since mob.ts imports the archetypes that import this. */
interface HitHooked { onHit?: (value: number) => boolean }

/**
 * A Broodling's whole life after the guard has chosen where to step: the
 * fuse, the adjacent tell and the three ways to go off, which are all one
 * blast (`detonate`).
 *
 * - **Fuse:** lit when the routine is built, which is in `Mob`'s constructor,
 *   before its create goes out: a `Timers` entry of `fuseMs` **owned by the
 *   Broodling**, so any other detonation (which destroys it) cancels it. It
 *   blasts where the Broodling is.
 * - **Adjacent:** once a live, unextracted player is within `PRIME_RINGS` of
 *   the cell it stands on or is stepping into, it primes there: effect 17 on
 *   that cell for `tellMs`, and a second owned timer blasts **that cell**
 *   `tellMs` later. Primed, it clears `stepGoal` every tick after the guard
 *   has set it, so it finishes the step in progress (`Unit.step` always
 *   does) and takes no other, as the Reactor's plant does.
 * - **Any damaging hit:** `Mob.hit` hands it to `onHit`, which blasts at once
 *   where it is (its primed cell, if primed) and returns true, so the caller
 *   credits the kill as for any kill (`onKill`: `mobKills`, `commonKills`, 0
 *   XP). It goes off on any hit that would do damage, not only on a lethal
 *   one.
 *
 * **The blast** (`detonate`) destroys the Broodling first (hp 0, so clients
 * see a death), then sends effect 18 and deals `damage` to every live,
 * unextracted player and mob on the disc but itself. Destroying first is the
 * chain guard: a blast that reaches another Broodling sets that one off
 * through its `hit` (a chain, depth-first), and by then this one is
 * `destroyed`, so nothing in the chain can reach it again, its id is freed
 * once (`GameObject.destroy`), and its fuse and tell timers are already
 * cancelled. `detonating` guards the same thing for the moment before the
 * destroy. **The blast credits nobody** (Dez, accepted by Nick #51): a player
 * it kills gets the Broodling as `killer` and `killedBy` 'mob' (`Unit.onKill`,
 * for `run_end` and spectate), which credits no one, and a mob it kills is
 * not passed to anyone's `onKill`.
 */
export default class BroodlingFuse implements IAIRoutine {
  readonly owner: Unit
  readonly spec: BroodlingSpec
  /** `Date.now()` at which the fuse ends. */
  readonly fuseEndsAt: number
  /** The primed cell, from the tell until the blast; undefined before. */
  primedCell: Vector | undefined
  /** Set as the blast starts, before the destroy; never cleared. */
  detonating = false

  constructor (owner: Unit, spec: BroodlingSpec) {
    this.owner = owner
    this.spec = spec
    this.fuseEndsAt = Date.now() + spec.fuseMs
    Timers.schedule(spec.fuseMs, () => { this.detonate() }, owner)
    // On the create, which `Mob`'s constructor sends after building this
    // routine (and then clears the dirty set); see `showFuse`.
    owner.lifetime = spec.fuseMs
    ;(owner as HitHooked).onHit = (value) => this.onHit(value)
  }

  /** What is left of the fuse, in ms, never below 0. */
  get remainingMs (): number {
    return Math.max(0, this.fuseEndsAt - Date.now())
  }

  update (dt: number): void {
    const owner = this.owner
    if (owner.destroyed) return
    this.showFuse()

    if (this.primedCell !== undefined) {
      owner.stepGoal = undefined
      return
    }

    const cell = owner.stepTo ?? owner.cell
    const near = World.FIND_IN_CELLS(cell, PRIME_RINGS, owner.tag, ObjectType.Player)
    if (!near.some((unit) => !unit.destroyed && (unit as { exited?: boolean }).exited !== true)) return

    this.primedCell = cell
    owner.stepGoal = undefined
    Multiplayer.Instance.effectAt(NPC_EFFECT.broodlingPrimed, owner.id, this.spec.tellMs, cell, owner.tag)
    Timers.schedule(this.spec.tellMs, () => { this.detonate() }, owner)
  }

  /**
   * The remaining fuse into `lifetime` (index 9) without marking it dirty, so
   * a create sent this tick carries it and no delta is ever sent. Every
   * create of a Broodling after its first comes from `Multiplayer.update`
   * (someone came into view), which runs at the end of the Broodling's own
   * update, after this. A join snapshot or a layer switch taken between
   * ticks reads the value from the Broodling's last update, at most one tick
   * old. The same trick `World.placeMob` plays with `loot`.
   */
  private showFuse (): void {
    this.owner.lifetime = this.remainingMs
    this.owner.dirtyFields.delete('lifetime')
  }

  /**
   * `Mob.hit` while this routine lives: any hit that would do damage (the
   * same arithmetic as `Unit.hit`) blasts at once and returns true, so the
   * caller credits the kill. A hit that would do none does nothing.
   */
  onHit (value: number): boolean {
    const owner = this.owner
    if (owner.destroyed || this.detonating) return false
    const multiplier = Math.max(0, Math.min(1, 1 - owner.damageReduction))
    if (Math.floor(value * multiplier) <= 0) return false
    return this.detonate()
  }

  /**
   * The blast, from any of the three: see the class comment. True if this
   * call set it off; false if it had already gone.
   */
  detonate (): boolean {
    const owner = this.owner
    if (owner.destroyed || this.detonating) return false
    this.detonating = true

    const cell = this.primedCell ?? owner.cell
    const tag = owner.tag
    owner.hp = 0
    owner.destroy()

    Multiplayer.Instance.effectAt(NPC_EFFECT.broodlingBlast, owner.id, BLAST_SHOW_MS, cell, tag)
    for (const unit of World.FIND_IN_CELLS(cell, this.spec.rings, tag, ObjectType.Player | ObjectType.Mob)) {
      // A corpse stays in the index until the next sweep; an extracted player
      // too (`Player.hit` refuses it anyway).
      if (unit === owner || unit.destroyed || (unit as { exited?: boolean }).exited === true) continue
      if (unit.hit(this.spec.damage) && unit.type === ObjectType.Player) owner.onKill(unit)
    }
    return true
  }
}

/** The Broodling routine of `unit`, if it has one. For the specs and the Brood. */
export function fuseOf (unit: Unit): BroodlingFuse | undefined {
  return unit.routines.find((r): r is BroodlingFuse => r instanceof BroodlingFuse)
}

