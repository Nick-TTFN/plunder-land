import { type Container } from 'pixi.js'

/** How far a cast shadow leans, radians of skew: the old up-left lean, mirrored. */
export const SHADOW_SKEW = 0.5
/** A cast shadow's length against its caster's height. */
export const SHADOW_LENGTH = 0.6

/**
 * Lays a silhouette standing on its base line (feet at y 0, drawn upwards)
 * down on the ground, falling to the bottom right, the light being up-left.
 * Mirrored about the base line (negative `scale.y`), then leaned: with
 * `scale.y` negative, `skew.x` moves what was above the feet right as well as
 * down. Every cast shadow goes through here so they all agree (mobs,
 * StoneWall stones, rigged robots). `scaleX`/`scaleY` are the caster's own
 * scale; a flipped sprite passes a negative `scaleX`.
 */
export function layShadow (shadow: Container, scaleX = 1, scaleY = 1): void {
  shadow.skew.set(SHADOW_SKEW, 0)
  shadow.scale.set(scaleX, -Math.abs(scaleY) * SHADOW_LENGTH)
}
