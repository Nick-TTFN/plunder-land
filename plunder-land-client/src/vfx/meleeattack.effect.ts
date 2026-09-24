import { type GameObject } from '../objects/gameobject'
import { MELEE_RINGS, discCells } from './cells'
import { CellHighlight, cellOf } from './cellhighlight'

/** The four swing clips `Player.initAnimation` loads. Mobs have none. */
const SWINGS = [
  'player/melee_1/attack',
  'player/melee_2/attack',
  'player/melee_3/attack',
  'player/melee_4/attack'
]

/**
 * A swing, and the 2 rings around the caster's cell that it hits (19 cells,
 * `MeleeAttack.RINGS`), flashed on the ground.
 *
 * The constructor body had been commented out since it was written against
 * PIXI's old `Loader` and swapped the unit's textures by hand. `AnimationStates`
 * now owns that: `playClip` plays a one-shot clip and falls back to the default
 * clip when it completes, so the run/idle loop comes back on its own.
 */
export class MeleeAttackEffect {
  constructor (owner: GameObject, lifetime: number) {
    const animation = owner.animation
    if (animation !== undefined) {
      const available = SWINGS.filter((name) => animation.clips[name] !== undefined)
      if (available.length > 0) {
        // Replace, not queue: playClip ignores a request while a one-shot is
        // still playing, and a swing interrupted by the next swing is right.
        animation.current = undefined
        animation.loop = true
        animation.playClip(available[Math.floor(Math.random() * available.length)])
      }
    }

    // A fixed flash rather than `lifetime`: the server sends melee a lifetime
    // of 1 ms, which the record's centisecond byte rounds to 0. The hit is
    // instant; this only has to be long enough to read.
    void lifetime
    CellHighlight.flash(owner.tag, discCells(cellOf(owner), MELEE_RINGS), 0xfff1c9, 350)
  }
}
