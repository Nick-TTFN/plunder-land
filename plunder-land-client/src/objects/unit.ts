import { ProgressBar } from '../ui/elements/progressbar'
import { type Texture, Sprite, Point, ColorMatrixFilter } from 'pixi.js'
import { GameObject } from './gameobject'
import { TextEffect } from '../ui/elements/texteffect'
import { Session } from '../net/session'

interface State {
  /** Client clock at which this state arrived. */
  t: number
  x: number
  y: number
}

/** Movement below this per frame counts as standing still, for animation. */
const IDLE_EPSILON = 0.05

export default class Unit extends GameObject {
  shadow: Sprite | undefined
  loot: number = 0
  progressBar: ProgressBar | undefined
  level: number = 0
  hp: number | undefined

  becameIdleAt: number = 0

  maxHP: number = 0
  runAnimation: string | undefined
  idleAnimation: string | undefined

  /**
   * Recent authoritative states, oldest first. Rendering runs deliberately
   * behind the newest of these so there is always a state on both sides of the
   * render time to interpolate between.
   */
  readonly states: State[] = []

  constructor (radius: number = 0) {
    super()

    if (radius > 0) {
      this.radius = radius
      this.DEBUG_DRAW_COLLIDER()
    }

    this.initAnimation()

    if (this.animation !== undefined) {
      this.shadow = new Sprite(
        this.animation.textures[this.animation.currentFrame] as Texture
      )
      const colorMatrix = new ColorMatrixFilter()
      this.shadow.filters = [colorMatrix]
      colorMatrix.desaturate()
      colorMatrix.brightness(0, true)
      this.shadow.alpha = 0.3
      this.shadow.anchor.x = 0.5
      this.shadow.anchor.y = 1
      this.shadow.skew = new Point(0.5, 0)

      this.addChild(this.shadow)

      this.animation.y += this.animation.height / 3
      this.shadow.y += this.animation.height / 3
    }

    this.progressBar = new ProgressBar()
    this.addChild(this.progressBar.graphics)
  }

  initAnimation (): void {}

  /**
   * The server now sends the real maximum. Previously this was inferred from the
   * first hp value ever seen, so any unit met while already damaged got a bar
   * that read full at its current health and overflowed if it healed.
   */
  setMaxHP (value: number): void {
    if (value <= 0 || this.maxHP === value) return

    this.maxHP = value

    if (this.progressBar !== undefined) {
      this.progressBar.width = this.maxHP
      this.progressBar.graphics.x = -this.progressBar.width / 2
      this.progressBar.graphics.y = this.radius + 5
    }

    if (this.hp !== undefined) this.progressBar?.setValue(this.hp / this.maxHP)
  }

  setHP (value: number): void {
    // Fallback for anything that somehow arrives without a maximum.
    if (this.maxHP === 0) this.setMaxHP(value)

    if (this.hp === value) return
    if (this.hp !== undefined) {
      if (this.visible && this.parent !== null && value < this.hp) {
      // eslint-disable-next-line no-new
        new TextEffect(
        `${value - this.hp}`,
        this.parent,
        this.x,
        this.y,
        24,
        'red',
        400
        )
      }
    }

    this.hp = value
    this.progressBar?.setValue(this.hp / this.maxHP)
  }

  /** Record an authoritative position. Replaces the old chase-the-target model. */
  pushState (x: number, y: number): void {
    const now = performance.now()
    this.states.push({ t: now, x, y })
    if (this.states.length > 24) this.states.shift()

    if (this.states.length === 1) {
      this.x = x
      this.y = y
    }
  }

  update (dt: number): void {
    const states = this.states
    if (states.length === 0) return

    const now = performance.now()
    const renderTime = now - Session.interpolationDelay

    let nx: number
    let ny: number

    if (renderTime <= states[0].t) {
      // Not enough history yet to render in the past: hold at the oldest state
      // rather than inventing motion.
      nx = states[0].x
      ny = states[0].y
    } else {
      let i = states.length - 1
      while (i > 0 && states[i].t > renderTime) i--

      const a = states[i]
      const b = states[i + 1]

      if (b !== undefined) {
        const span = b.t - a.t
        const f = span > 0 ? (renderTime - a.t) / span : 1
        nx = a.x + (b.x - a.x) * f
        ny = a.y + (b.y - a.y) * f
      } else {
        // The buffer has run dry - a packet is late. Continue along the last
        // known velocity for a bounded time, then hold. Holding is honest;
        // extrapolating indefinitely walks units through walls.
        const last = states[states.length - 1]
        const prev = states.length > 1 ? states[states.length - 2] : undefined
        const span = prev !== undefined ? last.t - prev.t : 0
        const ahead = Math.min(renderTime - last.t, Session.extrapolationCap)

        if (prev !== undefined && span > 0 && ahead > 0) {
          nx = last.x + ((last.x - prev.x) / span) * ahead
          ny = last.y + ((last.y - prev.y) / span) * ahead
        } else {
          nx = last.x
          ny = last.y
        }
      }
    }

    this.applyPosition(nx, ny, now)
  }

  /**
   * Move to a rendered position and run the animation bookkeeping that follows
   * from it. Shared with the locally predicted player, which arrives at its
   * position by a completely different route but needs the same footwork.
   */
  applyPosition (nx: number, ny: number, now: number): void {
    const dx = nx - this.x
    const dy = ny - this.y

    this.x = nx
    this.y = ny

    if (Math.abs(dx) + Math.abs(dy) < IDLE_EPSILON) {
      if (this.becameIdleAt === 0) this.becameIdleAt = now
      if (now - this.becameIdleAt > 100) this.animation?.setDefault(this.idleAnimation)
    } else {
      this.becameIdleAt = 0
      this.animation?.setDefault(this.runAnimation)

      if (this.animation != null && Math.abs(dx) > 0.01) {
        this.animation.scale.x = Math.abs(this.animation.scale.x) * (dx < 0 ? -1 : 1)
        if (this.shadow != null) {
          this.shadow.scale.x = this.animation.scale.x * 1.1
          this.shadow.scale.y = this.animation.scale.y * 1.1
        }
      }
    }

    if (this.animation != null && this.shadow != null) {
      this.shadow.texture = this.animation.textures[
        this.animation.currentFrame
      ] as Texture
    }

    this.zIndex = this.y
  }
}
