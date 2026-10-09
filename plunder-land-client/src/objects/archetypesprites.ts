import { type ArchetypeInfo, type ArchetypeKey } from '../utils/archetypes'

/**
 * Which sprite each archetype draws with. Client-only: the server neither knows
 * nor cares. The archetype comes from the `archetype` field (index 16), looked
 * up in the mirrored `utils/archetypes.ts`.
 *
 * Deliberately free of pixi imports, so the server's specs can load it and pin
 * the fallback (`archetypes/wire.spec.ts`).
 *
 * **Art is missing** (Nick's boundary) except for Peep, which is rigged
 * (`src/peep/`, 2026-09-30): the boss and gunner have no sprites. Until they
 * exist an unknown robot draws the player's old clips and every mob draws `mob/mob`, scaled by its body radius
 * as before (`Mob.initAnimation`). The gunner is tinted so it can be told from
 * a grunt; it is also smaller (body 24 against 30).
 */
export interface SpriteLook {
  /** Looping clip while moving; also the default for a unit with no idle clip. */
  run: string
  /** Looping clip at rest. Mobs have none. */
  idle?: string
  /** Multiplied into the sprite's colour. Absent = untinted. */
  tint?: number
  /**
   * Drawn by a skeletal rig instead of `run`/`idle` (`src/peep/`), when its
   * sheet is loaded; `run`/`idle` stay as the fallback.
   */
  rig?: 'peep' | 'periscope' | 'magnet' | 'hopper' | 'waddle'
  /**
   * A mob drawn by its NPC rig (`src/npcs/`, l1-8) instead of `run`, when its
   * sheet is loaded (`NPC_RIGS`, `NpcSprite.ready`); `run` stays the fallback.
   */
  npc?: 'crawler' | 'broodling' | 'reactor' | 'compactor' | 'kiln' | 'coil' | 'brood'
}

/** What a player looked like before archetypes: also the fallback for any robot id this build doesn't know. */
export const ROBOT_DEFAULT: SpriteLook = Object.freeze({ run: 'player/run/run', idle: 'player/idle/idle' })

/** What a mob looked like before archetypes: also the fallback for any mob id this build doesn't know. */
export const MOB_DEFAULT: SpriteLook = Object.freeze({ run: 'mob/mob' })

/**
 * One entry per key in the mirror. Typed as a full record so a key added to
 * `utils/archetypes.ts` without a look here is a client type error; at run time
 * a missing entry still falls back.
 */
const LOOKS: Readonly<Record<ArchetypeKey, SpriteLook>> = Object.freeze({
  peep: Object.freeze({ ...ROBOT_DEFAULT, rig: 'peep' as const }),
  periscope: Object.freeze({ ...ROBOT_DEFAULT, rig: 'periscope' as const }),
  magnet: Object.freeze({ ...ROBOT_DEFAULT, rig: 'magnet' as const }),
  hopper: Object.freeze({ ...ROBOT_DEFAULT, rig: 'hopper' as const }),
  waddle: Object.freeze({ ...ROBOT_DEFAULT, rig: 'waddle' as const }),
  grunt: MOB_DEFAULT,
  boss: MOB_DEFAULT,
  // A cold blue, far from the grunt's untinted sprite and from the 0xffbb00
  // that marks something with a lifetime.
  gunner: Object.freeze({ run: 'mob/mob', tint: 0x7fb2ff }),
  // The NPC roster (decision #51): drawn by their rigs (Crawler and Broodling
  // since l1-8; the Reactor, the Compactor, the Kiln, the Coil and the Brood
  // since l1-9, PROVISIONAL pending Nick's art review), `mob/mob` whenever a
  // sheet is missing. The Crawler's fallback takes the gunner's tint, as it takes its role (ranged).
  crawler: Object.freeze({ run: 'mob/mob', tint: 0x7fb2ff, npc: 'crawler' as const }),
  kiln: Object.freeze({ ...MOB_DEFAULT, npc: 'kiln' as const }),
  reactor: Object.freeze({ ...MOB_DEFAULT, npc: 'reactor' as const }),
  coil: Object.freeze({ ...MOB_DEFAULT, npc: 'coil' as const }),
  compactor: Object.freeze({ ...MOB_DEFAULT, npc: 'compactor' as const }),
  brood: Object.freeze({ ...MOB_DEFAULT, npc: 'brood' as const }),
  broodling: Object.freeze({ ...MOB_DEFAULT, npc: 'broodling' as const })
})

/**
 * The look for a unit of this object kind. **Anything unrecognised falls back
 * to that kind's pre-archetype sprite**: no archetype (id 0, or an id this
 * build doesn't know, which is what an older client sees from a newer server),
 * or an archetype of the other kind (a mob id on a player record).
 */
export function lookFor (kind: 'robot' | 'mob', archetype: ArchetypeInfo | undefined): SpriteLook {
  const fallback = kind === 'robot' ? ROBOT_DEFAULT : MOB_DEFAULT
  if (archetype === undefined || archetype.kind !== kind) return fallback
  return LOOKS[archetype.key] ?? fallback
}
