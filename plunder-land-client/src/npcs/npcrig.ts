import { type Matrix } from '../peep/rig'
import { CRAWLER_RIG } from './crawler/rig'
import { BROODLING_RIG } from './broodling/rig'
import { REACTOR_RIG } from './reactor/rig'
import { COMPACTOR_RIG } from './compactor/rig'
import { KILN_RIG } from './kiln/rig'
import { COIL_RIG } from './coil/rig'
import { BROOD_RIG } from './brood/rig'

/**
 * What `NpcSprite` needs to draw one NPC (l1-8, decision #51): the sibling of
 * `RobotRig`, kept apart because an NPC has none of a robot's eye, eye shot,
 * finishes or lobby sheets, and clips of its own (fire, emerge, detonate...).
 *
 * Each NPC's evaluator is a hand port of its Codex package's JavaScript
 * (`src/npcs/<key>/rig.ts`), the authority, checked against poses sampled from
 * the package by `npcrigs.spec.ts` (server). The port also turns a pose into a
 * draw list (`NpcDrawList`): where each image goes, and the shapes the package
 * draws in code (shadows, the Crawler's sensor, the Broodling's fuse and blast),
 * so the sprite stays generic and pixi stays out of the spec.
 *
 * Coordinates are the package's: rig units, x right, y down, the ground point
 * at 0,0 and anything standing drawn at negative y. On screen a rig unit is
 * `RobotSprite.SCALE` (every robot's base pixels per unit) times `sizeScale`.
 */
export interface NpcRig {
  /** The key in the mirror (`utils/archetypes.ts`), and its sheet `npc-<key>.json` (`tools/bake-npc-atlas.py`). */
  readonly key: 'crawler' | 'broodling' | 'reactor' | 'compactor' | 'kiln' | 'coil' | 'brood'
  /** Every clip, from the package's `rig/animation-manifest.json` (`npcrigs.spec.ts` checks the table against it). */
  readonly clips: Readonly<Record<string, NpcClip>>
  /**
   * The size Nick picked for it, against its own rig's size
   * (`codex_output/npc-scale-preview-v1/HANDOFF.md`, `ideas/npc-roster.md`).
   * The sheet is baked at the same factor (`bake-npc-atlas.py`): change both.
   */
  readonly sizeScale: number
  /** The rig units from the ground to the top of the reference pose, for the HP bar's height. */
  readonly referenceUnits: number
  /** Whether the death clip holds its last pose (`deathHolds` in the manifest). */
  readonly deathHolds: boolean
  /** The clips the sprite plays for each job; undefined where the NPC has none. */
  readonly roles: NpcRoles
  /**
   * The pose at `seconds` into `clip`, for a unit heading along ground
   * direction `direction` (any length). An action (attack, hit, death) points
   * along ground direction `aim` and starts from `from`, the pose shown when
   * it began, as the package's controller captures it. `options` are the
   * package's own pose parameters (the Broodling's cord length); a rig
   * without them ignores them.
   */
  readonly pose: (clip: string, seconds: number, direction: { x: number, y: number }, aim?: { x: number, y: number }, from?: NpcPose, options?: NpcPoseOptions) => NpcPose
  /** What to draw for a pose (`NpcSprite`). */
  readonly draw: (pose: NpcPose, options?: NpcDrawOptions) => NpcDrawList
  /** Every image the draw list may name, with its full size in the package's art pixels. */
  readonly arts: Readonly<Record<string, { readonly w: number, readonly h: number }>>
  /** How its move loop is timed against ground speed, if not as every other NPC's (`NpcGait`). */
  readonly gait?: NpcGait
}

/**
 * A rig's own gait timing (decision #52: lane 3, the Crawler's trial; lane 4,
 * every NPC whose legs allow it; PROVISIONAL until Nick has seen it). Without
 * it, a rig's move loop runs at `RobotSprite.RUN_RATE` times its pace, pace
 * clamped at `RobotSprite.MIN_PACE`, along the direction it moves: the same
 * for every NPC whatever its stride, so planted feet slide (strand B
 * measured 88-99%). With it, the loop's rate is derived from the rig's own
 * stride and its size (`gaitClock`), so a planted foot keeps still, and a
 * change of `sizeScale` keeps it still with no other edit.
 */
