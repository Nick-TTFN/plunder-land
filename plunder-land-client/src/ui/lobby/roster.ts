import { ARCHETYPE_INFO, SELECTABLE_ROBOTS, type RobotStats } from '../../utils/archetypes'

/**
 * The five robots the lobby shows (lobby-rework, decision #42), in the brief's
 * order. Lobby copy only: what a robot *does* is the mirrored archetype table,
 * whose `stats` the stat bars read, so the lobby can't show a number the
 * server doesn't play. All five are playable since 2026-10-01 (Hopper and
 * Waddle last; until then they were shown locked).
 *
 * The class lines and taglines other than Peep's (the mockup's) are Claude's
 * placeholder copy, 2026-10-01; Nick may replace them.
 */
export interface RosterEntry {
  readonly key: string
  readonly name: string
  /** The small line over the name ("BALANCED"). */
  readonly kind: string
  readonly tagline: string
  /** The archetype key when it can be picked; undefined while locked. */
  readonly robot: 'peep' | 'periscope' | 'magnet' | 'hopper' | 'waddle' | undefined
}

export const ROSTER: readonly RosterEntry[] = Object.freeze([
  { key: 'peep', name: 'PEEP', kind: 'BALANCED', tagline: 'A little bot. A lot of possibility.', robot: 'peep' },
  { key: 'periscope', name: 'PERISCOPE', kind: 'SCOUT', tagline: 'Sees the trouble first.', robot: 'periscope' },
  { key: 'magnet', name: 'MAGNET', kind: 'COLLECTOR', tagline: 'Loot comes to it.', robot: 'magnet' },
  { key: 'hopper', name: 'HOPPER', kind: 'JUMPER', tagline: 'Over walls, not around them.', robot: 'hopper' },
  { key: 'waddle', name: 'WADDLE', kind: 'TANK', tagline: 'Slow to arrive. Slower to leave.', robot: 'waddle' }
] as RosterEntry[])

/** The entries a player can pick, in roster order. */
export const PICKABLE: readonly RosterEntry[] = ROSTER.filter((r) => r.robot !== undefined && (SELECTABLE_ROBOTS as readonly string[]).includes(r.robot))

export function statsOf (entry: RosterEntry): RobotStats | null {
  return entry.robot !== undefined ? ARCHETYPE_INFO[entry.robot].stats : null
}

export function visionOf (entry: RosterEntry): number | null {
  return entry.robot !== undefined ? ARCHETYPE_INFO[entry.robot].vision : null
}

/**
 * The stat bars, each scaled to a fixed top so a bar means the same length for
 * every robot (and for robots still to come): the top is a little above the
 * largest value #16's table plans for any robot.
 */
export interface StatBar {
  readonly label: string
  readonly value: (e: RosterEntry) => number | null
  readonly top: number
  readonly text: (v: number) => string
}

export const STAT_BARS: readonly StatBar[] = Object.freeze([
  { label: 'SPEED', value: (e) => statsOf(e)?.speed ?? null, top: 160, text: (v) => `${v}` },
  { label: 'ARMOR', value: (e) => statsOf(e)?.armor ?? null, top: 100, text: (v) => `${v}` },
  { label: 'HP', value: (e) => statsOf(e)?.maxHp ?? null, top: 140, text: (v) => `${v}` },
  { label: 'DAMAGE', value: (e) => statsOf(e)?.damageScale ?? null, top: 1.5, text: (v) => `x${v.toFixed(1)}` },
  { label: 'PICKUP', value: (e) => statsOf(e)?.pickupReach ?? null, top: 3, text: (v) => `${v} ${v === 1 ? 'ring' : 'rings'}` },
  { label: 'VISION', value: (e) => visionOf(e), top: 12, text: (v) => `${v} cells` }
])
