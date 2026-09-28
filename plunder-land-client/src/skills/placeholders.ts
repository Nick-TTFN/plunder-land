import { Skill } from './skill'
import { Texture } from 'pixi.js'
import { type GameObject } from '../objects/gameobject'

/**
 * The four skills that had no icon of their own until the arena art pass
 * (2026-09-28). The file kept its name; the icons are real now.
 */
const ICON = {
  stoneWall: 'ui/skill_stone_wall.png',
  throwFireball: 'ui/skill_fireball.png',
  throwIcicle: 'ui/skill_icicle.png',
  iceBreath: 'ui/skill_ice_breath.png'
}

export class StoneWall extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Stone Wall'
    this.uiTexture = Texture.from(ICON.stoneWall)
    this.cooldown = 6 // mirrors the server's 6000 ms
  }
}

export class ThrowFireball extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Throw Fireball'
    this.uiTexture = Texture.from(ICON.throwFireball)
    this.cooldown = 4
  }
}

export class ThrowIcicle extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Throw Icicle'
    this.uiTexture = Texture.from(ICON.throwIcicle)
    this.cooldown = 4
  }
}

export class IceBreath extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Ice Breath'
    this.uiTexture = Texture.from(ICON.iceBreath)
    this.cooldown = 3
  }
}
