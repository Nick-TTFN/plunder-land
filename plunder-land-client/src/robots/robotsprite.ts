import { AlphaFilter, Assets, BLEND_MODES, Container, Graphics, LINE_CAP, LINE_JOIN, Matrix, Point, Sprite, Texture, Ticker, type DisplayObject } from 'pixi.js'
import {
  blinkClosure, multiply, regionMatrix,
  type ClipName, type EyeBone, type Matrix as RigMatrix, type Pose
} from '../peep/rig'
import { type LoopClip, type RobotRig, PEEP_RIG } from './robotrig'
import { chargedEyeMarks, SHOT, type ShotEye } from './eyeshot'
import { SPRING_STROKES, springPoints } from '../hopper/rig'
import { layShadow } from '../objects/shadow'
import { colourById, DEFAULT_FINISH, type Finish, type FinishGroup, patternById, type PatternKey } from '../utils/finishes'

/**
 * A finished part's paint group and layers, in draw order (`meta.finish` in
 * the robot's sheet). A part painted in several groups (Hopper's head,
 * Waddle's shell) is 'mixed', and its shade and pattern layers name their
 * group: `head-shade`, `body-zebra`.
 */
type FinishMeta = Record<string, { group: FinishGroup | 'mixed', layers: string[] }>

/** One group's paint on a finished part: its shade, tinted by the group's colour, and its patterns. */
interface PaintStack {
  group: FinishGroup
  shade?: Sprite
  patterns: Partial<Record<PatternKey, Sprite>>
}

/** One drawn region: a sprite, or a finished part's stack of layers, fitted to the region's box. */
interface Part {
  node: Container
  /** The frame size every layer shares, which the box fit divides by. */
  w: number
  h: number
  /** A finished part's paint, one stack per group it is painted in; undefined for a flat part. */
  paint?: PaintStack[]
  /** Its silhouette in the cast shadow, placed with it; none for the eye, which sits inside the head. */
  cast?: Container
}

/** A clip played over the idle/run loop, then gone (fall_apart holds); or an eye shot laid over the run. */
interface Action {
  name: ClipName
  t: number
  /** Undefined follows `setAim`. */
  aim: number | undefined
  /** Faces this way while it plays; undefined keeps the movement's facing. */
  facing: 1 | -1 | undefined
}

/**
 * A rigged robot, drawn from its rig (`RobotRig`, `src/robots/robotrig.ts`:
 * Peep, Magnet, Periscope, Hopper and Waddle, each `src/<robot>/rig.ts`) instead of a frame sheet: one sprite per
 * painted part from its sheet (`<sheet>.json`, `tools/bake-peep-atlas.py`),
 * placed every frame from the pose's bone matrices. Every robot is drawn at
 * Peep's pixels per rig unit (`SCALE`), so they keep their sizes relative to
 * each other; it was `PeepSprite` until Magnet (magnet-rig, #42).
 * A part with a paint group (head, body, limbs) is a stack of layers instead (robot-finishes, #41): its shading tinted
 * by the group's colour, the group's pattern at its opacity, the unpainted
 * details, and the highlights added on top (`setFinish`; the bake explains the
 * layers). The highlights' additive blend costs a batch break per part.
 * The clips and all their numbers are the drop's; this only decides which
 * clip plays, at what aim, and when to blink.
 *
 * - The idle/run loop follows movement (`setMoving`); `play` lays an action
 *   (shoot, swing, hit, fall_apart) over it, except that a shot while running
 *   is the eye shot laid over the run (the drop's `eyeShootTime`), not the
 *   standing shoot clip. The shot fires `SHOT.fire` after it starts, from the
 *   eye: two rings close in, then a bright dot (`chargedEyeMarks`). A new action replaces the one
 *   playing, except that the same clip asked for again early in its run is not
 *   restarted (`RETRIGGER_S`): a local press and the server's effect for it
 *   arrive a tick or so apart and are one swing. fall_apart is never replaced.
 * - Blinks run on their own clock, as the drop asks, whatever clip plays.
 * - `smile` shows the smiling eye for a while. As in the drop's preview, a
 *   change of expression is a blink with the eye swapped 0.06 s in, while the
 *   lid is shut, and blinks are automatic only while the eye is open.
 * - Aim is -60 to +60 degrees off the facing, positive up (screen north):
 *   an action's own, else `setAim`'s (your own robot follows the mouse), else
 *   level. Since the eye-firing drops it turns the head and eye, not an arm.
 *
 * No visor mask: the drop clips the eye to the visor with a Canvas path, which
 * in pixi is a mask per unit that breaks batching. At this size the overflow
 * isn't visible (Nick, 2026-09-30).
 *
 * The ticker listener lives while `host` is in the scene: it attaches on the
 * host's `added` and releases on its `removed`, which both `Player.dispose`
 * and `Game.clear` end in.
 */
