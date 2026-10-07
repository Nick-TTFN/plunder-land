import TWEEN from '@tweenjs/tween.js'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { type GameObject } from '../objects/gameobject'
import { discCells } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { COIL_PULSE, coilPulsePhase } from './coilfield'
import { FxSprite, discard, runFor, stampCells, standAt, warnCells } from './npcfx'

/** Fallback colours, drawn as cell highlights only while the effects sheet hasn't loaded. */
const TELL_COLOUR = 0x6fd3ff
const FIELD_COLOUR = 0x3aa8ff

/**
 * Effect 13, the Coil's pulse (task l1-3), on the field's cells: exactly the
 * disc the server slows (`World.FIND_IN_CELLS`, `COIL_PULSE.rings`). Art:
 * Codex `npc-fx-v1` (l1-11).
 *
 * The record's lifetime is tell + hold (`coilPulsePhase`, the tell's share
 * taken from the end, so a late viewer still sees the whole hold). Through
 * the tell the cells carry the shared warning (`warnCells`; the package has
 * no tell art). Through the hold, while the server slows, `coil-pulse-cell`
 * on every cell and `coil-pulse-burst` standing at the Coil's feet (the
 * field's centre cell, where it stands planted), both remapped onto the hold
 * (the package's 1.5 s is the server's `holdMs`).
 */
export class CoilPulseEffect {
  constructor (cell: Vector, tag: number | undefined, lifetime: number) {
    const layer = layerOf(tag)
    if (layer === undefined) return
    const centre = { x: cell.x, y: cell.y }
    const cells = discCells(centre, COIL_PULSE.rings)
    const duration = Math.max(lifetime, 100)
    const tellMs = Math.max(0, duration - COIL_PULSE.holdMs)

    if (!FxSprite.ready()) {
      if (tellMs > 0) CellHighlight.flash(tag, cells, TELL_COLOUR, tellMs)
      CellHighlight.flash(tag, cells, FIELD_COLOUR, duration)
      return
    }

    if (tellMs > 0) warnCells(tag, cells, centre, tellMs, TELL_COLOUR)

    let field: ReturnType<typeof stampCells> | undefined
    let burst: FxSprite | undefined
    runFor(duration, (elapsed) => {
      const { phase, t } = coilPulsePhase(elapsed, duration)
      if (phase !== 'hold') return
      if (field === undefined) {
        field = stampCells(layer, 'fx/coil-pulse-cell', cells)
        const at = Hex.toPosition(cell)
        burst = standAt(layer, 'fx/coil-pulse-burst', at.x, at.y)
      }
      for (const decal of field.decals) decal.through(t)
      burst?.through(t)
    }, () => {
      discard(field?.group)
      discard(burst)
    })
  }
}

/** Where a slowed cue sits on its victim: its feet, as `Unit.feetY` (structural; only units are slowed). */
function feetOf (owner: GameObject): number {
  return (owner as unknown as { feetY?: number }).feetY ?? 0
}

/**
 * Effect 16, slowed (task l1-3): `slow-status` (Codex `npc-fx-v1`, l1-11,
 * the package's open foot shackle) looping round the victim's feet for the
 * slow's lifetime. A later cue on the same victim restarts its clock instead
 * of adding a second one. Without the sheet, nothing: the victim's own speed
 * shows it.
 */
export class SlowedEffect {
  private static readonly shown = new WeakMap<GameObject, SlowedEffect>()

  private readonly cue = new FxSprite('fx/slow-status')
  private tween: { stop: () => unknown } | undefined = undefined
  private readonly startedAt = performance.now()

  static show (owner: GameObject, lifetime: number): void {
    const running = SlowedEffect.shown.get(owner)
    if (running !== undefined && !running.cue.destroyed && running.cue.parent !== null) {
      running.restart(lifetime)
      return
    }
    if (!FxSprite.ready()) return
    SlowedEffect.shown.set(owner, new SlowedEffect(owner, lifetime))
  }

  private constructor (private readonly owner: GameObject, lifetime: number) {
    this.cue.y = feetOf(owner)
    owner.addChild(this.cue)
    this.restart(lifetime)
  }

  private restart (lifetime: number): void {
    this.tween?.stop()
    const state = { ms: 0 }
    const duration = Math.max(lifetime, 100)
    this.tween = new TWEEN.Tween(state)
      .to({ ms: duration }, duration)
      .onUpdate(() => {
        // Its own loop clock, unbroken by a refresh.
        this.cue.at((performance.now() - this.startedAt) / 1000)
      })
      .onComplete(() => {
        discard(this.cue)
        SlowedEffect.shown.delete(this.owner)
      })
      .start()
  }
}
