import TWEEN from '@tweenjs/tween.js'
import { Graphics } from 'pixi.js'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { type GameObject } from '../objects/gameobject'
import { attackCells, type Cell } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { BombEffect } from './bomb.effect'
import { playBlast } from './blast.effect'

const MARKER_COLOUR = 0xff6a1f
const BLAST_COLOUR = 0xffa21f
const SHELL_COLOUR = 0x3a2a22
const SHELL_GLOW = 0xff8c2a
/** The arc's peak above the straight line, in world units. */
const ARC_HEIGHT = 140

/** The cells a Kiln's lob covers when it lands on `cell`: the server's set (`effectcells.spec.ts`). */
export function kilnLobCells (cell: Cell): Cell[] {
  const attack = ARCHETYPE_INFO.kiln.attack
  if (attack === undefined) return []
  return attackCells(attack, cell, undefined, cell)
}

/**
 * The Walking Kiln's lob (decision #51, l1-4): effect 9, the landing marker
 * and the shell's arc, and effect 10, the blast. Both on the landing cell the
 * record carries, over the cells `kilnLobCells` gives, which are the ones the
 * server damages.
 *
 * Effect 9 lasts the flight (`lifetime`): the cells pulse as a bomb's fuse
 * does (`BombEffect.fuse`, in the Kiln's own orange), and if this client holds
 * the Kiln (`kiln`) a shell flies from it to the cell over the same time.
 * Without the Kiln (out of view) the marker alone. Effect 10 arrives as its own
 * record when the server lands the lob, so the blast shows when the damage
 * lands, also after the Kiln died.
 *
 * **Placeholders for the art pass** (Codex effect art not ready): the shell
 * is a Graphics circle with a glow, the marker the bomb fuse's pulse, the blast
 * the arena `fx/blast_fire` clip. The rig's `lob` clip on effect 9 is wired in
 * l1-9.
 */
export class KilnLobEffect {
  constructor (cell: Vector, tag: number | undefined, blast: boolean, lifetime: number, kiln?: GameObject) {
    const cells = kilnLobCells(cell)
    const rings = ARCHETYPE_INFO.kiln.attack?.kind === 'lob' ? ARCHETYPE_INFO.kiln.attack.rings : 1

    if (blast) {
      CellHighlight.flash(tag, cells, BLAST_COLOUR, Math.max(lifetime, 300))
      const layer = layerOf(tag)
      if (layer !== undefined) playBlast(layer, cell, rings, 'fx/blast_fire')
      return
    }

    BombEffect.fuse(tag, cells, lifetime, MARKER_COLOUR)
    if (kiln !== undefined && !kiln.killed) KilnLobEffect.arc(tag, kiln, cell, lifetime)
  }

  /** The shell from the Kiln's drawn position to the cell's centre, on a parabola, over `lifetime`. */
  private static arc (tag: number | undefined, kiln: GameObject, cell: Vector, lifetime: number): void {
    const layer = layerOf(tag)
    if (layer === undefined) return

    const from = { x: kiln.x, y: kiln.y }
    const to = Hex.toPosition(cell)
    const shell = new Graphics()
    shell.eventMode = 'none'
    shell.beginFill(SHELL_GLOW, 0.35).drawCircle(0, 0, 11).endFill()
    shell.beginFill(SHELL_COLOUR, 1).drawCircle(0, 0, 6).endFill()
    layer.addChild(shell)

    const state = { t: 0 }
    const place = (): void => {
      const t = state.t
      shell.x = from.x + (to.x - from.x) * t
      const ground = from.y + (to.y - from.y) * t
      shell.y = ground - ARC_HEIGHT * 4 * t * (1 - t)
      // Over everything it passes, as a unit standing on its ground point.
      shell.zIndex = ground + 1
    }
    place()
    new TWEEN.Tween(state)
      .to({ t: 1 }, Math.max(lifetime, 100))
      .onUpdate(place)
      .onComplete(() => {
        shell.parent?.removeChild(shell)
        shell.destroy()
      })
      .start()
  }
}
