import Multiplayer, { type Connection } from '../network/multiplayer'
import { Vector } from '../utils/vector'
import Timers from './timers'

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ObjectType {
  static Obstacle = 1
  static Consumable = 1 << 1
  static Player = 1 << 2
  static Portal = 1 << 3
  static Throwable = 1 << 4
  static Mob = 1 << 5
  static Exit = 1 << 6
  /**
   * A usable item lying on the ground (`ItemPickup`). 128 does not fit the
   * signed byte `getBuffer` writes, so `type` goes on the wire unsigned; the
   * client has always read it unsigned, and every older type is below 128.
   */
  static Item = 1 << 7
}

/**
 * A world's object ids: the highest ever handed out and those freed since
 * (a second after their object went, `GameObject.destroy`). One per world
 * (worlds-per-process, decision #39): a client only ever sees its own world's
 * ids, and they are uint16 on the wire, so worlds do not share one counter.
 */
export class IdPool {
  last = 0
  freed: number[] = []
}

export class GameObject {
  /**
   * The current world's ids. Written only by `World.current`'s setter. Starts
   * as a pool of its own, which the default world adopts (see `Timers.active`);
   * undefined while no world is current (`World.strict`), and then making an
   * object throws.
   */
  static pool: IdPool | undefined = new IdPool()

  private static get _ids (): IdPool {
    const pool = GameObject.pool
    if (pool === undefined) throw new Error('GameObject: no world is current (outside World.run)')
    return pool
  }

  /** The current world's highest id handed out. Specs reset it. */
  static get id (): number {
    return GameObject._ids.last
  }

  static set id (value: number) {
    GameObject._ids.last = value
  }

  /** The current world's freed ids, reused before a new one is counted. */
  static get FreedIDs (): number[] {
    return GameObject._ids.freed
  }

  static set FreedIDs (value: number[]) {
    GameObject._ids.freed = value
  }

  id: number = 0
  /**
   * The connections whose client holds this object: sent its create and no
   * destroy since (interest-filtered-broadcasts, decision #35). Its updates
   * and its destroy go to exactly these. The other half of each
   * `Connection.known`; only `Multiplayer` writes either. Always empty for
   * terrain (`Multiplayer.isTerrain`), which goes by layer instead. Not a
   * wire field.
   */
  readonly knownBy = new Set<Connection>()
  destroyed: boolean
  dirtyFields: Set<string>
  allFieldsOwn: Set<string>
  allFields: Set<string>

  private _type: number
  private _position: Vector
  private _direction: Vector
  private _hp: number
  private _level: number
  private _loot: number
  private _tag: number
  private _to: number
  private _radius: number
  private _lifetime: number
  private _maxVelocity: number
  private _name: string
  private _maxHp: number
  // 0 rather than undefined, so a unit with no pool (a mob, a bare spec unit)
  // can be hit without arithmetic on undefined. A plain initialiser here is
  // safe: this is the base, so nothing has written the field before it runs.
  private _armor: number = 0
  private _maxArmor: number = 0
  // 0 rather than undefined for the same reason: `extractProgress` is compared
  // before it is written (Player.channelExtract).
  private _extractProgress: number = 0
  // 0 for the same reason: Player.onKill increments it.
  private _kills: number = 0

