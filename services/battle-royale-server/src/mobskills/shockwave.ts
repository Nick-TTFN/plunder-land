import { Skill } from '../skills/skill'
import { type Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import World from '../objects/world'
import Timers from '../objects/timers'
import Multiplayer from '../network/multiplayer'
import { type IAIRoutine } from '../ai/airoutine'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

/** A Shockwave's numbers (the Compactor's: `NPC_NUMBERS.compactorShockwave`). */
export interface ShockwaveNumbers {
  readonly damage: number
  readonly cooldownMs: number
  /** Cells a surviving victim is moved, radially away from the disc's centre. */
  readonly knockback: number
  /** Cast to hit, in ms. */
  readonly impactMs: number
}

/** What a knockback needs of its victim: `Player.knockback`, typed here so this file needn't import Player. */
interface Knockable extends Unit {
  exited: boolean
  knockback: (direction: number, cells: number) => Vector | undefined
}

/**
 * The Compactor's slam (decision #51, task l1-6; radial since pve-2, Nick
 * 2026-10-12): a disc of cells round the Compactor, telegraphed from the
 * cast, hitting at `impactMs`.
 *
 * At the cast the disc is fixed: its centre is the cell the Compactor stands
 * on (or is stepping into: it finishes that step and then stands still through
 * the impact, `ShockwaveRoutine`), its size the archetype's disc `rings`
 * (`NpcAttack`, mirrored). The Compactor turns to its target unless a step in
 * progress is still turning it, and its facing then, snapped to one of six
 * (`World.FACING_INDEX`), is the knockback direction of a player on the
 * centre cell. `effect(20)` goes to the Compactor's holders aimed at the
 * centre cell, so a client that places the Compactor a cell off still draws
 * the server's disc (`attackCells(disc, centre)`, checked by
 * `shockwave.spec.ts`), as the Reactor's tell does.
 *
 * At the impact, every live, unexited player on the disc, the centre cell
 * included (`World.FIND_IN_CELLS`, players only), takes `damage` (mob attacks
 * hurt players only, #51), and each one it doesn't kill is knocked back
 * `knockback` cells radially away from the centre (`outwardDirection`,
 * `Player.knockback`). Mobs are never hit and never moved. The impact is a
 * timer owned by the Compactor, so killing it during the wind-up cancels the
 * slam.
 */
export class Shockwave extends Skill {
  /** Cells a surviving victim is moved. */
  readonly knockback: number
  /** Cast to hit, in ms. */
  readonly impactMs: number
  /** True from the cast until the impact. The caster stands still meanwhile and after (`ShockwaveRoutine.holdMs`). */
  windingUp: boolean = false

  constructor (owner: Unit, numbers: ShockwaveNumbers) {
    super(owner, numbers.cooldownMs)
    this.damage = numbers.damage
    this.knockback = numbers.knockback
    this.impactMs = numbers.impactMs
  }

  /** The disc's rings from the caster's archetype row. A row without a disc is a table error. */
  get rings (): number {
    const attack = this.owner.archetype?.attack
    if (attack?.kind !== 'disc') throw new Error(`${this.owner.archetype?.key ?? 'unit'}: Shockwave needs a disc attack in utils/archetypes.ts`)
    return attack.rings
  }

  /**
   * The `Hex.DIRECTIONS` index pointing from `centre` out through `cell`: the
   * way a victim on `cell` is knocked back. On `centre` itself,
   * `centreDirection` (the Compactor's facing at the cast).
   *
   * Every offset is `m` steps along one direction plus `n` along the next
   * clockwise (m > 0, n >= 0, one sextant each); the nearer axis wins. A cell
   * exactly between two axes (m = n: ring 2's six edge cells, `d + (d + 1)`;
   * none on rings 1 and 3) is a tie, settled without float rounding (Nick,
   * 2026-10-12): the direction whose walk lands further (`reach`, the cells a
   * knockback that way would move the victim), and on equal reach the lower
   * index.
   */
  static outwardDirection (centre: Vector, cell: Vector, centreDirection: number, reach: (direction: number) => number): number {
    const dq = cell.x - centre.x
    const dr = cell.y - centre.y
    if (dq === 0 && dr === 0) return centreDirection
    for (let d = 0; d < 6; d++) {
      const next = (d + 1) % 6
      const a = Hex.DIRECTIONS[d]
      const b = Hex.DIRECTIONS[next]
      // Solve (dq, dr) = m * a + n * b; adjacent directions have determinant 1.
      const det = a.x * b.y - a.y * b.x
      const m = (dq * b.y - dr * b.x) / det
      const n = (a.x * dr - a.y * dq) / det
      if (m <= 0 || n < 0) continue
      if (m > n) return d
      if (n > m) return next
      const low = Math.min(d, next)
      const high = Math.max(d, next)
      return reach(high) > reach(low) ? high : low
    }
    return centreDirection
  }

  /**
   * How many cells `Player.knockback(direction, cells)` would move `victim`,
   * without moving it: the same walk, stopped before a cell the victim
   * `blocks`, a gate or a portal's arrival cell. `shockwave.spec.ts` holds it
   * to the real knockback on every kind of stop.
   */
  static reachOf (victim: Unit, direction: number, cells: number): number {
    let cell = victim.cell
    let reached = 0
    for (let i = 0; i < cells; i++) {
      cell = Hex.neighbour(cell, direction)
      if (victim.blocks(cell.x, cell.y)) break
      if (World.GATES_ON(cell.x, cell.y, victim.tag).length > 0 || World.isArrival(cell.x, cell.y, victim.tag)) break
      reached = i + 1
    }
    return reached
  }

  execute (aimCell?: Vector): boolean {
    if (this.windingUp) return false
    if (!super.execute()) return false
    const damage = this.damage
    if (damage === undefined) throw new Error('Shockwave needs a damage override (SkillSpec.damage)')

    const centre = this.owner.stepTo ?? this.owner.cell
    const rings = this.rings
    // Face the target (the sprite), unless a step in progress is still turning it.
    if (this.owner.stepTo === undefined && aimCell !== undefined && (aimCell.x !== centre.x || aimCell.y !== centre.y)) {
      this.owner.facing = Hex.toPosition(aimCell).sub(Hex.toPosition(centre)).normalised()
    }
    const centreDirection = World.FACING_INDEX(this.owner.facing)

    Multiplayer.Instance.effect(NPC_EFFECT.compactorSlam, this.owner, this.impactMs, centre)
    this.windingUp = true
    Timers.schedule(this.impactMs, () => { this.impact(centre, rings, centreDirection, damage) }, this.owner)
    return true
  }

  /** The hit: see the class comment. */
  impact (centre: Vector, rings: number, centreDirection: number, damage: number): void {
    this.windingUp = false
    if (this.owner.destroyed) return
    const victims: Knockable[] = []
    for (const unit of World.FIND_IN_CELLS(centre, rings, this.owner.tag, ObjectType.Player)) {
      if (unit.destroyed) continue
      const player = unit as Knockable
      if (player.exited) continue
      victims.push(player)
    }
    // The victims are gathered before anyone moves, so one knocked onto
    // another disc cell is not hit twice; the hits all land before the moves,
    // and every direction is taken from where the victims stood.
    const survivors: Knockable[] = []
    for (const victim of victims) {
      if (victim.hit(this.dealt(damage))) this.owner.onKill(victim)
      else survivors.push(victim)
    }
    if (this.knockback <= 0) return
    const directions = survivors.map((victim) =>
      Shockwave.outwardDirection(centre, victim.cell, centreDirection, (d) => Shockwave.reachOf(victim, d, this.knockback)))
    survivors.forEach((victim, i) => { victim.knockback(directions[i], this.knockback) })
  }
}

/**
 * The Compactor's AI for its slam (`ShockwaveSpec`), after its guard in the
 * routine list: it casts at its target's cell once the target is within
 * `withinCells` rings (`UseSkillOnTarget`'s rule), and from the cast it
 * clears the guard's step goal every tick, so the Compactor finishes any step
 * in progress and then stands on the disc's centre. It stands until the
 * later of the impact (`windingUp`) and `holdMs` from the cast (#52 lane 2;
 * 1250 since pve-2, while the clip's shoe is on the floor), a timer owned by
 * the Compactor; the first tick at or after that, the guard's goal stands
 * again.
 */
export class ShockwaveRoutine implements IAIRoutine {
  /** True from a cast until `holdMs` after it. */
  holding = false

  constructor (
    readonly owner: Unit,
    readonly skill: Shockwave,
    readonly withinCells: number,
    readonly holdMs: number
  ) {}

  update (dt: number): void {
    if (!this.skill.windingUp && !this.holding) {
      const target = this.owner.target
      if (target == null || target.destroyed) return
      const targetCell = Hex.toCell(target.position)
      if (Hex.distance(this.owner.cell, targetCell) > this.withinCells) return
      if (!this.skill.execute(targetCell)) return
      this.holding = true
      Timers.schedule(this.holdMs, () => { this.holding = false }, this.owner)
    }
    this.owner.stepGoal = undefined
  }
}
