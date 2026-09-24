import { type Texture } from 'pixi.js'
import { Game } from '../game'
import { type GameObject } from '../objects/gameobject'
import { Aim } from './aim'

export class Skill {
  name: string | undefined
  uiTexture: Texture

  owner: GameObject
  index: number | undefined
  cooldown: number | undefined

  constructor (owner: GameObject) {
    this.owner = owner
  }

  execute (): void {
    if (this.index === undefined) return
    // Every skill sends the cell under the mouse, or no aim; the server decides
    // which skills use it (decision #21), so the client needs no per-skill list.
    Game.socket.emit('skill', Aim.message(this.index, Aim.cell()))
  }
}
