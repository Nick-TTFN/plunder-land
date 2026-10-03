import { type Texture } from 'pixi.js'
import { type GameObject } from '../objects/gameobject'
import { skillById } from '../utils/skills'
import { type Skill } from './skill'
import { Dash } from './dash'
import { MeleeAttack } from './meleeattack'
import { RangedAttack } from './rangedattack'
import { Defend } from './defend'
import { StoneWall, ThrowFireball, ThrowIcicle, IceBreath } from './placeholders'

/**
 * The client's skill class for each mirrored skill id (`utils/skills.ts`,
 * decision #48 step 4), or null for 0 (an empty slot) and an id this build
 * doesn't know. archetypes.spec.ts (server) checks that every key has a case
 * here and that each case builds the same skill as the server's `SKILL_SPECS`.
 */
export function skillFor (id: number, owner: GameObject): Skill | null {
  switch (skillById(id)?.key) {
    case 'dash': return new Dash(owner)
    case 'melee': return new MeleeAttack(owner)
    case 'ranged': return new RangedAttack(owner)
    case 'defend': return new Defend(owner)
    case 'stoneWall': return new StoneWall(owner)
    case 'fireball': return new ThrowFireball(owner)
    case 'icicle': return new ThrowIcicle(owner)
    case 'iceBreath': return new IceBreath(owner)
    default: return null
  }
}

/**
 * A skill's icon, for the lobby, taken from its class (`uiTexture`) so the
 * frame names stay written down once. Undefined for 0 and unknown ids. The
 * skill built for it has no owner and is never executed.
 */
export function iconTexture (id: number): Texture | undefined {
  return skillFor(id, undefined as unknown as GameObject)?.uiTexture
}
