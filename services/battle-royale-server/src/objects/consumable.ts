import { GameObject, ObjectType } from './gameobject'
import { Random } from '../utils/random'
import Multiplayer from '../network/multiplayer'

export default class Consumable extends GameObject {
  constructor (x: number, y: number, tag: number, radius = undefined, loot: number | undefined = undefined) {
    super(ObjectType.Consumable, x, y, radius || Random.RangeInt(15, 25), tag)
    // Loot is separate from radius so a big haul can drop without producing a
    // pickup the size of a building.
    this.loot = loot ?? this.radius

    Multiplayer.Instance.create(this)
  }
}
