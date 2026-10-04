/**
 * Aiming on touch (L9 touch controls; Claude's design, 2026-10-04, Nick may
 * change it). A finger has no hover, so the desktop rule (the cell under the
 * mouse when the key goes down, `Aim`) can't work. Instead a tap on an aimed
 * skill's card **arms** it, and the next tap on the world casts it at that
 * cell instead of moving there. Tapping the armed card again casts it along
 * facing, as before; tapping another card arms or casts that one instead.
 * An armed skill disarms itself after `TIMEOUT_MS` so a forgotten one never
 * eats a move. Skills that ignore aim (Dash, Melee, Defend, StoneWall) cast at
 * once on a tap, as they always did.
 *
 * Pixi-free state only: the card draws itself (`SkillCard`), the stage's
 * press handler asks `take` (`index.ts`).
 */
export interface Armable {
  /** Show or hide "TAP TARGET". */
  setArmed: (armed: boolean) => void
}

export class TouchAim {
  static readonly TIMEOUT_MS = 4000
  private static card: Armable | undefined
  private static at = 0

  /** Arm `card`, disarming any other. */
  static arm (card: Armable, now: number): void {
    if (TouchAim.card !== undefined && TouchAim.card !== card) TouchAim.card.setArmed(false)
    TouchAim.card = card
    TouchAim.at = now
    card.setArmed(true)
  }

  /** The armed card, if any. */
  static armed (now: number): Armable | undefined {
    if (TouchAim.card !== undefined && now - TouchAim.at > TouchAim.TIMEOUT_MS) TouchAim.disarm()
    return TouchAim.card
  }

  /** The armed card, now disarmed, for a world tap to cast; undefined if none (the tap moves). */
  static take (now: number): Armable | undefined {
    const card = TouchAim.armed(now)
    TouchAim.disarm()
    return card
  }

  static disarm (): void {
    TouchAim.card?.setArmed(false)
    TouchAim.card = undefined
  }
}
