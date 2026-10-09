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
 * 0 means none was sent. Robots are 1-5 and mobs start at 6. A client that meets an id it doesn't
 * know draws that object type's default sprite, so a newer server can't break
 * an older client.
 *
 * Mobs 6-8 (grunt, boss, gunner) are retired by the NPC roster (decision #51,
 * L1): their rows stay, ids reserved, but no layer spawns them. An old server
 * during a drain still sends them, and specs use them as plain test mobs. The
 * seven NPCs are 9-15.
 */

export type ArchetypeKey = 'peep' | 'periscope' | 'magnet' | 'hopper' | 'waddle' | 'grunt' | 'boss' | 'gunner' |
'crawler' | 'kiln' | 'reactor' | 'coil' | 'compactor' | 'brood' | 'broodling'

/**
 * A mob's rarity (decision #51, Nick 2026-10-07): the same Common / Rare /
 * Epic / Legendary scale as gear tiers. null for robots and for the retired
 * grunt, gunner and boss. The server credits kills by it (`<rarity>Kills`) and
 * keeps players from spawning next to an epic or legendary mob.
 */
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'

/**
 * The cells an NPC's own attack covers, so the client draws and threat-marks
 * the cells the server hits (`vfx/cells.ts` `attackCells`, checked by
 * `effectcells.spec.ts`). Rings are `Hex.distance` and include the boundary.
 * A Crawler's shot has no entry: its line is `rangedCells`, as a robot's.
 */
export type NpcAttack =
  /** Kiln: lobbed at a cell at most `range` away; the blast is that cell and `rings` rings round it. */
  | { readonly kind: 'lob', readonly range: number, readonly rings: number }
  /** Reactor burst, Coil field, Broodling blast: every cell within `rings` of the NPC's own cell. */
  | { readonly kind: 'disc', readonly rings: number }
  /** Compactor: `length` cells in a straight line out of its cell, along one of the six directions. */
  | { readonly kind: 'line', readonly length: number }

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
   * client's `src/objects/fog.ts`). Enforced by the server since #48: it sends
   * units, pickups, projectiles and StoneWall stones only within vision + 1
   * ring (`Multiplayer.viewOf`), and its interest buckets grow with the
   * largest vision here (`World.INTEREST_BUCKET`). null = no fog, and the
   * server's 500-unit box. Robots 6, Periscope 10 (Nick, 2026-10-03; 11 from #43, held there
   * by the 500 box until #48 derived the buckets from vision; 8 before).
   */
  readonly vision: number | null
  /**
   * RangedAttack's range in cells (decision #25), or null for an archetype
   * without RangedAttack. The client draws a shot's beam this far
   * (`vfx/cells.ts`). The server's gunner override reads it; a robot's range
   * is `RangedAttack.RANGE_CELLS`, which every robot builds from any kit
   * (`SKILL_SPECS`). effectcells.spec.ts fails if a built skill disagrees.
   */
  readonly rangedCells: number | null
  /** Robots only; null for mobs, whose stats live only on the server. */
  readonly stats: RobotStats | null
  /**
   * The account level (not `Unit.level`) at which a player may pick it (#48
   * step 5, Dez's v1 in `ideas/meta-progression-numbers.md` section 3); null
   * for mobs. A tunable: a retune needs both deploys, client first; deployed
   * apart, the lobby shows a lock the server doesn't enforce or the other way
   * round, and the server's answer always wins (it plays a locked robot as
   * Peep). Bots ignore it.
   */
  readonly unlockLevel: number | null
  /** A mob's rarity (see `Rarity`); null for robots and for grunt, gunner and boss. */
  readonly rarity: Rarity | null
  /** An NPC's attack cells (see `NpcAttack`); undefined for any other row and for an NPC with none. */
  readonly attack?: NpcAttack
}

/**
 * **PROVISIONAL (l1-0)**: every NPC number the client shares, in one place,
 * from Dez's l1-0 table (`ideas/npc-numbers.md`, proposed, awaiting Nick).
 * Ranges and rings are cells. The server's
 * provisional numbers (HP, damage, speeds, guards) are in one block in
 * `archetypes/archetypes.ts` (`NPC_NUMBERS`). A retune here needs both
 * deploys, client first.
 */
const NPC_SHARED = Object.freeze({
  /** The Crawler's shot: 5, a cell short of a player's 6. */
  crawlerRangedCells: 5,
  /** Kiln lob: thrown up to 7 cells (it keeps 5-6 away), blast on the cell + 1 ring. */
  kilnLob: Object.freeze({ kind: 'lob' as const, range: 7, rings: 1 }),
  reactorBurst: Object.freeze({ kind: 'disc' as const, rings: 2 }),
  coilField: Object.freeze({ kind: 'disc' as const, rings: 2 }),
  compactorLine: Object.freeze({ kind: 'line' as const, length: 3 }),
  broodlingBlast: Object.freeze({ kind: 'disc' as const, rings: 1 })
})

