/**
 * The part of each archetype that the client has to agree on, and the wire id
 * that names it (the `archetype` field, index 16).
 *
 * **Mirrored in the client at the same path and the two copies must stay byte
 * identical**, like `hex.ts` and `path.ts`. `mirror.spec.ts` fails if they
 * drift. The server's full table (`archetypes/archetypes.ts`) takes these
 * fields from here, so nothing in this file is written down twice. The one
 * exception is a robot's `rangedCells`, which restates `RangedAttack.RANGE_CELLS`
 * (see the field).
 *
 * Only what the client needs goes in this file: the id, the key its sprite is
 * looked up by, the kind, the two flags the client will simulate itself
 * (`passesObstacles` for Hopper's prediction, `vision` for Periscope's fog),
 * and the ranged range the client draws a shot at. Stats, skills and AI stay
 * on the server.
 *
 * **Ids are append-only**, like field indices: never reuse or renumber one.
 * 0 means none was sent. Robots are 1-5 (2-5 are reserved for the robots that
 * don't exist yet) and mobs start at 6. A client that meets an id it doesn't
 * know draws that object type's default sprite, so a newer server can't break
 * an older client.
 */

export type ArchetypeKey = 'peep' | 'periscope' | 'magnet' | 'grunt' | 'boss' | 'gunner'

/**
 * A robot's stats as the lobby shows them (robot-select, #42), and the server's
 * archetype rows take them from here, so each is written down once. Magnet's
 * reach is its identity; everything else is #16's table.
 */
export interface RobotStats {
  readonly maxHp: number
  /** The armor pool's size. Its refill stays on the server. */
  readonly armor: number
  /** World units a second. A multiple of 10: `maxVelocity` goes out as /10. */
  readonly speed: number
  /** Rings from its cell within which it picks things up (0 = its own cell). */
  readonly pickupReach: number
  /** One multiplier on all of its skill damage (`Skill.dealt`). */
  readonly damageScale: number
}

export interface ArchetypeInfo {
  readonly id: number
  readonly key: ArchetypeKey
  readonly kind: 'robot' | 'mob'
  /** Hopper (#15). Not read by either side yet (step 6). */
  readonly passesObstacles: boolean
  /**
   * Fog radius in cells (`Hex.distance`), robots only: the client hides units
   * and pickups further than this from its own cell (`fog-of-war`, M2; the
   * client's `src/objects/fog.ts`). Cosmetic (decision #36): the server still
   * sends everything in the interest box. null = no fog. Robots 6, Periscope 11
   * (#43; 8 before). Keep it inside the interest box (`Multiplayer.INTEREST_RADIUS`,
   * 500 units, 11 rings east-west), or the edge of sight shows nothing.
   */
  readonly vision: number | null
  /**
   * RangedAttack's range in cells (decision #25), or null for an archetype
   * without RangedAttack. The client draws a shot's beam this far
   * (`vfx/cells.ts`). The server's gunner override reads it; a robot's range
   * is `RangedAttack.RANGE_CELLS`, which every robot shares through
   * `PLAYER_SKILLS`. effectcells.spec.ts fails if a built skill disagrees.
   */
  readonly rangedCells: number | null
  /** Robots only; null for mobs, whose stats live only on the server. */
  readonly stats: RobotStats | null
}

// Robot ids by the brief's order: peep 1, periscope 2, magnet 3, hopper 4,
// waddle 5 (robot-select, #42). 4 and 5 stay reserved until their robots exist.
export const ARCHETYPE_INFO: Readonly<Record<ArchetypeKey, ArchetypeInfo>> = Object.freeze({
  peep: Object.freeze({
    id: 1, key: 'peep', kind: 'robot', passesObstacles: false, vision: 6, rangedCells: 6,
    stats: Object.freeze({ maxHp: 100, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  }),
  periscope: Object.freeze({
    id: 2, key: 'periscope', kind: 'robot', passesObstacles: false, vision: 11, rangedCells: 6,
    stats: Object.freeze({ maxHp: 80, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  }),
  magnet: Object.freeze({
    id: 3, key: 'magnet', kind: 'robot', passesObstacles: false, vision: 6, rangedCells: 6,
    stats: Object.freeze({ maxHp: 90, armor: 25, speed: 140, pickupReach: 3, damageScale: 1 })
  }),
  grunt: Object.freeze({ id: 6, key: 'grunt', kind: 'mob', passesObstacles: false, vision: null, rangedCells: null, stats: null }),
  boss: Object.freeze({ id: 7, key: 'boss', kind: 'mob', passesObstacles: false, vision: null, rangedCells: null, stats: null }),
  gunner: Object.freeze({ id: 8, key: 'gunner', kind: 'mob', passesObstacles: false, vision: null, rangedCells: 6, stats: null })
})

/** The robots a player may pick at join, by key, in the lobby's order. */
export const SELECTABLE_ROBOTS: readonly ArchetypeKey[] = Object.freeze(['peep', 'periscope', 'magnet'])

/** The entry with this wire id, or undefined for 0 and for any id this build doesn't know. */
export function archetypeById (id: number | undefined): ArchetypeInfo | undefined {
  if (id === undefined || id === 0) return undefined
  for (const key in ARCHETYPE_INFO) {
    const info = ARCHETYPE_INFO[key as ArchetypeKey]
    if (info.id === id) return info
  }
  return undefined
}
