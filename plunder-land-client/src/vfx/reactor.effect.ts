import TWEEN from '@tweenjs/tween.js'
import { type Vector } from '../utils/vector'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { type AttackShape, attackCells } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { playBlast } from './blast.effect'

// PLACEHOLDER (art pass, decision #51): flat cell highlights and the arena's
// blast clip, until the Reactor tell and release art lands (Codex
// `npc-fx-v1`, sessions/06-effects.md). The rig's own activate and release
// clips are wired in l1-9.
const TELL_COLOUR = 0xff5a1f
const RELEASE_COLOUR = 0xffd21f

/**
 * The Reactor's burst (decision #51, l1-5) on the disc round its planted cell:
 * every cell within the mirror's `attack.rings` (`ARCHETYPE_INFO.reactor`),
 * which is the set the server's pulses hit (`mobskills/reactorburst.ts`,
 * `World.FIND_IN_CELLS`; `reactorburst.spec.ts` checks the two).
 *
 * `release` false is the tell (effect 11): the cells pulse, faster as it runs
 * down, for `lifetime` ms. The release (12) is its own record, sent when the
 * server starts dealing damage: the cells flash for `lifetime` ms, beating
 * once per pulse, with a placeholder blast.
 *
 * `dead` says whether the Reactor has been seen to die (destroy with hp 0).
 * The server stops a Reactor's burst the moment it dies, so a tell or release
 * still showing then would promise damage that never comes: either ends at
 * once. A Reactor this client doesn't hold (out of sight, the effect is sent by
 * the cell) is never seen to die, and its effect plays out.
 */
export class ReactorEffect {
  constructor (cell: Vector, tag: number | undefined, release: boolean, lifetime: number, dead: () => boolean) {
    const attack = ARCHETYPE_INFO.reactor.attack as AttackShape | undefined
    if (attack === undefined) return
    const cells = attackCells(attack, { x: cell.x, y: cell.y })
    const layer = layerOf(tag)
    if (layer === undefined) return

    const highlight = new CellHighlight(release ? RELEASE_COLOUR : TELL_COLOUR, release ? 0.45 : 0.3)
    highlight.draw(cells)
    layer.addChild(highlight)

    if (release && attack.kind === 'disc') playBlast(layer, cell, attack.rings, 'fx/blast_fire')

    const duration = Math.max(lifetime, 100)
    const seconds = duration / 1000
    const state = { t: 0 }
    const tween = new TWEEN.Tween(state)
      .to({ t: 1 }, duration)
      .onUpdate(() => {
        if (dead()) {
          tween.stop()
          end()
          return
        }
        // Tell: from 2 beats a second to 8, as the bomb's fuse. Release: 4
        // beats a second, one per server pulse at 250 ms.
        const phase = release
          ? state.t * 4 * seconds * Math.PI * 2
          : state.t * (2 + 6 * state.t) * seconds * Math.PI * 2
        highlight.alpha = 0.55 + 0.45 * Math.cos(phase)
      })
      .onComplete(() => { end() })
      .start()

    function end (): void {
      highlight.parent?.removeChild(highlight)
      if (!highlight.destroyed) highlight.destroy()
    }
  }
}
