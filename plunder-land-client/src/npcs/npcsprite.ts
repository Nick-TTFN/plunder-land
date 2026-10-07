import { AlphaFilter, Assets, Container, Graphics, LINE_CAP, LINE_JOIN, Matrix, Point, Rectangle, Sprite, Texture, Ticker, type DisplayObject } from 'pixi.js'
import { type NpcDrawList, type NpcImage, type NpcMark, type NpcPose, type NpcPoseOptions, type NpcRig } from './npcrig'
import { RobotSprite } from '../robots/robotsprite'
import { SHOT } from '../robots/eyeshot'
import { layShadow } from '../objects/shadow'

/** An `NpcMasked` drawn: its images in a container cut by its mask sprite. */
interface MaskedGroup {
  readonly container: Container
  readonly mask: Sprite
  readonly sprites: Sprite[]
}

/** A clip played over the idle/move loop, then gone (death holds). */
interface Action {
  role: 'attack' | 'hit' | 'death' | 'spawn' | 'prime'
  clip: string
  /** Clip seconds; negative while an attack waits to line its event up with the beam. */
  t: number
  /** Ground direction it points (an attack at its target). */
  aim: { x: number, y: number } | undefined
  /** The pose shown when it began, which the package's actions start from. */
  from: NpcPose | undefined
}

/**
 * An NPC drawn from its rig (`NpcRig`, `src/npcs/npcrig.ts`; l1-8, decision
 * #51), the sibling of `RobotSprite`: every frame the rig's pose becomes a
 * draw list (`NpcRig.draw`), its images placed as sprites from the NPC's sheet
 * (`npc-<key>.json`, `tools/bake-npc-atlas.py`) and its shapes (shadows,
 * fuse, sensor, blast) drawn into `Graphics` between them, in the package's
 * order. Drawn at `RobotSprite.SCALE` pixels per rig unit times the NPC's
 * `sizeScale`, so it keeps its size against the robots (Nick, 2026-10-07).
 *
 * - The idle/move loop follows movement (`setMoving`), along the ground
 *   direction it last moved in (`setDirection`): an NPC's body never turns,
 *   its gait points. The move loop runs at `RobotSprite.RUN_RATE` times the
 *   ground speed over `STRIDE_SPEED`, like the robots' (`setPace`).
 * - `play` lays an action over it: an attack (aimed, and started so that its
 *   event lands `lead` seconds after the effect: the Crawler's shot at
 *   0.34 s `SHOT.fire` after, when `RangedAttackEffect` fires the beam; the
 *   Compactor's impact on the server's `impactMs`; the Reactor's release on
 *   its effect 12, l1-9), a hit (with a code hit flash, which the packages
 *   leave to the game), a death (from `death.from`, held at its end; from the
 *   pose shown, an attack's included, with `death.fromAction`), a spawn (the
 *   Broodling's emerge, drawn in place, on the Brood's release) or a prime
 *   (the Broodling's tell, l1-7: the end of its detonate, which a death then
 *   carries on rather than restarts). A death is never replaced; a hit
 *   doesn't cut a spawn, a prime, an attack before its event, or any of an
 *   attack with `refusesHit`. With `holdGaitOnHit` the idle/move clock
 *   waits while a hit plays.
 * - `poseOptions` feeds the package's pose parameters each frame (the
 *   Broodling's cord length from its fuse left).
 *
 * Its own contact shadows are the package's; with `castShadow` it also casts
 * a silhouette (its images again in black under one `AlphaFilter`, laid by
 * `layShadow`), as every unit does, leaving out painted contact shadows and
 * masked images. An image with a clip is drawn from its band frame
 * (`<art>-<top row>`, the Crawler's shell) when the sheet has one, else cut
 * from its art's frame at draw time (`cut`: the Compactor's shaft, whose
 * crop slides, and its front legs' roots). The ticker listener lives while `host` is
 * in the scene, as `RobotSprite`'s.
 */
