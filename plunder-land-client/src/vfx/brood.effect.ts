import TWEEN from '@tweenjs/tween.js'
import { Graphics } from 'pixi.js'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { type GameObject } from '../objects/gameobject'
import { attackCells, type AttackShape } from './cells'
import { CellHighlight, layerOf } from './cellhighlight'
import { BombEffect } from './bomb.effect'
import { playBlast } from './blast.effect'
import { pickReleased } from './broodpick'

// The Broodling's rig (l1-8) draws its own body, cord, tell and detonate;
// this file is what it doesn't, and the stand-ins for a Broodling whose rig
// sheet hasn't loaded. PLACEHOLDERS for the art pass (decision #51):
// - without the rig, the fuse cord is a short Graphics line over its head
//   that burns down with the fuse left, and `emerge` is a 300 ms fade-in;
//   with it, the rig's cord is as long as the fuse left (`Mob.fuseEndsAt`)
//   and `spawn` plays its emerge;
// - the primed tell (17) also pulses the blast cells like the bomb's fuse;
//   the rig plays its `detonate` from 0.85 s (`roles.prime`, Dez Q9);
// - the blast (18) marks the cells with the bomb's flash and the arena
//   `fx/blast_fire` (the rig's own blast is body-sized);
// - the release (19) is a pod thrown from the Brood to the cell; the Brood's
//   rig (l1-9) would play its 1.10 s `spawn` clip, launch at its 0.18 s
//   event, and drop its unreleased socket children on death.
const FUSE_COLOUR = 0xffb02a
const FUSE_SPENT = 0x3a2a22
const TELL_COLOUR = 0xff3b1f
const BLAST_COLOUR = 0xffa21f
const RELEASE_COLOUR = 0xc06aff
/**
 * The cord's lit length per second of fuse left, in screen units, so its
 * length is the time left whatever the fuse's total (a server-only number):
 * 6 s is 22 units. Capped, should a retune make it long.
 */
const CORD_PER_SECOND = 22 / 6
const CORD_MAX = 30

/** The cells a Broodling's blast covers round `cell`: the server's set (`brood.spec.ts`). */
export function broodlingBlastCells (cell: Vector): Array<{ x: number, y: number }> {
  const attack = ARCHETYPE_INFO.broodling.attack as AttackShape | undefined
  if (attack === undefined) return []
  return attackCells(attack, { x: cell.x, y: cell.y })
}

function blastRings (): number {
  const attack = ARCHETYPE_INFO.broodling.attack
  return attack?.kind === 'disc' ? attack.rings : 1
}

/**
 * The Broodling's fuse cord over its head, burning down over `remainingMs`
 * (the create's `lifetime`, index 9: the server sends the fuse left at the
 * moment this client is sent the Broodling, so a late viewer's cord is
 * already short). Replaces the generic countdown ring a `lifetime` draws on
 * anything else. Removes itself when burnt out or when the Broodling goes.
 */
export function attachFuse (broodling: GameObject, remainingMs: number): void {
  const cord = new Graphics()
  cord.eventMode = 'none'
  cord.y = -broodling.radius * 2.6
  broodling.addChild(cord)

  const full = Math.min(CORD_MAX, CORD_PER_SECOND * remainingMs / 1000)
  const state = { left: 1 }
  const draw = (): void => {
    if (cord.destroyed) return
    const lit = full * state.left
    cord.clear()
    cord.lineStyle(3, FUSE_SPENT, 1).moveTo(0, 0).lineTo(full * 0.25, -full * 0.27)
    if (lit > 0) {
      cord.lineStyle(3, FUSE_COLOUR, 1).moveTo(0, 0).lineTo(lit * 0.25, -lit * 0.27)
      // The ember at the burning end, flickering.
      cord.lineStyle(0).beginFill(0xffe08a, 0.6 + 0.4 * Math.random()).drawCircle(lit * 0.25, -lit * 0.27, 3).endFill()
    }
  }
  draw()
  new TWEEN.Tween(state)
    .to({ left: 0 }, Math.max(remainingMs, 1))
    .onUpdate(() => {
      if (broodling.destroyed) return
      draw()
    })
    .onComplete(() => {
      if (!cord.destroyed) {
        cord.parent?.removeChild(cord)
        cord.destroy()
      }
    })
    .start()
}

