import { ProgressBar } from '../ui/elements/progressbar'
import { type Texture, Sprite, Point, ColorMatrixFilter } from 'pixi.js'
import { GameObject } from './gameobject'
import { TextEffect } from '../ui/elements/texteffect'
import { Session } from '../net/session'
import { type ArchetypeInfo } from '../utils/archetypes'

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

  /**
   * The server's `facing` field: an index into `Hex.DIRECTIONS` (E, SE, SW, W,
   * NW, NE), undefined until one arrives. Only for looks - a remote unit at rest
   * faces this way, and unaimed effects point along it. Aimed effects carry
   * their own cell (decision #21).
   */
  facingIndex: number | undefined

  maxHP: number = 0

  /**
   * The armor pool (#16): what is left and its size, from the server's `armor`
   * and `maxArmor` fields. 0/0 for anything without a pool, which is every mob:
   * the server sends neither field for them. Nothing draws these yet; the HUD
   * bar is `hud-rebuild`'s.
   */
  armor: number = 0
  maxArmor: number = 0

  runAnimation: string | undefined
  idleAnimation: string | undefined

  /**
   * What kind of unit this is, from the server's `archetype` field (index 16).
   * Undefined when none was sent or the id is one this build doesn't know;
   * `initAnimation` then draws the type's pre-archetype sprite
   * (`archetypesprites.ts`). Assigned in this class's constructor before
   * `initAnimation` runs, which is why it is a constructor parameter: a
   * subclass field would not exist yet at that point.
   */
  archetype: ArchetypeInfo | undefined

  /**
   * Recent authoritative states, oldest first. Rendering runs deliberately
   * behind the newest of these so there is always a state on both sides of the
   * render time to interpolate between.
   */
  readonly states: State[] = []

  constructor (radius: number = 0, archetype?: ArchetypeInfo) {
    super()

    this.archetype = archetype

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
    if (states.length === 0) {
      // Never moved since we met it: only the facing from its create record.
      if (this.facingIndex !== undefined) this.flip(this.facingIndex >= 2 && this.facingIndex <= 4)
      return
    }

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
  applyPosition (nx: number, ny: number, now: number, motionX?: number, motionY?: number): void {
    // Animation follows intent wherever we have it. For the locally predicted
    // player the rendered position also carries a decaying server correction,
    // and a correction is not movement — driving the run cycle and the sprite
    // flip from it made the player jog on the spot every time the server
    // nudged them. Remote units have no intent to read, so they fall back to
    // the rendered delta, which must be measured before the move.
    const dx = motionX ?? (nx - this.x)
    const dy = motionY ?? (ny - this.y)

    this.x = nx
    this.y = ny

    if (Math.abs(dx) + Math.abs(dy) < IDLE_EPSILON) {
      if (this.becameIdleAt === 0) this.becameIdleAt = now
      if (now - this.becameIdleAt > 100) {
        this.animation?.setDefault(this.idleAnimation)
        // A remote unit at rest faces the way the server says it does: the
        // rendered delta is zero, so there is nothing else to read, and a unit
        // that turned without moving (or was met standing still) would face
        // right forever. The locally predicted player passes its own motion
        // and keeps the flip its last step gave it, which is the same answer
        // a tick sooner. SW, W and NW (2, 3, 4) face left.
        if (motionX === undefined && this.facingIndex !== undefined) {
          this.flip(this.facingIndex >= 2 && this.facingIndex <= 4)
        }
      }
    } else {
      this.becameIdleAt = 0
      this.animation?.setDefault(this.runAnimation)

      if (Math.abs(dx) > 0.01) this.flip(dx < 0)
    }

    if (this.animation != null && this.shadow != null) {
      this.shadow.texture = this.animation.textures[
        this.animation.currentFrame
      ] as Texture
    }

    this.zIndex = this.y
  }

  /** Face the sprite (and its shadow) left or right. */
  flip (left: boolean): void {
    if (this.animation == null) return
    this.animation.scale.x = Math.abs(this.animation.scale.x) * (left ? -1 : 1)
    if (this.shadow != null) {
      this.shadow.scale.x = this.animation.scale.x * 1.1
      this.shadow.scale.y = this.animation.scale.y * 1.1
    }
  }
}
