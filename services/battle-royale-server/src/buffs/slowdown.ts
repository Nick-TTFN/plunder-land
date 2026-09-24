import { type GameObject } from '../objects/gameobject'
import Buff from './buff'

export default class Slowdown extends Buff {
  static Intencity = 2

  /**
   * The reduction actually applied, rather than a factor to undo. GuardPosition
   * assigns maxVelocity absolutely every two seconds, so a multiplicative
   * restore could multiply a value this buff never halved and leave the unit
   * permanently at double or a third of its intended speed.
   *
   * `declare`, so it compiles to nothing. `Buff`'s constructor calls `start()`,
   * which sets this, and only then do a subclass's own fields get defined:
   * `= 0` (and, under define semantics, even a bare `applied: number`) reset it
   * afterwards, so `stop()` restored nothing and every slowed unit stayed at
   * half speed for good.
   */
  private declare applied: number

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
