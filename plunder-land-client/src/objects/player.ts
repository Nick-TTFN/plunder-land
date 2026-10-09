import { Point } from 'pixi.js'
import { type Skill } from '../skills/skill'
import { skillFor } from '../skills/catalog'
import { AnimationStates } from '../animation/animationstates'
import Unit from './unit'
import { lookFor } from './archetypesprites'
import { type ArchetypeInfo } from '../utils/archetypes'
import { UnitPanel } from '../ui/elements/unitpanel'
import { RobotSprite } from '../robots/robotsprite'
import { ROBOT_RIGS } from '../robots/robotrig'
import { TILT } from './tilt'
import { type Finish } from '../utils/finishes'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { Walls } from './walls'
import { SETTINGS } from '../net/settings'
import { hitSpark } from '../vfx/npcfx'

export default class Player extends Unit {
  skills: Skill[]

  /** The text drawn over the robot: the player's name, or "YOU" for your own. */
  static OWN_LABEL = 'YOU'

  /** Name, hp and armor over the head (`UnitPanel`); it replaces `Unit`'s bare hp bar. */
  readonly panel = new UnitPanel()

  /** The rigged robot (`src/robots/`); undefined draws the old frame clips in `animation`. */
  robot: RobotSprite | undefined

  /**
   * Where a rigged robot's feet are, below the unit's position: where the old
   * 50 px sprite's were (anchored at its feet, moved down a third of itself).
   */
  static readonly PEEP_FEET_Y = 16

  constructor (archetype?: ArchetypeInfo) {
    super(0, archetype)
    // The panel's hp bar is the one `Unit` feeds.
    this.removeChild(this.hpBar)
    this.hpBar = this.panel.hp
    this.panel.y = this.headY - 4
    this.addChild(this.panel)

    // Only your own robot has skills (decision #48 step 4): `Game` builds them
    // from `hello.skills` when its create_own lands (`equip`). Nothing reads a
    // remote player's.
    this.skills = []
  }

  /**
   * This run's skills, one per HUD slot: slot i holds skill id `ids[i]`
   * (`skills/catalog.ts`; 0 or an unknown id is an empty slot) and sends i,
   * which the server reads as an index into the same 4 (`hello.skills`).
   * Returns one entry per slot, null where it is empty.
   */
  equip (ids: readonly number[]): Array<Skill | null> {
    const slots = ids.map((id, slot) => {
      const skill = skillFor(id, this)
      if (skill !== null) skill.index = slot
      return skill
    })
    this.skills = slots.filter((s): s is Skill => s !== null)
    return slots
  }

  /**
   * Whether cell (q, r) of layer `tag` is a wall (`Game.WALLS`); set by
   * `Game`, which owns the map, so this file needn't import it.
   */
  static wallAt: (q: number, r: number, tag: number) => boolean = () => false

  /** A wall's height eased in over this long, ms, as Hopper steps on or off one. */
  static readonly LIFT_MS = 80

  /**
   * How far the robot stands above its ground point, px: a wall's height
   * while on a wall cell (only Hopper gets there, decision #44), eased.
   */
  private lift = 0

  /** When `applyPosition` last ran, and the smoothed ground speed it fed the rig (`RobotSprite.setPace`). */
  private lastMovedAt = 0
  private pace = 1

  /**
   * As Unit's, then the run loop's speed follows the ground speed, from the
   * same motion the run/idle choice reads (intent for your own robot, the
   * rendered delta for others), so a dash speeds the legs up for everyone.
   * Smoothed over about 80 ms: a remote unit's per-frame delta jitters.
   */
  applyPosition (nx: number, ny: number, now: number, motionX?: number, motionY?: number): void {
    const dx = motionX ?? (nx - this.x)
    const dy = motionY ?? (ny - this.y)
    super.applyPosition(nx, ny, now, motionX, motionY)
    const elapsed = now - this.lastMovedAt
    this.lastMovedAt = now
    this.raise(elapsed)
    if (this.robot === undefined || elapsed <= 0 || elapsed > 250) return
    const speed = Math.hypot(dx, dy) / elapsed * 1000
    if (speed < 1) return
    this.pace += (speed / RobotSprite.STRIDE_SPEED - this.pace) * Math.min(1, elapsed / 80)
    this.robot.setPace(this.pace)
  }

  /** Ease the robot up onto a wall, or back down, over `LIFT_MS`; the panel follows. */
  private raise (elapsed: number): void {
    if (this.robot === undefined) return
    const cell = Hex.toCell(new Vector(this.x, this.y))
    const target = this.tag !== undefined && Player.wallAt(cell.x, cell.y, this.tag) ? Walls.HEIGHT : 0
    if (this.lift === target) return
    const step = Walls.HEIGHT * Math.max(0, elapsed) / Player.LIFT_MS
    this.lift = this.lift < target ? Math.min(target, this.lift + step) : Math.max(target, this.lift - step)
    this.robot.y = Player.PEEP_FEET_Y - this.lift
    this.panel.y = this.headY - 4
  }

  /** How long a robot smiles after picking up loot (Nick, 2026-09-30). */
  static readonly LOOT_SMILE_S = 0.5

  /** Loot went up: a pickup. The rigged robot smiles; the old sprite has no face. */
  onLootGained (): void {
    this.robot?.smile(Player.LOOT_SMILE_S)
  }

  /** Paints the rigged robot (robot-finishes, #41). The old frame sprite has no finish. */
  setFinish (finish: Finish): void {
    this.robot?.setFinish(finish)
  }

