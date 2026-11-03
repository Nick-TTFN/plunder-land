import { type Texture } from 'pixi.js'
import { Game } from '../game'
import { type GameObject } from '../objects/gameobject'
import { Session } from '../net/session'
import { Aim } from './aim'
import { type Vector } from '../utils/vector'

/**
 * Unused since auto-aim (#58): a press no longer carries its own aim. Kept
 * so the skill classes that still name it in `execute`'s signature compile.
 */
export interface Aimed { cell: Vector | undefined }

export class Skill {
  name: string | undefined
  uiTexture: Texture

  owner: GameObject
  index: number | undefined
  cooldown: number | undefined
  /**
   * Whether the server aims it at the pressed cell (ranged, fireball, icicle,
   * ice breath; decision #21). Dash, Melee, Defend and StoneWall ignore the
   * aim and follow the movement direction (#58 Q11).
   */
  aims = false

  constructor (owner: GameObject) {
    this.owner = owner
  }

  execute (_aim?: Aimed): void {
    if (this.index === undefined) return
    Game.socket.emit('skill', Aim.message(this.index, this.aimCell()))
  }

  /**
   * The cell this press sends (`Aim.skillCell`): the auto-aim target's, or
   * the skill's reach along the movement direction; undefined, the bare
   * slot, for a skill that doesn't aim. The id is this slot's in
   * `hello.skills`.
   */
  aimCell (): Vector | undefined {
    if (!this.aims || this.index === undefined) return undefined
    return Aim.skillCell(Session.skills?.[this.index])
  }
}
