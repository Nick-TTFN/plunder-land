/* eslint-disable no-new */
import {
  TilingSprite,
  Texture,
  Text,
  Container,
  Graphics,
  type Renderer,
  Assets
} from 'pixi.js'
import { TextEffect } from './ui/elements/texteffect'
import { Consumable } from './objects/consumable'
import { Obstacle } from './objects/obstacle'
import { Vector } from './utils/vector'
import { Timer } from './ui/elements/timer'
import { Throwable } from './objects/throwable'
import { Portal } from './objects/portal'
import TWEEN from '@tweenjs/tween.js'
import { CloudsLayer } from './objects/cloudslayer'
import Mob from './objects/mob'
import Player from './objects/player'
import GameEnterPopup from './ui/popups/gameenterpopup'

import { FireBreathEffect } from './vfx/firebreath.effect'
import { IceBreathEffect } from './vfx/icebreath.effect'
import { MeleeAttackEffect } from './vfx/meleeattack.effect'
import { RangedAttackEffect } from './vfx/rangedattack.effect'
import { DefendEffect } from './vfx/defend.effect'
import { type GameObject } from './objects/gameobject'
import { type HUD } from './ui/components/hud'
import { type Socket } from 'socket.io-client'
import { type PopupManager } from './ui/popups/popupmanager'
import { ToolKit } from './ui/components/toolkit'
import { Exit } from './objects/exit'
import { Session } from './net/session'
import { LocalPlayer, type Collider } from './net/localplayer'

/** [uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs] */
const UPDATE_HEADER_BYTES = 8

export class Game extends Container {
  mapSize: number
  serverTick: number = 0
  layers: Container[] | undefined
  static CONTAINER: Container
  tags: number[] | undefined
  static OBSTACLES: GameObject[]
  static CONSUMABLES: Consumable[]
  static PLAYERS: Player[]
  static FIREBALLS: Throwable[]
  static MOBS: Mob[]
  LOOKUP: Record<string, GameObject> = {}
  cloudsLayer: CloudsLayer | undefined
  static socket: Socket
  static hud: HUD
  static socketBytes: number
  static PLAYER: Player | undefined
  static RENDERER: Renderer
  static popups: PopupManager
  static Instance: Game
  static simulate: boolean
  static loader: any

  /**
   * Colliders the local prediction has to respect. The server pushes units out
   * of everything in its OBSTACLES list, which includes portals and exits, so
   * this has to hold all three or prediction walks through them and snaps back.
   */
  static COLLIDERS: Collider[] = []

  /** The locally simulated player. Never fed through onObjectUpdated. */
  static LOCAL: LocalPlayer = new LocalPlayer(() => Game.COLLIDERS)

  constructor () {
    super()
    this.mapSize = 4000

  }

  clear (): void {
    if (this.layers != null) {
      for (const layer of this.layers) {
        if (layer !== null) { while (layer.children.length > 0) layer.removeChildAt(0) }
      }
    }

    while (Game.CONTAINER !== undefined && Game.CONTAINER.children.length > 0) { Game.CONTAINER.removeChildAt(0) }
  }

  createLayer (tex: Texture, size: number): TilingSprite {
    const res = new TilingSprite(tex, size, size)
    res.anchor = ToolKit.TOP_LEFT_ANCHOR
    return res
  }

  start (): void {
    this.clear()

    // todo remove static accessors
    Game.OBSTACLES = []
    Game.CONSUMABLES = []
    Game.PLAYERS = []
    Game.FIREBALLS = []
    Game.MOBS = []

    // main container
    if (Game.CONTAINER === undefined) {
      Game.CONTAINER = new Container()
      this.addChild(Game.CONTAINER)
    }
    // map
    this.tags = [-1, 0, 1]
    this.layers = [
      this.createLayer(Texture.from('tiles/ground.png'), this.mapSize),
      this.createLayer(Texture.from('tiles/grass.png'), this.mapSize),
      new Container()
    ]

    for (const layer of this.layers) {
      layer.alpha = 0
      layer.sortableChildren = true
      Game.CONTAINER.addChild(layer)
    }

    this.cloudsLayer = new CloudsLayer(this.mapSize)
    Game.CONTAINER.addChild(this.cloudsLayer)
    this.cloudsLayer.alpha = 0

    Game.COLLIDERS = []
    this.LOOKUP = {}
    Session.reset()

    Game.socket.off('hello')
    Game.socket.off('create')
    Game.socket.off('create_own')
    Game.socket.off('effect')
    Game.socket.off('update')
    Game.socket.off('destroy')
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    Game.popups.show(new GameEnterPopup(this.onStartRequested.bind(this)))
  }

