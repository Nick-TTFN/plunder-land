import { Point } from 'pixi.js'
import Unit from './unit'
import { AnimationStates } from '../animation/animationstates'
import { lookFor } from './archetypesprites'
import { NPC_RIGS, attackLead } from '../npcs/npcrig'
import { NpcSprite } from '../npcs/npcsprite'
import { RobotSprite } from '../robots/robotsprite'
import { SETTINGS } from '../net/settings'
import { hitSpark } from '../vfx/npcfx'
import { type EmergeAbove, emergeDepth } from '../vfx/broodpick'
import { BROODLING_RIG } from '../npcs/broodling/rig'
import { BroodSockets } from '../vfx/broodsockets'
import { LAUNCH_MS, flightAt, type Point as ScreenPoint } from '../vfx/broodlaunch'
import { TILT } from './tilt'

/** A launched Broodling's flight off its Brood's socket (`Mob.launchFrom`). */
interface Launch {
  readonly from: Mob
  readonly socket: number
  /** Effect 19's arrival, `performance.now()` ms. */
  readonly start: number
  /** Its ground point in the socket, and the Brood's ground line, screen space (`broodlaunch.ts`); followed until the launch. */
  seat: ScreenPoint
  floorY: number
}

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

  /**
   * A Brood's loaded sockets (`BroodSockets`), when both its rig and the
   * Broodling's are loaded; undefined otherwise. Set from `initAnimation`,
   * so no initialiser, as `npc`.
   */
  sockets: BroodSockets | undefined

  /** A released Broodling's flight from its Brood's socket to its cell (`launchFrom`); undefined once landed. */
  launch: Launch | undefined = undefined

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

  /** A released Broodling's Brood, drawn under it while it emerges (`emergeReleased`, `emergeDepth`). */
  emergeAbove: EmergeAbove | undefined = undefined

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
      if (rig.key === 'brood' && NpcSprite.ready(BROODLING_RIG)) this.sockets = new BroodSockets(this.npc)
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

  /** Where its body is drawn across, px (a rigged NPC's `bodySpan`); undefined without a rig. */
  get bodySpan (): { left: number, right: number } | undefined {
    return this.npc?.bodySpan
  }

  get feetY (): number {
    if (this.npc !== undefined) return Mob.NPC_FEET_Y
    return this.animation !== undefined ? this.animation.y : 10
  }

  /**
   * As Unit's, then its depth: over its Brood while it emerges (#52 open
   * items, 5), else its `y`; and a launched Broodling's flight (`fly`).
   */
  update (dt: number): void {
    super.update(dt)
    const now = performance.now()
    if (this.emergeAbove !== undefined) {
      this.zIndex = emergeDepth(this.y, this.emergeAbove, now)
      if (now >= this.emergeAbove.until) this.emergeAbove = undefined
    }
    if (this.launch !== undefined) this.fly(now)
  }

  /**
   * Where socket `i`'s Broodling stands on this Brood as last drawn, and the
   * Brood's ground line, in the layer's screen space (`broodlaunch.ts`);
   * undefined once it is dying or gone, or before it is drawn.
   */
  seatOf (i: number): { seat: ScreenPoint, floorY: number } | undefined {
    const npc = this.npc
    if (this.sockets === undefined || npc === undefined || this.killed || this.destroyed || npc.dying) return undefined
    const seat = this.sockets.seat(i)
    if (seat === undefined) return undefined
    const floorY = this.y * TILT + npc.y
    return { seat: { x: this.x + npc.x + seat.x, y: floorY + seat.y }, floorY }
  }

  /**
   * Effect 19's Broodling (`emergeReleased`), launched off `brood`'s socket
   * nearest its way (`BroodSockets.launch`): drawn sitting in the socket
   * from now, flown down to its own cell from the Brood's launch
   * (`LAUNCH_MS`), landing `FLIGHT_MS` later (`flightAt`). False, and
   * nothing changes, if `brood` has no loaded sockets drawn or this has no
   * rig: then it emerges where it stands, as before.
   */
  launchFrom (brood: unknown): boolean {
    if (this.npc === undefined || !(brood instanceof Mob) || brood.sockets === undefined) return false
    const now = performance.now()
    const toward = { x: this.x - brood.x, y: (this.y - brood.y) * TILT }
    const socket = brood.sockets.launch(toward, now, now + LAUNCH_MS)
    const at = socket < 0 ? undefined : brood.seatOf(socket)
    if (at === undefined) return false
    this.launch = { from: brood, socket, start: now, seat: at.seat, floorY: at.floorY }
    this.fly(now)
    return true
  }

  /**
   * Draws the launched Broodling where `flightAt` says: its rig moved to the
   * ground point under it and raised by `lift`, its HP bar hidden. Until the
   * launch the seat follows the Brood (its bob, a hit's jolt); from the launch
   * the path is fixed, so the Brood's death mid-flight changes nothing. Ends,
   * back on its own cell, when it lands, or at once when it is killed (its
   * blast, which the server sets off on that cell, plays there) or goes.
   */
  private fly (now: number): void {
    const launch = this.launch
    const npc = this.npc
    if (launch === undefined || npc === undefined) return
    const elapsed = now - launch.start
    if (elapsed < LAUNCH_MS) {
      const at = launch.from.seatOf(launch.socket)
      if (at !== undefined) {
        launch.seat = at.seat
        launch.floorY = at.floorY
      }
    }
    const landing = { x: this.x, y: this.y * TILT + Mob.NPC_FEET_Y }
    const at = this.killed || this.destroyed ? undefined : flightAt(elapsed, launch.seat, launch.floorY, landing)
    if (at === undefined) {
      this.land()
      return
    }
    npc.position.set(at.ground.x - this.x, at.ground.y - this.y * TILT)
    npc.lift = at.lift
    this.hpBar.visible = false
  }

  /** Ends a flight: the rig back on its own cell, the HP bar shown. */
  private land (): void {
    if (this.launch === undefined) return
    this.launch = undefined
    const npc = this.npc
    if (npc !== undefined && !npc.destroyed) {
      npc.position.set(0, Mob.NPC_FEET_Y)
      npc.lift = 0
    }
    this.hpBar.visible = true
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

  /** A hit is an overlay over whatever plays (decision #52): the rig's flash and jolt, and the spark. */
  onHurt (): void {
    this.npc?.hit()
    hitSpark(this)
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
   * back in step with the server); the Coil's charge on its pulse (13, the
   * hold's end `lifetime` after). The Kiln's lob (9) and the Brood's release
   * (19) start from their wind-up instead (`playAttackFromStart`). False
   * without a rig.
   */
  playAttack (leadMs: number, toward?: { x: number, y: number }): boolean {
    const event = this.npc?.npc.roles.attack?.event
    if (this.npc === undefined || event === undefined) return false
    const aim = toward === undefined ? undefined : { x: toward.x - this.x, y: toward.y - this.y }
    return this.npc.play('attack', aim, attackLead(event, leadMs))
  }

  /**
   * Its attack clip from the start of its wind-up (t = 0), so the clip's
   * event comes `attackEventMs` from now (#52 lane 2, Archie's lane-1 F1):
   * the Kiln's lob on its marker (9: the gather, then the launch 0.58 s
   * later, when the slug leaves, `KilnLobEffect`) and the Brood's release on
   * 19. The server holds both still from that effect, so the wind-up has a
   * still body to play on. Aimed at `toward` (world position) if given.
   */
  playAttackFromStart (toward?: { x: number, y: number }): boolean {
    const event = this.npc?.npc.roles.attack?.event
    if (this.npc === undefined || event === undefined) return false
    const aim = toward === undefined ? undefined : { x: toward.x - this.x, y: toward.y - this.y }
    return this.npc.play('attack', aim, event)
  }

  /** Seconds from its attack clip's start to its event; 0 without a rigged attack. */
  get attackEvent (): number {
    return this.npc?.npc.roles.attack?.event ?? 0
  }

  /** Where its shot leaves (the Crawler's sensor), on screen, global, as `Player`'s eye. */
  eyeGlobal (): Point | undefined {
    return this.npc !== undefined && !this.npc.destroyed ? this.npc.muzzleGlobal() : undefined
  }

  dispose (): void {
    // Killed or gone mid-flight: its death (the blast) plays on its own cell,
    // where the server sets it off; a removed mob gets no more updates.
    this.land()
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