export interface NpcGait {
  /**
   * How fast a planted foot sweeps back under the body at the stride the
   * game plays, in drawn rig units per clip second: the package's stride /
   * duty / step period, times any draw scale of its own (the Broodling's
   * 1.12). The loop is run so that this, on screen, matches the ground speed.
   */
  readonly groundSpeed: number
  /** One leg's step cycle, clip seconds (the package's gait period). */
  readonly period: number
  /**
   * The most steps a second one leg takes going east or west. A rig whose
   * legs can't reach a stride long enough would otherwise need 10-70 steps
   * a second at chase speed: above this the loop runs no faster and the feet
   * slide the rest of the way (`gaitClock`).
   */
  readonly maxSteps: number
  /** The least pace, in place of `RobotSprite.MIN_PACE` (a fast gait at the shared floor runs its legs too fast at idle). */
  readonly minPace: number
  /**
   * The package's own ground squash (y times this on screen; the Crawler's
   * 0.68). Set, the gait is pointed and timed for the game's squash instead
   * (`gaitDirection`): a planted foot then keeps still going any way, not
   * only east and west.
   */
  readonly groundTilt?: number
}

/**
 * The ground direction to hand a rig's pose for a unit moving along world
 * `x, y`, and how much faster than its rate the loop must run that way
 * (`stretch`). A package lays its stride along the direction and draws
 * ground y at `groundTilt`; the game draws world y at `tilt` (`objects/tilt.ts`
 * `TILT`). So the direction's y is scaled by `tilt / groundTilt`, which
 * points the stride along the motion as drawn, and the loop runs `stretch`
 * times faster, so that a stride covers the same world distance any way:
 * 1 east and west, `groundTilt / tilt` slower going north or south (1.36x for the
 * Crawler) and in between on a diagonal. A rig without `groundTilt` keeps the
 * direction and a stretch of 1.
 */
export function gaitDirection (gait: NpcGait | undefined, x: number, y: number, tilt: number): { x: number, y: number, stretch: number } {
  if (gait?.groundTilt === undefined) return { x, y, stretch: 1 }
  const k = tilt / gait.groundTilt
  const d = Math.hypot(x, y * k)
  if (d < 1e-12) return { x, y, stretch: 1 }
  const dx = x / d
  const dy = y * k / d
  return { x: dx, y: dy, stretch: 1 / Math.hypot(dx, dy / k) }
}

/** A pace clamped to `[gait.minPace ?? min, max]`, as `NpcSprite.setPace` keeps it. */
export function gaitPace (gait: NpcGait | undefined, pace: number, min: number, max: number): number {
  return Math.min(max, Math.max(gait?.minPace ?? min, pace))
}

/** `RobotSprite`'s numbers the gait clock needs (the class itself fits; it is a pixi module, so the spec passes copies). */
export interface GaitSprite {
  readonly RUN_RATE: number
  readonly STRIDE_SPEED: number
  readonly SCALE: number
}

/**
 * Clip seconds a second of `rig`'s move loop at `pace` (ground speed over
 * `STRIDE_SPEED`), `stretch` from `gaitDirection`: what `NpcSprite.update`
 * adds to its clock. Without a gait, `RUN_RATE x pace`, as every rig ran
 * before. With one, the rate at which a planted foot keeps still east and
 * west: ground speed / (`groundSpeed` x `SCALE` x `sizeScale`), which for
 * the Crawler is `RUN_RATE` x 2.71 x pace. It follows `sizeScale`: a rig
 * drawn 1.25x larger takes 0.8x the steps. Capped at `maxSteps` a second
 * east and west, then stretched for the direction.
 */
export function gaitClock (rig: { readonly gait?: NpcGait, readonly sizeScale: number }, pace: number, stretch: number, sprite: GaitSprite): number {
  const gait = rig.gait
  if (gait === undefined) return sprite.RUN_RATE * pace
  const planted = pace * sprite.STRIDE_SPEED / (gait.groundSpeed * sprite.SCALE * rig.sizeScale)
  return Math.min(planted, gait.maxSteps * gait.period) * stretch
}

/**
 * How far its body is drawn left and right of its ground point, rig units:
 * the x extent of every image of its idle pose (east, in place), contact
 * shadows and emission layers left out. An NPC's body never turns, so one
 * pose stands for it. Where a hit spark may land (`sparkX`; Archie, lane 4
 * F1: the wire `radius` bunched the sparks in the middle of the big NPCs).
 */
export function bodySpan (rig: Pick<NpcRig, 'roles' | 'pose' | 'draw' | 'arts'>): { left: number, right: number } {
  const list = rig.draw(rig.pose(rig.roles.idle, 0, { x: 1, y: 0 }), { inPlace: true })
  let left = Infinity
  let right = -Infinity
  const image = (item: NpcImage): void => {
    if (item.contact === true || item.effect === true) return
    const c = item.clip ?? { x: 0, y: 0, ...rig.arts[item.art] }
    const m = item.m
    for (const [u, v] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]]) {
      const x = m.a * u + m.c * v + m.x
      left = Math.min(left, x)
      right = Math.max(right, x)
    }
  }
  for (const item of list.items) {
    if (item.kind === 'image') image(item)
    else if (item.kind === 'masked') image(item.mask)
  }
  return left <= right ? { left, right } : { left: 0, right: 0 }
}

