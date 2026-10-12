import { ObjectType } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import Buff from './buff'

/**
 * Which slow: the Coil's field, or the ice skills' (Icicle and Ice Breath,
 * #54, task ice-1). One of each kind at most on a unit.
 */
export type SlowKind = 'coil' | 'ice'

/**
 * A player's slow: the Coil's (decision #51, task l1-3) and the ice skills'
 * (#54, ice-1). `maxVelocity` times `factor` until `endTime`, **one per unit
 * per `kind`**, refreshed rather than stacked.
 *
 * Not `Slowdown`: `Unit.addBuff` pushes whatever it is given ("dont stack
 * same buffs?"), and a field re-applied every tick of its hold would cut the
 * speed again each tick. `FieldSlow.apply` finds a running one and moves its
 * end instead, so a field held for any number of ticks leaves the speed at
 * one factor.
 *
 * Like `Slowdown` it gives back exactly what it took (`applied`), never a
 * stored speed, so gear picked up during the slow (`Player.applyGear` adds a
 * delta) still lands on base + gear when it ends.
 *
 * **Kinds.** A slow of the same kind refreshes the running one (two Icicles,
 * or an Icicle and an Ice Breath, leave one x0.5, never x0.25). A different
 * kind is a second buff, and the two multiply (Coil x0.4 x ice x0.5 = x0.2,
 * #51 L1 calls, kept by #54): each takes its share of the speed it found.
 * Either can end first and the last to end leaves the unit at its base
 * again. In between, the one still running holds the absolute amount it
 * took, so the speed then is not exactly its own factor of base (Coil after
 * ice, ice ends first: 140 - 42 = 98, not 56); it lasts until the shorter
 * of the two ends. One shared slow instead would let a Coil's x0.4 be held
 * for an ice slow's length, or the ice x0.5 be extended by a Coil.
 *
 * **Players only** (`apply` refuses anything else): `GuardPosition` assigns a
 * mob's `maxVelocity` absolutely every refresh, so a slow on a mob would not
 * hold, and #51 says mob attacks hurt players only.
 */
export default class FieldSlow extends Buff {
  /**
   * The reduction actually applied, given back by `stop`. `declare`d, as
   * `Slowdown.applied` is, and set in the constructor after `super`: a field
   * initialiser would run after `Buff`'s constructor and could reset what a
   * base-constructor hook wrote (CLAUDE.md, "declare fields"). Nothing is
   * written from `start` here, but the rule is kept so it stays safe.
   */
  private declare applied: number
  /** When the victim's "slowed" cue (effect 16) was last sent, and the end it announced. */
  private declare cueAt: number
  private declare cueEnd: number
  /** Coil or ice: `apply` refreshes only a slow of its own kind. */
  declare readonly kind: SlowKind

  /**
   * Slow `target` by `factor` until `until` (ms, `Date.now()` clock), or move
   * the end of the `kind` slow it already has to `until` if that is later (a
   * shorter one is ignored; the running one keeps its factor). True when the
   * "slowed" cue should be sent: on a new slow, and on a refresh that comes
   * after more than half of what the last cue announced has run, so a field
   * held tick after tick sends one cue, not one a tick. False, and nothing
   * done, for a target that is not a player.
   */
  static apply (target: Unit, factor: number, until: number, now: number = Date.now(), kind: SlowKind = 'coil'): boolean {
    if (target.type !== ObjectType.Player) return false
    const running = FieldSlow.on(target, kind)
    if (running !== undefined) return running.refresh(until, now)
    target.addBuff(new FieldSlow(target, factor, until, now, kind))
    return true
  }

  /** The `FieldSlow` of `kind` running on `target`, if any. */
  static on (target: Unit, kind: SlowKind = 'coil'): FieldSlow | undefined {
    for (const buff of target.buffs) {
      if (buff instanceof FieldSlow && buff.kind === kind) return buff
    }
    return undefined
  }

  /** Use `apply`, which keeps one per unit per kind. */
  private constructor (target: Unit, factor: number, until: number, now: number, kind: SlowKind) {
    super(target, until - now)
    this.kind = kind
    // On the caller's clock, not a second read of `Date.now()`.
    this.endTime = until
    // Rounded to tenths, which the `speed` field (27) carries exactly, so the
    // predicting client walks at the very speed the server does.
    const reduced = Math.round(target.maxVelocity * factor * 10) / 10
    this.applied = target.maxVelocity - reduced
    target.maxVelocity = reduced
    this.cueAt = now
    this.cueEnd = this.endTime
  }

  private refresh (until: number, now: number): boolean {
    if (until <= this.endTime) return false
    this.endTime = until
    if (now - this.cueAt <= (this.cueEnd - this.cueAt) / 2) return false
    this.cueAt = now
    this.cueEnd = until
    return true
  }

  stop (): void {
    this.target.maxVelocity += this.applied
    this.applied = 0
  }
}
