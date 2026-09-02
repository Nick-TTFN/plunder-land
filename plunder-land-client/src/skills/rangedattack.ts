import { type GameObject } from '../objects/gameobject'
import { Skill } from './skill'
import { Texture } from 'pixi.js'

export class RangedAttack extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Ranged Attack'
    this.uiTexture = Texture.from('UI/controls/ranged.png')
    this.cooldown = 0.5
  }

  execute (): void {
    super.execute()
    // 'player/shoot/shot' is not in the atlas either; same story as Defend.
  }
}
