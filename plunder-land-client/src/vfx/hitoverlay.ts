/**
 * How a hit shows on a rigged unit (decision #52, anim-sync lane 1): **always
 * an overlay, never a body clip.** The gait, idle or attack underneath plays
 * on untouched; the hit adds a short tint flash and a small sideways jolt of
 * the drawn body (a few px, decaying; the unit's position never moves), plus
 * what the caller adds (the hit spark, the damage number). Used by
 * `RobotSprite` and `NpcSprite`; pixi-free so the timing is spec'd
 * (`hitoverlay.spec.ts`, server).
 *
 * Under damage every tick (a breath, a Reactor's contact) a new hit within
 * `RETRIGGER_S` of the last one shown is not shown again, so the flash comes
 * at most about twice a second instead of strobing with the 250 ms tick.
 */
export class HitOverlay {
  /** How long the tint lasts, seconds (the NPCs' flash since l1-8). */
  static readonly FLASH_S = 0.12
  /** The tint (a tint can only darken: red reads as a flash on these colours). */
  static readonly TINT = 0xff6a5a
  /** How long the jolt lasts, seconds, and how far it first goes, CSS px. */
  static readonly JOLT_S = 0.2
  static readonly JOLT_PX = 3
  /** No new flash or jolt within this of the last one started, seconds. */
  static readonly RETRIGGER_S = 0.45

  /** Seconds since the last hit shown; infinite before the first. */
  private age = Infinity

  /** A hit: true if it is shown, false if it fell inside `RETRIGGER_S` of the last. */
  trigger (): boolean {
    if (this.age < HitOverlay.RETRIGGER_S) return false
    this.age = 0
    return true
  }

  /** Ends a flash or jolt in progress (a death takes over). */
  clear (): void {
    this.age = Infinity
  }

  advance (dt: number): void {
    this.age += dt
  }

  get flashing (): boolean {
    return this.age < HitOverlay.FLASH_S
  }

  /**
   * The body's sideways offset now, CSS px: knocked back against `facing`
   * first, then a damped wobble back to 0 by `JOLT_S`.
   */
  jolt (facing: 1 | -1 = 1): number {
    const u = this.age / HitOverlay.JOLT_S
    if (!(u < 1)) return 0
    return -facing * HitOverlay.JOLT_PX * (1 - u) * (1 - u) * Math.cos(u * 3 * Math.PI)
  }
}

/** `a` times `b`, channel by channel: a finish colour seen through the hit tint. */
export function multiplyTint (a: number, b: number): number {
  const r = Math.round(((a >> 16) & 0xff) * ((b >> 16) & 0xff) / 255)
  const g = Math.round(((a >> 8) & 0xff) * ((b >> 8) & 0xff) / 255)
  const bl = Math.round((a & 0xff) * (b & 0xff) / 255)
  return (r << 16) | (g << 8) | bl
}

/**
 * A frozen mob's tint (effect 21, ice-2): a cool multiply, since a tint can
 * only darken. PROVISIONAL until Nick looks.
 */
export const ICE_TINT = 0x9fd8ff

/**
 * A body's tint over `base` (its look's own, white for none): the hit flash
 * and the ice tint multiplied together, so a hit still shows while frozen.
 */
export function bodyTint (flashing: boolean, frozen: boolean, base = 0xffffff): number {
  let tint = flashing ? multiplyTint(base, HitOverlay.TINT) : base
  if (frozen) tint = multiplyTint(tint, ICE_TINT)
  return tint
}
