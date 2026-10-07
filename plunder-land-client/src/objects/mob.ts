import { Point } from 'pixi.js'
import Unit from './unit'
import { AnimationStates } from '../animation/animationstates'
import { lookFor } from './archetypesprites'
import { NPC_RIGS, attackLead } from '../npcs/npcrig'
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

  /**
   * A Broodling's fuse end on `performance.now()`'s clock, from its create's
   * `lifetime` (the fuse left, l1-7; `Game.onObjectCreated`); undefined for
   * every other mob. The client never learns the full fuse.
   */
  fuseEndsAt: number | undefined = undefined

  /** `Game.FRAME` when its create arrived: the Brood's release picks among this frame's (l1-7 F6). */
  createdInFrame: number = -1

  /** Fuse left per unit of the rig's cord length: 3 s draws the default cord (Archie, l1-7 F4). */
  static readonly FUSE_MS_PER_CORD = 3000

  /** When `applyPosition` last ran, and the smoothed ground speed it fed the rig, as `Player`'s. */
  private lastMovedAt = 0
  private pace = 1

  initAnimation (): void {
    const look = lookFor('mob', this.archetype)
    const rig = look.npc !== undefined ? NPC_RIGS[look.npc] : undefined
    if (rig !== undefined && NpcSprite.ready(rig)) {
      this.npc = new NpcSprite(this, rig, SETTINGS.value.shadows)
      this.npc.y = Mob.NPC_FEET_Y
      this.npc.poseOptions = () => this.poseOptions()
      this.addChild(this.npc)
      // No emerge here: a create is also a late viewer's, so the Broodling's
      // spawn plays on the Brood's release (effect 19, `Game.onEffect`).
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

  /**
   * The rig's cord, as long as the fuse left: `remaining / 3000` times its
   * default length, 0.25-2 (the package's range), counting down from the
   * create. Undefined (the default cord) for a mob with no fuse.
   */
  private poseOptions (): { fuseLength: number } | undefined {
    if (this.fuseEndsAt === undefined) return undefined
    const left = Math.max(0, this.fuseEndsAt - performance.now())
    return { fuseLength: Math.min(2, Math.max(0.25, left / Mob.FUSE_MS_PER_CORD)) }
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

  /**
   * Its attack clip for an NPC effect that names the moment (l1-9): started
   * so that the clip's event lands when the server's moment does, `leadMs`
   * from now as the effect said it (`attackLead`), aimed at `toward` (world
   * position) if given. The Compactor's strike on its shockwave (14, the
   * impact `lifetime` after the cast); the Reactor's activation on its tell
   * (11, the release `lifetime` after) and again on its release (12, lead 0:
   * back in step with the server). False without a rig.
   */
  playAttack (leadMs: number, toward?: { x: number, y: number }): boolean {
    const event = this.npc?.npc.roles.attack?.event
    if (this.npc === undefined || event === undefined) return false
    const aim = toward === undefined ? undefined : { x: toward.x - this.x, y: toward.y - this.y }
    return this.npc.play('attack', aim, attackLead(event, leadMs))
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