export class NpcSprite extends Container {
  /** How long a hit tints it, seconds. */
  static readonly HIT_FLASH_S = 0.12
  /** The hit flash's tint (a tint can only darken: red reads as a flash on these colours). */
  static readonly HIT_TINT = 0xff6a5a
  /** How far short of `roles.death.from` a prime holds: at it, the rig already draws the blast. */
  static readonly PRIME_HOLD_S = 0.001
  /** The cast shadow's opacity, as the robots' (`RobotSprite.CAST_ALPHA`). */
  static readonly CAST_ALPHA = RobotSprite.CAST_ALPHA

  /** True once its sheet is loaded; `Mob` draws `mob/mob` otherwise. */
  static ready (rig: NpcRig): boolean {
    // Any of its arts will do: a sheet loads whole. (Not every NPC has a `body`.)
    return Assets.cache.has(`npc-${rig.key}/${Object.keys(rig.arts)[0]}.png`)
  }

  /** CSS px from the ground to the top of its reference pose. */
  readonly standHeight: number
  /** CSS px per rig unit. */
  private readonly pxPerUnit: number

  private readonly rig = new Container()
  private readonly ground = new Graphics()
  private readonly sprites: Sprite[] = []
  private readonly marks: Graphics[] = []
  private readonly groups: MaskedGroup[] = []
  private readonly cast: Container | undefined
  private readonly castRig = new Container()
  private readonly castSprites: Sprite[] = []
  private readonly scratch = new Matrix()
  private readonly muzzle = new Point()

  private moving = false
  private baseTime = 0
  private pace = 1
  private direction = { x: 0, y: 1 }
  private action: Action | undefined
  /** The last idle/move pose shown: what an action starts from. */
  private last: NpcPose | undefined
  /** The last pose shown, an action's included: what a `fromAction` death starts from. */
  private shownPose: NpcPose | undefined
  private flashLeft = 0
  private readonly tick = (): void => { this.update(Ticker.shared.deltaMS / 1000) }
  private ticking = false
  /**
   * Read every frame for the package's pose parameters (the Broodling's cord
   * length from its fuse left, l1-7); undefined for the defaults.
   */
  poseOptions: (() => NpcPoseOptions | undefined) | undefined = undefined

  constructor (private readonly host: Container, readonly npc: NpcRig, castShadow = false) {
    super()
    this.pxPerUnit = RobotSprite.SCALE * npc.sizeScale
    this.standHeight = npc.referenceUnits * this.pxPerUnit
    this.rig.scale.set(this.pxPerUnit)
    if (castShadow) {
      this.cast = new Container()
      this.cast.filters = [new AlphaFilter(NpcSprite.CAST_ALPHA)]
      layShadow(this.cast)
      this.castRig.scale.set(this.pxPerUnit)
      this.cast.addChild(this.castRig)
      this.addChild(this.cast)
    }
    this.addChild(this.ground)
    this.ground.scale.set(this.pxPerUnit)
    this.addChild(this.rig)

    host.on('added', this.start, this)
    host.on('removed', this.stop, this)
    if (host.parent !== null) this.start()
    this.update(0)
  }

  setMoving (moving: boolean): void {
    if (moving !== this.moving) this.baseTime = 0
    this.moving = moving
  }

  /** The ground direction it moves along (world x and y); a zero vector keeps the last. */
  setDirection (x: number, y: number): void {
    if (Math.hypot(x, y) > 1e-6) this.direction = { x, y }
  }

  /** Ground speed over `RobotSprite.STRIDE_SPEED`; scales the move loop only. */
  setPace (pace: number): void {
    this.pace = Math.min(RobotSprite.MAX_PACE, Math.max(RobotSprite.MIN_PACE, pace))
  }

  /** Whether it has a clip for `role`. */
  has (role: Action['role']): boolean {
    return this.clipFor(role) !== undefined
  }

  private clipFor (role: Action['role']): string | undefined {
    const roles = this.npc.roles
    if (role === 'attack') return roles.attack?.clip
    if (role === 'hit') return roles.hit
    if (role === 'death') return roles.death?.clip
    if (role === 'prime') return roles.prime?.clip
    return roles.spawn?.clip
  }

