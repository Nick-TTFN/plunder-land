import { Point } from 'pixi.js'
import Unit from './unit'
import { AnimationStates } from '../animation/animationstates'
import { lookFor } from './archetypesprites'
import { NPC_RIGS } from '../npcs/npcrig'
import { NpcSprite } from '../npcs/npcsprite'
import { RobotSprite } from '../robots/robotsprite'
import { SETTINGS } from '../net/settings'

export default class Mob extends Unit {
  /**
   * The NPC drawn from its rig (l1-8): undefined draws `mob/mob` in
   * `animation`, as an archetype without a rig, or one whose sheet hasn't
   * loaded, still does. Set from `initAnimation`, which `Unit`'s constructor
   * calls, so it has no initialiser, which would reset it afterwards (as
   * `Player.robot`; the client's Babel strips an uninitialised field and
   * rejects `declare`).
   */
  npc: NpcSprite | undefined

  /** Where a rigged NPC's feet are below the unit's position, as a rigged robot's (`Player.PEEP_FEET_Y`). */
  static readonly NPC_FEET_Y = 16

  /** When `applyPosition` last ran, and the smoothed ground speed it fed the rig, as `Player`'s. */
  private lastMovedAt = 0
  private pace = 1

  initAnimation (): void {
    const look = lookFor('mob', this.archetype)
    const rig = look.npc !== undefined ? NPC_RIGS[look.npc] : undefined
    if (rig !== undefined && NpcSprite.ready(rig)) {
      this.npc = new NpcSprite(this, rig, SETTINGS.value.shadows)
      this.npc.y = Mob.NPC_FEET_Y
      this.addChild(this.npc)
      this.npc.play('spawn')
      return
    }

    this.runAnimation = look.run

    this.animation = new AnimationStates(
      this.runAnimation,
      0.1,
      new Point(0.5, 1)
    )
    if (look.tint !== undefined) this.animation.tint = look.tint
    this.animation.play()
    this.addChild(this.animation)

    const targetScale = (this.radius * 3) / 64
    this.animation.scale = new Point(targetScale, targetScale)
  }

  // Unit's, plus the rig. (`super.headY` on an accessor doesn't typecheck here.)
  get headY (): number {
    if (this.npc !== undefined) return Mob.NPC_FEET_Y - this.npc.standHeight
    return this.animation !== undefined ? this.animation.y - this.animation.height : -30
  }

  get feetY (): number {
    if (this.npc !== undefined) return Mob.NPC_FEET_Y
    return this.animation !== undefined ? this.animation.y : 10
  }

  /** As Unit's; a rigged NPC's gait also follows the way it goes and how fast, as a robot's run does. */
  applyPosition (nx: number, ny: number, now: number, motionX?: number, motionY?: number): void {
    const dx = motionX ?? (nx - this.x)
    const dy = motionY ?? (ny - this.y)
    super.applyPosition(nx, ny, now, motionX, motionY)
    const elapsed = now - this.lastMovedAt
    this.lastMovedAt = now
    if (this.npc === undefined || elapsed <= 0 || elapsed > 250) return
    const speed = Math.hypot(dx, dy) / elapsed * 1000
    if (speed < 1) return
    this.npc.setDirection(dx, dy)
    this.pace += (speed / RobotSprite.STRIDE_SPEED - this.pace) * Math.min(1, elapsed / 80)
    this.npc.setPace(this.pace)
  }

  setMoving (moving: boolean): void {
    if (this.npc !== undefined) this.npc.setMoving(moving)
    else super.setMoving(moving)
  }

  /** An NPC's body never turns (its gait points instead): nothing to flip. */
  flip (left: boolean): void {
    if (this.npc === undefined) super.flip(left)
  }

  onHurt (): void {
    this.npc?.play('hit')
  }

  /**
   * Its attack clip, aimed at `toward` along the ground: the Crawler's shot
   * (effect 3). True when it played, so `RangedAttackEffect` holds the beam
   * for the shot's charge and fires it from the muzzle (`eyeGlobal`).
   */
  playAction (name: 'swing' | 'shoot', toward?: { x: number, y: number }): boolean {
    if (this.npc === undefined || name !== 'shoot') return false
    const aim = toward === undefined ? undefined : { x: toward.x - this.x, y: toward.y - this.y }
    return this.npc.play('attack', aim)
  }

  /** Where its shot leaves (the Crawler's sensor), on screen, global, as `Player`'s eye. */
  eyeGlobal (): Point | undefined {
    return this.npc !== undefined && !this.npc.destroyed ? this.npc.muzzleGlobal() : undefined
  }

  dispose (): void {
    const npc = this.npc
    if (npc === undefined || (this.hp ?? 0) > 0 || !npc.play('death')) {
      super.dispose()
      // The scale tween removes it in 200 ms; the rig goes with it.
      if (npc !== undefined) setTimeout(() => { npc.destroy() }, 400)
      return
    }
    // Dead: its death clip plays where it fell (held, if the package holds it), then it goes.
    this.removeChild(this.hpBar)
    this.killed = true
    setTimeout(() => {
      this.parent?.removeChild(this)
      npc.destroy()
    }, npc.deathSeconds * 1000)
  }
}