  static fieldOrder: string[] = [
    'id',
    'type',
    'position',
    'hp',
    'level',
    // Deprecated: a uint16, which a big haul overflowed. Never written since
    // `loot32`; kept so no index moves, and still read by the client.
    'loot',
    'tag',
    'to',
    'radius',
    'lifetime',
    'maxVelocity',
    'name',
    'maxHp',
    // A Unit's `World.FACING_INDEX(facing)`, one byte, 0-5 (see Unit.facing).
    // Appended: this table is a wire contract, see CLAUDE.md "Wire format".
    'facing',
    // The armor pool (#16), uint16 each, like hp/maxHp. Only units with a pool
    // put these in their snapshot sets (Unit's constructor), so a mob's create
    // record doesn't carry them. Appended, as above.
    'armor',
    'maxArmor',
    // The unit's archetype id (utils/archetypes.ts), one unsigned byte. Only a
    // unit built from an archetype sends it, and only in its snapshot sets: it
    // never changes, so it is never dirty. Unit.serialise swaps the archetype
    // object for its id. Appended, as above.
    'archetype',
    // An item pickup's kind: its `utils/items.ts` id, one unsigned byte. Only
    // `ItemPickup` sends it, in its create. Appended, as above.
    'item',
    // A player's inventory: `[uint8 slots][uint8 count] * slots`, the count of
    // the fixed kind in each slot (utils/items.ts). In `allFieldsOwn` only, but
    // like `loot` a change goes out as a delta to every connection in range.
    // Appended, as above.
    'inventory',
    // How far a player is through extracting on an exit, one unsigned byte:
    // 0 not extracting, 1-254 the fraction of the layer's `extractMs` done, in
    // 255ths. Dirty-tracked only, never in a snapshot set: it changes on every
    // tick of a channel, so a viewer who comes into range mid-channel has it by
    // the next tick anyway (see Player.channelExtract). Appended, as above.
    'extractProgress',
    // Carried loot as a uint32 (loot-wire-overflow). The `loot` property goes
    // out under this index; see WIRE_NAME. Appended, as above.
    'loot32',
    // A player's kills this run, uint16, saturated (run-summary-card, #36):
    // in the owner's create and a delta on each kill, for the end-of-run card.
    // Only Player puts it in a snapshot set. Appended, as above.
    'kills',
    // A projectile's kind, one unsigned byte: `Throwable.FIREBALL` 1 or
    // `Throwable.ICICLE` 2 (0 is never sent), so the client draws the right
    // sprite. Only Throwable sends it, in its create. Appended, as above.
    'projectile',
    // A player's finish (robot-finishes, #41): `[uint8 count]` and that many
    // bytes, `[colour][pattern]` for head, body and limbs (utils/finishes.ts).
    // Counted like `inventory`, so a later addition only lengthens it. Only
    // Player sends it, in its creates; it is fixed for the run, so never dirty.
    // Appended, as above.
    'finish',
    // Who took a pickup (pickup-reach, #42): the collecting player's id, a
    // uint16, in the pickup's destroy record only, so the client can fly it to
    // them. Set by `destroyCollected`. Appended, as above.
    'collector',
    // A gear pickup's item (decision #49, 49-2): `[uint8 n]` and that many
    // bytes, one instance as `encodeGear` writes it (utils/gear.ts). Counted,
    // so a later addition only lengthens it. Only `GearPickup` sends it, in its
    // create; it tells a gear pickup from an `ItemPickup`, which shares
    // `ObjectType.Item` and sends `item` instead. Appended, as above.
    'gear',
    // A player's carried gear (49-2): `[uint16 n big-endian]` and that many
    // bytes, `[uint8 entries = 6]` then per entry `[uint8 len][instance]`,
    // len 0 an empty entry; entries 0-1 are the gear slots (keys 3-4), 2-5 the
    // bag. In the owner's create and a delta on change, like `inventory`.
    // Appended, as above.
    'carried',
    // `maxVelocity` in tenths, a uint16 (49-2). The `maxVelocity` property goes
    // out under this index (see WIRE_NAME), so index 10, an int8 of tens that
    // floored a geared 149.8 to 140, is never written again. Appended, as above.
    'speed'
  ]

  /**
   * Properties that go on the wire under a different field than their own
   * name. `loot`: its uint16 field threw ERR_OUT_OF_RANGE for a haul over
   * 65,535, from inside the tick, so dirty tracking and the snapshot sets keep
   * saying `loot` and only the encoding changes. `maxVelocity` the same way
   * (49-2): index 10 carried tens in an int8, so a geared speed of 149.8
   * reached the predicting client as 140; `speed` (27) carries tenths.
   */
  static WIRE_NAME: Readonly<Record<string, string>> = Object.freeze({ loot: 'loot32', maxVelocity: 'speed' })