  async onStartRequested (playerId: string): Promise<void> {
    Game.socket.on('hello', (data) => { Session.onHello(data) })
    Game.socket.on('create', this.onObjectsCreated.bind(this))
    Game.socket.on('create_own', this.onOwnObjectsCreated.bind(this))
    Game.socket.on('effect', this.onEffects.bind(this))
    Game.socket.on('update', this.onObjectsUpdated.bind(this))
    Game.socket.on('destroy', this.onObjectsDestroyed.bind(this))
    Game.socket.emit('start_requested', playerId)

    Game.hud.setupGameUI()
  }

  onObjectsCreated (data: ArrayBuffer): void {
    for (const entry of this.unpackRecords(data)) this.onObjectCreated(entry)
  }

  onOwnObjectsCreated (data: ArrayBuffer): void {
    for (const entry of this.unpackRecords(data)) this.onObjectCreated(entry, true)
  }

  // Each event now arrives as one buffer holding many length-prefixed records
  // (see Multiplayer.packRecords on the server).
  unpackRecords (raw: ArrayBuffer): Uint8Array[] {
    const buffer = new Uint8Array(raw)
    Game.socketBytes += buffer.length
    return this.splitRecords(buffer, 0)
  }

  splitRecords (buffer: Uint8Array, start: number): Uint8Array[] {
    const records: Uint8Array[] = []
    let offset = start
    while (offset + 2 <= buffer.length) {
      const length = (buffer[offset] << 8) + buffer[offset + 1]
      offset += 2
      if (offset + length > buffer.length) {
        console.warn('truncated record batch', buffer)
        break
      }
      records.push(buffer.subarray(offset, offset + length))
      offset += length
    }
    return records
  }

  deserialiseBinary (raw: ArrayBuffer | Uint8Array): any {
    const allFields = [
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
      'name',
      'maxHp'
    ]

    const buffer = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
    const data: Record<string, number | Vector | string> = {}
    let offset = 0
    while (offset < buffer.length) {
      let value
      const keyIndex = buffer[offset++]
      const key = allFields[keyIndex]

      // An unrecognised key index means the stream is already misaligned and
      // there is no way to know how wide the payload is. Keep what parsed
      // cleanly rather than emitting garbage for every field after it.
      if (key === undefined) {
        console.warn('unknown field index', keyIndex, 'in', buffer)
        break
      }

      switch (key) {
        case 'id':
          value = (buffer[offset++] << 8) + buffer[offset++]
          break
        case 'type':
          value = buffer[offset++]
          break
        case 'position':
          value = new Vector(
            (buffer[offset++] << 8) + buffer[offset++],
            (buffer[offset++] << 8) + buffer[offset++]
          )
          break
        case 'hp':
          value = (buffer[offset++] << 8) + buffer[offset++]
          break
        case 'impulse':
          value = new Vector(this.overflow(buffer[offset++], 128) / 64, this.overflow(buffer[offset++], 128) / 64)
          break
        case 'level':
          value = buffer[offset++]
          break
        case 'loot':
          value = (buffer[offset++] << 8) + buffer[offset++]
          break
        case 'tag':
          value = this.overflow(buffer[offset++], 128)
          break
        case 'to':
          value = this.overflow(buffer[offset++], 128)
          break
        case 'radius':
          value = buffer[offset++]
          break
        case 'lifetime':
          value = ((buffer[offset++] << 8) + buffer[offset++]) * 100
          break
        case 'maxVelocity':
          value = buffer[offset++] * 10
          break
        case 'maxHp':
          value = (buffer[offset++] << 8) + buffer[offset++]
          break
        case 'name':
          value = ''

          while (offset < buffer.length) {
            const code = buffer[offset++]
            if (code === 0) { break }
            value += String.fromCharCode(code)
          }

          break
      }

      if (value !== undefined) data[key] = value
    }

    return data
  }

