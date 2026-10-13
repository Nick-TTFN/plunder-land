import { Sfx, type Point, type SfxName, type Voice } from './sfx'
import { NPC_EFFECT } from '../vfx/npceffects'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

/**
 * What the game's events sound like (`sfx.ts` holds the sounds). Called from
 * `Game` with plain values, so the sound logic stays here: the extraction
 * loop, the low-HP ticker and the NPC wind-ups cut at their impact.
 *
 * Client timers (`setTimeout`) are fine here: nothing in the world depends
 * on them, and a sound that outlives its run by a moment is harmless.
 */

/** At or below this share of max HP, your robot ticks a warning. */
const LOW_HP = 0.3
const LOW_HP_TICK_MS = 650
const EXTRACT_TICK_MS = 1000
/** How long the Kiln's thruster runs at the launch (its file is a 5 s loop), ms. */
const KILN_LAUNCH_MS = 600

let extractLoop: Voice | undefined
let extractTicker: ReturnType<typeof setInterval> | undefined
let lowHpTicker: ReturnType<typeof setInterval> | undefined

function stopExtract (): void {
  extractLoop?.stop(120)
  extractLoop = undefined
  if (extractTicker !== undefined) clearInterval(extractTicker)
  extractTicker = undefined
}

function stopLowHp (): void {
  if (lowHpTicker !== undefined) clearInterval(lowHpTicker)
  lowHpTicker = undefined
}

const cellAt = (cell: Vector | undefined): Point | undefined => cell === undefined ? undefined : Hex.toPosition(cell)

/** A wind-up from now to its impact `ms` later, then the impact. */
function windUp (windup: SfxName, impact: SfxName | undefined, at: Point, impactAt: Point | undefined, ms: number): void {
  const voice = Sfx.play(windup, { at, loop: true })
  setTimeout(() => {
    voice.stop(80)
    if (impact !== undefined) Sfx.play(impact, { at: impactAt ?? at })
  }, Math.max(0, ms))
}

export const GameSfx = {
  /**
   * An effect record (`Game.onEffect`): `origin` is its unit's position when
   * this client holds it. A ranged shot (3) sounds where its beam fires
   * (`RangedAttackEffect.fire`), not here.
   */
  effect (type: number, origin: Point | undefined, aimCell: Vector | undefined, lifetime: number, launchMs: number = 0): void {
    // Every effect sound is placed: without its unit or its cell it isn't
    // played, rather than played at full volume.
    const aim = cellAt(aimCell)
    const near = (name: SfxName, at: Point | undefined, gain?: number): void => { if (at !== undefined) Sfx.play(name, { at, gain }) }
    switch (type) {
      case 0: case 1: near('skill_heavy', origin); break
      case 2: near('melee_swing', origin); break
      case 5: case 6: case 8: near('blast', aim); break
      case NPC_EFFECT.reactorTell: if (aim !== undefined) windUp('reactor_windup', undefined, aim, undefined, lifetime); break
      case NPC_EFFECT.reactorRelease: near('blast', aim, 1.3); break
      case NPC_EFFECT.kilnLob:
        if (origin === undefined) break
        setTimeout(() => {
          const v = Sfx.play('kiln_launch', { at: origin })
          setTimeout(() => { v.stop(150) }, KILN_LAUNCH_MS)
        }, launchMs)
        break
      case NPC_EFFECT.kilnBlast: near('kiln_land', aim); break
      case NPC_EFFECT.coilPulse: near('coil_pulse', aim); break
      case NPC_EFFECT.broodlingPrimed: near('broodling_fuse', aim); break
      case NPC_EFFECT.broodlingBlast: near('broodling_blast', aim); break
      case NPC_EFFECT.compactorSlam: if (origin !== undefined) windUp('compactor_windup', 'compactor_slam', origin, aim, lifetime); break
    }
  },

  /** A ranged beam leaving its caster: a mob's (the Crawler's) a little lower. */
  shot (from: Point, mob: boolean): void {
    Sfx.play('shot_ranged', { at: from, rate: mob ? 0.85 : 1 })
  },

  /** A projectile appearing (fireball, icicle). */
  projectile (at: Point): void {
    Sfx.play('skill_heavy', { at })
  },

  /** A unit's HP fell: yours (`own`) is damage taken, anyone else's a hit. */
  hurt (at: Point, own: boolean): void {
    if (own) Sfx.play('damage_taken')
    else Sfx.play('hit_landed', { at })
  },

  /** Your robot's HP share now: below `LOW_HP` (and alive) it ticks until it isn't. */
  ownHealth (share: number): void {
    const low = share > 0 && share <= LOW_HP
    if (low && lowHpTicker === undefined) {
      Sfx.play('low_hp')
      lowHpTicker = setInterval(() => { Sfx.play('low_hp') }, LOW_HP_TICK_MS)
    } else if (!low) {
      stopLowHp()
    }
  },

  ownKill (): void { Sfx.play('kill') },
  ownLoot (): void { Sfx.play('loot_pickup') },
  ownGear (): void { Sfx.play('gear_pickup') },
  ownLayer (): void { Sfx.play('portal') },

  /** Your extraction's progress, 0 when not extracting: a loop and a tick a second while it runs. */
  ownExtract (progress: number): void {
    if (progress > 0 && extractLoop === undefined) {
      extractLoop = Sfx.play('extract_loop', { loop: true })
      Sfx.play('extract_tick')
      extractTicker = setInterval(() => { Sfx.play('extract_tick') }, EXTRACT_TICK_MS)
    } else if (progress === 0) {
      stopExtract()
    }
  },

  /** Your robot is gone: died, or extracted. */
  ownGone (dead: boolean): void {
    stopExtract()
    stopLowHp()
    if (dead) {
      Sfx.play('death')
      Sfx.play('death_sting')
    } else {
      Sfx.play('extract_done')
    }
  },

  /** A new run: nothing carried over. */
  runStart (): void {
    stopExtract()
    stopLowHp()
  }
}