  /**
   * Lays an action over the loop (see the class comment); `aim` is a ground
   * direction. An attack is started so that its event comes `lead` seconds
   * from now (the beam's `SHOT.fire` when undefined). False if it has no such
   * clip or it was refused.
   */
  play (role: Action['role'], aim?: { x: number, y: number }, lead?: number): boolean {
    const clip = this.clipFor(role)
    if (clip === undefined) return false
    const current = this.action
    if (current?.role === 'death') return false
    if (role === 'hit') {
      this.flashLeft = NpcSprite.HIT_FLASH_S
      if (current?.role === 'spawn' || current?.role === 'prime') return false
      if (current?.role === 'attack' && (this.npc.roles.attack?.refusesHit === true || current.t < (this.npc.roles.attack?.event ?? 0))) return false
    }
    const roles = this.npc.roles
    // A death on the clip a prime is already playing (the Broodling's
    // detonate) carries on from where the prime is, never earlier than the
    // death's own start: no restart, and the blast is never drawn late.
    if (role === 'death' && current?.role === 'prime' && current.clip === clip) {
      current.role = 'death'
      current.t = Math.max(current.t, roles.death!.from)
      return true
    }
    const t = role === 'attack' ? roles.attack!.event - (lead ?? SHOT.fire)
      : role === 'death' ? roles.death!.from
        : role === 'spawn' ? roles.spawn!.from
          : role === 'prime' ? roles.prime!.from
            : 0
    const from = role === 'death' && roles.death?.fromAction === true ? this.shownPose ?? this.last : this.last
    this.action = { role, clip, t, aim, from }
    return true
  }

  get dying (): boolean {
    return this.action?.role === 'death'
  }

  /** How long a death plays from its start before it can go: to its end, then a moment held. */
  get deathSeconds (): number {
    const death = this.npc.roles.death
    if (death === undefined) return 0
    return this.npc.clips[death.clip].duration - death.from + 0.5
  }

  /** Where a shot leaves it, on screen (global), as last drawn. */
  muzzleGlobal (): Point {
    return this.rig.toGlobal(this.muzzle)
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
    const holding = this.action?.role === 'hit' && this.npc.roles.holdGaitOnHit === true
    if (!holding) this.baseTime += this.moving ? dt * RobotSprite.RUN_RATE * this.pace : dt
    this.flashLeft = Math.max(0, this.flashLeft - dt)
    const action = this.action
    if (action !== undefined) {
      action.t += dt
      // A prime holds just short of the death's start (the Broodling's
      // 1.35 s, from which the rig draws it dead with its blast) until the
      // death arrives and carries on from there (l1-7 F7): a late destroy must
      // not show the blast before the server's, nor end the clip and stand it
      // back up.
      const death = this.npc.roles.death
      if (action.role === 'prime' && death !== undefined && action.clip === death.clip) {
        action.t = Math.min(action.t, death.from - NpcSprite.PRIME_HOLD_S)
      }
      const duration = this.npc.clips[action.clip].duration
      const spawn = this.npc.roles.spawn
      const done = action.role === 'spawn' && spawn !== undefined && this.moving && action.t >= spawn.ready
      const held = action.role === 'death' || (action.role === 'prime' && death !== undefined && action.clip === death.clip)
      if (!held && (action.t >= duration || done)) this.action = undefined
    }
    if (dt > 0 && !this.shown()) return

    const playing = this.action
    const roles = this.npc.roles
    const clip = playing?.clip ?? (this.moving ? roles.move : roles.idle)
    const t = playing === undefined ? this.baseTime : Math.min(Math.max(0, playing.t), this.npc.clips[playing.clip].duration)
    const pose = this.npc.pose(clip, t, this.direction, playing?.aim, playing?.from, this.poseOptions?.())
    if (playing === undefined) this.last = pose
    this.shownPose = pose
    if (pose.muzzle !== undefined) this.muzzle.set(pose.muzzle.x, pose.muzzle.y)
    this.drawList(this.npc.draw(pose, { inPlace: true }))
  }

