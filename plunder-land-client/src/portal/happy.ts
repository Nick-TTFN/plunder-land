import type { PortalSdk } from './adapter'

/**
 * When the portal celebrates (`happytime`, g2-6f; decision #62 Q5): on an
 * account level-up and on the account's first extraction ever, at most once
 * per run's end, and never for anything else. CrazyGames: "Use this feature
 * sparingly" (sdk/game, read 2026-11-13). No `reportGameCompletedPercentage`
 * (Q5: the game is endless).
 *
 * "Ever" is per browser: the accounts that have had their first-extraction
 * celebration are remembered in localStorage (`HAPPY_KEY`); the server keeps no
 * lifetime extraction count the client sees. So the same account on another
 * browser (or after storage is cleared) is celebrated once more there. A
 * storage that can't be read or written celebrates nothing (it fails quiet,
 * never repeatedly).
 *
 * Pixi-free and `window`-free.
 */
export const HAPPY_KEY = 'plunderland_first_extraction'

/** The most account ids remembered; the oldest go first. */
const HAPPY_MAX = 20

export interface HappyStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** The remembered account ids, or undefined if storage can't be read. */
function readIds (storage: HappyStorage): string[] | undefined {
  let raw: string | null
  try {
    raw = storage.getItem(HAPPY_KEY)
  } catch {
    return undefined
  }
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export class Happy {
  /** A celebration was sent since the last run began. */
  private spent = false

  constructor (private readonly sdk: Pick<PortalSdk, 'happytime'>, private readonly storage: () => HappyStorage | undefined) {}

  /** A run began: its end may celebrate once. */
  runStarted (): void {
    this.spent = false
  }

  /** The run's XP landed (`progress`): `levelUp` is the server's. */
  progress (levelUp: boolean): void {
    if (levelUp) this.celebrate()
  }

  /** The own player extracted. `accountId` undefined (no account, offline) celebrates nothing. */
  extracted (accountId: string | undefined): void {
    if (accountId === undefined || accountId === '') return
    const storage = this.storage()
    if (storage === undefined) return
    const ids = readIds(storage)
    if (ids === undefined || ids.includes(accountId)) return
    try {
      storage.setItem(HAPPY_KEY, JSON.stringify([...ids, accountId].slice(-HAPPY_MAX)))
    } catch {
      // Not remembered: no celebration, or it would come again every run.
      return
    }
    this.celebrate()
  }

  private celebrate (): void {
    if (this.spent) return
    this.spent = true
    this.sdk.happytime()
  }
}
