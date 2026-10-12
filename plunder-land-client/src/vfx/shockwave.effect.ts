import { type GameObject } from '../objects/gameobject'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { Session } from '../net/session'
import { TILT } from '../objects/tilt'
import { type AttackShape, type Cell, DIRECTIONS, attackCells, directionToward, lineFromTip } from './cells'
import { CellHighlight, cellOf, directionVector, facingOf, layerOf } from './cellhighlight'
import { FxSprite, discard, runFor, stampCells, standAt, warnCells } from './npcfx'

/** Fallback colours, drawn as cell highlights only while the effects sheet hasn't loaded. */
const WARN_COLOUR = 0xffb347
const IMPACT_COLOUR = 0xff5a2a
const IMPACT_FLASH_MS = 350

/**
 * The old line's length. The mirror's Compactor row is a disc since pve-2,
 * so effect 14 (sent only by an older server, during the deploy) keeps the
 * line it was built with here. Goes with `ShockwaveEffect`.
 */
const LEGACY_LINE_LENGTH = 3

/**
 * A Compactor's shockwave line (effect 14, decision #51). **Kept for one
 * release only (pve-2)**: no current server sends 14 (the slam is the disc of
 * effect 20, `CompactorSlamEffect`); it draws the line for a new client on
 * an old server between the two deploys. Delete it, its `game.ts` case and
 * the mirror's `line` attack kind in the follow-up. Art: Codex `npc-fx-v1`
 * (l1-11). The cells are worked back from the tip the record carries
 * (`lineFromTip`), so they are the server's cells even if the client places
 * the Compactor a cell off. They don't follow the Compactor: the server
 * fixes the line at the cast.
 *
 * Through the wind-up (the record's lifetime, cast to impact) the line
 * carries the shared warning (`warnCells`; the package has no wind-up art).
 * At the impact `compactor-shoe-puff` stands at the Compactor and
 * `compactor-wave-cell` runs out along the line: one per cell, turned to the
 * line's direction in the ground plane, each starting the clip's `chain`
 * delay (`meta.clips`, 0.25 s) after the one before, at the clip's own rate.
 */
export class ShockwaveEffect {
  constructor (owner: GameObject, lifetime: number, tip: Vector | undefined) {
    if (tip === undefined) return
    const from = cellOf(owner)
    const cells: Cell[] = lineFromTip(from, tip, LEGACY_LINE_LENGTH, (q, r) => Hex.onMap(q, r, Session.mapSize))
    if (cells.length === 0) return
    const tag = owner.tag
    const windUp = Math.max(0, lifetime)

    warnCells(tag, cells, undefined, windUp, WARN_COLOUR)

    const layer = layerOf(tag)
    if (layer === undefined) return
    const step = DIRECTIONS[directionToward(from, tip)]
    const way = Hex.toPosition(new Vector(step.x, step.y))
    const rotation = Math.atan2(way.y, way.x)
    const shoe = { x: owner.x, y: owner.y }

    // Everything about the impact's art is read at the impact, not the cast:
    // the sheet may land during the wind-up.
    const impact = (): void => {
      if (!FxSprite.ready()) {
        CellHighlight.flash(tag, cells, IMPACT_COLOUR, IMPACT_FLASH_MS)
        return
      }
      const delay = (FxSprite.meta('fx/compactor-wave-cell')?.chain?.cellDelay ?? 0.25) * 1000
      const wave = stampCells(layer, 'fx/compactor-wave-cell', cells, rotation)
      const puff = standAt(layer, 'fx/compactor-shoe-puff', shoe.x, shoe.y)
      // Until the last cell's clip ends, and the puff's.
      const waveMs = Math.max((cells.length - 1) * delay + 1000 * wave.decals[0].duration, 1000 * puff.duration)
      runFor(waveMs, (since) => {
        wave.decals.forEach((decal, i) => {
          const own = since - i * delay
          decal.visible = own >= 0
          decal.at(own / 1000)
        })
        puff.at(since / 1000)
      }, () => {
        discard(wave.group)
        discard(puff)
      })
    }
    runFor(windUp, () => {}, impact)
  }
}

/**
 * A Compactor's slam (effect 20, pve-2): the disc of the mirror's
 * `ARCHETYPE_INFO.compactor.attack` rings round the centre cell the record
 * carries, which is the set the server hits (`mobskills/shockwave.ts`,
 * `World.FIND_IN_CELLS`; `shockwave.spec.ts` checks the two for a cast
 * mid-step, the Compactor drawn a cell off). It doesn't follow the Compactor: the server
 * fixes the disc at the cast. Art: Codex `npc-fx-v1` (l1-11), no new art
 * (PROVISIONAL for Nick's look in play).
 *
 * Through the wind-up (the record's lifetime, cast to impact) the disc
 * carries the shared warning (`warnCells`, the centre marked). At the impact
 * `compactor-shoe-puff` stands at the Compactor and `compactor-wave-cell`
 * runs outward ring by ring: one per cell off the centre, turned outward from
 * the centre in the ground plane, each ring starting the clip's `chain`
 * delay (`meta.clips`, 0.25 s) after the one inside it. A Compactor seen to
 * die during the wind-up (the server cancels the slam then) ends the warning
 * and draws no impact.
 */
