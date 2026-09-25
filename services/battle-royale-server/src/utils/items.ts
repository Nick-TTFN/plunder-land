/**
 * The part of each usable item that the client has to agree on, and the wire
 * id that names it (the `item` field, index 17, on an item pickup).
 *
 * **Mirrored in the client at the same path and the two copies must stay byte
 * identical**, like `archetypes.ts`. `mirror.spec.ts` fails if they drift. The
 * server's full table (`ITEMS` in `archetypes/archetypes.ts`) takes these
 * fields from here, so nothing in this file is written down twice.
 *
 * Only what the client needs goes here: the id, the key, the inventory slot,
 * the label it prints, how far it can be aimed and the size of its area. What
 * an item does (heal amounts, damage, fuse, stack limits) stays on the server.
 *
 * **Ids are append-only**, like field indices: never reuse or renumber one.
 * 0 means none. **Slots are fixed per kind** (medkit in slot 1, bomb in slot 2,
 * keys 1-5 on the client), so the `inventory` field is a count per slot and a
 * key always means the same item. Two kinds never share a slot.
 */

export type ItemKey = 'medkit' | 'bomb'

export interface ItemInfo {
  readonly id: number
  readonly key: ItemKey
  /** 0-based inventory slot: key 1 is slot 0. Below `INVENTORY_SLOTS`. */
  readonly slot: number
  /** What the inventory readout prints. */
  readonly label: string
  /**
   * How far from the user's own cell it may be aimed, in cells (`Hex.distance`).
   * null = it does not aim, and any aim sent with it is ignored.
   */
  readonly aimRange: number | null
  /** Rings of the hex disc it covers around the aimed cell. 0 = no area. */
  readonly rings: number
}

/** Slots on the inventory, keyed 1-5 (the mockup). The `inventory` field carries this many counts. */
export const INVENTORY_SLOTS = 5

export const ITEM_INFO: Readonly<Record<ItemKey, ItemInfo>> = Object.freeze({
  medkit: Object.freeze({ id: 1, key: 'medkit', slot: 0, label: 'MEDKIT', aimRange: null, rings: 0 }),
  // Balance pass section 1 "Items": thrown up to 6 cells, a 2-ring disc (19 cells).
  bomb: Object.freeze({ id: 2, key: 'bomb', slot: 1, label: 'BOMB', aimRange: 6, rings: 2 })
})

/** The entry with this wire id, or undefined for 0 and for any id this build doesn't know. */
export function itemById (id: number | undefined): ItemInfo | undefined {
  if (id === undefined || id === 0) return undefined
  for (const key in ITEM_INFO) {
    const info = ITEM_INFO[key as ItemKey]
    if (info.id === id) return info
  }
  return undefined
}

/** The kind that lives in a 0-based slot, or undefined for an empty or out-of-range slot. */
export function itemInSlot (slot: number): ItemInfo | undefined {
  for (const key in ITEM_INFO) {
    const info = ITEM_INFO[key as ItemKey]
    if (info.slot === slot) return info
  }
  return undefined
}