export class RobotSprite extends Container {
  /**
   * The base size: CSS px from the feet to the top of Peep's head in the
   * reference pose at `drawScale` 1, in game; every robot's size follows it
   * (Peep itself is drawn at 0.9 of it, so 48 px). Nick: 44 on 2026-09-30 (a third
   * of the 128 first tried), then 20% bigger on 2026-10-01. The bake reads the
   * same number (`DISPLAY_HEIGHT` in `bake-peep-atlas.py`): change both.
   */
  static readonly PEEP_HEIGHT = 53
  /** CSS px per rig unit, for every robot: Peep's height over Peep's reference pose. */
  static readonly SCALE = RobotSprite.PEEP_HEIGHT / PEEP_RIG.referenceUnits

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

  /** The cast shadow's opacity, as the frame-sheet units' (`Unit`). */
  static readonly CAST_ALPHA = 0.3

  /** fall_apart is throttled to this step: each pose runs a physics loop from the detach. */
  static readonly DEBRIS_STEP_S = 1 / 30

  /**
   * The frames to draw with: the game sheet, or with `lobby` the lobby's
   * 2.75x sheet (`<sheet>-lobby.json`, `bake-peep-atlas.py --lobby`), for
   * robots drawn several times their in-game size. Same parts and layers, more
   * texels; the fit to each region's box doesn't care which.
   */
  static sheetFor (rig: RobotRig, lobby = false): string {
    return lobby ? `${rig.sheet}-lobby` : rig.sheet
  }

  /** True once that sheet is loaded; `Player` falls back to the old sprite otherwise. */
  static ready (rig: RobotRig = PEEP_RIG, lobby = false): boolean {
    return Assets.cache.has(`${RobotSprite.sheetFor(rig, lobby)}/eye_open.png`)
  }

  /** The sheet's `meta.finish`; empty for a sheet from before finishes, whose parts are flat. */
  private static finishMeta (sheet: string): FinishMeta {
    return Assets.cache.get(`./res/${sheet}.json`)?.data?.meta?.finish ?? {}
  }

  /**
   * CSS px from the feet to the top of the head in the reference pose. Not
   * `height`: that is pixi's accessor for the drawn bounds.
   */
  readonly standHeight: number
  /** CSS px from the feet up to the eye's shot origin (`eye_muzzle`) in the reference pose, where aim is measured from. */
  readonly aimPx: number
  /** CSS px per rig unit for this robot: `SCALE` times its `drawScale`. */
  private readonly pxPerUnit: number

  private readonly rig = new Container()
  /** The shot's origin (`eye_muzzle`) in the last pose drawn, rig units. */
  private readonly eye = new Point()
  private readonly parts: Part[] = []
  private readonly shadow = new Graphics()
  /**
   * The cast shadow (in game only): every part again, in black, in its own
   * copy of the rig's space, laid on the ground by `layShadow` like every
   * other cast shadow. One `AlphaFilter` over the lot, not alpha per part, or
   * the overlaps would come out darker. A filter is a render pass per robot on
   * screen.
   */
  private readonly cast: Container | undefined
  private readonly castRig = new Container()
  /** The eye shot's rings and dot, over everything (`drawShot`). */
  private readonly shotMarks = new Graphics()
  /** Hopper's coil, by region index: the drop strokes it rather than drawing art. */
  private readonly springs = new Map<number, { graphics: Graphics, cast?: Graphics, length: number }>()
  private readonly eyeTextures: { open: Texture, smile: Texture }