  onObjectCreated (raw: Uint8Array, own = false): void {
    let obj: GameObject | undefined

    const data = this.deserialiseBinary(raw)

    switch (data.type) {
      case 1: {
        const sheet = Assets.get('./res/atlas.json')
        const frames =
            sheet.data.animations[
              data.tag === 0
                ? data.radius < 20
                  ? 'obstacle_1_sm/obj'
                  : 'obstacle_1_lg/obj'
                : data.radius < 20
                  ? 'obstacle_0_sm/obj'
                  : 'obstacle_0_lg/obj'
            ]
        const tex = Texture.from(
          frames[Math.floor(frames.length * Math.random())]
        )
        obj = new Obstacle(tex, data.radius)
        Game.OBSTACLES.push(obj)
      }
        break

      case 1 << 4: {
        // Projectiles were never rendered: this branch was commented out, so
        // ThrowFireball and ThrowIcicle fired server-side and showed nothing.
        // Both use the fireball sprite; the atlas has no icicle art.
        const throwable = new Throwable()
        Game.FIREBALLS.push(throwable)
        obj = throwable as unknown as GameObject
        break
      }

      case 1 << 5:
        obj = new Mob(data.radius)

        const mob = (obj as Mob)
        mob.setHP(data.hp)
        Game.MOBS.push(mob)
        break

      case 1 << 3:
        obj = new Portal(data.radius, data.to > data.tag)
        break

      case 1 << 6:
        obj = new Exit(data.radius)
        break

      case 1 << 1:{
        const sheet = Assets.get('./res/atlas.json')
        const frames = sheet.data.animations['resource/resource']
        const tex = Texture.from(
          frames[Math.floor(frames.length * Math.random())]
        )
        const consumable = new Consumable(tex, data.radius, data.radius)
        Game.CONSUMABLES.push(consumable)
        obj = consumable

        break
      }

      case 1 << 2:{
        const player = new Player()
        player.setHP(data.hp)
        Game.PLAYERS.push(player)
        obj = player

        break
      }
    }

    if (obj === undefined) return

    if (data.maxVelocity !== undefined) (obj as any).maxVelocity = data.maxVelocity

    if (own) {
      Game.PLAYER = obj as Player

      Game.LOCAL.reset(
        data.position?.x ?? obj.x,
        data.position?.y ?? obj.y,
        data.tag,
        data.maxVelocity ?? 0
      )

      Game.hud.setupStats()
      Game.hud.setupSkills(Game.PLAYER.skills)

      this.updateLayerVisibility(data.tag)
    }

    if (data.lifetime !== undefined) {
      obj.addChild(new Timer(data.lifetime / 1000))
      if (obj.main != null) obj.main.tint = 0xffbb00
    }

    if (data.name !== undefined) {
      const label = new Text(data.name, {
        fontFamily: '"Trebuchet MS", Helvetica, sans-serif',
        fontSize: 10,
        fill: 'white',
        stroke: 'black',
        strokeThickness: 1
      })

      // move into name component of gameobject
      const name = new Container()
      const graphics = new Graphics()
      graphics.alpha = 0.4
      graphics
        .beginFill(0x000000)
        .drawRect(-3, 0, label.width + 5, label.height + 2)
        .endFill()
      name.addChild(graphics)
      name.addChild(label)

      name.x = -(label.width + 5) / 2
      name.y = -50
      obj.addChild(name)
    }

    if (data.position !== undefined) {
      obj.x = data.position.x
      obj.y = data.position.y
    }

    obj.tag = data.tag

    if ((this.layers != null) && (this.tags != null)) { this.layers[this.tags.indexOf(obj.tag ?? 0)].addChild(obj) }

    if (data.radius !== undefined && obj.radius !== data.radius) {
      obj.radius = data.radius
      obj.DEBUG_DRAW_COLLIDER()
    }

    // Obstacles, portals and exits all sit in the server's OBSTACLES list and
    // all push units out, so local prediction has to know about all three.
    if (data.type === 1 || data.type === (1 << 3) || data.type === (1 << 6)) {
      Game.COLLIDERS.push(obj as unknown as Collider)
    }

    this.LOOKUP[data.id] = obj
  }

  overflow (value: number, limit: number): number {
    if (value >= limit) value -= 2 * limit
    return value
  }

