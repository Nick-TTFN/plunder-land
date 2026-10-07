import { Skill } from '../skills/skill'
import { type Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import World from '../objects/world'
import Timers from '../objects/timers'
import Multiplayer from '../network/multiplayer'
import { type IAIRoutine } from '../ai/airoutine'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/** A Shockwave's numbers (the Compactor's: `NPC_NUMBERS.compactorShockwave`, PROVISIONAL l1-0). */
export interface ShockwaveNumbers {
  readonly damage: number
  readonly cooldownMs: number
  /** Cells a surviving victim is moved along the line. */
  readonly knockback: number
  /** Cast to hit, in ms: the strike clip's impact frame. */
  readonly impactMs: number
}

/** What a knockback needs of its victim: `Player.knockback`, typed here so this file needn't import Player. */
interface Knockable extends Unit {
  exited: boolean
  knockback: (direction: number, cells: number) => Vector | undefined
}

/**
 * The Compactor's slam (decision #51, L1, task l1-6): a line of cells straight
 * out of its cell toward its target, telegraphed from the cast, hitting at
 * `impactMs`.
 *
 * At the cast the line is fixed: its origin is the cell the Compactor stands
 * on (or is stepping into: it finishes that step and then stands still until
 * the impact, `ShockwaveRoutine`), its direction the aim snapped to one of
 * six as a breath's is (`World.FACING_INDEX`), and its cells the
 * archetype's line `length` (`NpcAttack`, mirrored), cut where the line
 * leaves the map. `effect(14)` goes to the Compactor's holders aimed at the
 * line's uncut tip, so a client that places the Compactor a cell off still
 * snaps to the same direction and works the cells back from the tip
 * (`vfx/cells.ts` `lineFromTip`, checked by `shockwave.spec.ts`).
 *
 * At the impact, every live player standing on a line cell takes `damage`
 * (mob attacks hurt players only, #51), and each one it doesn't kill is
 * knocked back `knockback` cells along the line (`Player.knockback`). Mobs
 * are never hit and never moved. The impact is a timer owned by the
 * Compactor, so killing it during the wind-up cancels the slam.
 */
export class Shockwave extends Skill {
  /** Cells a surviving victim is moved. */
  readonly knockback: number
  /** Cast to hit, in ms. */
  readonly impactMs: number
  /** True from the cast until the impact: the caster stands still meanwhile. */
  windingUp: boolean = false

  constructor (owner: Unit, numbers: ShockwaveNumbers) {
    super(owner, numbers.cooldownMs)
    this.damage = numbers.damage
    this.knockback = numbers.knockback
    this.impactMs = numbers.impactMs
  }

  /** The line's length from the caster's archetype row. A row without a line is a table error. */
  get length (): number {
    const attack = this.owner.archetype?.attack
    if (attack?.kind !== 'line') throw new Error(`${this.owner.archetype?.key ?? 'unit'}: Shockwave needs a line attack in utils/archetypes.ts`)
    return attack.length
  }

  /**
   * The `Hex.DIRECTIONS` index from `origin` toward `aimCell`, snapped as a
   * breath's aim is; the caster's facing when there is no aim or the aim is
   * the origin itself.
   */
  static directionOf (caster: Unit, origin: Vector, aimCell?: Vector): number {
    if (aimCell === undefined || (aimCell.x === origin.x && aimCell.y === origin.y)) {
      return World.FACING_INDEX(caster.facing)
    }
    return World.FACING_INDEX(Hex.toPosition(aimCell).sub(Hex.toPosition(origin)))
  }

  /**
   * `length` cells straight out of `origin` along `direction` (origin not
   * included), stopping at the first one off the map. Valleys, walls and
   * stones don't stop it: like shots, the wave passes over them.
   */
  static lineCells (origin: Vector, direction: number, length: number): Vector[] {
    const cells: Vector[] = []
    let cell = origin
    for (let i = 0; i < length; i++) {
      cell = Hex.neighbour(cell, direction)
      if (!Hex.onMap(cell.x, cell.y, World.mapSize)) break
      cells.push(cell)
    }
    return cells
  }

  execute (aimCell?: Vector): boolean {
    if (this.windingUp) return false
    if (!super.execute()) return false
    const damage = this.damage
    if (damage === undefined) throw new Error('Shockwave needs a damage override (SkillSpec.damage)')

    const origin = this.owner.stepTo ?? this.owner.cell
    const direction = Shockwave.directionOf(this.owner, origin, aimCell)
    const length = this.length
    const cells = Shockwave.lineCells(origin, direction, length)
    const step = Hex.DIRECTIONS[direction]
    const tip = new Vector(origin.x + step.x * length, origin.y + step.y * length)

    // Face the slam (the sprite), unless a step in progress is still turning it.
    if (this.owner.stepTo === undefined) this.owner.facing = Hex.toPosition(tip).sub(Hex.toPosition(origin)).normalised()

    Multiplayer.Instance.effect(NPC_EFFECT.compactorShockwave, this.owner, this.impactMs, tip)
    this.windingUp = true
    Timers.schedule(this.impactMs, () => { this.impact(cells, direction, damage) }, this.owner)
    return true
  }

  /** The hit: see the class comment. */
  impact (cells: readonly Vector[], direction: number, damage: number): void {
    this.windingUp = false
    if (this.owner.destroyed) return
    const victims: Knockable[] = []
    for (const cell of cells) {
      for (const unit of World.UNITS_ON(cell.x, cell.y, this.owner.tag)) {
        if (unit.type !== ObjectType.Player || unit.destroyed) continue
        const player = unit as Knockable
        if (player.exited) continue
        victims.push(player)
      }
    }
    // The victims are gathered before anyone moves, so one knocked onto a
    // later line cell is not hit twice; the hits all land before the moves.
    const survivors: Knockable[] = []
    for (const victim of victims) {
      if (victim.hit(this.dealt(damage))) this.owner.onKill(victim)
      else survivors.push(victim)
    }
    if (this.knockback <= 0) return
    for (const victim of survivors) victim.knockback(direction, this.knockback)
  }
}

/**
 * The Compactor's AI for its slam (`ShockwaveSpec`), after its guard in the
 * routine list: while the slam winds up it clears the guard's step goal, so
 * the Compactor finishes any step in progress and then stands where the line
 * starts; otherwise it casts at its target's cell once the target is within
 * `withinCells` rings (`UseSkillOnTarget`'s rule).
 */
export class ShockwaveRoutine implements IAIRoutine {
  constructor (
    readonly owner: Unit,
    readonly skill: Shockwave,
    readonly withinCells: number
  ) {}

  update (dt: number): void {
    if (!this.skill.windingUp) {
      const target = this.owner.target
      if (target == null || target.destroyed) return
      const targetCell = Hex.toCell(target.position)
      if (Hex.distance(this.owner.cell, targetCell) > this.withinCells) return
      if (!this.skill.execute(targetCell)) return
    }
    this.owner.stepGoal = undefined
  }
}
