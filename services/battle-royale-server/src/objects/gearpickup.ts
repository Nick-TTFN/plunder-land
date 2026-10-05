import { GameObject, ObjectType } from './gameobject'
import Multiplayer from '../network/multiplayer'
import { type GearInstance, encodeGear } from '../utils/gear'

/**
 * A gear item lying on the ground (decision #49, 49-2): a skill item or a
 * part, one instance (`utils/gear.ts`).
 *
 * **`ObjectType.Item` (128), not a type of its own**: `ObjectType` is a bit
 * mask (`typeMask` in `World.FIND_IN_CELLS`) and all 8 bits of the uint8 are
 * taken. It sends field `gear` (25) in its create instead of `item` (17), and
 * the client tells the two apart by which one the create carries. Server code
 * tells them apart with `World.isGear` (instanceof), never by type code.
 *
 * Its own list, `World.GEAR`, filed in `World.PICKUPS` like `ITEMS`. Either a
 * natural cache (`cache`, never expires; a taken one is replaced after the
 * layer's `gear.cacheRespawnMs`, `World.gearTaken`) or a drop (a mob's or a
 * dead player's), which expires after `World.DROPPED_LOOT_LIFETIME`.
 *
 * The instance is kept as it is, `rowId` included (the stash row it came
 * from, for 49-3/49-4): a dropped item keeps its lineage. `rowId` never goes
 * on the wire (`encodeGear` doesn't write it).
 */
export default class GearPickup extends GameObject {
  /** How big it is drawn, like `ItemPickup.RADIUS`. Pickup is by cell. */
  static RADIUS = 20

  readonly instance: GearInstance

  /** A natural cache, counted against the layer's `gear.caches`. */
  readonly cache: boolean

  /** Wall-clock deadline, or 0 for a cache that never expires (as `ItemPickup.expiresAt`). */
  expiresAt: number = 0

  constructor (x: number, y: number, tag: number, instance: GearInstance, lifetime: number = 0, cache: boolean = false) {
    super(ObjectType.Item, x, y, GearPickup.RADIUS, tag)
    this.instance = instance
    this.cache = cache

    if (lifetime > 0) {
      this.expiresAt = Date.now() + lifetime
      this.lifetime = lifetime // drives the countdown ring on the client
    }

    // Snapshot sets only: the instance never changes, so it is never dirty.
    this.allFields.add('gear')
    this.allFieldsOwn.add('gear')

    Multiplayer.Instance.create(this)
  }

  /** The `gear` wire field: the instance's bytes (`encodeGear`), without `rowId`. */
  get gear (): Uint8Array {
    return encodeGear(this.instance)
  }
}