/**
 * Where across a body a hit spark lands, px from the ground point, for a
 * random `u` in [0, 1): over the middle `SPARK_SPAN` of the drawn body
 * (`span`, px), or without one (a robot, an unrigged mob) `radius` wide
 * about the middle, as before.
 */
export function sparkX (span: { left: number, right: number } | undefined, radius: number, u: number): number {
  if (span === undefined) return (u - 0.5) * radius
  const mid = (span.left + span.right) / 2
  return mid + (u - 0.5) * SPARK_SPAN * (span.right - span.left)
}

/** The share of a body's drawn width hit sparks spread over: its edges are legs and rims. */
export const SPARK_SPAN = 0.7

export interface NpcClip {
  readonly duration: number
  readonly loop: boolean
  /** `leg`: which leg breaks (the Reactor's `leg_break`s). */
  readonly events: ReadonlyArray<{ readonly time: number, readonly name: string, readonly leg?: number }>
}

/** Which clip does what. A clip name is a key of `NpcRig.clips`. */
export interface NpcRoles {
  readonly idle: string
  readonly move: string
  /**
   * Played on the NPC's attack effect, started so that `attack.event` lands
   * when the server's moment does (the Crawler's beam, the Compactor's
   * impact, the Reactor's release). Past its event it gives way to movement
   * (`yieldsToMovement`).
   */
  readonly attack?: { readonly clip: string, readonly event: number }
  /**
   * The package's hit clip. **Never played** (decision #52): a hit is an
   * overlay (`vfx/hitoverlay.ts`), never a body clip. Kept as data so the
   * port and its fixtures still name and check it.
   */
  readonly hit?: string
  /**
   * Played on death; with `deathHolds`, from `death.from` seconds in (the
   * Broodling's blast). With `fromAction` it starts from the pose shown, an
   * attack's included; otherwise from the last idle/move pose.
   */
  readonly death?: { readonly clip: string, readonly from: number, readonly fromAction?: boolean }
  /** Played when it is released (the Broodling on the Brood's effect 19), from `spawn.from` seconds in. */
  readonly spawn?: { readonly clip: string, readonly from: number, readonly ready: number }
  /**
   * Played on its primed tell (the Broodling's effect 17, l1-7), from
   * `prime.from` seconds in, so that the tell's length later it is where
   * `death.from` starts: a death then carries on the same clip.
   */
  readonly prime?: { readonly clip: string, readonly from: number }
}

/** Per-pose parameters a package takes besides the clip and time. */
export interface NpcPoseOptions {
  /** The Broodling's cord length, 0.25-2 times its default (`sample`'s `fuseLength`); undefined is the default. */
  readonly fuseLength?: number
  /**
   * Seconds the sprite has lived, a clock that never resets with the clip
   * (l1-9): the Kiln's furnace and the Brood's lamps run on it, as their
   * packages ask; undefined is the clip's own time (the packages' stateless default).
   */
  readonly clock?: number
}

/** An evaluated pose: the port's own state, opaque to the sprite. */
export interface NpcPose {
  readonly clip: string
  readonly time: number
  /** Where a shot leaves it, rig units, if it shoots. */
  readonly muzzle?: { readonly x: number, readonly y: number }
  readonly state: unknown
}

export interface NpcDrawOptions {
  /** Ignore the clip's own root travel (the Broodling's emerge leaves a socket the game has no place for). */
  readonly inPlace?: boolean
}

/** An image placed by `m`, which maps the art's own pixels (top left 0,0) to rig units; `clip` is a sub-rectangle of the art, in its pixels. */
export interface NpcImage {
  readonly kind: 'image'
  readonly art: string
  readonly m: Matrix
  readonly clip?: { readonly x: number, readonly y: number, readonly w: number, readonly h: number }
  /** Opacity, 0-1; undefined is 1. */
  readonly alpha?: number
  /** A contact shadow painted as an image (the Reactor's, the Compactor's): drawn in turn, never cast. */
  readonly contact?: boolean
  /** An emission layer (the Coil's rings, glow, bloom and heat, l1-9): never cast, never tinted by a hit. */
  readonly effect?: boolean
  /** Composited as the package does it; undefined is normal (source-over). The Coil's bloom is `screen`. */
  readonly blend?: 'screen'
}

