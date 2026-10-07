/* eslint-disable no-new */
import {
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
import { Hex } from './utils/hex'
import { archetypeById } from './utils/archetypes'
import { PathMarker } from './ui/elements/pathmarker'
import { ThreatMarker, type Threat } from './ui/elements/threatmarker'
import { threatRingsOf } from './vfx/cells'
import { Timer } from './ui/elements/timer'
import { ExtractRing } from './ui/elements/extractring'
import { Throwable, PROJECTILE } from './objects/throwable'
import { Portal } from './objects/portal'
import TWEEN from '@tweenjs/tween.js'
import { HexTerrain } from './objects/hexterrain'
import { Walls } from './objects/walls'
import { Fog, SEEN, LAYER_TINT } from './objects/fog'
import { TILT, TiltedContainer, onGround } from './objects/tilt'
import Mob from './objects/mob'
import Player from './objects/player'
import Lobby from './ui/lobby/lobby'
import { RunRecord, RunSummaryCard } from './ui/popups/runsummary'
import { type BringPair } from './net/stash'

import { FireBreathEffect } from './vfx/firebreath.effect'
import { IceBreathEffect } from './vfx/icebreath.effect'
import { MeleeAttackEffect } from './vfx/meleeattack.effect'
import { Aim } from './skills/aim'
import { RangedAttackEffect } from './vfx/rangedattack.effect'
import { DefendEffect } from './vfx/defend.effect'
import { BlastEffect } from './vfx/blast.effect'
import { BombEffect } from './vfx/bomb.effect'
import { ReactorEffect } from './vfx/reactor.effect'
import { KilnLobEffect } from './vfx/kilnlob.effect'
import { KnockbackEffect, ShockwaveEffect } from './vfx/shockwave.effect'
import { CoilPulseEffect, SlowedEffect } from './vfx/coilfield.effect'
import { NPC_EFFECT } from './vfx/npceffects'
import { BroodlingEffect, BroodReleaseEffect, attachFuse, emerge } from './vfx/brood.effect'
import { ItemPickup } from './objects/itempickup'
import { GearPickup } from './objects/gearpickup'
import { itemById } from './utils/items'
import { finishFromBytes } from './utils/finishes'
import { type GearInstance } from './utils/gear'
import Unit from './objects/unit'
import { type GameObject } from './objects/gameobject'
import { type HUD } from './ui/components/hud'
import { type Socket } from 'socket.io-client'
import { type PopupManager } from './ui/popups/popupmanager'
import { Exit } from './objects/exit'
import { Session } from './net/session'
import { LocalPlayer } from './net/localplayer'
import { slotsFor } from './net/loadout'
import { onRefused, setEnergy } from './net/energy'
import { SETTINGS } from './net/settings'
import { clearFull, onFull } from './net/full'
import { decodeRecord } from './net/records'
import { RunMap, resetForRun } from './net/runmap'
import { presenceReach, stillPresent, type Viewpoint } from './net/presence'
import { SpectateBar } from './ui/popups/spectatebar'
import { Leaderboard, decodeStanding, type StandingRow } from './ui/components/leaderboard'

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
  /** The drawn ground of each layer, parallel to `layers`. */
  terrains: HexTerrain[] = []
  /** Each plane's walls, in `tags` order like `terrains`. */
  walls: Walls[] = []
  /** Draws the route the local player is walking. */
  pathMarker: PathMarker | undefined
  /** Red cells under the mobs that can reach you (world-markers). */
  threatMarker: ThreatMarker | undefined
  static socket: Socket
  static hud: HUD
  static socketBytes: number
  static PLAYER: Player | undefined
  /** `PLAYER`'s object id, which client objects do not carry themselves. */
  static PLAYER_ID: number | undefined
  static RENDERER: Renderer
  static popups: PopupManager
  /** Tile fog of war (fog-of-war, M2): reset per run at the own create. */
  static FOG = new Fog()
  /** This run's facts for the end-of-run card (run-summary-card, M2). */
  static RUN = new RunRecord()
  /**
   * Effects (types 0-4) whose originator this client does not hold, so
   * nothing was drawn (`onEffect`). Since the fog follow-ups (#48) a unit's
   * effect goes only to holders of its originator, so this should stay at 0;
   * a counter, not a warning, in case it doesn't.
   */
  static EFFECTS_UNHELD = 0

  /**
   * A knockback of our own player (effect 15) waiting for the update header
   * of the same flush, whose `lastInputSeq` `LocalPlayer.knockback` needs.
   * Effects come before the update in every flush, framed or not.
   */
  private _knockback: Vector | undefined
  /**
   * The object id a dead player watches (spectate, decision #47), from the
   * server's `spectate` event; undefined when not spectating.
   */
  static SPECTATE_ID: number | undefined
  private spectateBar: SpectateBar | undefined
  private runCard: RunSummaryCard | undefined
  /** The layer whose plane is shown, so following a spectated player fades only on a change. */
  private shownTag: number | undefined
  static Instance: Game
  static loader: any

  /**
   * The map this run is on: blocked cells, valleys and portals
   * (`net/runmap.ts`). Reset by `start` before every run, because the next run
   * can be in another world on the same server (worlds-per-process, #39).
   */
  static MAP = new RunMap()

  /**
   * Portals per plane: `Hex.key` of the portal's cell to the tag it leads to
   * (`MAP.portals`). Local prediction ends a route on a portal's cell and
   * waits there for the server's hop (`LocalPlayer._endAtPortal`), as the
   * server ends it (`Unit.endAtPortal`). Missing one, prediction walks on past
   * a portal the server has already taken the player through.
   *
   * It replaced `COLLIDERS` in hex-cells P2: nothing pushes the player out of
   * anything any more, so rocks matter only as blocked cells (`BLOCKED`) and
   * portals only as cells.
   */
  static get PORTALS (): Map<number, Map<number, number>> {
    return Game.MAP.portals
  }

  static portalTo (q: number, r: number, tag: number | undefined): number | undefined {
    return Game.MAP.portalTo(q, r, tag)
  }

  /**
   * Blocked cells per plane, mirroring `World.BLOCKED` on the server
   * (`MAP.blocked`).
   *
   * Populated from the obstacles the server sends, so it only ever covers what
   * is inside the interest radius - which is the point. The client can only
   * route through cells it can see, and the server searches the same bounded
   * window, so both derive the same path.
   */
  static get BLOCKED (): Map<number, Set<number>> {
    return Game.MAP.blocked
  }

  /**
   * Each layer's valleys by tag, from `hello.voids` (`Session.voids`,
   * `MAP.voids`): cells that are blocked for routing, like `BLOCKED`, and that
   * the ground always draws as unknown void. Replaced wholesale on every
   * `hello`, so a new world's map never mixes with an old one's.
   */
  static get VOIDS (): Map<number, Set<number>> {
    return Game.MAP.voids
  }

  /** Each layer's walls by tag, from `hello.walls` (decision #44): blocked for routing, drawn by `Walls`. */
  static get WALLS (): Map<number, Set<number>> {
    return Game.MAP.walls
  }

  /**
   * Whether the local player can't walk into cell (q, r) of its layer:
   * `isBlocked`, except that Hopper (`passesObstacles`) is stopped only by
   * void and the map edge (decision #44). **Mirrors the server's
   * `Unit.blocks`.**
   */
  static blocksLocal (q: number, r: number): boolean {
    const tag = Game.LOCAL.tag
    if (Game.PLAYER?.archetype?.passesObstacles !== true) return Game.isBlocked(q, r, tag)
    if (!Hex.onMap(q, r, Session.mapSize)) return true
    return tag !== undefined && Game.VOIDS.get(tag)?.has(Hex.key(q, r)) === true
  }

  static isBlocked (q: number, r: number, tag: number | undefined): boolean {
    // Off the map counts as solid, matching `World.isBlocked`. Without it the
    // client would happily route out past the edge while the server refused,
    // and the two would disagree about the one thing this design depends on
    // them agreeing about.
    if (!Hex.onMap(q, r, Session.mapSize)) return true
    if (tag === undefined) return false
    return Game.MAP.has(q, r, tag)
  }

  static block (q: number, r: number, tag: number): void {
    Game.MAP.block(q, r, tag)

    // Mirrors `World.block`, which re-routes anything walking through a cell
    // that just became solid. Without this the client keeps walking its old
    // route into a rock the server has already routed around, and every step
    // after that is a correction.
    if (Game.LOCAL.tag === tag && Game.LOCAL.pathCrosses(q, r)) Game.LOCAL.repath()
  }

  static unblock (q: number, r: number, tag: number): void {
    Game.MAP.unblock(q, r, tag)
  }

  /** The locally simulated player. Never fed through onObjectUpdated. */
  static LOCAL: LocalPlayer = new LocalPlayer(
    (q, r) => Game.blocksLocal(q, r),
    (q, r) => Game.portalTo(q, r, Game.LOCAL.tag)
  )

  constructor () {
    super()
    this.mapSize = 4000
    Player.wallAt = (q, r, tag) => Game.WALLS.get(tag)?.has(Hex.key(q, r)) === true

    // The NPC rigs' sheets (l1-8), in the background: a mob created before
    // they land draws `mob/mob` (`Mob.initAnimation`, `NpcSprite.ready`).
    void Assets.load(Game.NPC_SHEETS).catch((e) => { console.warn('NPC sheets did not load', e) })
  }

  /** `tools/bake-npc-atlas.py` writes one per NPC rig (`src/npcs/npcrig.ts` `NPC_RIGS`). */
  static readonly NPC_SHEETS = ['./res/npc-crawler.json', './res/npc-broodling.json']

  clear (): void {
    if (this.layers != null) {
      for (const layer of this.layers) {
        if (layer !== null) { while (layer.children.length > 0) layer.removeChildAt(0) }
      }
    }

    while (Game.CONTAINER !== undefined && Game.CONTAINER.children.length > 0) { Game.CONTAINER.removeChildAt(0) }
  }

  /**
   * A plane: its hex ground, plus everything standing on it.
   *
   * The ground goes in as a child rather than being the layer itself, because
   * the layer is also the parent of every object on that plane and those sort
   * against each other by `y`. A single very negative zIndex puts the ground
   * under all of them and under the path marker at -1.
   */
  createLayer (group: string): Container {
    // On the ground itself, so the camera's tilt squashes it; everything added
    // to it then stands up (objects/tilt.ts).
    const layer = onGround(new TiltedContainer())

    // `meta.regions` names the palettes in the order the terrain lays them out
    // along its noise field, so the order is the sheet's to decide and not this
    // function's to guess from key order.
    const sheet = Assets.get('./res/ground.json')
    const terrain = new HexTerrain(
      sheet.data.meta.regions[group].map((region: string) =>
        sheet.data.animations[region].map((name: string) => Texture.from(name))
      ),
      Texture.from(sheet.data.meta.outline),
      Texture.from(sheet.data.meta.fade.left),
      Texture.from(sheet.data.meta.fade.right)
    )
    if (Math.abs(sheet.data.meta.tilt - TILT) > 1e-6) {
      console.warn(`ground.json is baked for tilt ${String(sheet.data.meta.tilt)}, the camera is at ${TILT}: re-bake`)
    }
    terrain.zIndex = -1000

    layer.addChild(terrain)
    this.terrains.push(terrain)

    return layer
  }

  start (): void {
    this.clear()
    this.endSpectate()
    this.runCard = undefined

    // todo remove static accessors
    Game.OBSTACLES = []
    Game.CONSUMABLES = []
    Game.PLAYERS = []
    Game.FIREBALLS = []
    Game.MOBS = []

    // main container
    if (Game.CONTAINER === undefined) {
      // The tilted camera (objects/tilt.ts): the ground is drawn squashed to
      // TILT of its height, and toLocal undoes it for the pointer and the aim.
      Game.CONTAINER = new TiltedContainer()
      Game.CONTAINER.scale.y = TILT
      this.addChild(Game.CONTAINER)
    }
    // The layers come from the server, in `hello` (see onHello).
    this.tags = undefined
    this.layers = undefined
    this.terrains = []
    this.walls = []

    // Parented in update(), not here: it belongs to whichever plane the player
    // is standing on, and a portal moves them between planes mid-run.
    this.pathMarker = new PathMarker()
    this.threatMarker = new ThreatMarker()

    // Nothing of the last run's map, or of what it saw, is kept: the next run
    // may be in another world (worlds-per-process, #39), with other valleys,
    // portals and stones, and ids that name other objects. BLOCKED was never
    // cleared before this, so a stone from an earlier run stayed solid. This
    // also does `Session.reset()`.
    resetForRun(Game.MAP, Game.FOG)
    // Stops predicting the last run's route until the new own create resets it.
    Game.LOCAL.stop()
    Game.LOCAL.ready = false
    this._knockback = undefined
    Game.PLAYER = undefined
    Game.PLAYER_ID = undefined
    this.LOOKUP = {}

    Game.socket.off('hello')
    Game.socket.off('create')
    Game.socket.off('create_own')
    Game.socket.off('effect')
    Game.socket.off('update')
    Game.socket.off('destroy')
    Game.socket.off('standings')
    Game.socket.off('spectate')
    Game.socket.off('start_refused')
    Game.socket.off('full')
    Leaderboard.Instance?.setStandings([], undefined)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    Game.popups.show(new Lobby(this.onStartRequested.bind(this)))
  }

  async onStartRequested (playerId: string, name: string, finish: number[], robot: string, party: string, loadout: number, bring?: BringPair): Promise<void> {
    Game.socket.on('hello', this.onHello.bind(this))
    Game.socket.on('create', this.onObjectsCreated.bind(this))
    Game.socket.on('create_own', this.onOwnObjectsCreated.bind(this))
    Game.socket.on('effect', this.onEffects.bind(this))
    Game.socket.on('update', this.onObjectsUpdated.bind(this))
    Game.socket.on('destroy', this.onObjectsDestroyed.bind(this))
    Game.socket.on('standings', this.onStandings.bind(this))
    Game.socket.on('spectate', this.onSpectate.bind(this))
    Game.socket.on('start_refused', this.onStartRefused.bind(this))
    // Server full (burst-capacity): the transport closes next, socket.io
    // reconnects, and the lobby that comes back retries (net/full.ts).
    Game.socket.on('full', (data: unknown) => { onFull(data, performance.now()) })
    // `{ id, name, finish }`: the server plays under this connection's guest
    // account (decision #48, net/account.ts) and ignores `id`, which is sent
    // for one more release only because an older server refuses a start
    // without one; remove it in the release after. The name and the robot's
    // finish are only what others see. The server
    // sanitises and caps the name, gives an empty one a callsign made from the
    // id, and replaces anything unreadable in the finish with the default.
    // `robot` is the key of the robot picked in the lobby (robot-select); the
    // server plays peep for anything it doesn't offer.
    // `party`: the invite code (decision #47); a server from before it ignores it.
    // `loadout`: the index of the robot's loadout READY plays (decision #48
    // step 4); the server checks it and plays the start kit for anything else.
    // `bring`: stash row ids for keys 3 and 4 (decision #49, 49-4), only when
    // the lobby has some to send; a server from before the stash ignores it,
    // and the server carries only what the account owns and its level allows.
    Game.socket.emit('start_requested', bring === undefined
      ? { id: playerId, name, finish, robot, party, loadout }
      : { id: playerId, name, finish, robot, party, loadout, bring })

    Game.hud.setupGameUI()
  }

  /**
   * The server refused the start (decision #48 step 7: no play left). No run
   * began, so back to the lobby, whose READY line now says when the next play
   * comes. A refusal for a reason this client doesn't know does the same.
   */
  onStartRefused (data: unknown): void {
    const refusal = onRefused(data)
    if (refusal?.energy !== undefined) setEnergy(refusal.energy, Date.now())
    if (Game.PLAYER !== undefined) return
    Game.hud.clearGameUI()
    this.start()
  }

  /**
   * Builds one layer per tag the server lists, top (01) first. `hello` is
   * emitted before the join's first flush, so the layers exist before any
   * object that stands on them arrives.
   *
   * Every layer is the same steel ground (`ground.json`), tinted darker and
   * colder per layer (`LAYER_TINT`) until there is art for each.
   */
  onHello (data: Parameters<typeof Session.onHello>[0]): void {
    Session.onHello(data)
    // A run began: no server-full retry is pending any more.
    clearFull()
    Game.MAP.setVoids(Session.layers, Session.voids)
    Game.MAP.setWalls(Session.layers, Session.walls)
    // A later hello (a new run, or a reconnect to a restarted server) may
    // bring a different map: redraw the ground's fog over it.
    for (const terrain of this.terrains) terrain.retint()
    if (this.layers != null) {
      this.placeWalls()
      return
    }

    this.tags = [...Session.layers]
    this.terrains = []
    this.layers = this.tags.map(() => this.createLayer('ground/steel'))
    // Each plane's pads take the fog for their own layer, and its own tint.
    this.terrains.forEach((terrain, i) => {
      const tag = this.tags?.[i]
      terrain.seenOf = (q, r) => Game.FOG.state(q, r, tag)
      // Off the map is void too, so the ground ends in a drop at the edge.
      terrain.voidOf = (q, r) =>
        !Hex.onMap(q, r, Session.mapSize) || (tag !== undefined && Game.VOIDS.get(tag)?.has(Hex.key(q, r)) === true)
      terrain.tint = LAYER_TINT[Math.min(i, LAYER_TINT.length - 1)]
    })
    for (const layer of this.layers) {
      layer.alpha = 0
      layer.sortableChildren = true
      Game.CONTAINER.addChild(layer)
    }
    this.walls = this.layers.map((layer, i) => new Walls(layer, this.terrains[i], LAYER_TINT[Math.min(i, LAYER_TINT.length - 1)]))
    this.placeWalls()
  }

  /** Each plane's walls from `Game.WALLS`, under the fog as it stands. */
  private placeWalls (): void {
    this.walls.forEach((walls, i) => {
      const tag = this.tags?.[i]
      walls.set(tag !== undefined ? Game.WALLS.get(tag) : undefined, Session.mapSize)
      walls.retint((q, r) => Game.FOG.state(q, r, tag))
    })
  }

  onObjectsCreated (data: ArrayBuffer): void {
    for (const entry of this.unpackRecords(data)) this.onObjectCreated(entry)
  }

  onOwnObjectsCreated (data: ArrayBuffer): void {
    for (const entry of this.unpackRecords(data)) this.onObjectCreated(entry, true)
  }

  /** The standings board, about once a second, already ranked by the server. */
  onStandings (data: ArrayBuffer): void {
    const rows: StandingRow[] = []
    for (const entry of this.unpackRecords(data)) {
      const row = decodeStanding(entry)
      if (row !== undefined) rows.push(row)
    }
    Leaderboard.Instance?.setStandings(rows, Game.PLAYER_ID)
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
      // Deprecated, a uint16: no server since loot32 writes it. Still read, so
      // this client works against an older server.
      'loot',
      'tag',
      'to',
      'radius',
      'lifetime',
      'maxVelocity',
      'name',
      'maxHp',
      // A unit's hex facing, 0-5 into Hex.DIRECTIONS. Only for looks: effects
      // carry their own aim (decision #21).
      'facing',
      // The armor pool (#16), uint16 each. Only units with a pool send them.
      'armor',
      'maxArmor',
      // The unit's archetype id, one unsigned byte, looked up in the mirrored
      // utils/archetypes.ts. Only units built from an archetype send it, and
      // only with the whole record (a create, or a full resend in `update`),
      // never in a delta. Read only at construction.
      'archetype',
      // An item pickup's kind, one unsigned byte: its id in the mirrored
      // utils/items.ts. Only in an item pickup's create.
      'item',
      // A player's inventory: a uint8 slot count, then a uint8 count per slot,
      // by the fixed slot each kind lives in (utils/items.ts). Read for the own
      // player only; a change reaches every client in range, like loot. (No
      // square brackets in these comments: fieldtable.spec.ts reads this table
      // with a regex that stops at the first closing one.)
      'inventory',
      // How far a player is through extracting, one unsigned byte: 0 not
      // extracting, 1-254 in 255ths of the layer's time. Only ever a delta.
      'extractProgress',
      // Carried loot as a uint32, replacing the uint16 loot field, which a haul
      // over 65,535 overflowed. Stored under loot, so nothing downstream changes.
      'loot32',
      // The player's kills this run, uint16, for the run-summary card. In the
      // own create and a delta on each kill.
      'kills',
      // A projectile's kind, one unsigned byte: PROJECTILE in
      // objects/throwable.ts. Only in a projectile's create; a server from
      // before it sends none, and the projectile draws as a fireball.
      'projectile',
      // A player's finish (robot-finishes, #41): a count, then colour and
      // pattern for head, body and limbs (utils/finishes.ts). A server from
      // before it sends none, and the robot is drawn in the default finish.
      'finish',
      // Who took a pickup, a uint16 id, in its destroy record only
      // (pickup-reach): the pickup flies to them.
      'collector',
      // A gear pickup's item (decision #49): a uint8 count, then one instance
      // as utils/gear.ts encodes it. Only in a gear pickup's create, which is
      // type 128 like an item pickup and tells itself apart by this field.
      'gear',
      // The own player's carried gear: a uint16 count, then 6 entries, each a
      // uint8 length and an instance (0 = empty): the two gear slots, keys 3
      // and 4, then the bag of 4. In the own create and a delta on change.
      'carried',
      // maxVelocity in tenths, a uint16, stored as maxVelocity. It replaces
      // index 10, which floored speed to tens; that one is still read for an
      // older server.
      'speed'
    ]

    return decodeRecord(raw, allFields)
  }

  /** The own player's `carried` field (decision #49): the gear cards, the bag and the run card's count. */
  applyCarried (carried: Array<GearInstance | null>): void {
    Game.hud.updateGear(carried)
    Game.RUN.setCarried(carried)
  }

  /**
   * The armor pool's two fields onto the unit, for the HUD to read
   * (`hud-rebuild`). Either may come alone in a delta.
   */
  applyArmor (unit: Unit, data: Record<string, unknown>): void {
    if (typeof data.maxArmor === 'number') unit.maxArmor = data.maxArmor
    if (typeof data.armor === 'number') {
      if (data.armor < unit.armor) unit.onHurt()
      unit.armor = data.armor
    }
    if (typeof data.maxArmor === 'number' || typeof data.armor === 'number') unit.onArmor()
  }

  onObjectCreated (raw: Uint8Array, own = false): void {
    let obj: GameObject | undefined

    const data = this.deserialiseBinary(raw)

    switch (data.type) {
      case 1: {
        // A StoneWall stone, the only obstacle since the valleys replaced world
        // rocks: one crate per cell, on every layer (art pass 2026-09-28).
        obj = new Obstacle(Texture.from('map/stone_wall.png'), data.radius)
        Game.OBSTACLES.push(obj)
      }
        break

      case 1 << 4: {
        // Fireball or icicle by the `projectile` field; a server from before
        // it sends none, and every projectile draws as a fireball.
        const throwable = new Throwable(data.projectile === PROJECTILE.icicle)
        Game.FIREBALLS.push(throwable)
        obj = throwable as unknown as GameObject
        break
      }

      case 1 << 5:
        // An id this build doesn't know gives undefined, and the mob draws
        // today's sprite (archetypesprites.ts).
        obj = new Mob(data.radius, archetypeById(data.archetype))

        const mob = (obj as Mob)
        mob.setHP(data.hp)
        Game.MOBS.push(mob)
        break

      case 1 << 3: {
        // By position in the server's layer list, never by tag arithmetic:
        // a smaller layer number is nearer the surface.
        const from = Session.layerNumber(data.tag) ?? 0
        const to = Session.layerNumber(data.to)
        obj = new Portal(data.radius, to !== undefined && to < from, to)
        break
      }

      case 1 << 6:
        obj = new Exit(data.radius)
        break

      case 1 << 1:{
        // Sized by value (`Consumable.textureFor`). A server from before loot
        // was in the create sends none; the radius stands in.
        const consumable = new Consumable(data.loot ?? data.radius, data.radius)
        Game.CONSUMABLES.push(consumable)
        obj = consumable

        break
      }

      case 1 << 7: {
        // Gear on the ground (decision #49) shares the type and carries `gear`
        // instead of `item`; null is one this build can't read, still drawn.
        if ('gear' in data) {
          obj = new GearPickup(data.gear, data.radius)
          break
        }
        // A usable item on the ground (decision #12). Drawn with Graphics: the
        // atlas has no item art. An id this build doesn't know draws a plain
        // marker rather than nothing.
        obj = new ItemPickup(itemById(data.item), data.radius)
        break
      }

      case 1 << 2:{
        const player = new Player(archetypeById(data.archetype))
        player.setHP(data.hp)
        // Every create of a player carries its finish; none (a server from
        // before finishes) or an unreadable one draws the default.
        player.setFinish(finishFromBytes(data.finish))
        Game.PLAYERS.push(player)
        obj = player

        break
      }
    }

    if (obj === undefined) return

    if (data.maxVelocity !== undefined) (obj as any).maxVelocity = data.maxVelocity

    if (data.facing !== undefined && obj instanceof Unit) obj.facingIndex = data.facing

    if (obj instanceof Unit) this.applyArmor(obj, data)

    if (own) {
      Game.PLAYER = obj as Player
      Game.PLAYER_ID = data.id

      Game.LOCAL.reset(
        data.position?.x ?? obj.x,
        data.position?.y ?? obj.y,
        data.tag,
        data.maxVelocity ?? 0
      )

      // A new run sees nothing yet; its robot decides how far it sees.
      Game.FOG.reset(archetypeById(data.archetype)?.vision ?? null)
      Game.hud.legend.visible = Game.FOG.radius !== null

      Game.RUN.start(archetypeById(data.archetype)?.key)
      Game.RUN.layer(Session.layerNumber(data.tag))
      if (typeof data.kills === 'number') Game.RUN.kills = data.kills

      Game.hud.setupStats()
      // The 4 the server built for this run (`hello.skills`, which precedes
      // this create), on Q W E R; the legacy eight from an older server.
      const slots = slotsFor(Session.skills, SETTINGS.value.skillKeys)
      Game.hud.setupSkills(Game.PLAYER.equip(slots.ids), slots.keys)
      Game.hud.setupInventory()
      if (Array.isArray(data.inventory)) Game.hud.updateInventory(data.inventory)
      // Gear carried into the run (#49): keys 3-4 and the bag. A server from
      // before it sends none, and the cards stay empty.
      Game.hud.setupGear(slots.ids)
      if (Array.isArray(data.carried)) this.applyCarried(data.carried)

      this.updateLayerVisibility(data.tag)
    }

    // A countdown on what expires: dropped loot and items, StoneWall stones.
    // Not on a projectile, whose lifetime ends nothing (the server bursts it at
    // the end of its line). No tint any more: it turned the arena art amber.
    const projectile = (obj as unknown) instanceof Throwable
    // A Broodling's `lifetime` is its fuse left (#51, l1-7): a cord, not a ring.
    const broodling = obj instanceof Mob && obj.archetype?.key === 'broodling'
    if (broodling) emerge(obj)
    if (data.lifetime !== undefined && broodling) attachFuse(obj, data.lifetime)
    else if (data.lifetime !== undefined && !projectile) {
      obj.addChild(new Timer(data.lifetime / 1000))
    }

    // Your own robot reads YOU; its create_own record carries no name anyway.
    if (obj instanceof Player) {
      if (own) obj.setLabel(Player.OWN_LABEL, true)
      else if (typeof data.name === 'string') obj.setLabel(data.name)
    }

    if (data.position !== undefined) {
      obj.x = data.position.x
      obj.y = data.position.y
      // Its first position: it glides from here once the next one arrives.
      if (projectile) (obj as unknown as Throwable).setMoveTarget(new Vector(data.position.x, data.position.y))
      // Obstacles never move and are never fed through `update`, so this is the
      // only place their depth can be set. Without it they sit at zIndex 0 and
      // every unit on the plane draws in front of them - which nobody noticed
      // while obstacles were flat rocks, and is glaring now that some of them
      // are trees.
      obj.zIndex = obj.y
    }

    obj.tag = data.tag

    this.layerOf(obj.tag)?.addChild(obj)

    if (data.radius !== undefined && obj.radius !== data.radius) {
      obj.radius = data.radius
      obj.DEBUG_DRAW_COLLIDER()
    }

    // A portal ends a route on its cell (Game.PORTALS).
    // Only obstacles block a cell. Portals and exits are places you walk into
    // on purpose, so routing through them has to stay legal (`RunMap.created`).
    const cell = Game.MAP.created(data)
    if (cell !== undefined && Game.LOCAL.tag === data.tag && Game.LOCAL.pathCrosses(cell.x, cell.y)) {
      // One planned through a stone that has just come into view re-routes,
      // as `World.block` does on the server. A portal no longer comes into
      // view mid-route: portals are terrain (#35), sent with the join snapshot
      // and on a layer change, and the server makes none after the world is
      // built. A layer change's creates are applied before the update that
      // carries our new tag (and ends the route), so `LOCAL.tag` is still the
      // old layer here and this is skipped. `portalAppeared` stays as a
      // guard for a join whose creates meet a route left from the last run;
      // not shown to be dead, so not removed (extract.spec.ts covers it).
      if (data.type === LocalPlayer.PORTAL_TYPE) Game.LOCAL.portalAppeared()
      else Game.LOCAL.repath()
    }

    this.LOOKUP[data.id] = obj
  }

  /**
   * The layer container for a tag: where anything on that layer is drawn.
   * Undefined before `hello`, or for a tag the server did not list, and then
   * the object is simply not drawn. `indexOf`'s -1 used to index straight into
   * the array, and `addChild` on the undefined that came back threw.
   */
  layerOf (tag: number | undefined): Container | undefined {
    if (this.layers == null || this.tags == null || tag === undefined) return undefined
    return this.layers[this.tags.indexOf(tag)]
  }

  overflow (value: number, limit: number): number {
    if (value >= limit) value -= 2 * limit
    return value
  }

  /**
   * Fades in the player's layer and fades out every other. Only one layer is
   * ever shown: the airborne plane used to show the ground below it at half
   * alpha and 0.7 scale, as if seen from the air, and a layer underground has
   * nothing to see through to.
   */
  updateLayerVisibility (tag: number): void {
    if ((this.layers == null) || (this.tags == null)) return
    this.shownTag = tag

    const shown = this.layerOf(tag)
    for (const layer of this.layers) {
      new TWEEN.Tween(layer).to({ alpha: layer === shown ? 1 : 0 }, 500).start()
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

    // An aimed effect appends `[int16 q][int16 r]` (big-endian): the cell it
    // points at - the aimed cell for a ranged shot, the cone's tip for a breath
    // (decision #21, CLAUDE.md "Wire format"). A 4-byte record is unaimed.
    // Types 5 and 6, a fireball's and an icicle's blast, always carry the
    // impact cell.
    let aimCell: Vector | undefined
    if (buffer.length >= offset + 4) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      aimCell = new Vector(view.getInt16(offset), view.getInt16(offset + 2))
      offset += 4
    }

    const target = this.LOOKUP[targetid]

    // A blast is drawn on its cell, not on its caster, who may be dead or out
    // of view by the time the projectile lands. The caster only says which
    // plane it is on.
    if (type === 5 || type === 6) {
      if (aimCell !== undefined) new BlastEffect(aimCell, target?.tag ?? Game.LOCAL.tag, type === 6)
      return
    }

    // A bomb's fuse (7) and its blast (8), on the bomb's cell. The server sends
    // them only to players on the bomb's own layer (`Multiplayer.effectAt`), so
    // the viewer's layer is the right one. The originator is not looked up: by
    // the blast the thrower may be dead and its id reused.
    if (type === 7 || type === 8) {
      if (aimCell !== undefined) new BombEffect(aimCell, Game.LOCAL.tag, type === 8, lifetime)
      return
    }

    // The Reactor's tell (11) and release (12) on the disc round its planted
    // cell (decision #51, l1-5). Sent by the cell like the bomb's, so the
    // viewer's layer is the right one. The originator is looked up only to end
    // the effect early if this client sees it die (the server stops its burst
    // then); a Reactor out of sight plays it out.
    if (type === NPC_EFFECT.reactorTell || type === NPC_EFFECT.reactorRelease) {
      if (aimCell === undefined) return
      const reactor = target
      new ReactorEffect(aimCell, Game.LOCAL.tag, type === NPC_EFFECT.reactorRelease, lifetime,
        () => reactor instanceof Unit && reactor.hp === 0)
      return
    }

    // The Kiln's lob (#51, l1-4): its landing marker and arc (9) and its blast
    // (10), on the landing cell, sent like the bomb's to the cell's layer
    // (`effectAt`). The Kiln is looked up only for the arc's start, on the
    // marker: by the blast it may be dead and its id reused.
    if (type === NPC_EFFECT.kilnLob || type === NPC_EFFECT.kilnBlast) {
      const blast = type === NPC_EFFECT.kilnBlast
      if (aimCell !== undefined) new KilnLobEffect(aimCell, Game.LOCAL.tag, blast, lifetime, blast ? undefined : target)
      return
    }

    // The Coil's pulse (13, l1-3), on the field's cell: sent with `effectAt`
    // to viewers on its layer, like the bomb. The Coil itself is not looked up.
    if (type === NPC_EFFECT.coilPulse) {
      if (aimCell !== undefined) new CoilPulseEffect(aimCell, Game.LOCAL.tag, lifetime)
      return
    }

    // A Broodling's primed tell (17) and blast (18) (#51, l1-7), on their
    // cell, sent by the cell like the bomb's; the Broodling is not looked up.
    if (type === NPC_EFFECT.broodlingPrimed || type === NPC_EFFECT.broodlingBlast) {
      if (aimCell !== undefined) new BroodlingEffect(aimCell, Game.LOCAL.tag, type === NPC_EFFECT.broodlingBlast, lifetime)
      return
    }

    // A Brood's release (19), drawn on the Brood, aimed at the new Broodling's cell.
    if (type === NPC_EFFECT.broodRelease) {
      if (target !== undefined) new BroodReleaseEffect(target, aimCell, lifetime)
      else Game.EFFECTS_UNHELD++
      return
    }

    if (target === undefined) {
      // An originator this client doesn't hold. The server sends these types
      // only to holders of the originator (#48 follow-ups), so this should
      // stay near 0; a server from before that sends them in its 500 box.
      // Counted, not warned.
      Game.EFFECTS_UNHELD++
      return
    }

    switch (type) {
      case 0:
        new FireBreathEffect(target, lifetime, aimCell)
        break

      case 1:
        new IceBreathEffect(target, lifetime, aimCell)
        break

      case 2:
        new MeleeAttackEffect(target, lifetime)
        break

      case 3:
        new RangedAttackEffect(target, aimCell)
        break

      case 4:
        new DefendEffect(target, lifetime)
        break

      case NPC_EFFECT.compactorShockwave:
        new ShockwaveEffect(target, lifetime, aimCell)
        break

      case NPC_EFFECT.knockback:
        new KnockbackEffect(target, lifetime, aimCell)
        if (target === Game.PLAYER && aimCell !== undefined) this._knockback = aimCell
        break

      // Slowed by a Coil's field (l1-3), on the victim, for the slow's lifetime.
      case NPC_EFFECT.slowed:
        SlowedEffect.show(target, lifetime)
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
    // lastInputSeq: read only by a knockback (l1-6). ackElapsedMs: unread.
    const lastInputSeq = view.getUint16(4)
    void view.getUint16(6)
    // Before the records, so the position in them meets the landing cell.
    if (this._knockback !== undefined) {
      Game.LOCAL.knockback(this._knockback, lastInputSeq)
      this._knockback = undefined
    }

    const now = performance.now()
    Session.onPacket(now)

    for (const entry of this.splitRecords(buffer, UPDATE_HEADER_BYTES)) {
      this.onObjectUpdated(entry, now)
    }
  }

  onObjectUpdated (raw: Uint8Array, now: number = performance.now()) {
    const data = this.deserialiseBinary(raw)

    const obj = this.LOOKUP[data.id]

    if (obj) {
      // TODO generalise unit, move this into setData of relative descendant
      if (data.direction) obj.setDirection(data.direction.x, data.direction.y)

      if (data.position) {
        if (obj === Game.PLAYER) {
          // Authority for the local player is a correction, not a position.
          // The header still carries lastInputSeq and ackElapsedMs; nothing
          // reads them now. They answered "how far into a heading has the server
          // got", and a heading is no longer what gets sent.
          Game.LOCAL.reconcile(data.position.x, data.position.y)
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

      if (data.facing !== undefined && obj instanceof Unit) obj.facingIndex = data.facing

      if (obj instanceof Unit) this.applyArmor(obj, data)

      if (typeof data.extractProgress === 'number' && obj instanceof Player) {
        ExtractRing.show(obj, data.extractProgress, obj.radius)
      }

      if (data.hp !== undefined && obj.setHP) obj.setHP(data.hp)

      if (data.level !== undefined && obj.setLevel) {
        obj.setLevel(data.level)
        if (obj === Game.PLAYER) Game.hud.updateStats(data)
      }

      if (Array.isArray(data.inventory) && obj === Game.PLAYER) Game.hud.updateInventory(data.inventory)

      if (Array.isArray(data.carried) && obj === Game.PLAYER) this.applyCarried(data.carried)

      if (typeof data.kills === 'number' && obj === Game.PLAYER) Game.RUN.kills = data.kills

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
        // A rise on a total already known is a pickup; the first value seen for
        // a robot that just came into view is its haul so far, not a pickup.
        if (obj instanceof Player && delta > 0 && obj.loot !== undefined) obj.onLootGained()
        obj.loot = data.loot

        if (obj === Game.PLAYER) Game.hud.updateStats(data)
      }

      if (data.tag !== undefined && data.tag !== obj.tag) {
        obj.tag = data.tag
        // A layer change ends the route on both sides (LocalPlayer.changeLayer).
        if (obj === Game.PLAYER) Game.LOCAL.changeLayer(data.tag)
        this.layerOf(obj.tag)?.addChild(obj)

        if (obj === Game.PLAYER) {
          this.updateLayerVisibility(data.tag)
          Game.RUN.layer(Session.layerNumber(data.tag))
        }
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
      // Portals never go in play, but a route must not end on one that has.
      if (obj instanceof Portal && obj.tag !== undefined) {
        const cell = Hex.toCell(new Vector(obj.x, obj.y))
        Game.MAP.removePortal(cell.x, cell.y, obj.tag)
      }

      // instanceof rather than a type code: `LOOKUP` is typed as GameObject, so
      // reading `.type` off it adds to the documented pile of unsafe accesses in
      // this file. Destroy records only carry id and hp, so the type is not in
      // `data` either.
      if (obj instanceof Obstacle && obj.tag !== undefined) {
        const cell = Hex.toCell(new Vector(obj.x, obj.y))
        Game.unblock(cell.x, cell.y, obj.tag)
      }

      if (data.hp !== undefined && obj.setHP) { obj.setHP(data.hp) }

      // A unit's destroy without hp means it left this client's view (or, for
      // a player, extracted), not that it died: the server sends units only to
      // clients in range and destroys them on the way out (decision #35). Hide
      // it now. `dispose` would leave a player standing frozen for 1.7 s, and
      // one that comes straight back is created afresh, so the two would
      // show side by side.
      if (data.hp === undefined && obj instanceof Unit && obj !== Game.PLAYER) obj.visible = false

      if (obj === Game.PLAYER) {
        // The run-summary card replaces "Win!" / "Game Over" and the 2 s
        // restart: the next run starts when the player asks for it. A destroy
        // with hp 0 is a death; without hp, an extraction.
        Game.RUN.finish((obj as Unit).loot ?? 0)
        const dead = data.hp === 0
        const card = this.runCard = new RunSummaryCard(dead ? 'dead' : 'extracted', Game.RUN, this.start.bind(this),
          dead ? () => { card.visible = false } : undefined)
        Game.popups.show(card)
        Game.PLAYER = undefined
        Game.PLAYER_ID = undefined
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

      // Picked up (pickup-reach): it flies to whoever took it, then goes.
      const collector = data.collector !== undefined ? this.LOOKUP[data.collector] : undefined
      if (collector instanceof Unit && (obj instanceof Consumable || obj instanceof ItemPickup || obj instanceof GearPickup)) {
        Game.flyToCollector(obj, collector)
      } else {
        obj.dispose()
      }
    }
  }

  /** How long a picked-up crystal or item takes to reach its collector, ms. */
  static readonly PICKUP_FLIGHT_MS = 250

  /**
   * Pulls a taken pickup into the unit that took it, accelerating and
   * shrinking, aimed at the unit's position each frame so a moving collector
   * still catches it; disposed on arrival. Out of every list already, so
   * nothing else touches it meanwhile. Loot makes a robot smile through its
   * loot rising (`onObjectUpdated`); an item raises no loot, so it does here.
   */
  static flyToCollector (pickup: GameObject, collector: Unit): void {
    const fromX = pickup.x
    const fromY = pickup.y
    const fromScale = pickup.scale.x
    new TWEEN.Tween({ t: 0 })
      .to({ t: 1 }, Game.PICKUP_FLIGHT_MS)
      .easing(TWEEN.Easing.Quadratic.In)
      .onUpdate(({ t }) => {
        pickup.x = fromX + (collector.x - fromX) * t
        pickup.y = fromY + (collector.y - fromY) * t
        pickup.scale.set(fromScale * (1 - 0.6 * t))
      })
      .onComplete(() => {
        if ((pickup instanceof ItemPickup || pickup instanceof GearPickup) && collector instanceof Player) collector.onLootGained()
        pickup.dispose()
      })
      .start()
  }

  /**
   * Silence is no longer evidence of absence. Idle units send nothing at all
   * now that the per-tick id heartbeat is gone, so a unit that has stopped
   * reporting is only gone if it is also beyond the radius the server keeps
   * it to, measured from where the camera looks from (`net/presence.ts`).
   */
  stillPresent (unit: GameObject, staleBefore: number, viewpoint: Viewpoint | undefined): boolean {
    return stillPresent(unit, staleBefore, viewpoint)
  }

  /**
   * What the server measures this client's view from: the own robot, else
   * the spectated one (#47), by that robot's vision (#48). Undefined between
   * runs, or while the watched unit's create hasn't arrived. Once per
   * frame, with its reach, which every `stillPresent` that frame reads.
   */
  private viewpoint (watched: Unit | undefined): Viewpoint | undefined {
    const unit = Game.PLAYER ?? watched
    if (unit === undefined) return undefined
    return { x: unit.x, y: unit.y, reach: presenceReach(unit.archetype?.vision, Session.interestRadius) }
  }

  /**
   * Show the route on the player's current plane.
   *
   * Re-parented every frame rather than once, because a portal changes the
   * player's tag mid-run and the marker has to follow them onto the new layer.
   * addChild on the parent it already has is a no-op in pixi.
   */
  updatePathMarker (): void {
    const marker = this.pathMarker
    if (marker === undefined || this.layers == null || this.tags == null) return

    if (Game.PLAYER === undefined) {
      marker.setPath([])
      return
    }

    const layer = this.layerOf(Game.LOCAL.tag)
    if (layer !== undefined && marker.parent !== layer) layer.addChild(marker)

    marker.setPath(Game.LOCAL.remaining)
  }

  /**
   * The threat cells on the player's plane: every mob with a reach the player
   * can see (not hidden by fog, not out of view), at the cell it is drawn on:
   * a shot's range, or an NPC's attack cells (`threatRingsOf`).
   * Re-parented like the route marker.
   */
  updateThreatMarker (): void {
    const marker = this.threatMarker
    if (marker === undefined || this.layers == null) return

    const threats: Threat[] = []
    if (Game.PLAYER !== undefined) {
      const layer = this.layerOf(Game.LOCAL.tag)
      if (layer !== undefined && marker.parent !== layer) layer.addChild(marker)
      for (const mob of Game.MOBS) {
        if (mob.tag !== Game.LOCAL.tag || mob.killed || !mob.visible || !mob.renderable) continue
        // An NPC's reach from its own attack cells (`attack` in the mirror), else its shot.
        const a = mob.archetype
        const rings = a === undefined ? 0 : threatRingsOf(a.key, a.kind, a.rangedCells, a.attack)
        if (rings > 0) threats.push({ cell: Hex.toCell(new Vector(mob.x, mob.y)), rings })
      }
    }
    marker.setThreats(threats)
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

    // Fog follows the predicted position, like the camera; while spectating,
    // the watched player (#47), whose plane is the one shown.
    let fogMoved = false
    const watched = this.spectated()
    if (Game.PLAYER !== undefined) {
      const cell = Hex.toCell(new Vector(Game.LOCAL.x, Game.LOCAL.y))
      fogMoved = Game.FOG.update(cell.x, cell.y, Game.LOCAL.tag)
    } else if (watched !== undefined) {
      // By the watched robot's vision, which is what the server sends it by
      // (#48), not this player's own dead robot's. Here rather than in
      // `onSpectate`, which can arrive before the watched unit's create.
      Game.FOG.setRadius(watched.archetype?.vision ?? null)
      const cell = Hex.toCell(new Vector(watched.x, watched.y))
      fogMoved = Game.FOG.update(cell.x, cell.y, watched.tag)
      if (watched.tag !== undefined && watched.tag !== this.shownTag) this.updateLayerVisibility(watched.tag)
    }
    this.spectateBar?.layout(Game.RENDERER.screen.height)
    this.applyFog()

    this.updatePathMarker()

    const staleBefore = Date.now() - Session.stalenessLimit
    const viewpoint = this.viewpoint(watched)

    for (const player of Game.PLAYERS) {
      if (player === Game.PLAYER) {
        player.visible = true
        player.applyPosition(Game.LOCAL.renderX, Game.LOCAL.renderY, now, Game.LOCAL.moveX, Game.LOCAL.moveY)
        // A dash runs the way it goes: with the mouse behind a standing dash the
        // robot faced the mouse and ran backwards (Nick, 2026-10-01).
        player.aimAt(Game.LOCAL.dashLeft > 0 ? undefined : Aim.world())
        continue
      }
      if (this.stillPresent(player, staleBefore, viewpoint)) {
        player.visible = true
        player.update(dt)
      } else {
        player.visible = false
      }
    }

    for (const mob of Game.MOBS) {
      if (this.stillPresent(mob, staleBefore, viewpoint)) {
        mob.visible = true
        mob.update(dt)
      } else {
        mob.visible = false
      }
    }

    // After the mobs have moved to where they are drawn this frame.
    this.updateThreatMarker()

    const layers = this.layers

    const focus = Game.PLAYER ?? watched
    if (focus != null && layers != null) {
      // Snapped to device pixels, so the ground (laid out on whole device
      // pixels, see HexTerrain) stays on them as the camera moves.
      const res = Game.RENDERER.resolution
      Game.CONTAINER.x = -Math.round(focus.x * res) / res
      Game.CONTAINER.y = -Math.round(focus.y * TILT * res) / res

      const screen = Game.RENDERER.screen

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i]

        // A plane you are not on fades to alpha 0 and stays in the scene, which
        // used to cost nothing because it was one TilingSprite. It is now about
        // a thousand pad sprites, and PIXI walks every one of them to update
        // its transform whether or not anything comes of it. On a GPU that is
        // invisible either way; on the software rasteriser a headless browser
        // falls back to, skipping it was worth 6 fps. `visible`, not
        // `renderable`: only the former skips the transform pass as well as the
        // draw.
        layer.visible = layer.alpha > 0.01
        if (!layer.visible) continue

        // Every layer is drawn at scale 1 now. The parallax offset and the
        // screen-over-scale slice here existed for the half-size ground seen
        // from the airborne plane, which is gone.
        this.terrains[i]?.update(focus.x, focus.y, screen.width, screen.height)
        if (fogMoved) this.terrains[i]?.retint()
        // Every frame, not only when the fog moves: the fog's radius arrives
        // with the own create, after the hello that placed the walls, and a
        // wall shown before it stayed shown through fog. ~300 lookups.
        const tag = this.tags?.[i]
        this.walls[i]?.retint((q, r) => Game.FOG.state(q, r, tag))
      }
    }
  }

  /**
   * Draw only what the fog lets the player see (fog-of-war, M2): units,
   * pickups and projectiles on visible cells; terrain on visible and explored
   * cells; portals, exits and the player's own robot always (#16: gates are
   * marked through fog). `renderable`, not `visible`: other code already sets
   * `visible` (a unit that left the interest box, a stale one), and the two
   * must not undo each other. Cosmetic only (decision #36).
   */
  /** The unit being spectated, once this client holds it. */
  spectated (): Unit | undefined {
    if (Game.SPECTATE_ID === undefined) return undefined
    const obj = this.LOOKUP[Game.SPECTATE_ID]
    return obj instanceof Unit ? obj : undefined
  }

  /**
   * `spectate` (decision #47): whom this dead player now watches, `id: null`
   * when nobody is left. The server sends the world around them from then on;
   * the camera, the fog and the shown plane follow them (`update`).
   */
  onSpectate (data: { id: number | null, name?: string }): void {
    if (data?.id === null || typeof data?.id !== 'number') {
      this.endSpectate()
      if (this.runCard !== undefined) this.runCard.visible = true
      return
    }
    Game.SPECTATE_ID = data.id
    this.runCard?.setWatchable(true)
    if (this.spectateBar === undefined) {
      this.spectateBar = new SpectateBar(
        () => { if (this.runCard !== undefined) this.runCard.visible = true },
        () => { if (this.runCard !== undefined) this.runCard.again(); else this.start() })
      Game.popups.addChild(this.spectateBar)
    }
    this.spectateBar.setTarget(typeof data.name === 'string' ? data.name : '')
  }

  private endSpectate (): void {
    Game.SPECTATE_ID = undefined
    this.runCard?.setWatchable(false)
    this.spectateBar?.parent?.removeChild(this.spectateBar)
    this.spectateBar?.destroy({ children: true })
    this.spectateBar = undefined
  }

  applyFog (): void {
    const fog = Game.FOG
    for (const id in this.LOOKUP) {
      const obj = this.LOOKUP[id]
      // Ids are LOOKUP's keys: client objects don't carry theirs.
      if (obj === Game.PLAYER || Number(id) === Game.SPECTATE_ID || obj instanceof Portal || obj instanceof Exit || fog.radius === null) {
        obj.renderable = true
        continue
      }
      const cell = Hex.toCell(new Vector(obj.x, obj.y))
      const seen = fog.state(cell.x, cell.y, obj.tag)
      obj.renderable = obj instanceof Obstacle ? seen !== SEEN.UNKNOWN : seen === SEEN.VISIBLE
    }
  }
}
