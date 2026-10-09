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
}

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
   * impact, the Reactor's release). With `refusesHit` a hit never cuts it
   * (the package doesn't support a hit over it): the hit only flashes.
   */
  readonly attack?: { readonly clip: string, readonly event: number, readonly refusesHit?: boolean }
  readonly hit?: string
  /**
   * The idle/move clock stands still while a hit plays, so the hit, which
   * ends exactly on the pose it started from, hands back to the same gait
   * phase (the Reactor's and the Compactor's packages ask for it).
   */
  readonly holdGaitOnHit?: boolean
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