/** The Broodling's `emerge` without a rig, placeholder: a short fade-in. */
export function emerge (broodling: GameObject): void {
  broodling.alpha = 0
  new TWEEN.Tween(broodling).to({ alpha: 1 }, 300).start()
}

/** What `emergeReleased` and `primeBroodling` need of a client `Mob` (structural: `Mob` imports the rigs). */
interface BroodlingLike extends GameObject {
  archetype?: { key: string }
  npc?: { play: (role: 'spawn' | 'prime') => boolean }
  createdInFrame: number
}

/**
 * Effect 19: the Broodling the Brood has just released (`pickReleased`: one
 * created in this frame, on the Brood's layer, nearest the release cell)
 * plays its rig's `spawn` (emerge), or the fade-in without a rig. A late
 * viewer, whose create came in an earlier frame, sees no emerge.
 */
export function emergeReleased (mobs: readonly GameObject[], tag: number | undefined, cell: Vector, frame: number): void {
  const mob = pickReleased(mobs as unknown as BroodlingLike[], tag, Hex.toPosition(cell), frame)
  if (mob === undefined) return
  if (mob.npc !== undefined) mob.npc.play('spawn')
  else emerge(mob)
}

/**
 * Effect 17 (l1-7 F5): a rigged Broodling plays its tell, the end of its
 * `detonate` (`roles.prime`), which its death then carries on.
 */
export function primeBroodling (mob: GameObject): void {
  const broodling = mob as BroodlingLike
  if (broodling.archetype?.key === 'broodling') broodling.npc?.play('prime')
}

/**
 * Effect 17, the primed tell, and 18, the blast, on the cell the record
 * carries, over the cells the server damages. Sent by the cell (`effectAt`),
 * so the viewer's layer is the right one; the Broodling is not looked up (by
 * the blast it is gone and its id may be reused).
 */
export class BroodlingEffect {
  constructor (cell: Vector, tag: number | undefined, blast: boolean, lifetime: number) {
    const cells = broodlingBlastCells(cell)
    if (!blast) {
      BombEffect.fuse(tag, cells, lifetime, TELL_COLOUR)
      return
    }
    CellHighlight.flash(tag, cells, BLAST_COLOUR, Math.max(lifetime, 300))
    const layer = layerOf(tag)
    if (layer !== undefined) playBlast(layer, cell, blastRings(), 'fx/blast_fire')
  }
}

/**
 * Effect 19: the Brood releases a Broodling onto `cell` (the record's aim).
 * Sent to the Brood's holders (`effect`), so the Brood is held here.
 */
export class BroodReleaseEffect {
  constructor (brood: GameObject, cell: Vector | undefined, lifetime: number) {
    const duration = Math.max(lifetime, 100)
    if (cell !== undefined) CellHighlight.flash(brood.tag, [{ x: cell.x, y: cell.y }], RELEASE_COLOUR, duration)

    const layer = layerOf(brood.tag)
    if (layer === undefined) return
    const ring = new Graphics()
    ring.eventMode = 'none'
    const from = { x: brood.x, y: brood.y }
    const to = cell !== undefined ? Hex.toPosition(cell) : from
    ring.x = from.x
    ring.y = from.y
    ring.zIndex = from.y + 1
    layer.addChild(ring)
    const state = { t: 0 }
    new TWEEN.Tween(state)
      .to({ t: 1 }, duration)
      .onUpdate(() => {
        // A pod thrown from the Brood to the cell, growing as it lands.
        ring.clear()
        ring.beginFill(RELEASE_COLOUR, 0.8 * (1 - state.t * 0.5)).drawCircle(0, 0, 5 + 6 * state.t).endFill()
        ring.x = from.x + (to.x - from.x) * state.t
        ring.y = from.y + (to.y - from.y) * state.t - 60 * 4 * state.t * (1 - state.t)
      })
      .onComplete(() => {
        ring.parent?.removeChild(ring)
        ring.destroy()
      })
      .start()
  }
}
