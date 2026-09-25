/**
 * Objects by (layer, cell key), for lookups that must not scan a whole list
 * (hex-cells P1, decision #31, design `ideas/hex-cell-simulation.md` "One index").
 *
 * **Membership is the lists, not the objects.** An object is in the index
 * exactly while it is in one of the lists `lists()` returns (`World.PLAYERS`
 * and `World.MOBS` for units, say), so a dead unit stays findable until the
 * tick's sweep splices it out, as it always was (CLAUDE.md, "A dead unit stays
 * findable until the next tick's sweep"): callers still check `destroyed`.
 * Constructing an object does not index it; pushing it does.
 *
 * Kept exact two ways:
 *
 * - **World's own mutations go through the index** (`push`, `removeAt`, or
 *   `sync` / `insert` / `delete` / `record` when one list feeds two indexes),
 *   and a moving object reports itself (`moved`, from `GameObject`'s position
 *   and tag setters). That is O(1) per change and is every change the server
 *   makes.
 * - **Anything else that edits a list** - the specs push units straight into
 *   `World.MOBS` and empty the lists with `.length = 0` - is caught by `sync`,
 *   which every lookup runs first: it compares each list's identity, length and
 *   last element with what the index last recorded, and on any difference
 *   rebuilds from the lists (O(n), counted in `rebuilds`). A rebuild is always
 *   correct, so a server path that forgot to go through the index costs time,
 *   never a wrong answer.
 *
 *   The one edit the check cannot see is one that leaves every list's length
 *   and last element as they were: replacing an element in the middle, or
 *   removing one and inserting another before the end. Nothing in the server or
 *   the specs does that; if a spec ever needs to, it should go through the index.
 *
 * `index.spec.ts` checks that a world run through its own paths (joins, mob
 * spawns, deaths, exits, pickups, layer changes, StoneWall, bombs) never
 * rebuilds after its first sync.
 *
 * Buckets are arrays in insertion order, and an emptied bucket is deleted, so
 * the maps hold occupied cells only and never grow with the ground walked over.
 */
export class CellIndex<T extends object> {
  private readonly _layers = new Map<number, Map<number, T[]>>()
  /** Where each member is filed. Also the membership test. */
  private readonly _slots = new Map<T, { layer: number, key: number }>()
  /** Each list as last recorded: identity, length, last element. Undefined until the first sync. */
  private _seen: Array<{ list: readonly T[], length: number, last: T | undefined }> | undefined

  /**
   * How many times `sync` found the lists edited behind the index's back. The
   * first build, on the first lookup, is not counted.
   */
  rebuilds = 0

  constructor (
    /** The lists whose members are indexed. Read on every `sync`, never cached. */
    private readonly _lists: () => ReadonlyArray<readonly T[]>,
    private readonly _layerOf: (obj: T) => number,
    private readonly _keyOf: (obj: T) => number,
    /** Members of the lists that are indexed at all (portals and exits out of OBSTACLES). */
    private readonly _accept: (obj: T) => boolean = () => true
  ) {}

  /** The members filed under `key` on `layer`, insertion order. Do not mutate. */
  at (layer: number, key: number): readonly T[] {
    this.sync()
    return this._layers.get(layer)?.get(key) ?? EMPTY
  }

  /** Every occupied bucket on `layer`, for the rare caller that needs them all. */
  buckets (layer: number): ReadonlyMap<number, readonly T[]> {
    this.sync()
    return this._layers.get(layer) ?? NO_BUCKETS
  }

  /** True if `obj` is indexed. */
  has (obj: T): boolean {
    this.sync()
    return this._slots.has(obj)
  }

  /** How many objects are indexed. */
  get size (): number {
    this.sync()
    return this._slots.size
  }

  /** `list.push(obj)`, indexed. `list` must be one of `lists()`. */
  push (list: T[], obj: T): void {
    this.sync()
    list.push(obj)
    this.insert(obj)
    this.record()
  }

  /** `list.splice(index, 1)`, unindexed. Returns what was removed. */
  removeAt (list: T[], index: number): T | undefined {
    this.sync()
    const [obj] = list.splice(index, 1)
    if (obj !== undefined) this.delete(obj)
    this.record()
    return obj
  }

  /** Remove `obj` from `list` if it is there. True if it was. */
  remove (list: T[], obj: T): boolean {
    const index = list.indexOf(obj)
    if (index < 0) return false
    this.removeAt(list, index)
    return true
  }

  /**
   * `obj`'s position or layer changed: refile it if its bucket did. Nothing for
   * an object that is not indexed, which includes every object still inside its
   * own constructor. Never syncs, for that reason.
   */
  moved (obj: T): void {
    const slot = this._slots.get(obj)
    if (slot === undefined) return
    const layer = this._layerOf(obj)
    const key = this._keyOf(obj)
    if (slot.layer === layer && slot.key === key) return
    this.unlink(obj, slot)
    slot.layer = layer
    slot.key = key
    this.link(obj, slot)
  }

  /**
   * Rebuild if any list was edited since the last `record`. O(1) when not.
   * Runs before every lookup and every indexed mutation.
   */
  sync (): void {
    const lists = this._lists()
    const seen = this._seen
    if (seen !== undefined && lists.length === seen.length) {
      let same = true
      for (let i = 0; i < lists.length && same; i++) {
        const list = lists[i]
        same = seen[i].list === list && seen[i].length === list.length && seen[i].last === list[list.length - 1]
      }
      if (same) return
    }
    if (seen !== undefined) this.rebuilds++
    this._layers.clear()
    this._slots.clear()
    for (const list of lists) {
      for (const obj of list) this.insert(obj)
    }
    this.record()
  }

  /**
   * File `obj`, which the caller has just added to one of the lists. For a
   * list that feeds more than one index: `sync` each, mutate, `insert`, then
   * `record` each. `push` does all four for one index.
   */
  insert (obj: T): void {
    if (this._slots.has(obj) || !this._accept(obj)) return
    const slot = { layer: this._layerOf(obj), key: this._keyOf(obj) }
    this._slots.set(obj, slot)
    this.link(obj, slot)
  }

  /** Unfile `obj`, which the caller has just removed from its list. */
  delete (obj: T): void {
    const slot = this._slots.get(obj)
    if (slot === undefined) return
    this._slots.delete(obj)
    this.unlink(obj, slot)
  }

  /** Remember the lists as they stand, after the caller's own mutation. */
  record (): void {
    this._seen = this._lists().map((list) => ({ list, length: list.length, last: list[list.length - 1] }))
  }

  private link (obj: T, slot: { layer: number, key: number }): void {
    let layer = this._layers.get(slot.layer)
    if (layer === undefined) {
      layer = new Map()
      this._layers.set(slot.layer, layer)
    }
    const bucket = layer.get(slot.key)
    if (bucket === undefined) layer.set(slot.key, [obj])
    else bucket.push(obj)
  }

  private unlink (obj: T, slot: { layer: number, key: number }): void {
    const layer = this._layers.get(slot.layer)
    const bucket = layer?.get(slot.key)
    if (layer === undefined || bucket === undefined) return
    const i = bucket.indexOf(obj)
    if (i >= 0) bucket.splice(i, 1)
    if (bucket.length === 0) layer.delete(slot.key)
  }
}

const EMPTY: readonly never[] = Object.freeze([] as never[])
const NO_BUCKETS: ReadonlyMap<number, never> = new Map<number, never>()
