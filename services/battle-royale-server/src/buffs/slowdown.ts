import { type GameObject } from '../objects/gameobject'
import Buff from './buff'

export default class Slowdown extends Buff {
  static Intencity = 2

  /**
   * The reduction actually applied, rather than a factor to undo. GuardPosition
   * assigns maxVelocity absolutely every two seconds, so a multiplicative
   * restore could multiply a value this buff never halved and leave the unit
   * permanently at double or a third of its intended speed.
   */
  private applied: number = 0

  constructor (target: GameObject, lifetime: number) {
    super(target, lifetime)
  }

  start () {
    const reduced = this.target.maxVelocity / Slowdown.Intencity
    this.applied = this.target.maxVelocity - reduced
    this.target.maxVelocity = reduced
  }

  stop () {
    this.target.maxVelocity += this.applied
    this.applied = 0
  }
}
