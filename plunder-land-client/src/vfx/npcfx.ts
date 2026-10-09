import TWEEN from '@tweenjs/tween.js'
import { Assets, Container, Sprite, type Texture } from 'pixi.js'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { onGround } from '../objects/tilt'
import { type Cell } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { sparkX } from '../npcs/npcrig'

/**
 * The NPC effects sheet (task l1-11, decision #51): Codex's `npc-fx-v1`
 * library baked by `tools/bake-npc-fx-atlas.py`, PROVISIONAL until Nick's art
 * review. Clips are `fx/<id>`; `meta.clips` gives each its fps, loop and
 * whether it lies on the ground (`docs/art-pipeline.md`).
 *
 * **Loaded in the background from `Game`'s constructor**, with the NPC rig
 * sheets. An effect that arrives before it lands draws its cells as a plain
 * `CellHighlight` (`warnCells`, `burstCells`), so a telegraph is never lost,
 * and skips its standing art.
 */
export const NPC_FX_SHEET = './res/npc-fx.json'

interface ClipMeta {
  readonly fps: number
  readonly loop: boolean
  readonly ground: boolean
  readonly chain?: { readonly cellDelay: number }
}

/** Ground decals sit here: over the ground (-1000) and the route marker (-1), under every unit (zIndex = its y), as `CellHighlight`. */
export const GROUND_Z = -0.5

/** The loaded sheet, or undefined: checked first, as `NpcSprite.ready` does, because pixi's `Cache.get` warns on a missing key. */
function sheet (): any {
  return Assets.cache.has(NPC_FX_SHEET) ? Assets.get(NPC_FX_SHEET) : undefined
}

/**
 * One clip of the NPC effects sheet as a sprite whose frame the effect sets
 * from its own clock (`at`, `through`), so a clip can be remapped onto a
 * lifetime the server sends rather than played at its own rate. Each frame's
 * baked anchor is the package's pivot. A ground clip is marked `onGround`
 * (the tilted camera squashes it once, as the contract asks); a standing one
 * is not, and stands up when added to a plane.
 */
export class FxSprite extends Sprite {
  /** True once the sheet has loaded. */
  static ready (): boolean {
    return sheet()?.data?.animations !== undefined
  }

  /** The clip's metadata from the sheet (`meta.clips`), undefined for an unknown name or no sheet. */
  static meta (name: string): ClipMeta | undefined {
    return sheet()?.data?.meta?.clips?.[name]
  }

  readonly frames: Texture[]
  readonly fps: number
  readonly loop: boolean
  readonly ground: boolean

  /** Throws on a name the sheet doesn't have; `textures.spec.ts` (server) checks every literal one. */
  constructor (name: string) {
    const s = sheet()
    const names: string[] | undefined = s?.data?.animations?.[name]
    if (names === undefined) throw new Error(`npc-fx: no clip ${name}`)
    const frames = names.map((n) => s.textures[n] as Texture)
    super(frames[0])
    this.frames = frames
    const meta = FxSprite.meta(name)
    this.fps = meta?.fps ?? 12
    this.loop = meta?.loop ?? false
    this.ground = meta?.ground ?? false
    this.eventMode = 'none'
    if (this.ground) {
      onGround(this)
      this.zIndex = GROUND_Z
    }
  }

  /** The clip's own length, seconds. */
  get duration (): number {
    return this.frames.length / this.fps
  }

  /** The frame `seconds` into the clip at its own rate: wrapped if it loops, else held on the last. */
  at (seconds: number): void {
    const i = Math.floor(Math.max(0, seconds) * this.fps)
    this.show(this.loop ? i % this.frames.length : i)
  }

  /**
   * The frame `t` (0-1) of the way through the clip, held on the last: one
   * pass of the clip remapped onto a lifetime (the contract allows it), or a
   * looping warning's one urgency cycle stretched over its lifetime.
   */
  through (t: number): void {
    this.show(Math.floor(Math.max(0, t) * this.frames.length))
  }

  private show (i: number): void {
    const frame = this.frames[Math.min(this.frames.length - 1, Math.max(0, i))]
    if (this.texture !== frame) this.texture = frame
  }
}

/** The world position of a cell's centre. */
export function centreOf (cell: Cell): Vector {
  return Hex.toPosition(new Vector(cell.x, cell.y))
}

/**
 * One decal of `name` on every cell of `cells` (the server's set, from
 * `vfx/cells.ts`), each at its cell's centre and turned by `rotation` in the
 * ground plane, before the camera's tilt (the contract's order), inside one
 * ground container on `layer`. The decals are returned in `cells`' order.
 */
export function stampCells (layer: Container, name: string, cells: readonly Cell[], rotation = 0): { group: Container, decals: FxSprite[] } {
  const group = onGround(new Container())
  group.eventMode = 'none'
  group.zIndex = GROUND_Z
  const decals = cells.map((cell) => {
    const decal = new FxSprite(name)
    const at = centreOf(cell)
    decal.position.set(at.x, at.y)
    decal.rotation = rotation
    group.addChild(decal)
    return decal
  })
  layer.addChild(group)
  return { group, decals }
}

/** A standing clip on `layer` at a world point: upright, sorted with the units by its ground `y`. */
export function standAt (layer: Container, name: string, x: number, y: number): FxSprite {
  const sprite = new FxSprite(name)
  sprite.position.set(x, y)
  sprite.zIndex = y + 1
  layer.addChild(sprite)
  return sprite
}

