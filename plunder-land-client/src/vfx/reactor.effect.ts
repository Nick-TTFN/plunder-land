import { type Container } from 'pixi.js'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { ARCHETYPE_INFO } from '../utils/archetypes'
import { RobotSprite } from '../robots/robotsprite'
import { activationPose } from '../npcs/reactor/rig'
import { type AttackShape, attackCells } from './cells'
import { layerOf } from './cellhighlight'
import { FxSprite, burstCells, discard, runFor, standAt, warnCells } from './npcfx'

/** Fallback colours, drawn as cell highlights only while the effects sheet hasn't loaded. */
const TELL_COLOUR = 0xff5a1f
const RELEASE_COLOUR = 0xffd21f

/**
 * What the flare needs of a client `Mob` (structural: `Mob` imports the
 * rigs, and this file is imported by `game.ts` beside it): its rig's scale,
 * and where its feet are below its position (`Mob.NPC_FEET_Y`).
 */
export interface ReactorLike extends Container {
  npc?: { npc: { key: string, sizeScale: number }, destroyed: boolean }
  feetY: number
  killed: boolean
}

/** When the release starts in the rig's `activate` clip (`release_start`), seconds. */
const RELEASE_START_S = 1

/**
 * The Reactor's burst (decision #51, l1-5) on the disc round its planted cell:
 * every cell within the mirror's `attack.rings` (`ARCHETYPE_INFO.reactor`),
 * which is the set the server's pulses hit (`mobskills/reactorburst.ts`,
 * `World.FIND_IN_CELLS`; `reactorburst.spec.ts` checks the two). Art: Codex
 * `npc-fx-v1` (l1-11).
 *
 * `release` false is the tell (effect 11): the package has no art of its own
 * for it, so the cells carry the shared warning (`warnCells`), one cycle over
 * `lifetime`. The release (12) is its own record, sent when the server starts
 * dealing damage: `reactor-release-cell` on every cell and
 * `reactor-core-flare` from the Reactor's core, both over `lifetime` (the
 * package's 1 s, `release_start` to `release_end`).
 *
 * The flare follows the core: `activationPose(t).attachments.coreScreen` of
 * the rig, as the contract asks, with `t` from `release_start` on (the rig's
 * clip is put back in step there by effect 12, `Mob.playAttack(0)`), placed
 * as `NpcSprite` places the rig. A Reactor this client doesn't hold, or one
 * drawn without its rig, gets the flare on its cell instead.
 *
 * `dead` says whether the Reactor has been seen to die (destroy with hp 0).
 * The server stops a Reactor's burst the moment it dies, so a tell or release
 * still showing then would promise damage that never comes: either ends at
 * once. A Reactor this client doesn't hold (out of sight, the effect is sent by
 * the cell) is never seen to die, and its effect plays out.
 */
export class ReactorEffect {
  constructor (cell: Vector, tag: number | undefined, release: boolean, lifetime: number, dead: () => boolean, reactor?: ReactorLike) {
    const attack = ARCHETYPE_INFO.reactor.attack as AttackShape | undefined
    if (attack === undefined) return
    const centre = { x: cell.x, y: cell.y }
    const cells = attackCells(attack, centre)

    if (!release) {
      warnCells(tag, cells, centre, lifetime, TELL_COLOUR, dead)
      return
    }

    burstCells(tag, cells, 'fx/reactor-release-cell', lifetime, RELEASE_COLOUR, undefined, dead)
    ReactorEffect.flare(tag, cell, lifetime, dead, reactor)
  }

  private static flare (tag: number | undefined, cell: Vector, lifetime: number, dead: () => boolean, reactor: ReactorLike | undefined): void {
    if (!FxSprite.ready()) return
    const rig = reactor?.npc
    if (reactor === undefined || rig === undefined || rig.destroyed || rig.npc.key !== 'reactor') {
      const layer = layerOf(tag)
      if (layer === undefined) return
      const at = Hex.toPosition(cell)
      const flare = standAt(layer, 'fx/reactor-core-flare', at.x, at.y)
      runFor(lifetime, (elapsed) => { flare.through(elapsed / Math.max(lifetime, 1)) }, () => { discard(flare) }, dead)
      return
    }

    // A child of the Reactor, so it moves and fogs with it; drawn over its rig.
    const flare = new FxSprite('fx/reactor-core-flare')
    reactor.addChild(flare)
    const px = RobotSprite.SCALE * rig.npc.sizeScale
    runFor(lifetime, (elapsed) => {
      const core = activationPose(RELEASE_START_S + elapsed / 1000).attachments?.coreScreen
      if (core !== undefined) flare.position.set(core.x * px, reactor.feetY + core.y * px)
      flare.through(elapsed / Math.max(lifetime, 1))
    // `killed`, not `destroyed`: a unit is never pixi-destroyed (`dispose` scales it away and removes it).
    }, () => { discard(flare) }, () => dead() || reactor.killed)
  }
}