/**
 * Images seen only through `mask`'s alpha, as the package composites them
 * offscreen and cuts them with `destination-in` (the Reactor's core through
 * its aperture). Never cast.
 */
export interface NpcMasked {
  readonly kind: 'masked'
  readonly items: readonly NpcImage[]
  readonly mask: NpcImage
}

/** A filled ellipse, rig units. */
export interface NpcEllipse {
  readonly kind: 'ellipse'
  readonly x: number
  readonly y: number
  readonly rx: number
  readonly ry: number
  readonly color: number
  readonly alpha: number
  /** Stroked at this width instead of filled. */
  readonly stroke?: number
  readonly approx?: boolean
}

/** A stroked polyline, rig units: x0, y0, x1, y1... */
export interface NpcLine {
  readonly kind: 'line'
  readonly points: readonly number[]
  readonly width: number
  readonly color: number
  readonly alpha: number
  readonly approx?: boolean
}

/** A filled polygon with an optional outline, rig units. */
export interface NpcPolygon {
  readonly kind: 'polygon'
  readonly points: readonly number[]
  readonly color: number
  readonly alpha: number
  readonly stroke?: { readonly width: number, readonly color: number }
  readonly approx?: boolean
}

export type NpcMark = NpcEllipse | NpcLine | NpcPolygon
export type NpcDrawItem = NpcImage | NpcMasked | NpcMark

/**
 * In draw order. `ground` lies under everything (contact shadows); `items`
 * interleave images and shapes as the package draws them. A shape marked
 * `approx` is a flat stand-in for the package's Canvas gradients and clips
 * (the Crawler's sensor), which the spec does not compare.
 */
export interface NpcDrawList {
  readonly ground: NpcEllipse[]
  readonly items: NpcDrawItem[]
}

/**
 * Whether an action clip `t` seconds in ends when its NPC is moving (A1,
 * decision #52): an attack once past its event (the moment it exists for:
 * the Crawler's shot, the Kiln's launch, the Brood's release, the Coil's
 * hold end, the Reactor's release start, the Compactor's impact), a spawn
 * once it is `ready`. The planted feet would otherwise slide while the body
 * moves on. Before that moment it plays on; a death and a prime never yield.
 */
export function yieldsToMovement (roles: NpcRoles, role: 'attack' | 'death' | 'spawn' | 'prime', t: number): boolean {
  if (role === 'attack') return roles.attack !== undefined && t >= roles.attack.event
  if (role === 'spawn') return roles.spawn !== undefined && t >= roles.spawn.ready
  return false
}

/**
 * How long before an attack clip's event the server's moment is, in seconds,
 * from an effect sent `lifetimeMs` ahead of it (l1-9). The wire floors an
 * effect's lifetime to tenths of a second (`Multiplayer.effectLifetime`), so
 * when the clip's own event falls inside that tenth it is taken as the exact
 * moment: the server's numbers are the clip's (the Compactor's `impactMs`
 * 1215 arrives as 1200; the Reactor's tell, 1000, exactly). Otherwise (a
 * retuned server) the lifetime as received.
 */
export function attackLead (event: number, lifetimeMs: number): number {
  const ms = event * 1000
  return ms >= lifetimeMs && ms < lifetimeMs + 100 ? event : lifetimeMs / 1000
}

export const NPC_RIGS: Readonly<Partial<Record<string, NpcRig>>> = Object.freeze({
  crawler: CRAWLER_RIG,
  broodling: BROODLING_RIG,
  // PROVISIONAL (l1-9): reactor-v6 is delivered but not yet approved by Nick;
  // re-sync after his art review (`tools/npc-rig-sync.mjs reactor`, `tools/bake-npc-atlas.py reactor`).
  reactor: REACTOR_RIG,
  // PROVISIONAL (l1-9): compactor-v4 is delivered but not yet approved by Nick
  // (v3 was); re-sync after his art review (`tools/npc-rig-sync.mjs compactor`, `tools/bake-npc-atlas.py compactor`).
  compactor: COMPACTOR_RIG,
  // PROVISIONAL (l1-9): kiln-v3, coil-v5 and brood-v15 are delivered but not
  // yet approved by Nick (kiln-v2, coil-v4 and brood-v14 were); re-sync after
  // his art review (`tools/npc-rig-sync.mjs <npc>`, `tools/bake-npc-atlas.py <npc>`).
  kiln: KILN_RIG,
  coil: COIL_RIG,
  brood: BROOD_RIG
})
