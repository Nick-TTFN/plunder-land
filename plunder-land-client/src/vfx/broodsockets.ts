import { Container } from 'pixi.js'
import { NpcSprite } from '../npcs/npcsprite'
import { BROODLING_RIG, CFG, sample } from '../npcs/broodling/rig'
import { RobotSprite } from '../robots/robotsprite'
import { emptySocket, pickSocket, socketScale, type Point } from './broodlaunch'

/**
 * The Broodlings sitting loaded in a Brood's sockets (Nick, 2026-10-09,
 * "loaded + launch"; the maths and the rules are `broodlaunch.ts`'s). One
 * per socket of the Brood's pose (`NpcPose.sockets`: the package's three
 * open facets, crown, left and right), each the real Broodling rig at its
 * own size, held curled (its `emerge` at `roles.spawn.from`, 1.3 s: legs
 * folded, out of the ground), with no shadows (`NpcSprite.pin`).
 *
 * A child of the Brood's `NpcSprite`, over its drawing, placed after every
 * frame the Brood draws (`onPosed`) on its sockets as drawn, so the
 * Broodlings move with its bob, walk, release heave and hit jolt. All are
 * hidden once it dies. Cosmetic: they are loaded at the start and refill
 * `SOCKET_REFILL_MS` after each launch, whatever the server's count.
 */
export class BroodSockets extends Container {
  /** When each socket is loaded again, `performance.now()` ms: -Infinity is loaded. */
  readonly loadedAt: number[] = []
  /**
   * CSS px from a socket's point down to its Broodling's ground point, so
   * that its curled body's middle sits on the socket.
   */
  readonly seatDrop: number
  private readonly seats: NpcSprite[] = []

  constructor (private readonly brood: NpcSprite) {
    super()
    this.eventMode = 'none'
    const from = BROODLING_RIG.roles.spawn?.from ?? 0
    this.seatDrop = -sample('emerge', from).body.y * CFG.renderScale * RobotSprite.SCALE * BROODLING_RIG.sizeScale
    brood.addChild(this)
    brood.onPosed = () => { this.follow() }
    this.follow()
  }

  /** Where socket `i`'s Broodling stands, CSS px in the Brood sprite's space, or undefined. */
  seat (i: number): Point | undefined {
    const p = this.brood.socketPoints[i]
    return p === undefined ? undefined : { x: p.x, y: p.y + this.seatDrop }
  }

  /**
   * Picks the socket a Broodling landing along `toward` (screen space, from
   * the Brood) leaves from (`pickSocket`) and empties it until
   * `SOCKET_REFILL_MS` after `launchAt`. -1 before the Brood is first drawn.
   */
  launch (toward: Point, now: number, launchAt: number): number {
    const i = pickSocket(this.brood.socketPoints, toward, this.loadedAt, now)
    if (i < 0) return -1
    emptySocket(this.loadedAt, i, launchAt)
    this.follow()
    return i
  }

  private follow (): void {
    if (this.destroyed) return
    const points = this.brood.socketPoints
    while (this.seats.length < points.length) {
      const seat = new NpcSprite(this, BROODLING_RIG, false)
      seat.pin(BROODLING_RIG.roles.spawn?.clip ?? BROODLING_RIG.roles.idle, BROODLING_RIG.roles.spawn?.from ?? 0)
      // Placed and scaled about its body's middle, the socket's point.
      seat.pivot.set(0, -this.seatDrop)
      this.addChild(seat)
      this.seats.push(seat)
      this.loadedAt.push(-Infinity)
    }
    const now = performance.now()
    const dying = this.brood.dying
    for (let i = 0; i < this.seats.length; i++) {
      const seat = this.seats[i]
      const scale = dying || i >= points.length ? 0 : socketScale(this.loadedAt, i, now)
      seat.visible = scale > 0
      if (scale <= 0) continue
      seat.position.set(points[i].x, points[i].y)
      seat.scale.set(scale)
    }
  }
}
