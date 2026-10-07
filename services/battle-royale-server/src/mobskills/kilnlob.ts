import { Skill } from '../skills/skill'
import { type Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import World from '../objects/world'
import Timers from '../objects/timers'
import Multiplayer from '../network/multiplayer'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

/** How long the client shows the blast (effect 10), in ms. Looks only. */
const BLAST_SHOW_MS = 500

/** A lob's numbers, from the archetype row (`NPC_NUMBERS.kiln.lob`, PROVISIONAL l1-0). */
export interface LobNumbers {
  damage: number
  cooldownMs: number
  /** From the cast to the landing: how long the marker shows and the shell flies. */
  flightMs: number
}

/**
 * The Walking Kiln's telegraphed artillery lob (decision #51, task l1-4).
 *
 * Not a projectile object: the bomb's pattern (`items/bomb.ts`). On a cast it
 * sends effect 9 (`NPC_EFFECT.kilnLob`) aimed at the landing cell with the
 * flight as its lifetime, which the client draws as the landing marker and an
 * arc from the Kiln; `flightMs` later it lands (`landLob`). Aimed at the
 * target's cell **at the cast**, so moving off the marked cells dodges it.
 *
 * Range and blast rings are the Kiln's mirrored row's `attack`
 * (`utils/archetypes.ts`, kind `lob`), the same numbers the client draws the
 * cells and the threat ring from, whoever the owner (specs build every row's
 * skills for a stand-in owner).
 *
 * **The landing timer has no owner, on purpose** (#51, Nick: "lands even if the
 * Kiln dies"): the cells were shown to everyone, so a dead Kiln must not make
 * them lie, exactly as a thrown bomb outlives its thrower.
 */
export class KilnLob extends Skill {
  readonly range: number
  readonly rings: number
  readonly flightMs: number
  private readonly baseDamage: number

  constructor (owner: Unit, numbers: LobNumbers) {
    super(owner, numbers.cooldownMs)
    const attack = ARCHETYPE_INFO.kiln.attack
    if (attack?.kind !== 'lob') throw new Error('KilnLob: the kiln row has no lob in utils/archetypes.ts')
    this.range = attack.range
    this.rings = attack.rings
    this.flightMs = numbers.flightMs
    this.baseDamage = numbers.damage
  }

  /**
   * Lob at `aimCell` (the target's cell, `UseSkillOnTarget`). Refused, with
   * the cooldown not spent, without an aim, off the map, or further than
   * `range` cells from the Kiln's cell.
   */
  execute (aimCell?: Vector): boolean {
    if (aimCell === undefined) return false
    if (!Hex.onMap(aimCell.x, aimCell.y, World.mapSize)) return false
    if (Hex.distance(this.owner.cell, aimCell) > this.range) return false
    if (!super.execute()) return false

    const kiln = this.owner
    const tag = kiln.tag
    const damage = this.dealt(this.damage ?? this.baseDamage)
    const rings = this.rings
    Multiplayer.Instance.effectAt(NPC_EFFECT.kilnLob, kiln.id, this.flightMs, aimCell, tag)
    Timers.schedule(this.flightMs, () => { landLob(kiln, aimCell, tag, damage, rings) })
    return true
  }
}

/**
 * The landing: effect 10 (`NPC_EFFECT.kilnBlast`) on `cell`, and `damage` to
 * every live **player** on the disc of `rings` around it (#51 Q6: mob attacks
 * hurt players only), no falloff. A kill goes to the Kiln, dead or alive
 * (`onKill`: `killer` and `killedBy` 'mob'). Stones and rocks are untouched.
 */
export function landLob (kiln: Unit, cell: Vector, tag: number, damage: number, rings: number): void {
  Multiplayer.Instance.effectAt(NPC_EFFECT.kilnBlast, kiln.id, BLAST_SHOW_MS, cell, tag)

  for (const unit of World.FIND_IN_CELLS(cell, rings, tag, ObjectType.Player)) {
    // A corpse stays in the index until the next sweep; an extracted player
    // is destroyed too.
    if (unit.destroyed) continue
    if (unit.hit(damage)) kiln.onKill(unit)
  }
}
