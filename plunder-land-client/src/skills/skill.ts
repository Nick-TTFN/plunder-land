import { type Texture } from 'pixi.js'
import { Game } from '../game'
import { type GameObject } from '../objects/gameobject'
import { Aim } from './aim'
import { type Vector } from '../utils/vector'

/**
 * Where a press aims: `cell` is the absolute cell (undefined: no aim, along
 * facing). Absent, the desktop mouse's cell (`Aim.cell`). Touch passes the
 * tapped cell (`TouchAim`).
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
   * aim. On touch an aimed skill waits for a tap on its target (`TouchAim`).
   */
  aims = false

  constructor (owner: GameObject) {
    this.owner = owner
  }

  execute (aim?: Aimed): void {
    if (this.index === undefined) return
    // Every skill sends the cell under the mouse (or the tapped one), or no
    // aim; the server decides which skills use it (decision #21).
    Game.socket.emit('skill', Aim.message(this.index, Skill.cellOf(aim)))
  }

  /** The cell a press aims at: the one given, else the mouse's. */
  static cellOf (aim: Aimed | undefined): Vector | undefined {
    return aim !== undefined ? aim.cell : Aim.cell()
  }
}
