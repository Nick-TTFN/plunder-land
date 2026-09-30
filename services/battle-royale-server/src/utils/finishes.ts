/**
 * A robot's finish (robot-finishes, decision #41): a colour and a pattern for
 * each of its three paint groups, head, body and limbs, and the wire form that
 * carries it (the `finish` field, index 23, on a player's create).
 *
 * **Mirrored in the client at the same path and the two copies must stay byte
 * identical**, like `items.ts`. `mirror.spec.ts` fails if they drift.
 *
 * The colours and patterns come from Peep's v15 art drop (`materials/compose.mjs`
 * in the drop, kept outside the repo): the palette is the ten colours its six
 * presets use, so every preset is exact, and a pattern's opacity is the one
 * every preset gives it (camo semi-transparent, the others solid), so it is not
 * the player's to choose and is not on the wire. The palette was Claude's pick
 * from those presets, 2026-09-30; Nick may replace it.
 *
 * **Colour and pattern ids are append-only**, like field indices: never reuse
 * or renumber one. Colour id 0 is never valid; pattern 0 is "none".
 */

export type FinishGroup = 'head' | 'body' | 'limbs'

/** Wire order: the `finish` field is `[colour][pattern]` for each, in this order. */
export const FINISH_GROUPS: readonly FinishGroup[] = Object.freeze(['head', 'body', 'limbs'])

export interface PaletteColour {
  readonly id: number
  readonly label: string
  readonly rgb: readonly [number, number, number]
}

export const PALETTE: readonly PaletteColour[] = Object.freeze([
  Object.freeze({ id: 1, label: 'MINT', rgb: Object.freeze([54, 201, 183]) as readonly [number, number, number] }),
  Object.freeze({ id: 2, label: 'CREAM', rgb: Object.freeze([239, 233, 212]) as readonly [number, number, number] }),
  Object.freeze({ id: 3, label: 'OLIVE', rgb: Object.freeze([123, 149, 82]) as readonly [number, number, number] }),
  Object.freeze({ id: 4, label: 'SAND', rgb: Object.freeze([225, 202, 154]) as readonly [number, number, number] }),
  Object.freeze({ id: 5, label: 'ICE', rgb: Object.freeze([191, 218, 235]) as readonly [number, number, number] }),
  Object.freeze({ id: 6, label: 'SKY', rgb: Object.freeze([188, 223, 255]) as readonly [number, number, number] }),
  Object.freeze({ id: 7, label: 'PEACH', rgb: Object.freeze([225, 155, 105]) as readonly [number, number, number] }),
  Object.freeze({ id: 8, label: 'CORAL', rgb: Object.freeze([248, 160, 132]) as readonly [number, number, number] }),
  Object.freeze({ id: 9, label: 'VIOLET', rgb: Object.freeze([149, 117, 211]) as readonly [number, number, number] }),
  Object.freeze({ id: 10, label: 'BONE', rgb: Object.freeze([239, 233, 225]) as readonly [number, number, number] })
])

export type PatternKey = 'none' | 'zebra' | 'checker' | 'camo'

export interface PatternInfo {
  readonly id: number
  readonly key: PatternKey
  readonly label: string
  /** How strongly it lies over the colour, 0-1. */
  readonly opacity: number
}

export const PATTERNS: readonly PatternInfo[] = Object.freeze([
  Object.freeze({ id: 0, key: 'none', label: 'PLAIN', opacity: 0 }),
  Object.freeze({ id: 1, key: 'zebra', label: 'ZEBRA', opacity: 1 }),
  Object.freeze({ id: 2, key: 'checker', label: 'CHECKER', opacity: 1 }),
  Object.freeze({ id: 3, key: 'camo', label: 'CAMO', opacity: 0.45 })
] as PatternInfo[])

export interface GroupFinish {
  /** A `PALETTE` id. */
  readonly colour: number
  /** A `PATTERNS` id. */
  readonly pattern: number
}

export type Finish = Readonly<Record<FinishGroup, GroupFinish>>

/** Bytes the finish takes on the wire, after its count byte. */
export const FINISH_BYTES = 2 * FINISH_GROUPS.length

function finish (head: [number, number], body: [number, number], limbs: [number, number]): Finish {
  return Object.freeze({
    head: Object.freeze({ colour: head[0], pattern: head[1] }),
    body: Object.freeze({ colour: body[0], pattern: body[1] }),
    limbs: Object.freeze({ colour: limbs[0], pattern: limbs[1] })
  })
}

/**
 * The drop's six presets, in its order. Its limbs always copy its body.
 * Mint is the default: the finish every robot had before finishes, and what a
 * missing or unreadable one means.
 */
export const FINISH_PRESETS: ReadonlyArray<{ readonly key: string, readonly label: string, readonly finish: Finish }> = Object.freeze([
  { key: 'mint', label: 'MINT', finish: finish([2, 1], [1, 0], [1, 0]) },
  { key: 'field', label: 'FIELD', finish: finish([4, 0], [3, 3], [3, 3]) },
  { key: 'wild', label: 'WILD', finish: finish([2, 1], [3, 3], [3, 3]) },
  { key: 'arctic', label: 'ARCTIC', finish: finish([6, 1], [5, 3], [5, 3]) },
  { key: 'sunset', label: 'SUNSET', finish: finish([8, 1], [7, 3], [7, 3]) },
  { key: 'arcade', label: 'ARCADE', finish: finish([10, 2], [9, 3], [9, 3]) }
])

export const DEFAULT_FINISH: Finish = FINISH_PRESETS[0].finish

export function colourById (id: number): PaletteColour | undefined {
  return PALETTE.find((c) => c.id === id)
}

export function patternById (id: number): PatternInfo | undefined {
  return PATTERNS.find((p) => p.id === id)
}

/** `[colour, pattern]` per group, in `FINISH_GROUPS` order. */
export function finishToBytes (f: Finish): number[] {
  const out: number[] = []
  for (const g of FINISH_GROUPS) out.push(f[g].colour, f[g].pattern)
  return out
}

/**
 * Whatever arrived, as a finish that can be drawn. Not an array of whole
 * numbers, or shorter than `FINISH_BYTES`: the default. Longer: the rest is
 * ignored, room for later additions. A colour or pattern this build doesn't
 * know: the default's for that group, so an id added later degrades one group
 * rather than the whole robot.
 */
export function finishFromBytes (bytes: unknown): Finish {
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) return DEFAULT_FINISH
  const b = bytes as ArrayLike<unknown>
  if (b.length < FINISH_BYTES) return DEFAULT_FINISH
  for (let i = 0; i < FINISH_BYTES; i++) {
    const v = b[i]
    if (typeof v !== 'number' || !Number.isInteger(v)) return DEFAULT_FINISH
  }
  const group = (g: FinishGroup, i: number): GroupFinish => {
    const colour = b[2 * i] as number
    const pattern = b[2 * i + 1] as number
    return Object.freeze({
      colour: colourById(colour) !== undefined ? colour : DEFAULT_FINISH[g].colour,
      pattern: patternById(pattern) !== undefined ? pattern : DEFAULT_FINISH[g].pattern
    })
  }
  return Object.freeze({ head: group('head', 0), body: group('body', 1), limbs: group('limbs', 2) })
}
