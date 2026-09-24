import { type Unit } from '../objects/unit'
import { type Vector } from '../utils/vector'
import Area from './area'

export default class SectorArea extends Area {
  sqRadius: number
  angle: number
  /** The same object as `target`, typed as the Unit it always is. */
  private readonly caster: Unit

  constructor (target: Unit, radius: number, angle: number) {
    super(target)
    this.caster = target
    this.sqRadius = radius * radius
    this.angle = angle
  }

  overlaps (value: Vector) {
    const delta = value.sub(this)
    // `facing`, not `direction`: a stopped caster's direction is (0,0), whose
    // angle is 0, so a breath from a standstill always coned East, and a caster
    // who stopped mid-breath swung the cone East with them.
    return (
      delta.getSquareMagnitude() < this.sqRadius &&
			Math.abs(delta.getAngleTo(this.caster.facing.getAngle())) < this.angle
    )
  }
}