// Robot ids by the brief's order: peep 1, periscope 2, magnet 3, hopper 4,
// waddle 5 (robot-select, #42). Hopper and Waddle playable since 2026-10-01,
// with #16's stats and #43's standard vision.
export const ARCHETYPE_INFO: Readonly<Record<ArchetypeKey, ArchetypeInfo>> = Object.freeze({
  peep: Object.freeze({
    id: 1, key: 'peep', kind: 'robot', unlockLevel: 1, rarity: null, passesObstacles: false, vision: 6, rangedCells: 6,
    stats: Object.freeze({ maxHp: 100, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  }),
  periscope: Object.freeze({
    id: 2, key: 'periscope', kind: 'robot', unlockLevel: 5, rarity: null, passesObstacles: false, vision: 10, rangedCells: 6,
    stats: Object.freeze({ maxHp: 80, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  }),
  magnet: Object.freeze({
    id: 3, key: 'magnet', kind: 'robot', unlockLevel: 3, rarity: null, passesObstacles: false, vision: 6, rangedCells: 6,
    stats: Object.freeze({ maxHp: 90, armor: 25, speed: 140, pickupReach: 3, damageScale: 1 })
  }),
  // Its trait, passing through obstacle cells (#15), is flagged but not built.
  hopper: Object.freeze({
    id: 4, key: 'hopper', kind: 'robot', unlockLevel: 8, rarity: null, passesObstacles: true, vision: 6, rangedCells: 6,
    stats: Object.freeze({ maxHp: 90, armor: 50, speed: 140, pickupReach: 1, damageScale: 1 })
  }),
  // HP and armor paid for in speed (#16).
  waddle: Object.freeze({
    id: 5, key: 'waddle', kind: 'robot', unlockLevel: 12, rarity: null, passesObstacles: false, vision: 6, rangedCells: 6,
    stats: Object.freeze({ maxHp: 130, armor: 100, speed: 120, pickupReach: 1, damageScale: 1 })
  }),
  // Retired (#51): kept, ids reserved, spawned by no layer.
  grunt: Object.freeze({ id: 6, key: 'grunt', kind: 'mob', unlockLevel: null, rarity: null, passesObstacles: false, vision: null, rangedCells: null, stats: null }),
  boss: Object.freeze({ id: 7, key: 'boss', kind: 'mob', unlockLevel: null, rarity: null, passesObstacles: false, vision: null, rangedCells: null, stats: null }),
  gunner: Object.freeze({ id: 8, key: 'gunner', kind: 'mob', unlockLevel: null, rarity: null, passesObstacles: false, vision: null, rangedCells: 6, stats: null }),
  // The NPC roster (decision #51, L1). Rarity is Nick's; the rest NPC_SHARED.
  crawler: Object.freeze({ id: 9, key: 'crawler', kind: 'mob', unlockLevel: null, rarity: 'common', passesObstacles: false, vision: null, rangedCells: NPC_SHARED.crawlerRangedCells, stats: null }),
  kiln: Object.freeze({ id: 10, key: 'kiln', kind: 'mob', unlockLevel: null, rarity: 'rare', passesObstacles: false, vision: null, rangedCells: null, stats: null, attack: NPC_SHARED.kilnLob }),
  reactor: Object.freeze({ id: 11, key: 'reactor', kind: 'mob', unlockLevel: null, rarity: 'epic', passesObstacles: false, vision: null, rangedCells: null, stats: null, attack: NPC_SHARED.reactorBurst }),
  coil: Object.freeze({ id: 12, key: 'coil', kind: 'mob', unlockLevel: null, rarity: 'rare', passesObstacles: false, vision: null, rangedCells: null, stats: null, attack: NPC_SHARED.coilField }),
  compactor: Object.freeze({ id: 13, key: 'compactor', kind: 'mob', unlockLevel: null, rarity: 'common', passesObstacles: false, vision: null, rangedCells: null, stats: null, attack: NPC_SHARED.compactorLine }),
  // No attack cells of its own: it releases Broodlings (l1-7).
  brood: Object.freeze({ id: 14, key: 'brood', kind: 'mob', unlockLevel: null, rarity: 'legendary', passesObstacles: false, vision: null, rangedCells: null, stats: null }),
  broodling: Object.freeze({ id: 15, key: 'broodling', kind: 'mob', unlockLevel: null, rarity: 'common', passesObstacles: false, vision: null, rangedCells: null, stats: null, attack: NPC_SHARED.broodlingBlast })
})

/** The robots a player may pick at join, by key, in the lobby's order. */
export const SELECTABLE_ROBOTS: readonly ArchetypeKey[] = Object.freeze(['peep', 'periscope', 'magnet', 'hopper', 'waddle'])

/** Whether an account of `level` may play `key`: a selectable robot whose `unlockLevel` is at most `level`. */
export function robotUnlocked (key: unknown, level: number): boolean {
  if (typeof key !== 'string' || !(SELECTABLE_ROBOTS as readonly string[]).includes(key)) return false
  const unlock = ARCHETYPE_INFO[key as ArchetypeKey].unlockLevel
  return unlock !== null && unlock <= level
}

/** The entry with this wire id, or undefined for 0 and for any id this build doesn't know. */
export function archetypeById (id: number | undefined): ArchetypeInfo | undefined {
  if (id === undefined || id === 0) return undefined
  for (const key in ARCHETYPE_INFO) {
    const info = ARCHETYPE_INFO[key as ArchetypeKey]
    if (info.id === id) return info
  }
  return undefined
}
