/**
 * The part of each archetype that the client has to agree on, and the wire id
 * that names it (the `archetype` field, index 16).
 *
 * **Mirrored in the client at the same path and the two copies must stay byte
 * identical**, like `hex.ts` and `path.ts`. `mirror.spec.ts` fails if they
 * drift. The server's full table (`archetypes/archetypes.ts`) takes these
 * fields from here, so nothing in this file is written down twice.
 *
 * Only what the client needs goes in this file: the id, the key its sprite is
 * looked up by, the kind, and the two flags the client will simulate itself
 * (`passesObstacles` for Hopper's prediction, `vision` for Periscope's fog).
 * Stats, skills and AI stay on the server.
 *
 * **Ids are append-only**, like field indices: never reuse or renumber one.
 * 0 means none was sent. Robots are 1-5 (2-5 are reserved for the robots that
 * don't exist yet) and mobs start at 6. A client that meets an id it doesn't
 * know draws that object type's default sprite, so a newer server can't break
 * an older client.
 */

export type ArchetypeKey = 'peep' | 'grunt' | 'boss' | 'gunner'

export interface ArchetypeInfo {
  readonly id: number
  readonly key: ArchetypeKey
  readonly kind: 'robot' | 'mob'
  /** Hopper (#15). Not read by either side yet (step 6). */
  readonly passesObstacles: boolean
  /** Fog radius, robots only. Not read yet (step 5); null = no fog, as today. */
  readonly vision: number | null
}

export const ARCHETYPE_INFO: Readonly<Record<ArchetypeKey, ArchetypeInfo>> = Object.freeze({
  peep: Object.freeze({ id: 1, key: 'peep', kind: 'robot', passesObstacles: false, vision: null }),
  grunt: Object.freeze({ id: 6, key: 'grunt', kind: 'mob', passesObstacles: false, vision: null }),
  boss: Object.freeze({ id: 7, key: 'boss', kind: 'mob', passesObstacles: false, vision: null }),
  gunner: Object.freeze({ id: 8, key: 'gunner', kind: 'mob', passesObstacles: false, vision: null })
})

/** The entry with this wire id, or undefined for 0 and for any id this build doesn't know. */
export function archetypeById (id: number | undefined): ArchetypeInfo | undefined {
  if (id === undefined || id === 0) return undefined
  for (const key in ARCHETYPE_INFO) {
    const info = ARCHETYPE_INFO[key as ArchetypeKey]
    if (info.id === id) return info
  }
  return undefined
}
