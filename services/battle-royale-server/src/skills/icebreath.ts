import { Skill } from './skill'
import SectorArea from '../area/sectorarea'
import Multiplayer from '../network/multiplayer'
import World from '../objects/world'
import Timers from '../objects/timers'
import { type Unit } from '../objects/unit'
import { ObjectType } from '../objects/gameobject'
import FieldSlow from '../buffs/fieldslow'
import { FREEZE, chill } from '../buffs/freeze'
import { NPC_EFFECT } from '../archetypes/npceffects'
import { type Vector } from '../utils/vector'

export class IceBreath extends Skill {
  /** 3 cells (the balance pass's 135 u = 3 * Hex.SIZE). */
  static RINGS = 3

  // Per second, applied as `damage * dt` and floored per tick by `hit()`, so
  // keep it a multiple of 4 at 250 ms ticks: 32/s is 8 a tick, 32 a cast.
  // Only [1] is read while `setLevel(1)` is the only level.
  static Damage = [25, 32, 45, 55]

  constructor (owner) {
    super(owner, 3000)
  }

  execute (aimCell?: Vector) {
    if (!super.execute()) return false

    // Aimed: snapped to one of six once, and held for the breath (decision #21).
    const aimed = SectorArea.aimIndex(this.owner, aimCell)
    const area = new SectorArea(this.owner, IceBreath.RINGS, aimed)
    area.setEffect(this.dealt(this.byLevel(IceBreath.Damage)), true)
    area.onOverlap = this.overlapHook()
    World.AREA_EFFECT.push(area)
    const lifetime = 1000
    Multiplayer.Instance.effect(1, this.owner, lifetime, aimed !== undefined ? area.tipCell() : undefined)

    // FireBreath has always had this; IceBreath never did, so every cast left a
    // permanent damage field tracking its caster.
    // No owner: the area must go even if its caster dies first.
    Timers.schedule(lifetime, () => {
      const idx = World.AREA_EFFECT.indexOf(area)
      if (idx >= 0) World.AREA_EFFECT.splice(idx, 1)
    })

    return true
  }

  /**
   * One cast's ice (#54, ice-1), run on every tick the cone overlaps a unit,
   * before that tick's hit. A player gets the one ice slow, refreshed to
   * `breathTailMs` past this tick (so it ends that long after the last tick
   * that hit), with the "slowed" cue as the Coil's is throttled. A mob is
   * chilled on the first tick of this cast that overlaps it and never again
   * by this cast: one stack per cast per caster, and a freeze from the first
   * tick that later ticks don't extend.
   */
  private overlapHook (): (unit: Unit, now: number) => void {
    const caster = this.owner
    const chilled = new Set<Unit>()
    return (unit: Unit, now: number) => {
      if (unit.type === ObjectType.Player) {
        const until = now + FREEZE.slow.breathTailMs
        if (FieldSlow.apply(unit, FREEZE.slow.factor, until, now, 'ice')) {
          Multiplayer.Instance.effect(NPC_EFFECT.slowed, unit, until - now)
        }
        return
      }
      if (chilled.has(unit)) return
      chilled.add(unit)
      chill(unit, caster, 'breath', now)
    }
  }
}
