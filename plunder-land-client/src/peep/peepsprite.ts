import { Assets, Container, Graphics, Matrix, Sprite, Texture, Ticker, type DisplayObject } from 'pixi.js'
import {
  animationPose, blinkClosure, CLIPS, eyeMatrix, regionMatrix, REGIONS,
  type ClipName, type Matrix as RigMatrix, type Pose
} from './rig'

/** A clip played over the idle/run loop, then gone (fall_apart holds). */
interface Action {
  name: ClipName
  t: number
  /** Undefined follows `setAim`. */
  aim: number | undefined
  /** Faces this way while it plays; undefined keeps the movement's facing. */
  facing: 1 | -1 | undefined
}

/**
 * Peep, drawn from the v15 rig (`rig.ts`) instead of a frame sheet: one sprite
 * per painted part from `peep.json` (`tools/bake-peep-atlas.py`), placed every
 * frame from the pose's bone matrices. The clips and all their numbers are the
 * drop's; this only decides which clip plays, at what aim, and when to blink.
 *
 * - The idle/run loop follows movement (`setMoving`); `play` lays an action
 *   (shoot, swing, hit, fall_apart) over it. A new action replaces the one
 *   playing, except that the same clip asked for again early in its run is not
 *   restarted (`RETRIGGER_S`): a local press and the server's effect for it
 *   arrive a tick or so apart and are one swing. fall_apart is never replaced.
 * - Blinks run on their own clock, as the drop asks, whatever clip plays.
 * - Aim is -60 to +60 degrees off the facing, positive up (screen north):
 *   an action's own, else `setAim`'s (your own robot follows the mouse), else level.
 *
 * No visor mask: the drop clips the eye to the visor with a Canvas path, which
 * in pixi is a mask per unit that breaks batching. At this size the overflow
 * isn't visible (Nick, 2026-09-30).
 *
 * The ticker listener lives while `host` is in the scene: it attaches on the
 * host's `added` and releases on its `removed`, which both `Player.dispose`
 * and `Game.clear` end in.
 */
export class PeepSprite extends Container {
  /** CSS px from the feet to the top of the head in the reference pose. Nick, 2026-09-30: a third of the 128 first tried. */
  static readonly HEIGHT = 44
  /** That height in rig units (measured from the drop's reference pose). */
  static readonly REFERENCE_UNITS = 245.5
  static readonly SCALE = PeepSprite.HEIGHT / PeepSprite.REFERENCE_UNITS
  /** CSS px from the feet up to the gun arm's shoulder (rig y 79 at rest), where aim is measured from. */
  static readonly SHOULDER_PX = 79 * PeepSprite.SCALE

  /** See the class comment. Below every cooldown that plays one of these clips (0.75 s). */
  static readonly RETRIGGER_S = 0.6

  /** fall_apart is throttled to this step: each pose runs a physics loop from the detach. */
  static readonly DEBRIS_STEP_S = 1 / 30

  /** True once `peep.json` is loaded; `Player` falls back to the old sprite otherwise. */
  static ready (): boolean {
    return Assets.cache.has('peep/head.png')
  }

  private readonly rig = new Container()
  private readonly parts: Sprite[] = []
  private readonly shadow = new Graphics()
  private readonly flash = new Graphics()
  private readonly eyeTextures: { open: Texture, smile: Texture }

  private base: 'idle' | 'run' = 'idle'
  private baseTime = 0
  private action: Action | undefined
  private moveFacing: 1 | -1 = 1
  /** From `setAim`: the aim outside actions, and the facing it wants (undefined = movement's). */
  private lookAim = 0
  private lookFacing: 1 | -1 | undefined

  private sinceBlink = 0
  private nextBlink = PeepSprite.blinkGap()

  private lastDebrisT = -1
  private readonly scratch = new Matrix()
  private readonly tick = (): void => { this.update(Ticker.shared.deltaMS / 1000) }
  private ticking = false

  constructor (private readonly host: Container) {
    super()
    this.eyeTextures = { open: Texture.from('peep/eye_open.png'), smile: Texture.from('peep/eye_smile.png') }

    this.shadow.beginFill(0x000000).drawEllipse(0, -2, 70, 9).endFill()
    this.rig.addChild(this.shadow)
    for (const r of REGIONS) {
      const sprite = new Sprite(r.kind === 'eye' ? this.eyeTextures.open : Texture.from(`peep/${r.art}.png`))
      sprite.anchor.set(0.5)
      this.parts.push(sprite)
      this.rig.addChild(sprite)
    }
    this.rig.addChild(this.flash)
    this.addChild(this.rig)

    host.on('added', this.start, this)
    host.on('removed', this.stop, this)
    if (host.parent !== null) this.start()
    this.update(0)
  }

  /** Movement picks the loop under any action. */
  setMoving (moving: boolean): void {
    const next = moving ? 'run' : 'idle'
    if (next === this.base) return
    this.base = next
    this.baseTime = 0
  }

  setFacing (facing: 1 | -1): void {
    this.moveFacing = facing
  }

  /** Aim outside actions; undefined levels the gun and hands facing back to movement. */
  setAim (aim: number | undefined, facing?: 1 | -1): void {
    this.lookAim = aim ?? 0
    this.lookFacing = aim === undefined ? undefined : facing
  }

  /** The facing an aim currently holds, if any. */
  get aimFacing (): 1 | -1 | undefined {
    return this.lookFacing
  }

