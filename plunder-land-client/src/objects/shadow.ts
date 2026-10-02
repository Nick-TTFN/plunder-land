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

/**
 * Where the shadow of a point `height` px above the ground falls, relative to
 * the point under it: what `layShadow` does to a silhouette's top, so a
 * shadow drawn as an offset (walls, portal and exit pads) leans the same way
 * as every laid silhouette. Mostly down, a little right.
 */
export function shadowOffset (height: number): { x: number, y: number } {
  return { x: Math.sin(SHADOW_SKEW) * SHADOW_LENGTH * height, y: Math.cos(SHADOW_SKEW) * SHADOW_LENGTH * height }
}

/**
 * How far a portal or exit pad stands off the ground, for its offset shadow
 * (Nick, 2026-10-02: "offset copy underneath for portals"). Claude's pick:
 * the pads are thin.
 */
export const PAD_HEIGHT = 6