  private base: 'idle' | 'run' = 'idle'
  private baseTime = 0
  /** Ground speed over `STRIDE_SPEED`, from `setPace`. */
  private pace = 1
  private action: Action | undefined
  /** An eye shot over the run loop: a shot asked for while running. */
  private shot: Action | undefined
  private moveFacing: 1 | -1 = 1
  /** From `setAim`: the aim outside actions, and the facing it wants (undefined = movement's). */
  private lookAim = 0
  private lookFacing: 1 | -1 | undefined

  /** The eye's clock, seconds; blinks and smiles are times on it. */
  private eyeClock = 0
  private blinkAt = -Infinity
  private nextBlinkAt = RobotSprite.blinkGap()
  private expression: 'open' | 'smile' = 'open'
  private pendingExpression: 'open' | 'smile' = 'open'
  private expressionAt = -Infinity
  private smileUntil = -Infinity

  private lastDebrisT = -1
  private readonly scratch = new Matrix()
  private readonly tick = (): void => { this.update(Ticker.shared.deltaMS / 1000) }
  private ticking = false

  /** `castShadow` adds the silhouette shadow `Player` wants; the lobby stands robots on its platform without one. */
  constructor (private readonly host: Container, private readonly character: RobotRig = PEEP_RIG, lobby = false, castShadow = false) {
    super()
    this.pxPerUnit = RobotSprite.SCALE * character.drawScale
    this.standHeight = character.referenceUnits * this.pxPerUnit
    this.aimPx = character.animationPose('reference', 0, {}).matrices.eye_muzzle.y * this.pxPerUnit
    const sheet = RobotSprite.sheetFor(character, lobby)
    this.eyeTextures = { open: Texture.from(`${sheet}/eye_open.png`), smile: Texture.from(`${sheet}/eye_smile.png`) }

    const shadow = character.shadow
    this.shadow.beginFill(0x000000).drawEllipse(shadow.x, -2, shadow.rx, shadow.ry).endFill()
    this.rig.addChild(this.shadow)
    const finishes = RobotSprite.finishMeta(sheet)
    character.regions.forEach((r, i) => {
      if (r.kind === 'spring') {
        // Stroked, not drawn from the sheet; its shadow is the same coil in black.
        const graphics = new Graphics()
        const spring = { graphics, cast: castShadow ? new Graphics() : undefined, length: -1 }
        this.springs.set(i, spring)
        this.parts.push({ node: graphics, w: 1, h: 1, cast: spring.cast })
        this.rig.addChild(graphics)
        if (spring.cast !== undefined) this.castRig.addChild(spring.cast)
        return
      }
      const finished = r.kind === 'eye' ? undefined : finishes[r.art]
      const part = finished !== undefined
        ? RobotSprite.layered(sheet, r.art, finished)
        : RobotSprite.flat(r.kind === 'eye' ? this.eyeTextures.open : Texture.from(`${sheet}/${r.art}.png`))
      this.parts.push(part)
      this.rig.addChild(part.node)
      if (castShadow && r.kind !== 'eye') {
        part.cast = RobotSprite.silhouette(part)
        this.castRig.addChild(part.cast)
      }
    })
    this.rig.addChild(this.shotMarks)
    this.setFinish(DEFAULT_FINISH)
    if (castShadow) {
      this.cast = new Container()
      this.cast.filters = [new AlphaFilter(RobotSprite.CAST_ALPHA)]
      layShadow(this.cast)
      this.cast.addChild(this.castRig)
      this.addChild(this.cast)
    }
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

  /**
   * A part's outline in black: the flat sprite, or a finished part's shading
   * and unpainted details (patterns and highlights lie inside those).
   */
  private static silhouette (part: Part): Container {
    const node = new Container()
    const layers = part.paint === undefined ? [part.node as Sprite] : part.node.children as Sprite[]
    const patterns = (part.paint ?? []).flatMap((stack) => Object.values(stack.patterns))
    for (const layer of layers) {
      if (layer.blendMode === BLEND_MODES.ADD || patterns.includes(layer)) continue
      const sprite = new Sprite(layer.texture)
      sprite.anchor.set(0.5)
      sprite.tint = 0x000000
      node.addChild(sprite)
    }
    return node
  }

  private static layered (sheet: string, art: string, meta: FinishMeta[string]): Part {
    const node = new Container()
    const part: Part = { node, w: 0, h: 0, paint: [] }
    const stackOf = (group: FinishGroup): PaintStack => {
      let stack = part.paint!.find((p) => p.group === group)
      if (stack === undefined) {
        stack = { group, patterns: {} }
        part.paint!.push(stack)
      }
      return stack
    }
    for (const layer of meta.layers) {
      const sprite = new Sprite(Texture.from(`${sheet}/${art}/${layer}.png`))
      sprite.anchor.set(0.5)
      // Every layer is baked at the part's size, trimmed; `width` is the untrimmed size.
      part.w = sprite.texture.width
      part.h = sprite.texture.height
      const dash = layer.lastIndexOf('-')
      const kind = dash < 0 ? layer : layer.slice(dash + 1)
      const group = (dash < 0 ? meta.group : layer.slice(0, dash)) as FinishGroup
      if (kind === 'shade') stackOf(group).shade = sprite
      else if (kind === 'hi') sprite.blendMode = BLEND_MODES.ADD
      else if (kind !== 'fixed') {
        sprite.visible = false
        stackOf(group).patterns[kind as PatternKey] = sprite
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
    for (const stack of this.parts.flatMap((part) => part.paint ?? [])) {
      const { colour, pattern } = finish[stack.group]
      const rgb = colourById(colour)?.rgb ?? [255, 255, 255]
      if (stack.shade !== undefined) stack.shade.tint = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
      const info = patternById(pattern)
      for (const key in stack.patterns) {
        const sprite = stack.patterns[key as PatternKey]!
        sprite.visible = key === info?.key
        sprite.alpha = info?.opacity ?? 0
      }
    }
  }

  /** Movement picks the loop under any action. */
  setMoving (moving: boolean): void {
    const next = moving ? 'run' : 'idle'
    if (next === this.base) return
    // The same loop under both (Hopper's hop) carries on rather than restart mid-air.
    if (this.character.loops?.[next] === undefined || this.character.loops[next] !== this.character.loops[this.base]) this.baseTime = 0
    this.base = next
  }

  /** The clip a movement loop plays (`RobotRig.loops`). */
  private loopClip (base: 'idle' | 'run'): ClipName {
    return this.character.loops?.[base]?.clip ?? base
  }

  /** A loop made of another clip: `seconds` into the loop as that clip's time, wrapped. */
  private loopTime (loop: LoopClip, seconds: number): number {
    const segments = loop.segments ?? [[0, this.character.clips[loop.clip].duration] as const]
    const total = segments.reduce((sum, [a, b]) => sum + b - a, 0)
    let u = ((seconds % total) + total) % total
    for (const [a, b] of segments) {
      if (u < b - a) return a + u
      u -= b - a
    }
    return segments[segments.length - 1][1]
  }

  /** Ground speed as a multiple of `STRIDE_SPEED`; scales the run loop only. */
  setPace (pace: number): void {
    this.pace = Math.min(this.character.maxPace ?? RobotSprite.MAX_PACE, Math.max(RobotSprite.MIN_PACE, pace))
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
    // Over a loop that moves (running, or Hopper's hop) the shot is the eye's alone.
    if (name === 'shoot' && this.loopClip(this.base) !== 'idle' && current === undefined) {
      // A press and the server's effect for it: one shot, as for an action below.
      if (this.shot !== undefined && this.shot.t < RobotSprite.RETRIGGER_S) {
        if (aim !== undefined) this.shot.aim = aim
        if (facing !== undefined) this.shot.facing = facing
        return
      }
      this.shot = { name, t: 0, aim, facing }
      return
    }
    if (name === 'shoot') this.shot = undefined
    if (current !== undefined && current.name === name && current.t < RobotSprite.RETRIGGER_S) {
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
    const facingNow = this.action?.facing ?? this.shot?.facing ?? this.lookFacing ?? this.moveFacing
    const backwards = facingNow !== this.moveFacing ? -1 : 1
    this.baseTime += this.base === 'run' ? dt * RobotSprite.RUN_RATE * (this.character.runRate ?? 1) * this.pace * backwards : dt
    this.eyeClock += dt
    const now = this.eyeClock
    if (this.pendingExpression === 'smile' && now >= this.smileUntil) {
      this.changeExpression('open')
      this.nextBlinkAt = Math.max(this.nextBlinkAt, now + RobotSprite.blinkGap())
    }
    if (now - this.expressionAt >= RobotSprite.EXPRESSION_SWAP_S) this.expression = this.pendingExpression
    if (this.expression === 'open' && this.pendingExpression === 'open' && now >= this.nextBlinkAt) {
      this.blinkAt = now
      this.nextBlinkAt = now + RobotSprite.blinkGap()
    }
    const action = this.action
    if (action !== undefined) {
      action.t += dt
      if (action.name !== 'fall_apart' && action.t >= this.character.clips[action.name].duration) this.action = undefined
    }
    if (this.shot !== undefined) {
      this.shot.t += dt
      // An action (a hit, a swing, a death) ends a shot laid over the run.
      if (this.shot.t >= SHOT.duration || this.action !== undefined) this.shot = undefined
    }
    if (dt > 0 && !this.shown()) return

    const playing = this.action
    const loop = this.character.loops?.[this.base]
    const name = playing?.name ?? loop?.clip ?? this.base
    // A one-shot clip as a loop (Hopper's jump) wraps here; `clipTime` would hold its end.
    const t = playing?.t ?? (loop === undefined ? this.baseTime : this.loopTime(loop, this.baseTime))
    if (name === 'fall_apart') {
      const clamped = Math.min(t, this.character.clips.fall_apart.duration)
      if (this.lastDebrisT >= 0 && clamped - this.lastDebrisT < RobotSprite.DEBRIS_STEP_S &&
        clamped < this.character.clips.fall_apart.duration) return
      if (clamped === this.lastDebrisT) return
      this.lastDebrisT = clamped
    }

    const shot = playing === undefined ? this.shot : undefined
    const facing = playing?.facing ?? shot?.facing ?? this.lookFacing ?? this.moveFacing
    this.rig.scale.set(this.pxPerUnit * facing, -this.pxPerUnit)
    this.castRig.scale.copyFrom(this.rig.scale)
    const pose = this.character.animationPose(name, t, {
      aimAngle: playing?.aim ?? shot?.aim ?? this.lookAim,
      blink: blinkClosure(this.eyeClock - this.blinkAt),
      expression: this.expression,
      eyeShootTime: shot?.t
    })
    this.apply(pose)
  }

  /** Where the eye's shot comes from on screen (global), as last drawn. */
  eyeGlobal (): Point {
    return this.rig.toGlobal(this.eye)
  }

  private apply (pose: Pose): void {
    const { state, matrices } = pose
    this.eye.set(matrices.eye_muzzle.x, matrices.eye_muzzle.y)
    const info = state.animation
    this.character.regions.forEach((r, i) => {
      const part = this.parts[i]
      let m: RigMatrix
      let w: number
      let h: number
      if (r.kind === 'spring') {
        this.drawSpring(this.springs.get(i)!, state.springLength ?? 66)
        m = matrices[r.bone]
        w = 1
        h = 1
      } else if (r.kind === 'eye') {
        const sprite = part.node as Sprite
        const eye = state[r.bone] as EyeBone
        const texture = eye.expression === 'smile' ? this.eyeTextures.smile : this.eyeTextures.open
        if (sprite.texture !== texture) sprite.texture = texture
        m = this.character.eyeMatrix(matrices, eye)
        w = this.character.eyeSize.w
        h = this.character.eyeSize.h
        // A shot hides the normal eye until it recovers.
        sprite.alpha = info.eyeOpacity * (state.shootEye?.eyeOpacity ?? 1)
        sprite.visible = sprite.alpha > 0
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
      part.cast?.transform.setFromMatrix(this.scratch)
    })

    // The drop's shadow: one under the feet that shrinks with a jump, one
    // per piece once it has come apart.
    if (info.detached) {
      this.shadow.clear()
      this.shadow.alpha = 0.28
      this.shadow.scale.set(1)
      this.shadow.beginFill(0x000000)
      for (const p of info.parts ?? []) this.shadow.drawEllipse(p.x, -1, this.character.debrisShadow[p.id] ?? 16, 3)
      this.shadow.endFill()
    } else {
      const jump = this.character.shadow.jumpHeight
      const lift = Math.min(1, info.height / jump)
      this.shadow.alpha = 0.5 - 0.2 * lift
      this.shadow.scale.set(1 - 0.18 * info.height / jump)
    }

    this.shotMarks.clear()
    const shot = state.shootEye
    if (shot !== null && shot !== undefined) {
      const region = this.character.regions.find((r) => r.name === shot.primaryRegion)
      if (region !== undefined) {
        const eyeM = this.character.eyeMatrix(matrices, state[region.bone] as EyeBone)
        const at = multiply(eyeM, { a: 1, b: 0, c: 0, d: 1, x: this.character.shot.offset(state), y: 0 })
        this.drawShot(at, shot, info.eyeOpacity)
      }
    }
  }

  /**
   * The eye shot (`chargedEyeMarks`, the drop's `drawChargedEye`), in the
   * eye's drawing space. The drop's Canvas glow (`shadowBlur`, radius x 0.42
   * on the rings, x 0.4-0.9 on the dot) has no pixi equivalent without a
   * filter per robot; a wider, fainter orange mark under each stands in for it.
   */
  private drawShot (m: RigMatrix, shot: ShotEye, alpha: number): void {
    const radius = this.character.shot.radius
    this.scratch.set(m.a, m.b, m.c, m.d, m.x, m.y)
    this.shotMarks.transform.setFromMatrix(this.scratch)
    const g = this.shotMarks
    for (const mark of chargedEyeMarks(shot, radius, alpha)) {
      if (mark.kind === 'stroke') {
        if (mark.color === 0xff8e15) g.lineStyle(mark.lw! + radius * 0.42, 0xff9b19, mark.alpha * 0.3).drawCircle(0, 0, mark.r)
        g.lineStyle(mark.lw!, mark.color, mark.alpha).drawCircle(0, 0, mark.r)
      } else {
        g.lineStyle(0)
        if (mark.color === 0xff9b19) {
          const glow = mark.r + radius * (0.4 + 0.5 * shot.flash) * 0.5
          g.beginFill(0xff9b19, mark.alpha * 0.3).drawCircle(0, 0, glow).endFill()
        }
        g.beginFill(mark.color, mark.alpha).drawCircle(0, 0, mark.r).endFill()
      }
    }
  }

  /** Hopper's coil (`springPoints`), stroked dark to light like the drop's `drawSpring`; redrawn only when its length changes. */
  private drawSpring (spring: { graphics: Graphics, cast?: Graphics, length: number }, length: number): void {
    if (Math.abs(spring.length - length) < 0.01) return
    spring.length = length
    const points = springPoints(length)
    const stroke = (g: Graphics, width: number, color: number): void => {
      g.lineStyle({ width, color, cap: LINE_CAP.ROUND, join: LINE_JOIN.ROUND })
      g.moveTo(points[0], points[1])
      for (let k = 2; k < points.length; k += 2) g.lineTo(points[k], points[k + 1])
    }
    spring.graphics.clear()
    for (const { width, color } of SPRING_STROKES) stroke(spring.graphics, width, color)
    if (spring.cast !== undefined) {
      spring.cast.clear()
      stroke(spring.cast, SPRING_STROKES[0].width, 0x000000)
    }
  }
}
