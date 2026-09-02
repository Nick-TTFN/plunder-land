import Multiplayer from '../network/multiplayer'
import { Vector } from '../utils/vector'

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ObjectType {
  static Obstacle = 1
  static Consumable = 1 << 1
  static Player = 1 << 2
  static Portal = 1 << 3
  static Throwable = 1 << 4
  static Mob = 1 << 5
  static Exit = 1 << 6
}

export class GameObject {
  static id = 0
  id: number = 0
  static FreedIDs: number[] = []
  destroyed: boolean
  dirtyFields: Set<string>
  allFieldsOwn: Set<string>
  allFields: Set<string>

  private _type: number
  private _position: Vector
  private _direction: Vector
  private _hp: number
  private _impulse: Vector
  private _level: number
  private _loot: number
  private _tag: number
  private _to: number
  private _radius: number
  private _lifetime: number
  private _maxVelocity: number
  private _name: string

  static fieldOrder: string[] = [
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
    'name'
  ]

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
      'lifetime'
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
      'name'
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

  get impulse () {
    return this._impulse
  }

  set impulse (value) {
    this._impulse = value
    // this.dirtyFields.add('impulse')
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
  }

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
    // this.dirtyFields.add('maxVelocity')
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

    // we need this time out because server sends out all data asynchronously,
    // and a new objectmight take an id of a destroyed object,
    // before clients were notified about it.
    // our server loop is 16ms, thin of a cleaner way to do this.
    setTimeout(() => {
      GameObject.FreedIDs.push(this.id)
    }, 1000)
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

      raw.push(this.getBuffer(GameObject.fieldOrder.indexOf(key)))
      switch (key) {
        case 'id':
          raw.push(this.getBuffer2(value))
          break
        case 'type':
          raw.push(this.getBuffer(value))
          break
        case 'position':
          raw.push(this.getBufferVec2(value))
          break
        case 'direction':
          raw.push(this.getBufferVec(value.multiply(127)))
          break
        case 'hp':
          raw.push(this.getBuffer2(value))
          break
        case 'impulse':
          raw.push(this.getBufferVec(value.multiply(64)))
          break
        case 'level':
          raw.push(this.getBuffer(value))
          break
        case 'loot':
          raw.push(this.getBuffer2(value))
          break
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
          // wire format is centiseconds in one signed byte; the client
          // multiplies by 100 again on receipt.
          raw.push(this.getBuffer(Math.min(127, Math.floor(value / 100))))
          break
        case 'maxVelocity':
          raw.push(this.getBuffer(Math.floor(value / 10)))
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