  /** `aim` undefined keeps whatever `setAim` holds, e.g. a melee press at the mouse. */
  play (name: ClipName, aim?: number, facing?: 1 | -1): void {
    const current = this.action
    if (current?.name === 'fall_apart') return
    if (current !== undefined && current.name === name && current.t < PeepSprite.RETRIGGER_S) {
      if (aim !== undefined) current.aim = aim
      if (facing !== undefined) current.facing = facing
      return
    }
    this.action = { name, t: 0, aim, facing }
    this.lastDebrisT = -1
  }

  get dying (): boolean {
    return this.action?.name === 'fall_apart'
  }

  start (): void {
    if (this.ticking) return
    this.ticking = true
    Ticker.shared.add(this.tick)
  }

  stop (): void {
    if (!this.ticking) return
    this.ticking = false
    Ticker.shared.remove(this.tick)
  }

  destroy (): void {
    this.stop()
    this.host.off('added', this.start, this)
    this.host.off('removed', this.stop, this)
    super.destroy({ children: true })
  }

  private static blinkGap (): number {
    return 2.5 + Math.random() * 3.5
  }

  /** Whether anything above would draw this: fogged, hidden or off its plane costs no pose. */
  private shown (): boolean {
    if (!this.visible || !this.renderable) return false
    let o: DisplayObject | null = this.parent
    while (o !== null) {
      if (!o.visible || !o.renderable) return false
      o = o.parent
    }
    return true
  }

  update (dt: number): void {
    this.baseTime += dt
    this.sinceBlink += dt
    if (this.sinceBlink > this.nextBlink + 0.16) {
      this.sinceBlink = 0
      this.nextBlink = PeepSprite.blinkGap()
    }
    const action = this.action
    if (action !== undefined) {
      action.t += dt
      if (action.name !== 'fall_apart' && action.t >= CLIPS[action.name].duration) this.action = undefined
    }
    if (dt > 0 && !this.shown()) return

    const playing = this.action
    const name = playing?.name ?? this.base
    const t = playing?.t ?? this.baseTime
    if (name === 'fall_apart') {
      const clamped = Math.min(t, CLIPS.fall_apart.duration)
      if (this.lastDebrisT >= 0 && clamped - this.lastDebrisT < PeepSprite.DEBRIS_STEP_S &&
        clamped < CLIPS.fall_apart.duration) return
      if (clamped === this.lastDebrisT) return
      this.lastDebrisT = clamped
    }

    const facing = playing?.facing ?? this.lookFacing ?? this.moveFacing
    this.rig.scale.set(PeepSprite.SCALE * facing, -PeepSprite.SCALE)
    const pose = animationPose(name, t, {
      aimAngle: playing?.aim ?? this.lookAim,
      blink: blinkClosure(this.sinceBlink - this.nextBlink)
    })
    this.apply(pose)
  }

  private apply (pose: Pose): void {
    const { state, matrices } = pose
    const info = state.animation
    REGIONS.forEach((r, i) => {
      const sprite = this.parts[i]
      let m: RigMatrix
      let w: number
      let h: number
      if (r.kind === 'eye') {
        const texture = state.eye.expression === 'smile' ? this.eyeTextures.smile : this.eyeTextures.open
        if (sprite.texture !== texture) sprite.texture = texture
        m = eyeMatrix(matrices.head, state.eye)
        w = 144
        h = 198
        sprite.alpha = info.eyeOpacity
      } else {
        m = regionMatrix(matrices[r.bone], r)
        w = r.w
        h = r.h
      }
      // Fit the texture, whatever its resolution, to the region's box.
      const fx = w / sprite.texture.width
      const fy = h / sprite.texture.height
      this.scratch.set(m.a * fx, m.b * fx, m.c * fy, m.d * fy, m.x, m.y)
      sprite.transform.setFromMatrix(this.scratch)
    })

    // The drop's shadow: one under the feet that shrinks with a jump, one
    // per piece once it has come apart.
    if (info.detached) {
      this.shadow.clear()
      this.shadow.alpha = 0.28
      this.shadow.scale.set(1)
      this.shadow.beginFill(0x000000)
      for (const p of info.parts ?? []) this.shadow.drawEllipse(p.x, -1, p.id === 'head' ? 53 : p.id === 'torso' ? 29 : 16, 3)
      this.shadow.endFill()
    } else {
      const lift = Math.min(1, info.height / 48)
      this.shadow.alpha = 0.5 - 0.2 * lift
      this.shadow.scale.set(1 - 0.18 * info.height / 48)
    }

    this.flash.clear()
    if (info.flash > 0) this.drawFlash(matrices.muzzle, info.flash)
  }

  /** The drop's muzzle flash, drawn along the muzzle bone. */
  private drawFlash (m: RigMatrix, amount: number): void {
    this.scratch.set(m.a, m.b, m.c, m.d, m.x, m.y)
    this.flash.transform.setFromMatrix(this.scratch)
    this.flash.alpha = amount
    const length = 18 + 16 * amount
    const w = 3 + 5 * amount
    this.flash.beginFill(0xff9b18).drawPolygon([-1, 0, 8, w, 6, 2, length, 0, 7, -3, 9, -w]).endFill()
    this.flash.beginFill(0xfff5bd).drawPolygon([0, 0, 7, 3, length * 0.72, 0, 7, -3]).endFill()
  }
}
