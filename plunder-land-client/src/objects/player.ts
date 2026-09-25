import { Container, Graphics, Point, Text } from 'pixi.js'
import { Dash } from '../skills/dash'
import { MeleeAttack } from '../skills/meleeattack'
import { RangedAttack } from '../skills/rangedattack'
import { Defend } from '../skills/defend'
import { StoneWall, ThrowFireball, ThrowIcicle, IceBreath } from '../skills/placeholders'
import { type Skill } from '../skills/skill'
import { AnimationStates } from '../animation/animationstates'
import Unit from './unit'
import { lookFor } from './archetypesprites'
import { type ArchetypeInfo } from '../utils/archetypes'

export default class Player extends Unit {
  skills: Skill[]

  /** The text drawn over the robot: the player's name, or "YOU" for your own. */
  static OWN_LABEL = 'YOU'

  label: Container | undefined

  constructor (archetype?: ArchetypeInfo) {
    super(0, archetype)

    // Must match Player.skills on the server: the index of the pressed slot is
    // the whole payload of the `skill` message.
    this.skills = [
      new Dash(this),
      new MeleeAttack(this),
      new RangedAttack(this),
      new Defend(this),
      new StoneWall(this),
      new ThrowFireball(this),
      new ThrowIcicle(this),
      new IceBreath(this)
    ]
    for (let i = 0; i < this.skills.length; i++) this.skills[i].index = i
  }

  initAnimation (): void {
    const look = lookFor('robot', this.archetype)
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

  /**
   * Draws `text` over the robot, replacing any label already there. Remote
   * players get the `name` from their create record, which the server has
   * already sanitised and capped (server `Player.sanitiseName`); the local
   * player gets OWN_LABEL, since its own create record carries no name.
   * `own` also picks the colour, so YOU stands out from a remote player's name.
   */
  setLabel (text: string, own: boolean = false): void {
    if (this.label !== undefined) this.removeChild(this.label)

    const label = new Text(text, {
      fontFamily: '"Trebuchet MS", Helvetica, sans-serif',
      fontSize: 10,
      fill: own ? 0xffe066 : 'white',
      stroke: 'black',
      strokeThickness: 1
    })

    const container = new Container()
    const graphics = new Graphics()
    graphics.alpha = 0.4
    graphics
      .beginFill(0x000000)
      .drawRect(-3, 0, label.width + 5, label.height + 2)
      .endFill()
    container.addChild(graphics)
    container.addChild(label)

    container.x = -(label.width + 5) / 2
    container.y = -50
    this.addChild(container)
    this.label = container
  }

  dispose (): void {
    if ((this.hp ?? 0) <= 0) {
      this.animation?.playClip('player/die/die')
      this.animation?.setDefault(undefined)
    }

    if (this.progressBar != null) { this.removeChild(this.progressBar.graphics) }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    setTimeout(() => {
      // A removed PIXI object has `parent === null`, which passed the old
      // `!== undefined` test and then threw on the line below.
      if (self.parent != null) self.parent.removeChild(self)
    }, 1700)

    this.killed = true
  }
}