  updateLayerVisibility (tag: number): void {
    if ((this.layers == null) || (this.tags == null)) return

    for (const layer of this.layers) {
      const tagIndex = this.tags.indexOf(tag)
      const layerIndex = this.layers.indexOf(layer)

      let layerAlpha = tagIndex === layerIndex ? 1 : 0
      let layerScale = 1

      if (tagIndex === 2 && layerIndex === 1) {
        layerAlpha = 0.5
        layerScale = 0.7
      }

      new TWEEN.Tween(layer).to({ alpha: layerAlpha }, 500).start()
      new TWEEN.Tween(layer.scale)
        .to({ x: layerScale, y: layerScale }, 500)
        .start()
    }

    if (this.cloudsLayer != null) {
      new TWEEN.Tween(this.cloudsLayer)
        .to({ alpha: tag === 1 ? 1 : 0 }, 500)
        .start()
    }
  }

  onEffects (data: ArrayBuffer) {
    // ADD_TO_BENCHMARK(data);

    for (const entry of this.unpackRecords(data)) this.onEffect(entry)
  }

  onEffect (raw: Uint8Array) {
    const buffer = new Uint8Array(raw)
    Game.socketBytes += buffer.length

    let offset = 0

    const type = buffer[offset++]
    const targetid = (buffer[offset++] << 8) + buffer[offset++]
    const lifetime = buffer[offset++] * 100

    const target = this.LOOKUP[targetid]
    if (target === undefined) {
      console.warn('target not found for effect', buffer)
      return
    }

    switch (type) {
      case 0:
        new FireBreathEffect(target, lifetime)
        break

      case 1:
        new IceBreathEffect(target, lifetime)
        break

      case 2:
        new MeleeAttackEffect(target, lifetime)
        break

      case 3:
        new RangedAttackEffect(target)
        break

      case 4:
        new DefendEffect(target, lifetime)
        break
    }
  }

  onObjectsUpdated (data: ArrayBuffer) {
    const buffer = new Uint8Array(data)
    Game.socketBytes += buffer.length

    if (buffer.length < UPDATE_HEADER_BYTES) return

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    // [uint32 tick][uint16 lastInputSeq][uint16 ackElapsedMs]
    this.serverTick = view.getUint32(0)
    const ackSeq = view.getUint16(4)
    const ackElapsed = view.getUint16(6)

    const now = performance.now()
    Session.onPacket(now)

    for (const entry of this.splitRecords(buffer, UPDATE_HEADER_BYTES)) {
      this.onObjectUpdated(entry, ackSeq, ackElapsed, now)
    }
  }

  onObjectUpdated (raw: Uint8Array, ackSeq: number = 0, ackElapsed: number = 0, now: number = performance.now()) {
    const data = this.deserialiseBinary(raw)

    const obj = this.LOOKUP[data.id]

    if (obj) {
      // TODO generalise unit, move this into setData of relative descendant
      if (data.direction) obj.setDirection(data.direction.x, data.direction.y)

      if (data.position) {
        if (obj === Game.PLAYER) {
          // Authority for the local player is a correction, not a position.
          Game.LOCAL.reconcile(data.position.x, data.position.y, ackSeq, ackElapsed, now)
        } else if (obj.pushState) {
          obj.pushState(data.position.x, data.position.y)
        } else if (obj.setMoveTarget) {
          obj.setMoveTarget(new Vector(data.position.x, data.position.y))
        } else {
          obj.x = data.position.x
          obj.y = data.position.y
        }
      }

      if (data.maxVelocity) {
        obj.maxVelocity = data.maxVelocity
        if (obj === Game.PLAYER) Game.LOCAL.maxVelocity = data.maxVelocity
      }

      if (data.maxHp !== undefined && obj.setMaxHP) obj.setMaxHP(data.maxHp)

      if (data.hp !== undefined && obj.setHP) obj.setHP(data.hp)

      if (data.impulse && obj.impulse) obj.impulse = data.impulse

      if (data.level !== undefined && obj.setLevel) {
        obj.setLevel(data.level)
        if (obj === Game.PLAYER) Game.hud.updateStats(data)
      }

      if (data.loot !== undefined && data.loot !== obj.loot) {
        // Was `+${data.loot < obj.loot ? data.loot : data.loot - obj.loot}`, which
        // printed the new absolute total with a plus sign whenever loot fell, and
        // NaN the first time an object was seen with no previous value.
        const delta = data.loot - (obj.loot ?? 0)
        new TextEffect(
          `${delta > 0 ? '+' : ''}${delta}`,
          Game.CONTAINER,
          obj.x,
          obj.y,
          24,
          delta > 0 ? 'green' : 'orange',
          400
        )
        obj.loot = data.loot

        if (obj === Game.PLAYER) Game.hud.updateStats(data)
      }

      if (data.tag !== undefined && data.tag !== obj.tag) {
        obj.tag = data.tag
        if (obj === Game.PLAYER) Game.LOCAL.tag = data.tag
        this.layers[this.tags.indexOf(obj.tag)].addChild(obj)

        if (obj === Game.PLAYER) this.updateLayerVisibility(data.tag)
      }

      if (data.radius !== undefined && obj.radius !== data.radius) {
        obj.radius = data.radius
        if (obj.DEBUG_DRAW_COLLIDER) obj.DEBUG_DRAW_COLLIDER()
      }

      if (obj._lastUpdate > 0) { obj.timeSinceUpdate = (Date.now() - obj._lastUpdate) / 1000 }

      obj._lastUpdate = Date.now()
    }
  }