  private drawList (list: NpcDrawList): void {
    const g = this.ground
    g.clear()
    for (const e of list.ground) {
      if (e.alpha > 0) g.beginFill(e.color, e.alpha).drawEllipse(e.x, e.y, e.rx, e.ry).endFill()
    }

    const order: DisplayObject[] = []
    const shades: Sprite[] = []
    let sprites = 0
    let graphics = 0
    let groups = 0
    let open: Graphics | undefined
    const tint = this.flashLeft > 0 ? NpcSprite.HIT_TINT : 0xffffff
    for (const item of list.items) {
      if (item.kind === 'image') {
        open = undefined
        const sprite = this.sprites[sprites] ?? (this.sprites[sprites] = new Sprite())
        this.place(sprite, item)
        sprite.tint = item.contact === true ? 0xffffff : tint
        order.push(sprite)
        if (this.cast !== undefined && item.contact !== true) {
          const shade = this.castSprites[shades.length] ?? (this.castSprites[shades.length] = Object.assign(new Sprite(), { tint: 0x000000 }))
          this.place(shade, item)
          // The silhouette is solid; its opacity is the filter's.
          shade.alpha = 1
          shades.push(shade)
        }
        sprites++
        continue
      }
      if (item.kind === 'masked') {
        open = undefined
        const group = this.groups[groups] ?? (this.groups[groups] = NpcSprite.maskedGroup())
        groups++
        while (group.sprites.length < item.items.length) group.sprites.push(new Sprite())
        for (let k = 0; k < item.items.length; k++) {
          this.place(group.sprites[k], item.items[k])
          group.sprites[k].tint = tint
        }
        this.place(group.mask, item.mask)
        const want = group.sprites.slice(0, item.items.length)
        const now = group.container.children
        if (now.length !== want.length + 1 || want.some((s, k) => now[k] !== s)) {
          group.container.removeChildren()
          group.container.addChild(...want, group.mask)
        }
        order.push(group.container)
        continue
      }
      if (open === undefined) {
        open = this.marks[graphics] ?? (this.marks[graphics] = new Graphics())
        open.clear()
        graphics++
        order.push(open)
      }
      NpcSprite.drawMark(open, item)
    }
    const children = this.rig.children
    if (children.length !== order.length || order.some((o, i) => children[i] !== o)) {
      this.rig.removeChildren()
      if (order.length > 0) this.rig.addChild(...order)
    }
    if (this.cast !== undefined) {
      const now = this.castRig.children
      if (now.length !== shades.length || shades.some((s, i) => now[i] !== s)) {
        this.castRig.removeChildren()
        if (shades.length > 0) this.castRig.addChild(...shades)
      }
    }
  }

  private static maskedGroup (): MaskedGroup {
    const container = new Container()
    const mask = new Sprite()
    container.mask = mask
    return { container, mask, sprites: [] }
  }

  /**
   * The frame for an image: the art; or the band of it a clip cuts, as its
   * own frame (the Crawler's shell sections, `body-<top row>`) or, where the
   * sheet has none, cut from the art's frame (`cut`).
   */
  private place (sprite: Sprite, item: NpcImage): void {
    const art = this.npc.arts[item.art]
    let texture: Texture
    let clip = item.clip
    if (clip === undefined) texture = Texture.from(`npc-${this.npc.key}/${item.art}.png`)
    else {
      const band = `npc-${this.npc.key}/${item.art}-${clip.y}.png`
      if (Assets.cache.has(band)) texture = Texture.from(band)
      else ({ texture, clip } = NpcSprite.cut(Texture.from(`npc-${this.npc.key}/${item.art}.png`), art, clip))
    }
    if (sprite.texture !== texture) sprite.texture = texture
    sprite.alpha = item.alpha ?? 1
    const ox = clip?.x ?? 0
    const oy = clip?.y ?? 0
    // Stretch the frame, whatever its resolution, over the art (or band) it stands for.
    const fx = (clip?.w ?? art.w) / texture.width
    const fy = (clip?.h ?? art.h) / texture.height
    const m = item.m
    this.scratch.set(m.a * fx, m.b * fx, m.c * fy, m.d * fy, m.a * ox + m.c * oy + m.x, m.b * ox + m.d * oy + m.y)
    sprite.transform.setFromMatrix(this.scratch)
  }

