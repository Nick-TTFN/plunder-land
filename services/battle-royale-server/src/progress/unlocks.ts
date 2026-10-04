import { type Account } from '../db/accounts'
import { type ArchetypeKey, robotUnlocked } from '../utils/archetypes'
import { finishFromBytes, finishToBytes, lockFinish } from '../utils/finishes'
import { levelOf } from './xp'

/**
 * Robot and finish locks at a join (decision #48 step 5). Pure: no I/O. The
 * unlock levels are on the mirrored rows (`utils/archetypes.ts`,
 * `utils/finishes.ts`), so the lobby locks exactly what is locked here.
 *
 * **A join is never refused**: a locked robot plays Peep, a locked colour or
 * pattern becomes that group's default. Applied once, in
 * `Multiplayer.startRequested`, the one human join path. Not in
 * `World.robotFor`, `createPlayer` or `Player`, which bots join through: bots
 * ignore locks.
 */

/**
 * The account level a join's locks are checked at: `levelOf(account.xp)` for a
 * stored account, 1 for an offline one (the store failed; it earns nothing,
 * and fails closed like `kitFor`'s start kit).
 *
 * **No account at all is `Infinity`, no locks, on purpose.** That path is only
 * reachable with `World.strict` off: single-world specs joining through
 * `onConnect`, many of which pick a robot or finish. The server and every
 * `Worlds` spec run strict, where a start without an account is ignored. This
 * is the one place it differs from `kitFor` (start kit with no account).
 */
export function joinLevel (account: Account | undefined): number {
  if (account === undefined) return Infinity
  if (!account.persisted) return 1
  return levelOf(account.xp)
}

/**
 * What a join on `account` asking for `robot` and `finish` plays: the robot if
 * it is selectable and the account's level has it (`robotUnlocked`), else Peep,
 * which is `World.robotFor`'s answer narrowed by the level; and the finish
 * decoded (`finishFromBytes`), locked (`lockFinish`) and as wire bytes.
 */
export function lockedStart (account: Account | undefined, robot: unknown, finish: unknown): { robot: ArchetypeKey, finish: number[] } {
  const level = joinLevel(account)
  return {
    robot: robotUnlocked(robot, level) ? robot as ArchetypeKey : 'peep',
    finish: finishToBytes(lockFinish(finishFromBytes(finish), level))
  }
}
