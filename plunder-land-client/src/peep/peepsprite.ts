import { Assets, BLEND_MODES, Container, Graphics, Matrix, Sprite, Texture, Ticker, type DisplayObject } from 'pixi.js'
import {
  animationPose, blinkClosure, CLIPS, eyeMatrix, regionMatrix, REGIONS,
  type ClipName, type Matrix as RigMatrix, type Pose
} from './rig'
import { colourById, DEFAULT_FINISH, type Finish, type FinishGroup, patternById, type PatternKey } from '../utils/finishes'

/** A finished part's paint group and layers, in draw order (`meta.finish` in peep.json). */
type FinishMeta = Record<string, { group: FinishGroup, layers: string[] }>

/** One drawn region: a sprite, or a finished part's stack of layers, fitted to the region's box. */
interface Part {
  node: Container
  /** The frame size every layer shares, which the box fit divides by. */
  w: number
  h: number
  group?: FinishGroup
  shade?: Sprite
  patterns?: Partial<Record<PatternKey, Sprite>>
}

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
 * frame from the pose's bone matrices. A part with a paint group (head, body,
 * limbs) is a stack of layers instead (robot-finishes, #41): its shading tinted
 * by the group's colour, the group's pattern at its opacity, the unpainted
 * details, and the highlights added on top (`setFinish`; the bake explains the
 * layers). The highlights' additive blend costs a batch break per part.
 * The clips and all their numbers are the drop's; this only decides which
 * clip plays, at what aim, and when to blink.
 *
 * - The idle/run loop follows movement (`setMoving`); `play` lays an action
 *   (shoot, swing, hit, fall_apart) over it. A new action replaces the one
 *   playing, except that the same clip asked for again early in its run is not
 *   restarted (`RETRIGGER_S`): a local press and the server's effect for it
 *   arrive a tick or so apart and are one swing. fall_apart is never replaced.
 * - Blinks run on their own clock, as the drop asks, whatever clip plays.
 * - `smile` shows the smiling eye for a while. As in the drop's preview, a
 *   change of expression is a blink with the eye swapped 0.06 s in, while the
 *   lid is shut, and blinks are automatic only while the eye is open.
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

  /** The run loop plays this much faster than the drop's clip at `STRIDE_SPEED` (Nick, 2026-09-30: 2x). */
  static readonly RUN_RATE = 2
  /**
   * The ground speed, u/s, at which the run loop plays at `RUN_RATE`: peep's
   * speed (server `ARCHETYPES.peep.speed`). Faster or slower movement plays it
   * in proportion (`setPace`), so a dash (2.5x) runs the legs 2.5x faster again.
   */
  static readonly STRIDE_SPEED = 140
  /** `setPace`'s range: a stall or a teleport's one-frame jump shouldn't spin or freeze the legs. */
  static readonly MIN_PACE = 0.5
  static readonly MAX_PACE = 3

  /** See the class comment. Below every cooldown that plays one of these clips (0.75 s). */
  static readonly RETRIGGER_S = 0.6

  /** How far into a blink an expression change swaps the eye (the drop's preview: 0.06 s, lid shut). */
  static readonly EXPRESSION_SWAP_S = 0.06

  /** fall_apart is throttled to this step: each pose runs a physics loop from the detach. */
  static readonly DEBRIS_STEP_S = 1 / 30

  /** True once `peep.json` is loaded; `Player` falls back to the old sprite otherwise. */
  static ready (): boolean {
    return Assets.cache.has('peep/eye_open.png')
  }

  /** The sheet's `meta.finish`; empty for a sheet from before finishes, whose parts are flat. */
  private static finishMeta (): FinishMeta {
    return Assets.cache.get('./res/peep.json')?.data?.meta?.finish ?? {}
  }

  private readonly rig = new Container()
  private readonly parts: Part[] = []
  private readonly shadow = new Graphics()
  private readonly flash = new Graphics()
  private readonly eyeTextures: { open: Texture, smile: Texture }

  private base: 'idle' | 'run' = 'idle'
  private baseTime = 0
  /** Ground speed over `STRIDE_SPEED`, from `setPace`. */
  private pace = 1
  private action: Action | undefined
  private moveFacing: 1 | -1 = 1
  /** From `setAim`: the aim outside actions, and the facing it wants (undefined = movement's). */
  private lookAim = 0
  private lookFacing: 1 | -1 | undefined

  /** The eye's clock, seconds; blinks and smiles are times on it. */
  private eyeClock = 0
  private blinkAt = -Infinity
  private nextBlinkAt = PeepSprite.blinkGap()
  private expression: 'open' | 'smile' = 'open'
  private pendingExpression: 'open' | 'smile' = 'open'
  private expressionAt = -Infinity
  private smileUntil = -Infinity

  private lastDebrisT = -1
  private readonly scratch = new Matrix()
  private readonly tick = (): void => { this.update(Ticker.shared.deltaMS / 1000) }
  private ticking = false

  constructor (private readonly host: Container) {
    super()
    this.eyeTextures = { open: Texture.from('peep/eye_open.png'), smile: Texture.from('peep/eye_smile.png') }

    this.shadow.beginFill(0x000000).drawEllipse(0, -2, 70, 9).endFill()
    this.rig.addChild(this.shadow)
    const finishes = PeepSprite.finishMeta()
    for (const r of REGIONS) {
      const finished = r.kind === 'eye' ? undefined : finishes[r.art]
      const part = finished !== undefined
        ? PeepSprite.layered(r.art, finished)
        : PeepSprite.flat(r.kind === 'eye' ? this.eyeTextures.open : Texture.from(`peep/${r.art}.png`))
      this.parts.push(part)
      this.rig.addChild(part.node)
    }
    this.rig.addChild(this.flash)
    this.setFinish(DEFAULT_FINISH)
    this.addChild(this.rig)

    host.on('added', this.start, this)
    host.on('removed', this.stop, this)
    if (host.parent !== null) this.start()
    this.update(0)
  }

  private static flat (texture: Texture): Part {
    const sprite = new Sprite(texture)
    sprite.anchor.set(0.5)
    return { node: sprite, w: texture.width, h: texture.height }
  }

  private static layered (art: string, meta: FinishMeta[string]): Part {
    const node = new Container()
    const part: Part = { node, w: 0, h: 0, group: meta.group, patterns: {} }
    for (const layer of meta.layers) {
      const sprite = new Sprite(Texture.from(`peep/${art}/${layer}.png`))
      sprite.anchor.set(0.5)
      // Every layer is baked at the part's size, trimmed; `width` is the untrimmed size.
      part.w = sprite.texture.width
      part.h = sprite.texture.height
      if (layer === 'shade') part.shade = sprite
      else if (layer === 'hi') sprite.blendMode = BLEND_MODES.ADD
      else if (layer !== 'fixed') {
        sprite.visible = false
        part.patterns![layer as PatternKey] = sprite
      }
      node.addChild(sprite)
    }
    return part
  }

  /**
   * Paints each group's parts: the shading tinted by its colour, and only its
   * pattern shown, at the pattern's opacity. A finish from `finishFromBytes`
   * only holds ids this build knows; anything else draws uncoloured and plain.
   */
  setFinish (finish: Finish): void {
    for (const part of this.parts) {
      if (part.group === undefined) continue
      const { colour, pattern } = finish[part.group]
      const rgb = colourById(colour)?.rgb ?? [255, 255, 255]
      if (part.shade !== undefined) part.shade.tint = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
      const info = patternById(pattern)
      for (const key in part.patterns) {
        const sprite = part.patterns[key as PatternKey]!
        sprite.visible = key === info?.key
        sprite.alpha = info?.opacity ?? 0
      }
    }
  }

  /** Movement picks the loop under any action. */
  setMoving (moving: boolean): void {
    const next = moving ? 'run' : 'idle'
    if (next === this.base) return
    this.base = next
    this.baseTime = 0
  }

  /** Ground speed as a multiple of `STRIDE_SPEED`; scales the run loop only. */
  setPace (pace: number): void {
    this.pace = Math.min(PeepSprite.MAX_PACE, Math.max(PeepSprite.MIN_PACE, pace))
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

  /**
   * The smiling eye for `seconds` from now. Asked again while smiling, it
   * lasts to the later end, without another blink.
   */
  smile (seconds: number): void {
    const until = this.eyeClock + seconds
    if (this.pendingExpression !== 'smile') this.changeExpression('smile')
    this.smileUntil = Math.max(this.smileUntil, until)
  }

  /** The drop's switch: blink now, swap the eye once the lid has shut. */
  private changeExpression (to: 'open' | 'smile'): void {
    this.pendingExpression = to
    this.expressionAt = this.eyeClock
    this.blinkAt = this.eyeClock
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
    // Moving against the way it faces (your own robot aiming behind itself),
    // the run loop plays backwards (Nick, 2026-09-30). `clipTime` wraps it.
    const facingNow = this.action?.facing ?? this.lookFacing ?? this.moveFacing
    const backwards = facingNow !== this.moveFacing ? -1 : 1
    this.baseTime += this.base === 'run' ? dt * PeepSprite.RUN_RATE * this.pace * backwards : dt
    this.eyeClock += dt
    const now = this.eyeClock
    if (this.pendingExpression === 'smile' && now >= this.smileUntil) {
      this.changeExpression('open')
      this.nextBlinkAt = Math.max(this.nextBlinkAt, now + PeepSprite.blinkGap())
    }
    if (now - this.expressionAt >= PeepSprite.EXPRESSION_SWAP_S) this.expression = this.pendingExpression
    if (this.expression === 'open' && this.pendingExpression === 'open' && now >= this.nextBlinkAt) {
      this.blinkAt = now
      this.nextBlinkAt = now + PeepSprite.blinkGap()
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
      blink: blinkClosure(this.eyeClock - this.blinkAt),
      expression: this.expression
    })
    this.apply(pose)
  }

  private apply (pose: Pose): void {
    const { state, matrices } = pose
    const info = state.animation
    REGIONS.forEach((r, i) => {
      const part = this.parts[i]
      let m: RigMatrix
      let w: number
      let h: number
      if (r.kind === 'eye') {
        const sprite = part.node as Sprite
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
      const fx = w / part.w
      const fy = h / part.h
      this.scratch.set(m.a * fx, m.b * fx, m.c * fy, m.d * fy, m.x, m.y)
      part.node.transform.setFromMatrix(this.scratch)
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