  initAnimation (): void {
    const look = lookFor('robot', this.archetype)
    const rig = look.rig !== undefined ? ROBOT_RIGS[look.rig] : undefined
    if (rig !== undefined && RobotSprite.ready(rig)) {
      // Its cast shadow unless settings turned shadows off (a render pass per robot).
      this.robot = new RobotSprite(this, rig, false, SETTINGS.value.shadows)
      this.robot.y = Player.PEEP_FEET_Y
      this.addChild(this.robot)
      return
    }
    this.runAnimation = look.run
    this.idleAnimation = look.idle ?? look.run

    this.animation = new AnimationStates(
      this.idleAnimation,
      0.2,
      new Point(0.5, 1)
    )
    this.animation.addClip(this.runAnimation, 0.2, new Point(0.5, 1), true)
    this.animation.addClip('player/melee_1/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/melee_2/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/melee_3/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/melee_4/attack', 0.2, new Point(0.5, 1))
    this.animation.addClip('player/die/die', 0.1, new Point(0.36, 1))
    if (look.tint !== undefined) this.animation.tint = look.tint
    this.animation.play()
    this.addChild(this.animation)
  }

  // Unit's, plus the rig. (`super.headY` on an accessor doesn't typecheck here.)
  get headY (): number {
    if (this.robot !== undefined) return Player.PEEP_FEET_Y - this.lift - this.robot.standHeight
    return this.animation !== undefined ? this.animation.y - this.animation.height : -30
  }

  get feetY (): number {
    if (this.robot !== undefined) return Player.PEEP_FEET_Y - this.lift
    return this.animation !== undefined ? this.animation.y : 10
  }

  setMoving (moving: boolean): void {
    if (this.robot !== undefined) this.robot.setMoving(moving)
    else super.setMoving(moving)
  }

  flip (left: boolean): void {
    if (this.robot !== undefined) this.robot.setFacing(left ? -1 : 1)
    else super.flip(left)
  }

  /**
   * A hit is an overlay over whatever plays (decision #52), never the hit
   * clip: the rig's flash and jolt, and the spark NPCs show too. A killing
   * blow's fall_apart (from dispose) ends it.
   */
  onHurt (): void {
    this.robot?.hit()
    hitSpark(this)
  }

  /**
   * Turns to `toward` and aims at it: the angle it makes with the ground's
   * left-right axis on screen (so the tilt's squash of y counts), which the
   * rig clamps to +-60. A point straight above or below keeps the facing.
   */
  playAction (name: 'swing' | 'shoot', toward?: { x: number, y: number }): boolean {
    if (this.robot === undefined) return false
    if (toward === undefined) {
      this.robot.play(name)
      return true
    }
    const { aim, facing } = this.aimToward(toward, undefined)
    this.robot.play(name, aim, facing)
    return true
  }

  /**
   * Your own robot's head and eye follow the mouse (Nick, 2026-09-30): the
   * facing flips to the mouse's side, and the aim is the angle on screen,
   * clamped by the rig to +-60, so straight up and down are small dead zones.
   * `point` undefined (no mouse over the world, or touch) gives the facing
   * back to movement and levels the look. An action's own aim wins while it
   * plays. Other players' aim isn't on the wire; they aim only in actions.
   */
  aimAt (point: { x: number, y: number } | undefined): void {
    if (this.robot === undefined) return
    if (point === undefined) {
      this.robot.setAim(undefined)
      return
    }
    const { aim, facing } = this.aimToward(point, this.robot.aimFacing)
    this.robot.setAim(aim, facing)
  }

  /** Mouse this close to straight above or below (screen px) keeps the facing it had. */
  static readonly AIM_FLIP_DEADBAND = 6

  /**
   * Facing and aim angle from the eye (the shot's origin) to a world point, on screen:
   * the tilt squashes y, and the robot stands up from its feet.
   */
  private aimToward (point: { x: number, y: number }, keep: 1 | -1 | undefined): { aim: number, facing: 1 | -1 | undefined } {
    const dx = point.x - this.x
    const dy = (point.y - this.y) * TILT - (Player.PEEP_FEET_Y - this.lift - (this.robot?.aimPx ?? 0))
    const facing = Math.abs(dx) < Player.AIM_FLIP_DEADBAND ? keep : dx < 0 ? -1 : 1
    const aim = Math.atan2(-dy, Math.max(Math.abs(dx), 1e-6)) * 180 / Math.PI
    return { aim, facing }
  }

  /**
   * Names the panel over the robot. Remote players get the `name` from their
   * create record, which the server has already sanitised and capped (server
   * `Player.sanitiseName`); the local player gets OWN_LABEL, since its own
   * create record carries no name. `own` also picks the colours, so YOU stands
   * out from a remote player's name.
   */
  setLabel (text: string, own: boolean = false): void {
    this.panel.setName(text, own)
  }

  eyeGlobal (): Point | undefined {
    // Gone 3 s after a death; a shot fired just before can still be waiting.
    return this.robot !== undefined && !this.robot.destroyed ? this.robot.eyeGlobal() : undefined
  }

  onArmor (): void {
    this.panel.setArmor(this.armor, this.maxArmor)
  }

  dispose (): void {
    if ((this.hp ?? 0) <= 0) {
      this.robot?.play('fall_apart')
      this.animation?.playClip('player/die/die')
      this.animation?.setDefault(undefined)
    }

    this.removeChild(this.panel)

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    setTimeout(() => {
      // A removed PIXI object has `parent === null`, which passed the old
      // `!== undefined` test and then threw on the line below.
      if (self.parent != null) self.parent.removeChild(self)
      self.robot?.destroy()
    // fall_apart is 2.2 s (Magnet 2.4) and holds its settled pose; leave it a moment.
    }, this.robot?.dying === true ? 3000 : 1700)

    this.killed = true
  }
}