  onObjectsDestroyed (data: ArrayBuffer) {
    for (const entry of this.unpackRecords(data)) this.onObjectDestroyed(entry)
  }

  onObjectDestroyed (raw: Uint8Array) {
    const data = this.deserialiseBinary(raw)

    const obj = this.LOOKUP[data.id]
    if (obj !== undefined) {
      const collider = Game.COLLIDERS.indexOf(obj as unknown as Collider)
      if (collider >= 0) Game.COLLIDERS.splice(collider, 1)

      if (data.hp !== undefined && obj.setHP) { obj.setHP(data.hp) }

      if (obj === Game.PLAYER) {
        if (data.hp === 0) { new TextEffect('Game Over', this, 0, 0) } else { new TextEffect('Win!', this, 0, 0, 64, 'green') }
        setTimeout(this.start.bind(this), 2000)
        Game.PLAYER = undefined
        Game.hud.clearGameUI()
      }

      // Drop every reference. These arrays were never pruned, so the render loop
      // kept walking objects that had been destroyed rounds ago, and LOOKUP kept
      // resolving recycled ids to stale containers.
      for (const list of [Game.PLAYERS, Game.MOBS, Game.CONSUMABLES, Game.OBSTACLES, Game.FIREBALLS]) {
        const at = (list as unknown[]).indexOf(obj)
        if (at >= 0) list.splice(at, 1)
      }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.LOOKUP[data.id]

      obj.dispose()
    }
  }

  /**
   * Silence is no longer evidence of absence. Idle units send nothing at all
   * now that the per-tick id heartbeat is gone, so a unit that has stopped
   * reporting is only really gone if it is also outside the interest window the
   * server is filtering on.
   */
  stillPresent (unit: GameObject, staleBefore: number): boolean {
    if (unit._lastUpdate > staleBefore) return true
    if (Game.PLAYER === undefined) return false

    const r = Session.interestRadius
    return Math.abs(unit.x - Game.PLAYER.x) < r && Math.abs(unit.y - Game.PLAYER.y) < r
  }

  update (dt: number): void {
    // for (const obstacle of Game.OBSTACLES) {
    //   obstacle.update(dt)
    // }

    // for (const obj of Game.CONSUMABLES) {
    //   obj.update(dt)
    // }

    const now = performance.now()

    // The local player moves on input, not on the network.
    Game.LOCAL.predict(dt)

    const staleBefore = Date.now() - Session.stalenessLimit

    for (const player of Game.PLAYERS) {
      if (player === Game.PLAYER) {
        player.visible = true
        player.applyPosition(Game.LOCAL.renderX, Game.LOCAL.renderY, now)
        continue
      }
      if (this.stillPresent(player, staleBefore)) {
        player.visible = true
        player.update(dt)
      } else {
        player.visible = false
      }
    }

    for (const mob of Game.MOBS) {
      if (this.stillPresent(mob, staleBefore)) {
        mob.visible = true
        mob.update(dt)
      } else {
        mob.visible = false
      }
    }

    if (Game.PLAYER != null) {
      Game.CONTAINER.x = -Game.PLAYER.x
      Game.CONTAINER.y = -Game.PLAYER.y

      // parallax (kinda)
      for (const layer of this.layers) {
        layer.x = Game.PLAYER.x * (1 - layer.scale.x)
        layer.y = Game.PLAYER.y * (1 - layer.scale.y)
      }
    }

    this.cloudsLayer.update(dt)
  }
}
