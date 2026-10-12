import TWEEN from '@tweenjs/tween.js'
import { Container, Sprite, Texture } from 'pixi.js'
import Mob from '../objects/mob'
import { type GameObject } from '../objects/gameobject'
import { discard } from './npcfx'

/** How long the cue fades in and out, ms. */
const FADE_MS = 150
/** One snowflake per this much body width, px, between `MIN_FLAKES` and `MAX_FLAKES`. */
const FLAKE_EVERY_PX = 22
const MIN_FLAKES = 3
const MAX_FLAKES = 9
/** The snowflake's scale (the arena's is 32 px) and how far each bobs, px. */
const FLAKE_SCALE = 0.45
const BOB_PX = 3

/**
 * Effect 21, frozen (ice-2), on the mob, for the freeze's length (1500 ms an
 * Icicle, 1250 ms Ice Breath, 750 ms a boss; `ice-1`). Only mobs freeze.
 *
 * - The tint: `NpcSprite.frozen` for a rigged NPC (multiplied with its hit
 *   flash, `bodyTint`), `Mob.setIceTint` for an old-sprite mob (its look's
 *   own tint back at the end).
 * - The cue: the arena's snowflakes hung across the body, spread over its
 *   drawn width (`Mob.bodySpan`, so a 7-cell Reactor or Brood gets more) and
 *   height (`feetY` to `headY`), bobbing and turning. A stand-in until there
 *   is frozen-status art (PROVISIONAL, Nick's).
 * - Never pauses an attack: a wind-up started before the freeze still lands
 *   on the server, and its clip is timed to it (#52). Only the idle/move loop
 *   holds (`NpcSprite.update`).
 *
 * One per mob: a later effect 21 on the same mob restarts the running one
 * (as `SlowedEffect`) instead of adding a second. Keyed by the object in a
 * `WeakMap`, so a new run carries nothing over.
 */
export class FrozenEffect {
  private static readonly shown = new WeakMap<GameObject, FrozenEffect>()

  private readonly cue = new Container()
  private readonly flakes: Array<{ sprite: Sprite, x: number, y: number, phase: number }> = []
  private tween: { stop: () => unknown } | undefined = undefined
  private readonly startedAt = performance.now()

  static show (owner: GameObject, lifetime: number): void {
    if (!(owner instanceof Mob) || owner.destroyed) return
    const running = FrozenEffect.shown.get(owner)
    if (running !== undefined && !running.cue.destroyed && running.cue.parent !== null) {
      running.restart(lifetime)
      return
    }
    FrozenEffect.shown.set(owner, new FrozenEffect(owner, lifetime))
  }

  private constructor (private readonly owner: Mob, lifetime: number) {
    const span = owner.bodySpan ?? { left: -owner.radius * 1.5, right: owner.radius * 1.5 }
    const top = owner.headY
    const bottom = owner.feetY
    const width = Math.max(1, span.right - span.left)
    const count = Math.min(MAX_FLAKES, Math.max(MIN_FLAKES, Math.round(width / FLAKE_EVERY_PX)))
    for (let i = 0; i < count; i++) {
      // The arena's snowflake (Ice Breath's); its motion is code's.
      const sprite = new Sprite(Texture.from('fx/snowflake.png'))
      sprite.anchor.set(0.5)
      sprite.scale.set(FLAKE_SCALE)
      sprite.rotation = Math.random() * Math.PI
      sprite.eventMode = 'none'
      // Spread across the body, alternately high and low on it.
      const x = span.left + width * (i + 0.5) / count
      const y = top + (bottom - top) * (i % 2 === 0 ? 0.35 : 0.7)
      this.flakes.push({ sprite, x, y, phase: i * 1.7 })
      this.cue.addChild(sprite)
    }
    this.cue.eventMode = 'none'
    owner.addChild(this.cue)
    this.setFrozen(true)
    this.restart(lifetime)
  }

  private setFrozen (frozen: boolean): void {
    const npc = this.owner.npc
    if (npc !== undefined) {
      npc.frozen = frozen
      return
    }
    this.owner.setIceTint(frozen)
  }

  private restart (lifetime: number): void {
    this.tween?.stop()
    const state = { ms: 0 }
    const duration = Math.max(lifetime, 100)
    this.tween = new TWEEN.Tween(state)
      .to({ ms: duration }, duration)
      .onUpdate(() => {
        if (this.cue.destroyed || this.owner.destroyed) {
          this.end()
          return
        }
        // Its own clock, unbroken by a restart; only the fade-out waits for the new end.
        const seconds = (performance.now() - this.startedAt) / 1000
        this.cue.alpha = Math.min(1, seconds * 1000 / FADE_MS, (duration - state.ms) / FADE_MS)
        for (const flake of this.flakes) {
          flake.sprite.x = flake.x
          flake.sprite.y = flake.y + Math.sin(seconds * 3 + flake.phase) * BOB_PX
          flake.sprite.rotation += 0.01
        }
      })
      .onComplete(() => { this.end() })
      .start()
  }

  private end (): void {
    this.tween?.stop()
    this.tween = undefined
    if (FrozenEffect.shown.get(this.owner) === this) FrozenEffect.shown.delete(this.owner)
    // Safe on a destroyed mob: `setIceTint` skips a destroyed sprite.
    this.setFrozen(false)
    discard(this.cue)
  }
}
