import { type GameObject } from '../objects/gameobject'
import { type Unit } from '../objects/unit'
import { Vector } from '../utils/vector'

export default class Area extends Vector {
  target: GameObject
  tag: number
  damage: number
  continious: boolean

  constructor (target: GameObject) {
    super(target.position.x, target.position.y)
    this.target = target
    this.tag = target.tag
  }

  /**
   * True if the area covers `value`. With `unit` (the unit standing at
   * `value`), a body (`Unit.bodyRings`, ring-footprint) counts if the area
   * covers any of its cells.
   */
  overlaps (value: Vector, unit?: Unit): boolean {
    throw new Error('Use of base class not permitted!')
  }

  setEffect (value: number, continious: boolean) {
    this.damage = value // todo might be not only damage
    this.continious = continious // todo might be not only damage
  }

  getEffect (dt: number) {
    return this.continious ? this.damage * dt : this.damage
  }

  update (dt: number) {
    if (this.target) {
      this.x = this.target.position.x
      this.y = this.target.position.y
    }
  }
}