  constructor (
    type: number,
    x: number,
    y: number,
    radius: number,
    tag: number,
    lifetime: number = 0,
    to = 0
  ) {
    this.dirtyFields = new Set()
    this.allFieldsOwn = new Set([
      'id',
      'type',
      'position',
      'hp',
      'level',
      'loot',
      'tag',
      'to',
      'radius',
      'lifetime',
      'maxVelocity',
      'maxHp'
    ])
    this.allFields = new Set([
      'id',
      'type',
      'position',
      'hp',
      'level',
      'tag',
      'to',
      'radius',
      'lifetime',
      'name',
      'maxHp',
      'facing'
    ])

    if (radius) {
      this.radius = radius
    }

    this.position = new Vector(x, y)
    this.type = type
    const ids = GameObject._ids
    this.id = ids.freed.pop() ?? ++ids.last

    this.destroyed = false

    if (lifetime) this.lifetime = lifetime

    this.to = to // this is portal specific.
    this.tag = tag
  }

  // todo distribute this into relevant classes
  get type () {
    return this._type
  }

  set type (value) {
    this._type = value
    this.dirtyFields.add('type')
  }

  get position () {
    return this._position
  }

  set position (value) {
    this._position = value
    this.dirtyFields.add('position')
    this.placed()
  }

  get direction () {
    return this._direction
  }

  set direction (value) {
    this._direction = value
    // this.dirtyFields.add('direction')
  }

  get hp () {
    return this._hp
  }

  set hp (value) {
    this._hp = value
    this.dirtyFields.add('hp')
  }

  get level () {
    return this._level
  }

  set level (value) {
    this._level = value
    this.dirtyFields.add('level')
  }

  get loot () {
    return this._loot
  }

  set loot (value) {
    this._loot = value
    this.dirtyFields.add('loot')
  }

  get tag () {
    return this._tag
  }

  set tag (value) {
    this._tag = value
    this.dirtyFields.add('tag')
    this.placed()
  }

  /**
   * Called after every write to `position` or `tag`, including the first ones
   * in this constructor, before any subclass field exists. `Unit` refiles
   * itself in the world's cell indexes here (hex-cells P1), so no caller that
   * moves a unit can forget to. Nothing for anything else: pickups and gates
   * never move, and projectiles are not indexed.
   */
  protected placed (): void {}

  get to () {
    return this._to
  }

  set to (value) {
    this._to = value
    this.dirtyFields.add('to')
  }

  get radius () {
    return this._radius
  }

  set radius (value) {
    this._radius = value
    this.dirtyFields.add('radius')
  }

  get lifetime () {
    return this._lifetime
  }

  set lifetime (value) {
    this._lifetime = value
    this.dirtyFields.add('lifetime')
  }

  get maxVelocity () {
    return this._maxVelocity
  }

  set maxVelocity (value) {
    this._maxVelocity = value
    this.dirtyFields.add('maxVelocity')
  }

  // The client used to infer a unit's maximum from the first hp value it ever
  // saw, which is wrong for anything already damaged when you meet it.
  get maxHp () {
    return this._maxHp
  }

  set maxHp (value) {
    this._maxHp = value
    this.dirtyFields.add('maxHp')
  }

  /**
   * The armor pool (#16): what is left of it, and its size. Damage comes off
   * `armor` before `hp` (Unit.hit), and Unit.update refills it. A whole number
   * always, because it goes on the wire as a uint16.
   *
   * These accessors are why `Unit` must not declare its own `armor` field:
   * under define semantics a subclass field is defined on the instance after
   * this constructor runs and shadows the accessor, so writes would never mark
   * the field dirty and the client would never hear of them.
   */
  get armor () {
    return this._armor
  }

  set armor (value) {
    this._armor = value
    this.dirtyFields.add('armor')
  }

  get maxArmor () {
    return this._maxArmor
  }

  set maxArmor (value) {
    this._maxArmor = value
    this.dirtyFields.add('maxArmor')
  }

  /** See 'extractProgress' in `fieldOrder`. Written only by Player. */
  get extractProgress () {
    return this._extractProgress
  }

  set extractProgress (value) {
    this._extractProgress = value
    this.dirtyFields.add('extractProgress')
  }

  /** See 'kills' in `fieldOrder`. Written only by Player. */
  get kills () {
    return this._kills
  }

  set kills (value) {
    this._kills = value
    this.dirtyFields.add('kills')
  }

  get name () {
    return this._name
  }

  set name (value) {
    this._name = value
    this.dirtyFields.add('name')
  }

  update (dt: number) {
    Multiplayer.Instance.update(this)
  }

