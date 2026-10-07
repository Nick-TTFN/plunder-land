import { Graphics, Sprite } from 'pixi.js'
import { GameObject } from './gameobject'
import { type GearInstance } from '../utils/gear'
import { iconTexture } from '../skills/catalog'

/**
 * Each tier's tint, T1 first (Common, Rare, Epic, Legendary): the ring round
 * a gear pickup and the frame of a gear card or bag icon. Placeholder colours
 * (Claude's pick; Legendary's gold per #51's L1 plan calls) until the tier
 * frames are drawn (art is Nick's; Dez's missing-art list).
 */
export const GEAR_TIER_TINT: readonly number[] = [0x7ee081, 0x5aa9ff, 0xc77dff, 0xffc94a]

/** The tint of `tier`, grey for one this build doesn't know. */
export function tierTint (tier: number | undefined): number {
  return tier !== undefined ? GEAR_TIER_TINT[tier - 1] ?? 0x9a9a9a : 0x9a9a9a
}

/**
 * A gear item on the ground (decision #49, 49-2): type 128 like an item
 * pickup, told apart by its create carrying `gear` (25). **Placeholder look**:
 * a skill item is its skill's icon in a ring tinted by tier; a part is a
 * small filled hex in the same ring. No new art (a cache pickup in the world
 * is on Dez's missing-art list). `instance` null is one this build can't read
 * (an unknown skill or tier): a grey ring.
 */
export class GearPickup extends GameObject {
  readonly instance: GearInstance | null

  constructor (instance: GearInstance | null, radius: number | undefined) {
    super()
    this.instance = instance
    if (radius !== undefined) this.radius = radius
    const r = this.radius
    const tint = tierTint(instance?.tier)

    this.addChild(new Graphics().beginFill(0x000000, 0.3).drawEllipse(0, 0, r * 0.8, r * 0.3).endFill())
    const ring = new Graphics()
      .lineStyle(3, tint, 1)
      .beginFill(0x101A28, 0.85)
      .drawCircle(0, -r * 0.7, r * 0.75)
      .endFill()
    this.addChild(ring)

    const texture = instance !== null && instance.skill !== 0 ? iconTexture(instance.skill) : undefined
    if (texture !== undefined) {
      const icon = new Sprite(texture)
      icon.anchor.set(0.5, 0.5)
      const size = r * 1.1
      icon.scale.set(Math.min(size / texture.frame.width, size / texture.frame.height))
      icon.y = -r * 0.7
      this.addChild(icon)
    } else if (instance !== null) {
      // A part: a small hex in the tier's colour.
      const hex = new Graphics().beginFill(tint, 1)
      const s = r * 0.35
      hex.drawPolygon(Array.from({ length: 12 }, (_, i) => {
        const a = Math.PI / 6 + Math.floor(i / 2) * Math.PI / 3
        return i % 2 === 0 ? Math.cos(a) * s : Math.sin(a) * s - r * 0.7
      }))
      hex.endFill()
      this.addChild(hex)
    }
    this.DEBUG_DRAW_COLLIDER()
  }
}
