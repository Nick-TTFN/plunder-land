import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { type GameObject } from '../objects/gameobject'
import { TILT } from '../objects/tilt'
import { attackCells, type Cell } from './cells'
import { layerOf } from './cellhighlight'
import { FxSprite, burstCells, discard, runFor, standAt, warnCells } from './npcfx'

/** Fallback colours, drawn as cell highlights only while the effects sheet hasn't loaded. */
const MARKER_COLOUR = 0xff6a1f
const BLAST_COLOUR = 0xffa21f
/** The arc's peak above the straight line, in world units. */
const ARC_HEIGHT = 140

/** The cells a Kiln's lob covers when it lands on `cell`: the server's set (`effectcells.spec.ts`). */
export function kilnLobCells (cell: Cell): Cell[] {
  const attack = ARCHETYPE_INFO.kiln.attack
  if (attack === undefined) return []
  return attackCells(attack, cell, undefined, cell)
}

/**
 * The Walking Kiln's lob (decision #51, l1-4): effect 9, the landing warning
 * and the slug's arc, and effect 10, the impact. Both on the landing cell the
 * record carries, over the cells `kilnLobCells` gives, which are the ones the
 * server damages. Art: Codex `npc-fx-v1` (l1-11, `vfx/npcfx.ts`).
 *
 * Effect 9 lasts the flight (`lifetime`): `landing-center` on the landing
 * cell and `landing-ring` on the rest, one urgency cycle over the flight; and,
 * if this client holds the Kiln (`kiln`), the furnace slug (`kiln-lob`, a
 * standing loop turned along its arc) flies from it to the cell over the same
 * time with its ground shadow (`kiln-lob-shadow`) under it. Without the Kiln
 * (out of view) the warning alone. Effect 10 arrives as its own record when
 * the server lands the lob, so the impact shows when the damage lands, also
 * after the Kiln died: `kiln-impact-cell` on every cell and
 * `kiln-impact-burst` standing on the landing cell, over the record's
 * lifetime. The rig's `lob` clip is l1-9's.
 */
export class KilnLobEffect {
  constructor (cell: Vector, tag: number | undefined, blast: boolean, lifetime: number, kiln?: GameObject) {
    const cells = kilnLobCells(cell)
    const landing = { x: cell.x, y: cell.y }

    if (blast) {
      const at = Hex.toPosition(cell)
      burstCells(tag, cells, 'fx/kiln-impact-cell', lifetime, BLAST_COLOUR, { name: 'fx/kiln-impact-burst', at })
      return
    }

    warnCells(tag, cells, landing, lifetime, MARKER_COLOUR)
    if (kiln !== undefined && !kiln.killed) KilnLobEffect.arc(tag, kiln, cell, lifetime)
  }

  /** The slug from the Kiln's drawn position to the cell's centre, on a parabola, over `lifetime`, its shadow on the ground under it. */
  private static arc (tag: number | undefined, kiln: GameObject, cell: Vector, lifetime: number): void {
    const layer = layerOf(tag)
    if (layer === undefined || !FxSprite.ready()) return

    const from = { x: kiln.x, y: kiln.y }
    const to = Hex.toPosition(cell)
    const slug = standAt(layer, 'fx/kiln-lob', from.x, from.y)
    const shadow = new FxSprite('fx/kiln-lob-shadow')
    layer.addChild(shadow)

    const duration = Math.max(lifetime, 100)
    const groundAt = (t: number): { x: number, y: number } =>
      ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    const heightAt = (t: number): number => ARC_HEIGHT * 4 * t * (1 - t)

    runFor(duration, (elapsed) => {
      const t = Math.min(1, elapsed / duration)
      const ground = groundAt(t)
      shadow.position.set(ground.x, ground.y)
      slug.position.set(ground.x, ground.y - heightAt(t))
      // Over everything it passes, as a unit standing on its ground point.
      slug.zIndex = ground.y + 1
      // Along the arc as drawn: the camera squashes every y by TILT, the
      // height included (the slug's position is in the plane).
      const vx = to.x - from.x
      const vy = (to.y - from.y - ARC_HEIGHT * 4 * (1 - 2 * t)) * TILT
      slug.rotation = Math.atan2(vy, vx)
      slug.at(elapsed / 1000)
      shadow.at(elapsed / 1000)
    }, () => {
      discard(slug)
      discard(shadow)
    })
  }
}