  /** The id of whoever took this pickup; see 'collector' in `fieldOrder`. */
  collector: number | undefined = undefined

  /** Destroyed by being picked up: the destroy record names the collector. */
  destroyCollected (by: GameObject): void {
    this.collector = by.id
    this.destroy()
  }

  destroy () {
    this.dirtyFields = new Set(this.collector === undefined ? ['id', 'hp'] : ['id', 'hp', 'collector'])
    Multiplayer.Instance.destroy(this)
    this.destroyed = true

    // Its own pending work (a projectile's lifetime, a mob's attack cooldown)
    // goes with it. Before the free below, which must not be cancelled.
    Timers.cancelOwner(this)

    // we need this time out because server sends out all data asynchronously,
    // and a new objectmight take an id of a destroyed object,
    // before clients were notified about it.
    // our server loop is 16ms, thin of a cleaner way to do this.
    // The pool is taken now, not when the timer runs: the id belongs to the
    // world this object was in. (The timer runs in that world's tick anyway.)
    const ids = GameObject._ids
    Timers.schedule(1000, () => {
      ids.freed.push(this.id)
    })
  }

  onCollide (target) { }

  serialise (fields: Set<string>) {
    if (!fields?.size) return null

    const result = { id: this.id }
    for (const key of fields) {
      if (this[key] !== undefined) result[key] = this[key]
    }

    return result
  }

  /**
   * Scratch space for `serialiseBinary`: a record is written here and copied
   * out once, instead of one small Buffer per field and a concat (which was
   * most of the serialiser's cost). Grown when a record would not fit, never
   * shrunk; a record is a few dozen bytes, so 1 KB is almost never outgrown.
   */
  private static _scratch = Buffer.alloc(1024)

  private static _room (at: number, bytes: number): Buffer {
    let scratch = GameObject._scratch
    if (at + bytes > scratch.length) {
      const grown = Buffer.alloc(Math.max(scratch.length * 2, at + bytes))
      scratch.copy(grown, 0, 0, at)
      GameObject._scratch = scratch = grown
    }
    return scratch
  }

  /** Each field's wire index, by property name (`WIRE_NAME` applied), -1 if not in the table. */
  private static _indexOf: Map<string, number> | undefined

  private static _fieldIndex (key: string): number {
    let indices = GameObject._indexOf
    if (indices === undefined) {
      indices = new Map()
      GameObject._indexOf = indices
    }
    let index = indices.get(key)
    if (index === undefined) {
      index = GameObject.fieldOrder.indexOf(GameObject.WIRE_NAME[key] ?? key)
      indices.set(key, index)
    }
    return index
  }

