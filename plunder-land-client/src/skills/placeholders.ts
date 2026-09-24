import { Skill } from './skill'
import { Texture } from 'pixi.js'
import { type GameObject } from '../objects/gameobject'

/**
 * PLACEHOLDER ART. The atlas ships four control icons — dash, defend, melee and
 * ranged — and these four skills have none of their own, so each borrows the
 * closest existing one. The key letter on the button is what actually tells them
 * apart until real icons exist. Swap the texture name here when they do.
 */
const PLACEHOLDER = {
  stoneWall: 'UI/controls/defend.png',
  throwFireball: 'UI/controls/ranged.png',
  throwIcicle: 'UI/controls/ranged.png',
  iceBreath: 'UI/controls/melee.png'
}

export class StoneWall extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Stone Wall'
    this.uiTexture = Texture.from(PLACEHOLDER.stoneWall)
    this.cooldown = 6 // mirrors the server's 6000 ms
  }
}

export class ThrowFireball extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Throw Fireball'
    this.uiTexture = Texture.from(PLACEHOLDER.throwFireball)
    this.cooldown = 4
  }
}

export class ThrowIcicle extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Throw Icicle'
    this.uiTexture = Texture.from(PLACEHOLDER.throwIcicle)
    this.cooldown = 4
  }
}

export class IceBreath extends Skill {
  constructor (owner: GameObject) {
    super(owner)
    this.name = 'Ice Breath'
    this.uiTexture = Texture.from(PLACEHOLDER.iceBreath)
    this.cooldown = 3
  }
}
