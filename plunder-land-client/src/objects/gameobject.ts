import { Container, Sprite, Point, ColorMatrixFilter, Graphics, type Texture, type RenderTexture, SCALE_MODES } from 'pixi.js'
import TWEEN from '@tweenjs/tween.js'
import { type Vector } from '../utils/vector'
import { type AnimationStates } from '../animation/animationstates'
import { Game } from '../game'
import { layShadow } from './shadow'

export class GameObject extends Container {
  DEBUG_COLLIDER: Graphics
  radius: number = 10
  killed: boolean = false
  _lastUpdate: number = -1
  tag: number | undefined
  main: Sprite | undefined

  direction: Vector | undefined
  animation: AnimationStates | undefined
  timeSinceUpdate: number = 0

  constructor () {
    super()
    this.DEBUG_COLLIDER = new Graphics()
    this.DEBUG_COLLIDER.alpha = 0.3

    this.addChild(this.DEBUG_COLLIDER)
  }

  /**
   * Off. It draws a magenta disc the size of the collider under every unit,
   * pickup and portal in the world, and the `// return` that used to switch it
   * off had been commented out, so the shipping game had one under everything.
   * Kept as a flag rather than deleted - it is the only way to see where the
   * server thinks a thing is, and the push-out work needs it.
   */
  static DEBUG_COLLIDERS = false

  DEBUG_DRAW_COLLIDER (): void {
    this.DEBUG_COLLIDER.clear()
    if (!GameObject.DEBUG_COLLIDERS) return
    if (this.radius !== undefined) {
      this.DEBUG_COLLIDER.beginFill(0xff00ff)
        .drawCircle(0, 0, this.radius)
        .endFill()
    }
  }

  static SHADOW_CACHE: Record<string, RenderTexture> = {}

  createShadow (texture: Texture): Sprite {
    const cacheId = `${texture.baseTexture.uid}@${texture.frame.x}:${texture.frame.y}`
    let renderTexture = GameObject.SHADOW_CACHE[cacheId]
    if (renderTexture === undefined) {
      const sprite = new Sprite(texture)
      const colorMatrix = new ColorMatrixFilter()
      sprite.filters = [colorMatrix]
      colorMatrix.desaturate()
      colorMatrix.brightness(0, true)
      sprite.alpha = 0.3
      // pixi v7: generateTexture already renders into the texture it returns.
      // The old v6-style positional args meant the scale mode was dropped and
      // the follow-up render() drew the shadow to the screen instead.
      renderTexture = Game.RENDERER.generateTexture(sprite, {
        scaleMode: SCALE_MODES.NEAREST,
        resolution: 1
      })
      GameObject.SHADOW_CACHE[cacheId] = renderTexture
    }
    const shadowSprite = new Sprite(renderTexture)
    shadowSprite.anchor = new Point(0.5, 1)
    layShadow(shadowSprite)
    return shadowSprite
  }

  update (dt: number): void {
    const global = this.toGlobal(new Point(0, 0))
    this.visible = global.x > 0 && global.x < window.innerWidth && global.y > 0 && global.y < window.innerHeight
    this.zIndex = this.position.y
  }

  /**
   * Named `dispose`, not `destroy`: this is our own teardown and it used to
   * override PIXI's `destroy()` with an incompatible signature, so PIXI's own
   * cleanup could never run and any caller expecting PIXI semantics got ours.
   * We still do not call `super.destroy()` - effects hold a reference to their
   * target for up to a second after it dies, and freeing the container under
   * them throws. Dropping every reference is what actually lets it be collected.
   */
  dispose (): void {
    new TWEEN.Tween(this.scale)
      .to({ x: 0, y: 0 }, 200)
      .onComplete(() => {
        this.parent?.removeChild(this)
      })
      .start()

    this.killed = true
  }
}
