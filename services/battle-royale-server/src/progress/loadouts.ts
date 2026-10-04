import { type Account } from '../db/accounts'
import { SELECTABLE_ROBOTS, robotUnlocked } from '../utils/archetypes'
import { START_KIT, checkLoadout, loadoutSlotsAt } from '../utils/skills'
import { levelOf } from './xp'

/**
 * Which skills a join plays, and what may be saved (decision #48 step 4).
 * Pure: no I/O. The rule itself is `checkLoadout` in the mirrored
 * `utils/skills.ts`, so the lobby greys out exactly what is refused here.
 *
 * **The level is the account's, `levelOf(account.xp)`, never `Unit.level`**,
 * which indexes skill damage and stays 1. **Any failure gives the whole start
 * kit**, never a partly kept loadout and never a refused join.
 */

/** Whether `index` is a loadout an account of `level` has. */
function indexOk (index: unknown, level: number): index is number {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < loadoutSlotsAt(level)
}

/**
 * The 4 skill ids a join on `account` with `robotKey` and loadout `index`
 * plays: the stored row, checked against the account's level now; else the
 * start kit (no account or an offline one, an index past the level's
 * loadouts or malformed, no row, a row that fails `checkLoadout`). A fresh
 * array.
 */
export function kitFor (account: Account | undefined, robotKey: string, index: unknown): number[] {
  if (account === undefined || !account.persisted) return [...START_KIT]
  const level = levelOf(account.xp)
  if (!indexOk(index, level)) return [...START_KIT]
  const row = account.loadouts.find((l) => l.robot === robotKey && l.index === index)
  if (row === undefined) return [...START_KIT]
  return checkLoadout(row.skills, level) ?? [...START_KIT]
}

/** A save that passed: what to store. */
export interface LoadoutSave {
  robot: string
  index: number
  skills: number[]
}

/**
 * A `save_loadout` payload (`{ robot, index, skills }`) for an account of
 * `level`, or undefined: `robot` a key in `SELECTABLE_ROBOTS` that the level
 * has unlocked (`robotUnlocked`, #48 step 5), `index` a loadout the level has,
 * and `skills` passing `checkLoadout`.
 */
export function parseSave (data: unknown, level: number): LoadoutSave | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const { robot, index, skills } = data as { robot?: unknown, index?: unknown, skills?: unknown }
  if (typeof robot !== 'string' || !robotUnlocked(robot, level)) return undefined
  if (!indexOk(index, level)) return undefined
  const checked = checkLoadout(skills, level)
  if (checked === undefined) return undefined
  return { robot, index, skills: checked }
}

/**
 * What the lobby is told (`account.loadouts`): for every selectable robot and
 * every loadout the account's level has, what a join would really play
 * (`kitFor`), so the lobby never shows a loadout the server won't run.
 *
 * **Locked robots are included, with their stored rows** (#48 step 5): the
 * account is sent only on connect, so leaving them out would hide a robot
 * unlocked mid-connection until the next one; and a row saved before locks
 * existed is what a join plays once the robot opens, so showing the start kit
 * instead would show a loadout the server won't run. A locked robot's card
 * can't be picked in the lobby, and `parseSave` refuses a new row for it.
 */
export function loadoutsFor (account: Account): Record<string, number[][]> {
  const slots = loadoutSlotsAt(levelOf(account.xp))
  const out: Record<string, number[][]> = {}
  for (const robot of SELECTABLE_ROBOTS) {
    out[robot] = Array.from({ length: slots }, (_, index) => kitFor(account, robot, index))
  }
  return out
}
