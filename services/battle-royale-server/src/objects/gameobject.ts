import Multiplayer from '../network/multiplayer'
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

export class GameObject {
  static id = 0
  id: number = 0
  /**
   * `Multiplayer`'s change counter at this object's last update that carried
   * changes, 0 if none since it was created. A connection that was last
   * brought up to date before this missed a change, and gets the whole record
   * when the object is next in its range (`Multiplayer.update`). Not a wire
   * field.
   */
  changedAt: number = 0
  static FreedIDs: number[] = []
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
    'loot32'
  ]

  /**
   * Properties that go on the wire under a different field than their own
   * name. `loot` is the only one: its uint16 field threw ERR_OUT_OF_RANGE for
   * a haul over 65,535, from inside the tick, so dirty tracking and the
   * snapshot sets keep saying `loot` and only the encoding changes.
   */
  static WIRE_NAME: Readonly<Record<string, string>> = Object.freeze({ loot: 'loot32' })

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
    this.id = GameObject.FreedIDs.pop() ?? ++GameObject.id

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

  destroy () {
    this.dirtyFields = new Set(['id', 'hp'])
    Multiplayer.Instance.destroy(this)
    this.destroyed = true

    // Its own pending work (a projectile's lifetime, a mob's attack cooldown)
    // goes with it. Before the free below, which must not be cancelled.
    Timers.cancelOwner(this)

    // we need this time out because server sends out all data asynchronously,
    // and a new objectmight take an id of a destroyed object,
    // before clients were notified about it.
    // our server loop is 16ms, thin of a cleaner way to do this.
    Timers.schedule(1000, () => {
      GameObject.FreedIDs.push(this.id)
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

  serialiseBinary (fields: Set<string>) {
    const dataObj = this.serialise(fields)
    if (dataObj == null) return null
    const raw: Buffer[] = []
    for (const key in dataObj) {
      const value = dataObj[key]
      if (value === undefined) continue

      raw.push(this.getBuffer(GameObject.fieldOrder.indexOf(GameObject.WIRE_NAME[key] ?? key)))
      switch (key) {
        case 'id':
          raw.push(this.getBuffer2(value))
          break
        case 'type': {
          // Unsigned: ObjectType.Item is 128 (see ObjectType).
          const byte = Buffer.alloc(1)
          byte.writeUInt8(value)
          raw.push(byte)
          break
        }
        case 'position':
          raw.push(this.getBufferVec2(value))
          break
        case 'direction':
          raw.push(this.getBufferVec(value.multiply(127)))
          break
        case 'hp':
          raw.push(this.getBuffer2(value))
          break
        case 'level':
          raw.push(this.getBuffer(value))
          break
        case 'loot': {
          // As `loot32`. Saturated and whole, like the standings row: the
          // client only displays it, and the banked total comes from here.
          const wide = Buffer.alloc(4)
          wide.writeUInt32BE(Math.max(0, Math.min(0xFFFFFFFF, Math.floor(value))))
          raw.push(wide)
          break
        }
        case 'tag':
          raw.push(this.getBuffer(value))
          break
        case 'to':
          raw.push(this.getBuffer(value))
          break
        case 'radius':
          raw.push(this.getBuffer(value))
          break
        case 'lifetime':
          // Centiseconds in a uint16. It was a single signed byte, which capped
          // any lifetime at 12.7s - fine for a 3s fireball, silently wrong for
          // the 60s timer on dropped loot, where the client's countdown ring
          // would finish while the pickup sat there for another 47 seconds.
          raw.push(this.getBuffer2(Math.min(65535, Math.floor(value / 100))))
          break
        case 'maxVelocity':
          raw.push(this.getBuffer(Math.floor(value / 10)))
          break
        case 'maxHp':
          raw.push(this.getBuffer2(value))
          break
        case 'armor':
          raw.push(this.getBuffer2(value))
          break
        case 'maxArmor':
          raw.push(this.getBuffer2(value))
          break
        case 'archetype': {
          // Unsigned, unlike getBuffer: ids are append-only and may pass 127.
          const byte = Buffer.alloc(1)
          byte.writeUInt8(value)
          raw.push(byte)
          break
        }
        case 'item': {
          const byte = Buffer.alloc(1)
          byte.writeUInt8(value)
          raw.push(byte)
          break
        }
        case 'inventory': {
          const counts = value as readonly number[]
          const bytes = Buffer.alloc(1 + counts.length)
          bytes.writeUInt8(counts.length)
          counts.forEach((count, i) => { bytes.writeUInt8(count, 1 + i) })
          raw.push(bytes)
          break
        }
        case 'extractProgress': {
          // Unsigned, like archetype: the progress runs to 254.
          const byte = Buffer.alloc(1)
          byte.writeUInt8(value)
          raw.push(byte)
          break
        }
        case 'facing':
          // Already the snapped index: Unit.serialise swaps the vector for it.
          raw.push(this.getBuffer(value))
          break
        case 'name':
          raw.push(Buffer.from(value), Buffer.alloc(1)); break
      }
    }
    return Buffer.concat(raw)
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
