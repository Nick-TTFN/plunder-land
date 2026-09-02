import { GameObject, ObjectType } from './gameobject'
import { Random } from '../utils/random'
import Multiplayer from '../network/multiplayer'

export default class Consumable extends GameObject {
  /**
   * Wall-clock deadline, or 0 for a pickup that never expires. Only loot dropped
   * on death gets one: the world's own spawner is already bounded by a count,
   * but drops are not, so without expiry a busy world's pickup population only
   * ever ratchets upward.
   */
  expiresAt: number = 0

  constructor (x: number, y: number, tag: number, radius = undefined, loot: number | undefined = undefined, lifetime: number = 0) {
    super(ObjectType.Consumable, x, y, radius || Random.RangeInt(15, 25), tag)

    if (lifetime > 0) {
      this.expiresAt = Date.now() + lifetime
      this.lifetime = lifetime  // drives the countdown ring on the client
    }
    // Loot is separate from radius so a big haul can drop without producing a
    // pickup the size of a building.
    this.loot = loot ?? this.radius

    Multiplayer.Instance.create(this)
  }
}
