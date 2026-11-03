import { type GameObject, ObjectType } from '../objects/gameobject'
import type Player from '../objects/player'
import { type RunResult, runXp } from './xp'

/**
 * A run's part in progression (decision #48 step 3): the kills it is credited
 * with, split the way the XP formula pays them. Kept here, keyed by the player
 * object, so `Player` carries nothing for it. (That the run is granted once is
 * `Player.runOver`, set where the run ends, `Multiplayer.destroy`.)
 */
interface Tally {
  playerKills: number
  mobKills: Record<string, number>
}

const tallies = new WeakMap<Player, Tally>()

/** `player` was credited with killing `victim` (`Player.onKill`). */
export function countKill (player: Player, victim: GameObject): void {
  let tally = tallies.get(player)
  if (tally === undefined) {
    tally = { playerKills: 0, mobKills: {} }
    tallies.set(player, tally)
  }
  if (victim.type === ObjectType.Player) {
    tally.playerKills++
    return
  }
  const key = (victim as { archetype?: { key?: string } }).archetype?.key
  if (key === undefined) return
  tally.mobKills[key] = (tally.mobKills[key] ?? 0) + 1
}

/**
 * A first run's kill credit goes on to the shared run its handoff begins
 * (decision #58, retest-4): the kills of `from` are added to `to`'s, so the
 * XP counted at the shared run's end pays them (Dez: "its kills pay normal
 * XP"). `from`'s run never ends as a run (`Player.runOver`), so nothing
 * counts them twice. Time alive and depth are not carried.
 */
export function carryKills (from: Player, to: Player): void {
  const carried = tallies.get(from)
  if (carried === undefined) return
  const tally = tallies.get(to) ?? { playerKills: 0, mobKills: {} }
  tally.playerKills += carried.playerKills
  for (const key in carried.mobKills) tally.mobKills[key] = (tally.mobKills[key] ?? 0) + carried.mobKills[key]
  tallies.set(to, tally)
}

/** What the XP formula reads of a finished run, from the same values `run_end` sends. */
export function runResultOf (player: Player, seconds: number, deepestLayer: number): RunResult {
  const tally = tallies.get(player)
  return {
    extracted: player.extracted,
    loot: Math.floor(player.loot),
    playerKills: tally?.playerKills ?? 0,
    mobKills: tally?.mobKills ?? {},
    deepestLayer,
    seconds
  }
}

/**
 * The XP `player`'s run earns: 0 for a bot or a run on an offline account
 * (#48 build call 9: while the database is down, runs earn nothing).
 */
export function earnedXp (player: Player, offline: boolean, seconds: number, deepestLayer: number): number {
  if (player.bot !== undefined || offline) return 0
  return runXp(runResultOf(player, seconds, deepestLayer))
}
