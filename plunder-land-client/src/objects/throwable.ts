import { Texture, AnimatedSprite, Assets } from 'pixi.js'
import { Vector } from '../utils/vector'
import { Game } from '../game'
import { Session } from '../net/session'
import { TILT } from './tilt'

/**
 * The `projectile` wire field (index 22). Append-only; the server's copy is
 * `Throwable.FIREBALL` / `ICICLE` (`projectilekind.spec.ts` compares them).
 */
export const PROJECTILE = { fireball: 1, icicle: 2 }

/**
 * A fireball or icicle in flight: the arena sheet's looping clip, drawn at its
 * baked size around its baked pivot (the art faces +X).
 *
 * The server sends a projectile's position once a tick, 75 units apart, and
 * never its direction (`direction` is not in the field table). So it is drawn
 * one tick behind, gliding from each position to the next over a tick, and
 * pointed along that step. It stays hidden until the second position, when
 * the heading is first known, so it never flies a tick pointing the wrong way.
 * Remote units are drawn behind the server for the same reason.
 */
export class Throwable extends AnimatedSprite {
  maxVelocity: number
  direction: Vector | undefined
  private _from: Vector | undefined
  private _to: Vector | undefined
  private _startedAt = 0

  constructor (icy = false) {
    const sheet = Assets.get('./res/arena.json')
    const name = icy ? 'fx/icicle' : 'fx/fireball'
    const tex = new Array<Texture>()
    for (const frame of sheet.data.animations[name]) { tex.push(Texture.from(frame)) }
    super(tex, true)
    this.animationSpeed = (sheet.data.meta.clips[name]?.fps ?? 12) / 60
    this.maxVelocity = 300
    this.alpha = 0
    this.play()
  }

  setDirection (x: number, y: number): void {
    this.direction = new Vector(x, y).normalised()
  }

  setMoveTarget (value: Vector): void {
    const last = this._to
    this._to = value
    if (last === undefined) {
      this.x = value.x
      this.y = value.y
      return
    }
    this._from = new Vector(this.x, this.y)
    this._startedAt = performance.now()
    const dx = value.x - last.x
    const dy = value.y - last.y
    if (dx !== 0 || dy !== 0) {
      // On screen: the camera squashes y by TILT and this sprite stands up.
      this.rotation = Math.atan2(dy * TILT, dx)
      this.alpha = 1
    }
  }

  update (deltaTime: number): void {
    super.update(deltaTime)
    if (this._from === undefined || this._to === undefined) return
    const t = Math.min(1, (performance.now() - this._startedAt) / Session.tickMs)
    this.x = this._from.x + (this._to.x - this._from.x) * t
    this.y = this._from.y + (this._to.y - this._from.y) * t
  }

  DEBUG_DRAW_COLLIDER (): void {}

  dispose (): void {
    // The burst is the server's blast effect now (BlastEffect), drawn on the
    // cells the blast damaged. The explosions scattered here were centred on
    // the last position this client had, a tick behind the hit, and would have
    // played on top of it about a cell and a half away.
    if (Game.FIREBALLS.includes(this)) { Game.FIREBALLS.splice(Game.FIREBALLS.indexOf(this), 1) }

    // super.destroy();
    this.parent?.removeChild(this)
  }
}