  /** Cut textures, by frame and texel rectangle: a sliding crop makes a few dozen at most. */
  private static readonly cuts = new Map<string, Texture>()

  /**
   * `clip` (art pixels) of the art's frame `full`, snapped to whole texels:
   * the texture, and the clip it really shows, in art pixels. Works on a
   * trimmed frame (`orig`/`trim`), so the bake may trim as for any part.
   */
  static cut (full: Texture, art: { w: number, h: number }, clip: { x: number, y: number, w: number, h: number }): { texture: Texture, clip: { x: number, y: number, w: number, h: number } } {
    const sx = full.orig.width / art.w
    const sy = full.orig.height / art.h
    const x0 = Math.round(clip.x * sx)
    const y0 = Math.round(clip.y * sy)
    const x1 = Math.max(x0 + 1, Math.round((clip.x + clip.w) * sx))
    const y1 = Math.max(y0 + 1, Math.round((clip.y + clip.h) * sy))
    const shown = { x: x0 / sx, y: y0 / sy, w: (x1 - x0) / sx, h: (y1 - y0) / sy }
    const key = `${full.textureCacheIds[0] ?? ''}:${x0},${y0},${x1},${y1}`
    let texture = NpcSprite.cuts.get(key)
    if (texture === undefined) {
      // The trimmed frame's pixels inside the cut, in the untrimmed frame's coordinates.
      const trim = full.trim ?? new Rectangle(0, 0, full.orig.width, full.orig.height)
      const vx0 = Math.max(x0, trim.x)
      const vy0 = Math.max(y0, trim.y)
      const vx1 = Math.min(x1, trim.x + trim.width)
      const vy1 = Math.min(y1, trim.y + trim.height)
      const orig = new Rectangle(0, 0, x1 - x0, y1 - y0)
      texture = vx1 <= vx0 || vy1 <= vy0
        ? new Texture(full.baseTexture, new Rectangle(full.frame.x, full.frame.y, 1, 1), orig, new Rectangle(0, 0, 0, 0))
        : new Texture(full.baseTexture, new Rectangle(full.frame.x + vx0 - trim.x, full.frame.y + vy0 - trim.y, vx1 - vx0, vy1 - vy0), orig, new Rectangle(vx0 - x0, vy0 - y0, vx1 - vx0, vy1 - vy0))
      NpcSprite.cuts.set(key, texture)
    }
    return { texture, clip: shown }
  }

  private static drawMark (g: Graphics, mark: NpcMark): void {
    if (mark.alpha <= 0) return
    if (mark.kind === 'ellipse') {
      if (mark.stroke !== undefined) g.lineStyle(mark.stroke, mark.color, mark.alpha).drawEllipse(mark.x, mark.y, mark.rx, mark.ry).lineStyle(0)
      else g.beginFill(mark.color, mark.alpha).drawEllipse(mark.x, mark.y, mark.rx, mark.ry).endFill()
      return
    }
    if (mark.kind === 'line') {
      g.lineStyle({ width: mark.width, color: mark.color, alpha: mark.alpha, cap: LINE_CAP.ROUND, join: LINE_JOIN.ROUND })
      g.moveTo(mark.points[0], mark.points[1])
      for (let k = 2; k < mark.points.length; k += 2) g.lineTo(mark.points[k], mark.points[k + 1])
      g.lineStyle(0)
      return
    }
    if (mark.stroke !== undefined) g.lineStyle(mark.stroke.width, mark.stroke.color, mark.alpha)
    g.beginFill(mark.color, mark.alpha).drawPolygon([...mark.points]).endFill().lineStyle(0)
  }
}