  /**
   * One record: `[field index][payload]` per field, in `serialise`'s key
   * order. Byte for byte what it was when every field was its own Buffer
   * (`serialise.spec.ts` holds the old encoder and compares), including the
   * same RangeError from the same Buffer write for a value that does not fit
   * its field. The writes go through the same Buffer methods for that reason.
   */
  serialiseBinary (fields: Set<string>) {
    const dataObj = this.serialise(fields)
    if (dataObj == null) return null
    let at = 0
    for (const key in dataObj) {
      const value = dataObj[key]
      if (value === undefined) continue

      // A key that is not in the table writes -1, as it always has (see
      // `direction` in CLAUDE.md "Wire format").
      GameObject._room(at, 1).writeInt8(GameObject._fieldIndex(key), at)
      at += 1
      switch (key) {
        case 'id':
        case 'collector':
        case 'hp':
        case 'maxHp':
        case 'armor':
        case 'maxArmor':
          GameObject._room(at, 2).writeUInt16BE(value, at)
          at += 2
          break
        case 'kills':
          // Saturated, so no run can overflow it inside the tick (loot32's lesson).
          GameObject._room(at, 2).writeUInt16BE(Math.max(0, Math.min(0xFFFF, Math.floor(value))), at)
          at += 2
          break
        // Unsigned: ObjectType.Item is 128 (see ObjectType); archetype ids are
        // append-only and may pass 127; the extract progress runs to 254.
        case 'type':
        case 'archetype':
        case 'item':
        case 'projectile':
        case 'extractProgress':
          GameObject._room(at, 1).writeUInt8(value, at)
          at += 1
          break
        case 'position': {
          const scratch = GameObject._room(at, 4)
          scratch.writeInt16BE(Math.floor(value.x), at)
          scratch.writeInt16BE(Math.floor(value.y), at + 2)
          at += 4
          break
        }
        case 'direction': {
          const scaled = value.multiply(127)
          const scratch = GameObject._room(at, 2)
          scratch.writeInt8(Math.floor(scaled.x), at)
          scratch.writeInt8(Math.floor(scaled.y), at + 1)
          at += 2
          break
        }
        // Already the snapped index for `facing`: Unit.serialise swaps the vector for it.
        case 'level':
        case 'tag':
        case 'to':
        case 'radius':
        case 'facing':
          GameObject._room(at, 1).writeInt8(value, at)
          at += 1
          break
        case 'loot':
          // As `loot32`. Saturated and whole, like the standings row: the
          // client only displays it, and the banked total comes from here.
          GameObject._room(at, 4).writeUInt32BE(Math.max(0, Math.min(0xFFFFFFFF, Math.floor(value))), at)
          at += 4
          break
        case 'lifetime':
          // Centiseconds in a uint16. It was a single signed byte, which capped
          // any lifetime at 12.7s - fine for a 3s fireball, silently wrong for
          // the 60s timer on dropped loot, where the client's countdown ring
          // would finish while the pickup sat there for another 47 seconds.
          GameObject._room(at, 2).writeUInt16BE(Math.min(65535, Math.floor(value / 100)), at)
          at += 2
          break
        case 'maxVelocity':
          // As `speed` (27): tenths in a uint16, rounded (a sum such as
          // 140.1 + 0.2 times 10 is 1402.9999...) and saturated, so no speed can throw inside the tick
          // (loot32's lesson). Index 10 is never written since 49-2.
          GameObject._room(at, 2).writeUInt16BE(Math.max(0, Math.min(0xFFFF, Math.round(value * 10))), at)
          at += 2
          break
        case 'gear': {
          // One instance's bytes (`encodeGear`), counted by a uint8. An
          // instance is 3 + 3 per roll bytes, far under 255.
          const bytes = value as Uint8Array
          const scratch = GameObject._room(at, 1 + bytes.length)
          scratch.writeUInt8(bytes.length, at)
          scratch.set(bytes, at + 1)
          at += 1 + bytes.length
          break
        }
        case 'carried': {
          // Already the entries' bytes (`Player.carried`), counted by a uint16.
          const bytes = value as Uint8Array
          const scratch = GameObject._room(at, 2 + bytes.length)
          scratch.writeUInt16BE(bytes.length, at)
          scratch.set(bytes, at + 2)
          at += 2 + bytes.length
          break
        }
        case 'inventory':
        case 'finish': {
          const counts = value as readonly number[]
          const scratch = GameObject._room(at, 1 + counts.length)
          scratch.writeUInt8(counts.length, at)
          for (let i = 0; i < counts.length; i++) scratch.writeUInt8(counts[i], at + 1 + i)
          at += 1 + counts.length
          break
        }
        case 'name': {
          // Buffer.from(value) did the encoding before; it throws on a
          // non-string the same way this does.
          const bytes = Buffer.from(value)
          const scratch = GameObject._room(at, bytes.length + 1)
          bytes.copy(scratch, at)
          scratch[at + bytes.length] = 0
          at += bytes.length + 1
          break
        }
      }
    }
    const out = Buffer.allocUnsafe(at)
    GameObject._scratch.copy(out, 0, 0, at)
    return out
  }

  getBuffer (value: number): Buffer {
    const res = Buffer.alloc(1)
    res.writeInt8(value)
    return res
  }

  getBuffer2 (value: number): Buffer {
    const res = Buffer.alloc(2)
    res.writeUInt16BE(value)
    return res
  }

  getBufferVec (value: Vector): Buffer {
    const res = Buffer.alloc(2)
    res.writeInt8(Math.floor(value.x))
    res.writeInt8(Math.floor(value.y), 1)
    return res
  }

  getBufferVec2 (value: Vector): Buffer {
    const res = Buffer.alloc(4)
    res.writeInt16BE(Math.floor(value.x))
    res.writeInt16BE(Math.floor(value.y), 2)
    return res
  }
}
