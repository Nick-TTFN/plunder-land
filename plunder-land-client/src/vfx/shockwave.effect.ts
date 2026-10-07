import { type GameObject } from '../objects/gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { Session } from '../net/session'
import { type Cell, lineFromTip } from './cells'
import { CellHighlight, cellOf } from './cellhighlight'

/**
 * **Placeholder art (l1-6), listed for the art pass**: plain cell highlights,
 * no clip. The Compactor's strike clip is wired by l1-9.
 */

/** The line's length: the Compactor row's line in the mirrored table. */
function lineLength (): number {
  const attack = ARCHETYPE_INFO.compactor.attack
  return attack?.kind === 'line' ? attack.length : 0
}

/** How long the impact flash lasts after the telegraph, ms. Placeholder. */
const IMPACT_FLASH_MS = 350

/**
 * A Compactor's shockwave (effect 14, decision #51): the line it will hit,
 * lit for the record's lifetime (the wind-up, cast to impact), then flashed
 * as the hit lands. The cells are worked back from the tip the record carries
 * (`lineFromTip`), so they are the server's cells even if the client places
 * the Compactor a cell off. They don't follow the Compactor: the server
 * fixes the line at the cast.
 */
export class ShockwaveEffect {
  constructor (owner: GameObject, lifetime: number, tip: Vector | undefined) {
    if (tip === undefined) return
    const cells: Cell[] = lineFromTip(cellOf(owner), tip, lineLength(), (q, r) => Hex.onMap(q, r, Session.mapSize))
    if (cells.length === 0) return
    const tag = owner.tag
    CellHighlight.flash(tag, cells, 0xffb347, lifetime)
    setTimeout(() => { CellHighlight.flash(tag, cells, 0xff5a2a, IMPACT_FLASH_MS) }, Math.max(0, lifetime))
  }
}

/**
 * A knockback (effect 15, aimed at the landing cell): a short flash on the
 * landing cell, for any player. The move itself is interpolation for a remote
 * player and `LocalPlayer.knockback` for our own.
 */
export class KnockbackEffect {
  constructor (owner: GameObject, lifetime: number, landing: Vector | undefined) {
    if (landing === undefined) return
    CellHighlight.flash(owner.tag, [{ x: landing.x, y: landing.y }], 0xffffff, Math.max(lifetime, 200))
  }
}

