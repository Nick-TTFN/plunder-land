import { type GameObject } from '../objects/gameobject'
import { Skill } from './skill'
import { Texture } from 'pixi.js'

export class Defend extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Defend'
    this.uiTexture = Texture.from('ui/skill_defend.png')
    this.cooldown = 8
  }

  execute (): void {
    super.execute()
    // 'player/magic/frame' is not in the atlas, so asking for it only logged an
    // error. Restore the call once the clip exists.
  }
}
