import { Container, Transform, type DisplayObject } from 'pixi.js'
import { Hex } from '../utils/hex'

/** A row of the untilted lattice, in world units. */
const ROW = Hex.SIZE * Math.sqrt(3) / 2

/**
 * A row of the tilted lattice on screen: about 0.75 of `ROW`, **rounded to a
 * whole pixel** (29). The ground's pads are laid at multiples of it; a
 * fractional pitch put every row on a different fraction of a pixel, so seams
 * came out 29 and 30 pixels apart and the ground looked wobbly.
 */
export const ROW_SCREEN = Math.round(ROW * 0.75)

/**
 * How much the ground is squashed vertically: the camera is tilted back from
 * straight down, as in the mockup (tile art pass, 2026-09-27). Drawing only.
 * Every rule, the wire and the server stay on the regular top-down grid; a
 * world `y` is drawn at `y * TILT`. About 0.744.
 *
 * `tools/bake-ground-atlas.py` derives the same value and bakes the pads at it
 * (written to `ground.json` as `meta.tilt`); change the two together.
 */
export const TILT = ROW_SCREEN / ROW

/**
 * The camera applies `TILT` as a y scale (`Game.CONTAINER`), so anything drawn
 * *on* the ground - terrain cells, the route, threat and effect cells, beams -
 * is squashed with it for free. Anything standing *up* - units, props,
 * pickups, explosions, floating text - must not be: its position squashes,
 * its shape does not.
 *
 * That is this transform: the local matrix gets the inverse squash after the
 * position, `T(position) * S^-1 * (rotation, skew, scale, pivot)`, so an
 * upright object's own `scale`, and every tween already running on it, keep
 * meaning what they always did.
 */
export class UprightTransform extends Transform {
  updateTransform (parentTransform: Transform): void {
    if (this._localID !== this._currentLocalID) {
      this.updateLocalTransform()
      const lt = this.localTransform
      // Only the shape is unsquashed. The pivot's offset is part of the shape.
      lt.ty = this.position.y - (this.position.y - lt.ty) / TILT
      lt.b /= TILT
      lt.d /= TILT
    }
    // The local matrix is now current, so this only composes it with the
    // parent's.
    super.updateTransform(parentTransform)
  }

  /**
   * An upright transform in place of `old`, keeping its position, scale,
   * pivot, skew and rotation. The points themselves move across, not copies,
   * because tweens hold on to them: `new TWEEN.Tween(sprite.scale)` before the
   * sprite is added must still drive it after.
   */
  static from (old: Transform): UprightTransform {
    const next = new UprightTransform()
    for (const key of ['position', 'scale', 'pivot'] as const) {
      const point = old[key]
      point.cb = next.onChange
      point.scope = next
      next[key] = point
    }
    old.skew.cb = next.updateSkew
    old.skew.scope = next
    next.skew = old.skew
    next.rotation = old.rotation
    next.onChange()
    next.updateSkew()
    return next
  }
}

const GROUND = new WeakSet<DisplayObject>()

/** Mark something as lying on the ground: a `TiltedContainer` leaves it squashed. */
export function onGround<T extends DisplayObject> (object: T): T {
  GROUND.add(object)
  return object
}

/** Give an object the upright transform (`UprightTransform.from`). */
function standUp (object: DisplayObject): void {
  if (object.transform instanceof UprightTransform) return
  object.transform = UprightTransform.from(object.transform)
}

/**
 * A container inside the tilted camera. Every child it is given stands up
 * (`UprightTransform`) unless it was marked `onGround`. Used for the camera
 * itself and for each plane, which are the only two places things are added
 * directly into squashed space: a child of an upright object is upright
 * already.
 */
export class TiltedContainer extends Container {
  addChild<U extends DisplayObject[]>(...children: U): U[0] {
    for (const child of children) if (!GROUND.has(child)) standUp(child)
    return super.addChild(...children)
  }

  addChildAt<U extends DisplayObject>(child: U, index: number): U {
    if (!GROUND.has(child)) standUp(child)
    return super.addChildAt(child, index)
  }
}
