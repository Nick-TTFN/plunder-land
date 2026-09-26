// The `standings` event's decoding and ranking, kept free of pixi so the
// server's specs can run it against the server's own bytes (standings.spec.ts).
// The board that draws it is leaderboard.ts.

/** The status byte of a standings row. Mirrors the server's `Standing`. */
export enum Standing {
  ACTIVE = 0,
  EXTRACTED = 1,
  DEAD = 2
}

export interface StandingRow {
  id: number
  status: Standing
  loot: number
  name: string
  /**
   * The row's 1-based rank on the whole board, when the server sent one.
   * Undefined from a server that sends the whole board, where the rank is the
   * row's position instead.
   */
  rank?: number
}

/**
 * One `standings` record: `[uint16 id][uint8 status][uint32 loot][UTF-8 name][0][uint16 rank]`,
 * big-endian (server `Multiplayer.rankStandings`). The rank is missing from a
 * server that predates it (it sent the whole board, ranked by position). Anything
 * after the rank is a field added later and is ignored. A record too short for
 * its fixed part is dropped.
 */
export function decodeStanding (record: Uint8Array): StandingRow | undefined {
  if (record.length < 7) return undefined
  let end = 7
  while (end < record.length && record[end] !== 0) end++
  const rankAt = end + 1
  return {
    id: (record[0] << 8) | record[1],
    status: record[2],
    loot: ((record[3] << 24) >>> 0) + (record[4] << 16) + (record[5] << 8) + record[6],
    name: new TextDecoder().decode(record.subarray(7, end)),
    rank: rankAt + 2 <= record.length ? (record[rankAt] << 8) | record[rankAt + 1] : undefined
  }
}

export interface ShownRow { rank: number, row: StandingRow }

/**
 * The rows the board shows: the first `top` of `rows` (the server's order,
 * which is the ranking), plus the own row when it comes after them. `ownId` is
 * the local player's object id; the own row is the ACTIVE one with that id.
 * Ids are recycled, so a finished row can share it; a live one cannot.
 *
 * A row's rank is the one the server sent, or its position when it sent none.
 * The server now sends only its top rows plus the own row, appended after
 * them, so the own row's position is no longer its rank. `ownBelow` is true
 * when the last shown row is the own row, listed after a gap.
 */
export function pickShown (rows: StandingRow[], ownId: number | undefined, top: number): { shown: ShownRow[], own: StandingRow | undefined, ownBelow: boolean } {
  const ownIndex = ownId === undefined ? -1 : rows.findIndex((r) => r.id === ownId && r.status === Standing.ACTIVE)
  const rankOf = (i: number): number => rows[i].rank ?? i + 1

  const shown: ShownRow[] = []
  rows.slice(0, top).forEach((row, i) => shown.push({ rank: rankOf(i), row }))
  const ownBelow = ownIndex >= top
  if (ownBelow) shown.push({ rank: rankOf(ownIndex), row: rows[ownIndex] })
  return { shown, own: ownIndex < 0 ? undefined : rows[ownIndex], ownBelow }
}
