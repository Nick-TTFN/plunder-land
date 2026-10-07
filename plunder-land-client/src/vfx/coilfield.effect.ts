import TWEEN from '@tweenjs/tween.js'
import { Graphics } from 'pixi.js'
import { type Vector } from '../utils/vector'
import { type GameObject } from '../objects/gameobject'
import { discCells } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { COIL_PULSE, coilPulsePhase } from './coilfield'

/**
 * **PLACEHOLDER ART (art pass, #51):** both effects below are drawn in code
 * until the Coil pulse and slowed-cue art arrives (Codex brief
 * `npc-integration-2026-10-07/sessions/06-effects.md`, `codex_output/npc-fx-v1/`).
 */

const TELL_COLOUR = 0x6fd3ff
const FIELD_COLOUR = 0x3aa8ff
const SLOWED_COLOUR = 0x7fdcff

/**
 * Effect 13, the Coil's pulse (task l1-3): on the field's cells, exactly the
 * disc the server slows (`World.FIND_IN_CELLS`, `COIL_PULSE.rings`). Faint and
 * swelling through the tell, solid while the field holds, then gone.
 * Placeholder (see above).
 */
export class CoilPulseEffect {
  constructor (cell: Vector, tag: number | undefined, lifetime: number) {
    const layer = layerOf(tag)
    if (layer === undefined) return

    const highlight = new CellHighlight(FIELD_COLOUR, 0.3)
    highlight.draw(discCells(cell, COIL_PULSE.rings))
    highlight.tint = TELL_COLOUR
    highlight.alpha = 0
    layer.addChild(highlight)

    const duration = Math.max(lifetime, 100)
    const state = { ms: 0 }
    new TWEEN.Tween(state)
      .to({ ms: duration }, duration)
      .onUpdate(() => {
        const { phase, t } = coilPulsePhase(state.ms, duration)
        if (phase === 'tell') {
          highlight.tint = TELL_COLOUR
          highlight.alpha = 0.15 + 0.35 * t
        } else {
          highlight.tint = 0xffffff
          highlight.alpha = 0.75 + 0.25 * Math.sin(t * Math.PI * 6)
        }
      })
      .onComplete(() => {
        highlight.parent?.removeChild(highlight)
        highlight.destroy()
      })
      .start()
  }
}

/**
 * Effect 16, slowed (task l1-3): a pale ring at the victim's feet for the
 * slow's lifetime. A later cue on the same victim restarts its clock instead
 * of adding a second ring. Placeholder (see above).
 */
export class SlowedEffect {
  private static readonly shown = new WeakMap<GameObject, SlowedEffect>()

  private readonly ring = new Graphics()
  private timer: ReturnType<typeof setTimeout> | undefined

  static show (owner: GameObject, lifetime: number): void {
    const running = SlowedEffect.shown.get(owner)
    if (running !== undefined && running.ring.parent !== null) {
      running.restart(lifetime)
      return
    }
    SlowedEffect.shown.set(owner, new SlowedEffect(owner, lifetime))
  }

  private constructor (private readonly owner: GameObject, lifetime: number) {
    const r = Math.max(10, owner.radius) * 1.2
    this.ring.lineStyle(2, SLOWED_COLOUR, 0.9)
    this.ring.drawEllipse(0, 0, r, r * 0.45)
    this.ring.eventMode = 'none'
    owner.addChild(this.ring)
    this.restart(lifetime)
  }

  private restart (lifetime: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.ring.parent?.removeChild(this.ring)
      this.ring.destroy()
      SlowedEffect.shown.delete(this.owner)
    }, Math.max(lifetime, 100))
  }
}