/** Take a display object out of the scene and free it, once. */
export function discard (object: Container | undefined): void {
  if (object === undefined || object.destroyed) return
  object.parent?.removeChild(object)
  object.destroy({ children: true })
}

/**
 * Run `update` with the elapsed ms every frame for `ms`, then `end` (also
 * when `stop` returns true: an NPC seen to die, whose effect the server has
 * cancelled). On the shared TWEEN clock, as every other effect.
 */
export function runFor (ms: number, update: (elapsed: number) => void, end: () => void, stop?: () => boolean): void {
  const duration = Math.max(ms, 1)
  const state = { elapsed: 0 }
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    end()
  }
  update(0)
  const tween = new TWEEN.Tween(state)
    .to({ elapsed: duration }, duration)
    .onUpdate(() => {
      if (stop?.() === true) {
        tween.stop()
        finish()
        return
      }
      update(state.elapsed)
    })
    .onComplete(finish)
    .onStop(finish)
    .start()
}

/**
 * The warning on cells about to be hit (`landing-center` on `centre`, the
 * aimed cell, `landing-ring` on the rest), one urgency cycle stretched over
 * `ms` as the contract asks for the Kiln's landing, gone at its end. The
 * package draws it for the Kiln's lob; it is also the tell of every other NPC
 * attack that has no art of its own (the Reactor's charge, the Coil's tell,
 * the Compactor's wind-up, a primed Broodling), so a danger cell reads the
 * same whoever threatens it. Without the sheet, a `CellHighlight` in
 * `fallback`.
 */
export function warnCells (tag: number | undefined, cells: readonly Cell[], centre: Cell | undefined, ms: number, fallback: number, stop?: () => boolean): void {
  const layer = layerOf(tag)
  if (layer === undefined || cells.length === 0) return
  if (!FxSprite.ready()) {
    CellHighlight.flash(tag, [...cells], fallback, ms)
    return
  }
  const isCentre = (c: Cell): boolean => centre !== undefined && c.x === centre.x && c.y === centre.y
  const rings = stampCells(layer, 'fx/landing-ring', cells.filter((c) => !isCentre(c)))
  const middle = stampCells(layer, 'fx/landing-center', cells.filter(isCentre))
  const all = [...rings.decals, ...middle.decals]
  runFor(ms, (elapsed) => {
    const t = elapsed / Math.max(ms, 1)
    for (const decal of all) decal.through(t)
  }, () => {
    discard(rings.group)
    discard(middle.group)
  }, stop)
}

/**
 * A one-shot ground clip on every cell of `cells` and, if `standing` is
 * given, a standing clip at `at`, both remapped onto `ms` (the server's
 * lifetime) and removed at its end. The impacts: the Kiln's, the Reactor's
 * release, a Broodling's blast. Without the sheet, a `CellHighlight` in
 * `fallback`.
 */
export function burstCells (
  tag: number | undefined,
  cells: readonly Cell[],
  ground: string,
  ms: number,
  fallback: number,
  standing?: { name: string, at: { x: number, y: number } },
  stop?: () => boolean
): void {
  const layer = layerOf(tag)
  if (layer === undefined) return
  if (!FxSprite.ready()) {
    CellHighlight.flash(tag, [...cells], fallback, Math.max(ms, 300))
    return
  }
  const { group, decals } = stampCells(layer, ground, cells)
  const burst = standing !== undefined ? standAt(layer, standing.name, standing.at.x, standing.at.y) : undefined
  runFor(ms, (elapsed) => {
    const t = elapsed / Math.max(ms, 1)
    for (const decal of decals) decal.through(t)
    burst?.through(t)
  }, () => {
    discard(group)
    discard(burst)
  }, stop)
}

/** What a hit spark needs of a mob: where its body is drawn, relative to its position. */
interface Struck extends Container {
  killed: boolean
  headY: number
  feetY: number
  radius: number
  /** Its drawn body's extent across, px (a rigged NPC's); without it the spark spreads over `radius`. */
  bodySpan?: { left: number, right: number }
}

/**
 * A mob taking damage (`Mob.onHurt`): `mob-hit-spark` (Codex `npc-fx-v1`,
 * l1-11), a neutral metallic spark, at its own rate, on a point of the body
 * between its feet and its head, a child of the mob so it moves with it. The
 * client is not told where the hit landed, so the point is picked at random
 * on the upper two thirds of the body, and across the middle of its drawn
 * width (`sparkX`; `radius` wide for a robot or an unrigged mob). Nothing
 * without the sheet.
 */
export function hitSpark (mob: Struck): void {
  // `killed`, not `destroyed`: a unit is never pixi-destroyed (`dispose` scales it away and removes it).
  if (!FxSprite.ready() || mob.killed) return
  const spark = new FxSprite('fx/mob-hit-spark')
  const height = mob.feetY - mob.headY
  spark.position.set(sparkX(mob.bodySpan, mob.radius, Math.random()), mob.headY + height * Math.random() * 2 / 3)
  mob.addChild(spark)
  runFor(spark.duration * 1000, (elapsed) => { spark.at(elapsed / 1000) }, () => { discard(spark) })
}
