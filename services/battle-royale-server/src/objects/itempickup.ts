import { GameObject, ObjectType } from './gameobject'
import Multiplayer from '../network/multiplayer'
import { type Item } from '../archetypes/archetypes'

/**
 * A usable item lying on the ground: a medkit or a bomb (decision #12).
 *
 * Not a `Consumable`, on purpose. Loot is a number and items are not loot
 * (#12): a consumable is banked on touch, counts toward a layer's natural loot
 * cap and draws as a resource crystal, and none of that is true of an item. It
 * has its own list (`World.ITEMS`), its own type (`ObjectType.Item`) and its
 * own field, `item`, naming its kind.
 */
export default class ItemPickup extends GameObject {
  /** Centre to centre with a peep's body (14) that is 34, the reach of a mid-sized loot pickup. */
  static RADIUS = 20

  readonly kind: Item

  /**
   * Wall-clock deadline, or 0 for a natural pickup that never expires. Only
   * what a dead player drops gets one, for the reason `Consumable.expiresAt`
   * gives: the spawner is bounded by a count and drops are not.
   */
  expiresAt: number = 0

  constructor (x: number, y: number, tag: number, kind: Item, lifetime: number = 0) {
    super(ObjectType.Item, x, y, ItemPickup.RADIUS, tag)
    this.kind = kind

    if (lifetime > 0) {
      this.expiresAt = Date.now() + lifetime
      this.lifetime = lifetime // drives the countdown ring on the client
    }

    // Snapshot sets only: a pickup's kind never changes, so it is never dirty.
    this.allFields.add('item')
    this.allFieldsOwn.add('item')

    Multiplayer.Instance.create(this)
  }

  /** The `item` wire field: the kind's `utils/items.ts` id. */
  get item (): number {
    return this.kind.id
  }
}
