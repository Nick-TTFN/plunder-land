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
  rig?: 'peep' | 'magnet'
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
  magnet: Object.freeze({ ...ROBOT_DEFAULT, rig: 'magnet' as const }),
  grunt: MOB_DEFAULT,
  boss: MOB_DEFAULT,
  // A cold blue, far from the grunt's untinted sprite and from the 0xffbb00
  // that marks something with a lifetime.
  gunner: Object.freeze({ run: 'mob/mob', tint: 0x7fb2ff })
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