export class CompactorSlamEffect {
  /** Where the strike clip aims, as a world point: one unit along `owner`'s reported facing (`facingOf`). */
  static strikeAim (owner: GameObject): { x: number, y: number } {
    const facing = directionVector(facingOf(owner))
    return { x: owner.x + facing.x, y: owner.y + facing.y }
  }

  constructor (owner: GameObject, lifetime: number, centre: Vector | undefined) {
    if (centre === undefined) return
    const attack = ARCHETYPE_INFO.compactor.attack as AttackShape | undefined
    if (attack === undefined) return
    const middle: Cell = { x: centre.x, y: centre.y }
    const cells = attackCells(attack, middle).filter((c) => Hex.onMap(c.x, c.y, Session.mapSize))
    if (cells.length === 0) return
    const tag = owner.tag
    const windUp = Math.max(0, lifetime)
    const dead = (): boolean => (owner as unknown as { killed?: boolean }).killed === true

    warnCells(tag, cells, middle, windUp, WARN_COLOUR, dead)

    const layer = layerOf(tag)
    if (layer === undefined) return
    const from = Hex.toPosition(centre)
    // The wave's cells, ring by ring outward, without the centre (the puff's).
    const wave = cells
      .map((c) => ({ cell: c, ring: Hex.distance(new Vector(c.x, c.y), centre) }))
      .filter((w) => w.ring > 0)
      .sort((a, b) => a.ring - b.ring)
    const shoe = { x: owner.x, y: owner.y }

    // Everything about the impact's art is read at the impact, not the cast:
    // the sheet may land during the wind-up.
    const impact = (): void => {
      if (dead()) return
      if (!FxSprite.ready()) {
        CellHighlight.flash(tag, cells, IMPACT_COLOUR, IMPACT_FLASH_MS)
        return
      }
      const delay = (FxSprite.meta('fx/compactor-wave-cell')?.chain?.cellDelay ?? 0.25) * 1000
      const stamped = stampCells(layer, 'fx/compactor-wave-cell', wave.map((w) => w.cell))
      stamped.decals.forEach((decal, i) => {
        const at = Hex.toPosition(new Vector(wave[i].cell.x, wave[i].cell.y))
        decal.rotation = Math.atan2(at.y - from.y, at.x - from.x)
      })
      const puff = standAt(layer, 'fx/compactor-shoe-puff', shoe.x, shoe.y)
      const lastRing = wave.length > 0 ? wave[wave.length - 1].ring : 1
      const clipMs = stamped.decals.length > 0 ? 1000 * stamped.decals[0].duration : 0
      // Until the outer ring's clip ends, and the puff's.
      const waveMs = Math.max((lastRing - 1) * delay + clipMs, 1000 * puff.duration)
      runFor(waveMs, (since) => {
        stamped.decals.forEach((decal, i) => {
          const own = since - (wave[i].ring - 1) * delay
          decal.visible = own >= 0
          decal.at(own / 1000)
        })
        puff.at(since / 1000)
      }, () => {
        discard(stamped.group)
        discard(puff)
      })
    }
    runFor(windUp, () => {}, impact, dead)
  }
}

/**
 * A knockback (effect 15, aimed at the landing cell): `knockback-skid`
 * (Codex `npc-fx-v1`, l1-11) at the victim's feet, a child of it so it slides
 * with the victim, its trail pointing back the way it came, over the record's
 * lifetime. The move itself is interpolation for a remote player and
 * `LocalPlayer.knockback` for our own. Without the sheet, a short flash on the
 * landing cell.
 */
export class KnockbackEffect {
  constructor (owner: GameObject, lifetime: number, landing: Vector | undefined) {
    if (landing === undefined) return
    if (!FxSprite.ready()) {
      CellHighlight.flash(owner.tag, [{ x: landing.x, y: landing.y }], 0xffffff, Math.max(lifetime, 200))
      return
    }
    const to = Hex.toPosition(landing)
    let dx = to.x - owner.x
    let dy = to.y - owner.y
    if (Math.hypot(dx, dy) < 1) {
      // Already drawn on the landing (our own player, moved this frame): its facing will do.
      const facing = directionVector(facingOf(owner))
      dx = facing.x
      dy = facing.y
    }
    const skid = new FxSprite('fx/knockback-skid')
    skid.y = (owner as unknown as { feetY?: number }).feetY ?? 0
    // A child of an upright unit draws in screen space: the push as the camera shows it.
    skid.rotation = Math.atan2(dy * TILT, dx)
    owner.addChild(skid)
    const duration = Math.max(lifetime, 100)
    runFor(duration, (elapsed) => { skid.through(elapsed / duration) }, () => { discard(skid) })
  }
}
