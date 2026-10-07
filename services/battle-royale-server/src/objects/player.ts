import { Unit } from './unit'
import { GameObject, ObjectType } from './gameobject'
import { type Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { type Skill } from '../skills/skill'
import { type Archetype, ARCHETYPES, buildKit, buildSkillById } from '../archetypes/archetypes'
import { LOADOUT_SIZE, START_KIT, skillById } from '../utils/skills'
import { type GearEffect, type GearInstance, GEAR_BAG, GEAR_FIRST_SLOT, GEAR_SLOTS, NO_GEAR_EFFECT, effectiveReach, encodeGear, gearEffect, itemCooldownMs } from '../utils/gear'
import World from './world'
import Multiplayer, { type Connection } from '../network/multiplayer'
import Timers from './timers'
import { INVENTORY_SLOTS } from '../utils/items'
import { type Finish, finishFromBytes, finishToBytes } from '../utils/finishes'
import { type Item } from '../archetypes/archetypes'
import { itemForSlot, useItem } from '../items/use'
import type Consumable from './consumable'
import type ItemPickup from './itempickup'
import type GearPickup from './gearpickup'
import Analytics from '../analytics'
import type BotBrain from '../bots/brain'
import { countKill } from '../progress/run'
import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity'

export class Stats {
  kills?: number
  mobKills?: number
  /** Frozen since L1 (decision #51): see `KillStat`. Kept readable, never renamed. */
  bossKills?: number
  /** Killing blows by mob rarity (decision #51, L1; `KillStat`). */
  commonKills?: number
  rareKills?: number
  epicKills?: number
  legendaryKills?: number
  games?: number
  lootCollected?: number
  lifeTime?: number
}
export default class Player extends Unit {
  // Always set, by Unit's constructor; narrowed from Unit's optional one.
  declare archetype: Archetype

  /** The run's 4 slots, Q W E R; null is an empty slot. Always `LOADOUT_SIZE` long. */
  skills: Array<Skill | null>
  /** The mirrored skill id in each slot (0 = empty), as `hello.skills` sends it. Frozen. */
  skillIds: readonly number[]
  createdAt: number
  exited: boolean
  playerId: string
  /** When the run first picked up loot (analytics `first_loot`, #46). */
  firstLootAt: number | undefined
  /** The deepest layer's tag this run (the lowest), for analytics `run_end`. */
  deepestTag: number
  /**
   * Set by `exit` before it destroys: `exited` is only set after
   * `Multiplayer.destroy`, which is where `run_end` is sent, and moving it
   * would change what `Multiplayer.gone` lets through. Analytics only.
   */
  extracted = false
  /**
   * The run has been ended: set by `Multiplayer.destroy` the first time it
   * sees this player, before its stats write, `run_end` and XP grant, which
   * it skips on any later destroy. A run ends once however its end is
   * reported (an extraction, then a disconnect before the flush; an `exit`
   * that threw before setting `exited`). Never set from a constructor.
   */
  runOver = false
  /**
   * A bot's brain (decision #47), undefined for a human. A bot has no
   * connection, writes no stats and sends no analytics; it counts nowhere a
   * world counts its humans (`Worlds.activePlayers`).
   */
  bot: BotBrain | undefined
  /** Connections spectating this player (decision #47), made on first use. */
  spectators: Set<Connection> | undefined

  /**
   * The robot's colours and patterns (robot-finishes, #41), fixed for the run.
   * Cosmetic: nothing on the server reads it but the wire, where it goes out
   * as bytes (`serialise`) in every create of this player.
   */
  finish: Finish

  /**
   * How many of each item the player carries, by fixed slot (utils/items.ts).
   * Private behind `inventory` so every change goes through `addItem` /
   * `tryUseItem`, which mark the field dirty. The `inventory` accessor lives on
   * this class and no subclass may declare a field of that name (the `armor`
   * trap, CLAUDE.md "Wire format").
   */
  private readonly _inventory: number[] = new Array<number>(INVENTORY_SLOTS).fill(0)

  /**
   * A medkit in progress: hp still to give, the rate, and the fraction of a
   * point earned but not yet given (like `armorCarry`), so hp stays whole while
   * the rate stays exact under a jittering `dt`. Applied in `update`, which
   * stops running the moment the player dies or exits, so death ends it.
   */
  private _healLeft = 0
  private _healPerSec = 0
  private _healCarry = 0

  /**
   * Equipped gear (decision #49): one item per slot (keys 3 and 4), null when
   * empty; the skill each slot fires, which for a duplicate is the kit's (or
   * the other slot's) own instance; the summed, capped bonuses, computed once
   * per `equipGear` and read by the stat paths, never per tick; and the speed
   * the bonus has added to `maxVelocity`, so a change is applied as a delta.
   * Written only after construction (`equipGear`), never from a
   * base-constructor hook, so plain initialisers are safe.
   */
  private readonly _gear: Array<GearInstance | null> = new Array<GearInstance | null>(GEAR_SLOTS).fill(null)
  private readonly _gearSkills: Array<Skill | null> = new Array<Skill | null>(GEAR_SLOTS).fill(null)
  private _gearEffect: GearEffect = NO_GEAR_EFFECT
  private _gearSpeed = 0
  /**
   * Gear carried but not equipped (49-2): found with no free slot, a part, or
   * anything a bot picks up. At most `GEAR_BAG`. Not usable; dropped on death,
   * kept on extraction (49-4). Behind `carried`, like `_inventory`: every
   * change goes through `addGear` / `takeGear`.
   */
  private readonly _bag: GearInstance[] = []

  /**
   * Every player is a peep until `robot-type-on-join` lets them choose.
   *
   * `name` is what the player typed, unsanitised: it is cleaned here, before
   * `Multiplayer.create` serialises it into everyone's create record, and an
   * empty or unusable one becomes the id's callsign. `playerId` stays the
   * identity - stats are keyed by it, never by the name.
   *
   * `finish` is the client's, unchecked; anything unreadable in it becomes
   * the default finish (`finishFromBytes`) rather than refusing the join.
   *
   * `kit` is the run's 4 skill ids, already resolved (`kitFor` for a human,
   * a bot's own). **It defaults to the start kit, not all eight, on
   * purpose**: a path that forgets the kit fails closed, never open.
   */
  constructor (x: number, y: number, tag: number, playerId: string, archetype: Archetype = ARCHETYPES.peep, name?: unknown, finish?: unknown, kit: readonly number[] = START_KIT) {
    super(ObjectType.Player, x, y, 0, tag, archetype)
    this.playerId = playerId
    this.name = Player.displayName(name, playerId)
    this.finish = finishFromBytes(finish)

    this.setLevel(archetype.level ?? 1)

    // The run's 4 slots (decision #48 step 4): the client sends the slot it
    // pressed, `tryExecuteSkill` indexes this array, and `hello.skills` tells
    // the client which skill is in each (`skillIds`).
    this.skillIds = Object.freeze([...kit])
    this.skills = buildKit(this, this.skillIds)

    this.createdAt = Date.now()
    this.deepestTag = tag

    // The owner's own record only. Its create for everyone else stays as it was.
    this.allFieldsOwn.add('inventory')
    // Kills this run, for the end-of-run card (run-summary-card). Starts at 0,
    // so the owner's create always carries it.
    this.allFieldsOwn.add('kills')
    // Everyone's create, the owner's included, so your own robot is drawn from
    // what the server holds. Never dirty: it doesn't change within a run.
    this.allFields.add('finish')
    this.allFieldsOwn.add('finish')
    // Carried gear (49-2), the owner's create only, and a delta on change.
    // Then the speed, moved to the end: it goes out as field 27 since 49-2.
    // Fields go out in the order the sets were filled, and a client from
    // before 49-2 stops at the first index it doesn't know, so with these two
    // last it still reads everything else of its own create (PROTOCOL 6 then
    // sends it to reload).
    this.allFieldsOwn.add('carried')
    this.allFieldsOwn.delete('maxVelocity')
    this.allFieldsOwn.add('maxVelocity')

    Multiplayer.Instance.create(this)
  }

  /** `finish` goes on the wire as its bytes (see 'finish' in `GameObject.fieldOrder`). */
  serialise (fields: Set<string>): ReturnType<Unit['serialise']> {
    const result = super.serialise(fields)
    if (result !== null && 'finish' in result) (result as Record<string, unknown>).finish = finishToBytes(this.finish)
    return result
  }

  /**
   * How long this player has been on an exit, in ms, or undefined while they
   * are not extracting. Counted from the first tick that found them on the
   * pad, which counts as 0 (see `channelExtract`).
   */
  extractElapsed: number | undefined

  /**
   * The connection this player was attached to (`Multiplayer.attach`), for
   * `Multiplayer.connectionOf`, which checks it still points back. Network
   * bookkeeping only; nothing in the simulation reads it.
   */
  connection: Connection | undefined = undefined

  /**
   * The cell, layer and `World.GATES` version at which this player's cell was
   * last found to hold no gate. `gateFree` answers from it until one of the
   * three changes, which spares the exit and portal lookups on the ticks a
   * player stands or walks inside one cell (server-cpu-trim). Written only by
   * `gateFree`, never from a base-constructor hook, so plain initialisers are
   * safe here.
   */
  private _gateFreeKey = NaN
  private _gateFreeTag = NaN
  private _gateFreeVersion = -1

  /**
   * True if the player's cell on its layer holds no portal and no exit. Gates
   * are placed when the world is built and never move, but specs add them
   * later, so the answer is keyed to the gate index's version too.
   */
  gateFree (): boolean {
    const here = this.cell
    const key = Hex.key(here.x, here.y)
    const version = World.GATES.version
    if (key === this._gateFreeKey && this.tag === this._gateFreeTag && version === this._gateFreeVersion) return true
    if (World.GATES_ON(here.x, here.y, this.tag).length > 0) return false
    this._gateFreeKey = key
    this._gateFreeTag = this.tag
    this._gateFreeVersion = version
    return true
  }

  update (dt: number): void {
    if (this.tag < this.deepestTag) this.deepestTag = this.tag
    // Before moving, so the channel is judged on the position every client was
    // last sent, and its progress goes out in this tick's update rather than
    // the next one's. An extraction ends the update: the player is gone.
    if (this.channelExtract(dt)) return

    super.update(dt)

    // Something in this tick's own update (a breath's area) can kill it. A
    // corpse picks nothing up and heals nothing: what it carries is dropped by
    // the next sweep (World.update).
    if (this.destroyed) return

    // Before the pickup, so a hop picks up on the cell it lands on.
    this.hopPortal()
    this.applyHeal(dt)
    this.pickUp()
    // No push-out out of mobs (hex-cells P2): players may share a cell with a
    // mob (#31 Q2), and a mob's chase stops a ring short of its target.
  }

  /** A portal to another layer: routes end on it (`Unit.endAtPortal`). */
  stopsOn (q: number, r: number): boolean {
    return World.portalOn(q, r, this.tag) !== undefined
  }

  /**
   * If this tick left the player on a portal's cell, move them to the portal's
   * arrival cell (`World.arrivalOf`: its east neighbour, decision #33) on the
   * layer it leads to, on that cell's centre, and end their route
   * (`changeLayer`). True if they hopped.
   *
   * It replaces the push-out hop, which left a player 64 units from the
   * portal's centre on the other layer (#31 Q3). The arrival cell is kept
   * clear of rocks (`gateKeepOut`), stones (`StoneWall.canPlace`) and mobs
   * (`World.mobCanEnter`); other players may be standing on it.
   *
   * The client does not predict the hop: it walks to the portal's centre,
   * waits there for the new tag, and jumps to where the server put it
   * (`LocalPlayer.changeLayer`).
   */
  hopPortal (): boolean {
    if (this.gateFree()) return false
    const here = this.cell
    const portal = World.portalOn(here.x, here.y, this.tag)
    if (portal === undefined) return false
    this.position = Hex.toPosition(World.arrivalOf(here))
    this.changeLayer(portal.to)
    return true
  }

  /**
   * Take at most one loot pickup and one item a tick, from the cells within
   * `pickupReach` rings of the player's cell: 0 (and null) is the player's own
   * cell (decision #32). It was a radius, the pickup's plus the body. Natural
   * pickups and item drops sit on cell centres, and a route runs centre to
   * centre, so a walk collects exactly what it did; it now does so on
   * entering the cell rather than 10-15 units earlier.
   *
   * Through `World.PICKUPS`, never a scan of the lists. Removing one does an
   * `indexOf` on its list, once per pickup taken.
   */
  private pickUp (): void {
    const reach = this.pickupReach
    let loot: Consumable | undefined
    let item: ItemPickup | undefined
    let gear: GearPickup | undefined
    World.forKeysWithin(this.cell, reach, (key) => {
      for (const obj of World.PICKUPS.at(this.tag, key)) {
        if (obj.destroyed) continue
        if (obj.type === ObjectType.Consumable) {
          if (loot === undefined) loot = obj as Consumable
        } else if (World.isGear(obj)) {
          // Gear shares ObjectType.Item with items (49-2). One a tick; with no
          // room for it the pickup stays where it is.
          if (gear === undefined && this.gearRoom(obj.instance)) gear = obj
        } else if (item === undefined && this.countOf((obj as ItemPickup).kind) < (obj as ItemPickup).kind.maxStack) {
          // One a tick, like loot. A full stack leaves the pickup where it is.
          item = obj as ItemPickup
        }
      }
    })

    if (loot !== undefined) {
      // Banks it, and nothing else. It used to heal by the same amount too;
      // healing is the medkit's job now (decision #5).
      this.addLoot(loot.loot)
      loot.destroyCollected(this)
      World.PICKUPS.remove(World.CONSUMABLES, loot)
    }
    if (item !== undefined && this.addItem(item.kind)) {
      item.destroyCollected(this)
      World.PICKUPS.remove(World.ITEMS, item)
    }
    if (gear !== undefined && this.addGear(gear.instance)) World.gearTaken(gear, this)
  }

  /**
   * One tick of extracting (#16). Returns true if the player extracted.
   *
   * A player is on an exit when the cell under their centre is the exit's
   * cell, the way every area in the game is a set of cells (decision #18).
   * The pad's 50-unit radius draws a little wider than the cell; the cell is
   * what counts. Nothing is solid since hex-cells P2, so a player who clicks
   * an exit comes to rest on its centre.
   *
   * The first tick on the pad counts as 0 and each later one adds its `dt`,
   * so at 250 ms ticks a 5 s layer extracts on the 20th tick after the one
   * that first found the player there. Stepping off the pad, or a hit that
   * does damage (`hit`), starts it over from nothing on the next tick on it.
   * A per-tick check rather than a `Timers` entry: it is cancelled on any
   * tick the player is off the pad, and it has to report progress every tick
   * anyway.
   *
   * A layer missing from `LAYERS` has no extraction time and nobody extracts
   * there: fails closed. No such layer exists; every tag comes from `LAYERS`.
   */
  channelExtract (dt: number): boolean {
    if (this.gateFree()) {
      this.cancelExtract()
      return false
    }
    const extractMs = World.LAYERS.find((layer) => layer.tag === this.tag)?.extractMs
    if (extractMs === undefined || !this.onExit()) {
      this.cancelExtract()
      return false
    }

    this.extractElapsed = this.extractElapsed === undefined ? 0 : this.extractElapsed + dt * 1000
    if (this.extractElapsed >= extractMs) {
      this.exit()
      return true
    }

    // 1-254: 0 means not extracting, and 255 would be done, which is never
    // sent because the player is gone by then.
    const progress = Math.max(1, Math.min(254, Math.floor(255 * this.extractElapsed / extractMs)))
    if (progress !== this.extractProgress) this.extractProgress = progress
    return false
  }

  /**
   * Stop extracting, and tell everyone in range, if extracting.
   *
   * A player still on the pad starts again on the next tick, and if that tick
   * comes before this 0 is sent (a hit between ticks, or from a mob acting
   * after this player in the tick), clients see the progress fall straight
   * back to 1 instead. Either way the ring starts over. Measured with a bot:
   * a melee hit took a channel from 89 to 1, and it extracted 5.02 s later.
   */
  cancelExtract (): void {
    if (this.extractElapsed === undefined) return
    this.extractElapsed = undefined
    this.extractProgress = 0
  }

  /** True if the cell under this player is an exit's cell on their layer (`World.GATES`). */
  onExit (): boolean {
    const here = this.cell
    return World.isExit(here.x, here.y, this.tag)
  }

  /**
   * A hit that does damage, to the armor pool or to hp, cancels an extraction
   * (#16 Q6). "Does damage" is the rule the armor refill already uses: after
   * Defend, before armor, so armor soaking the whole hit still cancels it and
   * a hit Defend floors to 0 does not.
   *
   * An extracted player can't be hit. They stay in `PLAYERS` until the next
   * tick, and a mob acting later in the tick they extracted on could otherwise
   * kill them after their destroy had gone out; `World.update` tests
   * `destroyed` before `exited`, so it would then drop the loot they banked.
   */
  hit (value: number): boolean {
    if (this.exited) return false
    const before = this.hp + this.armor
    const killed = super.hit(value)
    if (!killed && this.hp + this.armor < before) this.cancelExtract()
    return killed
  }

  addLoot (value: number): void {
    this.loot += value
    if (this.firstLootAt === undefined && value > 0 && this.bot === undefined) {
      this.firstLootAt = Date.now()
      Analytics.send({ playerId: this.playerId, startedAt: this.createdAt, offline: Multiplayer.isOffline(this) }, 'first_loot', {
        seconds: Math.round((this.firstLootAt - this.createdAt) / 100) / 10
      }, this.firstLootAt)
    }
  }

  // Items ========

  /** The `inventory` wire field: the count in each slot. Read-only; see `_inventory`. */
  get inventory (): readonly number[] {
    return this._inventory
  }

  /** How many of `item` the player carries. */
  countOf (item: Item): number {
    return this._inventory[item.slot] ?? 0
  }

  /** One more of `item`, unless the stack is full. True if it was taken. */
  addItem (item: Item): boolean {
    if (this.countOf(item) >= item.maxStack) return false
    this._inventory[item.slot]++
    this.dirtyFields.add('inventory')
    return true
  }

  /**
   * Empty every slot and return what was in it, for the death drop. The field
   * is not marked: the player is gone, and its destroy record carries id and
   * hp only.
   */
  takeInventory (): Array<{ item: Item, count: number }> {
    const out: Array<{ item: Item, count: number }> = []
    for (let slot = 0; slot < this._inventory.length; slot++) {
      const item = itemForSlot(slot)
      const count = this._inventory[slot]
      this._inventory[slot] = 0
      if (item !== undefined && count > 0) out.push({ item, count })
    }
    return out
  }

  /**
   * Use the item in a 0-based `slot`, aimed at the absolute cell `aimCell` or
   * not aimed at all (decision #21). Refused, and nothing is spent, unless the
   * slot is a whole number in range, it holds one, and the item itself accepts
   * (`useItem`: the aim's range, a heal already running, full hp).
   * True if one was used.
   */
  tryUseItem (slot: number, aimCell?: Vector): boolean {
    if (this.destroyed || this.exited) return false
    if (!Number.isInteger(slot) || slot < 0 || slot >= INVENTORY_SLOTS) return false
    // Keys 3-4 (slots 2-3) are the gear slots (decision #49): they cast the
    // slot's skill, nothing is spent, and an empty slot is refused.
    if (slot >= GEAR_FIRST_SLOT && slot < GEAR_FIRST_SLOT + GEAR_SLOTS) return this.castGear(slot - GEAR_FIRST_SLOT, aimCell)
    const item = itemForSlot(slot)
    if (item === undefined || this._inventory[slot] <= 0) return false

    if (!useItem(this, item, aimCell)) return false

    this._inventory[slot]--
    this.dirtyFields.add('inventory')
    return true
  }

  /** True while a medkit is still healing. */
  get healing (): boolean {
    return this._healLeft > 0
  }

  /**
   * Start healing `amount` hp over `durationMs`. Refused (false) while one is
   * already running, or at full hp, so a medkit is never spent for nothing.
   */
  startHeal (amount: number, durationMs: number): boolean {
    if (this.healing || this.hp >= this.maxHP()) return false
    this._healLeft = amount
    this._healPerSec = amount / (durationMs / 1000)
    this._healCarry = 0
    return true
  }

  /**
   * One tick of a heal in progress: the rate times `dt`, in whole points, never
   * more than is left. hp above the maximum is lost, but still counts against
   * what is left, so a heal always ends on time.
   */
  private applyHeal (dt: number): void {
    if (this._healLeft <= 0) return
    this._healCarry += this._healPerSec * dt
    const whole = Math.min(this._healLeft, Math.floor(this._healCarry))
    if (whole <= 0) return
    this._healCarry -= whole
    this._healLeft -= whole
    const hp = Math.min(this.maxHP(), this.hp + whole)
    if (hp !== this.hp) this.hp = hp
  }

  // Gear ========

  /** The equipped gear, by slot (null = empty). Read-only; see `equipGear`. */
  get gear (): ReadonlyArray<GearInstance | null> {
    return this._gear
  }

  /** The summed, capped bonuses of the equipped gear (`gearEffect`), as of the last `equipGear`. */
  get gearEffect (): GearEffect {
    return this._gearEffect
  }

  /** The skill gear slot `slot` fires, or null. A duplicate's is the kit's own instance. */
  gearSkill (slot: number): Skill | null {
    return this._gearSkills[slot] ?? null
  }

  /** The gear carried but not equipped, oldest first. Read-only; see `_bag`. */
  get bag (): readonly GearInstance[] {
    return this._bag
  }

  /**
   * Whether `addGear` would take `item`: a skill item while a gear slot is
   * empty (never for a bot), else while the bag has room.
   */
  gearRoom (item: GearInstance): boolean {
    if (this._bag.length < GEAR_BAG) return true
    return this.bot === undefined && item.skill !== 0 && this._gear.includes(null)
  }

  /**
   * Carry a found item (49-2): a skill item goes into the first empty gear
   * slot (`equipGear`, which applies its stats), else into the bag; a part
   * always goes into the bag. **A bot puts everything in the bag** (spec: bots
   * carry, never equip, so a bot's stats never change). False, and nothing
   * changes, with no room. The instance is kept as it is, `rowId` included.
   * Nothing moves between the bag and the slots mid-run (Nick, #49 Q3).
   */
  addGear (item: GearInstance): boolean {
    if (this.bot === undefined && item.skill !== 0) {
      const empty = this._gear.indexOf(null)
      if (empty >= 0 && this.equipGear(empty, item)) {
        this.dirtyFields.add('carried')
        return true
      }
    }
    if (this._bag.length >= GEAR_BAG) return false
    this._bag.push(item)
    this.dirtyFields.add('carried')
    return true
  }

  /**
   * Empty both gear slots and the bag and return what was in them, slots
   * first, for the death drop (`World.createItemsFrom`). For a dead player
   * only: the stats the gear gave are left as they are, and the field is not
   * marked (the destroy record carries id and hp only), as `takeInventory`.
   */
  takeGear (): GearInstance[] {
    const out: GearInstance[] = []
    for (let i = 0; i < GEAR_SLOTS; i++) {
      const item = this._gear[i]
      if (item !== null) out.push(item)
      this._gear[i] = null
      this._gearSkills[i] = null
    }
    out.push(...this._bag)
    this._bag.length = 0
    return out
  }

  /**
   * Cast gear slot `slot`'s skill at `aimCell` (or along facing), through the
   * same `Skill.execute` a kit press uses; a duplicate fires the kit's own
   * instance and shares its cooldown (49-1). False for an empty slot.
   */
  private castGear (slot: number, aimCell?: Vector): boolean {
    const skill = this._gearSkills[slot]
    if (skill === null || skill === undefined) return false
    skill.execute(aimCell)
    return true
  }

  /**
   * The `carried` wire field (49-2): `[uint8 entries = 6]` then per entry
   * `[uint8 len][instance]` (`encodeGear`; len 0 = empty), entries 0-1 the
   * gear slots, 2-5 the bag. `GameObject.serialiseBinary` puts a uint16
   * length in front. Built when serialised: it is sent in the owner's create
   * and when it changes, never per tick.
   */
  get carried (): Uint8Array {
    const entries: Array<Uint8Array | null> = [...this._gear.map((g) => g === null ? null : encodeGear(g))]
    for (let i = 0; i < GEAR_BAG; i++) entries.push(this._bag[i] !== undefined ? encodeGear(this._bag[i]) : null)
    let size = 1
    for (const e of entries) size += 1 + (e?.length ?? 0)
    const out = new Uint8Array(size)
    out[0] = entries.length
    let at = 1
    for (const e of entries) {
      out[at++] = e?.length ?? 0
      if (e !== null) {
        out.set(e, at)
        at += e.length
      }
    }
    return out
  }

  /** The archetype's `damageScale` plus the gear's, through `Skill.dealt` (#49). */
  get damageScale (): number {
    return super.damageScale + this._gearEffect.damageScale
  }

  /**
   * Rings within which loot and items are taken: the robot's, raised by gear
   * to at most 2, and a robot already at 2 or more (Magnet) untouched
   * (`effectiveReach`).
   */
  get pickupReach (): number {
    return effectiveReach(this.archetype.pickupReach ?? 0, this._gearEffect.reach)
  }

  /**
   * Put a skill item in gear slot `slot` (0 or 1, keys 3 and 4) and apply
   * its stats. Refused (false, nothing changes) for a slot out of range or
   * already holding an item, a part, or a skill this build doesn't know:
   * gear only arrives mid-run and leaves only by death (49-2 empties the
   * slots for the drop).
   *
   * The slot's skill: a **duplicate** (the skill is already in the kit, or in
   * the other gear slot) fires that existing instance and shares its
   * cooldown (spec Q7); whether its cooldown roll applies there is
   * `itemCooldownMs`'s rule (no, Nick 2026-10-05). Otherwise a new instance,
   * its cooldown cut by the item's own roll.
   */
  equipGear (slot: number, item: GearInstance): boolean {
    if (!Number.isInteger(slot) || slot < 0 || slot >= GEAR_SLOTS) return false
    if (this._gear[slot] !== null) return false
    if (item.skill === 0 || skillById(item.skill) === undefined) return false

    const shared = this.instanceOf(item.skill)
    let skill: Skill
    if (shared !== null) {
      skill = shared
      skill.cooldown = itemCooldownMs(skill.cooldown, item, true)
    } else {
      skill = buildSkillById(this, item.skill)
      skill.cooldown = itemCooldownMs(skill.cooldown, item, false)
    }
    this._gear[slot] = item
    this._gearSkills[slot] = skill
    this.applyGear()
    return true
  }

  /** The instance already firing skill `id`: a kit slot's, else a gear slot's; null if none. */
  private instanceOf (id: number): Skill | null {
    const kit = this.slotOf(id)
    if (kit >= 0) return this.skills[kit]
    for (let i = 0; i < GEAR_SLOTS; i++) {
      if (this._gear[i]?.skill === id) return this._gearSkills[i]
    }
    return null
  }

  /**
   * Recompute the gear's bonuses once and apply them through the existing
   * stats. Max HP and max armor are `round(base * (1 + pct / 100))` from the
   * archetype; a rise lifts hp and armor by the same amount. Speed is added
   * to `maxVelocity` as the change in the bonus (rounded to tenths, which
   * 49-2's `speed` field carries exactly), never assigned, so a `Slowdown`
   * running now still restores to base + gear.
   */
  private applyGear (): void {
    const effect = gearEffect(this._gear)
    const base = this.archetype

    const maxHp = Math.round(base.maxHp * (1 + effect.hpPct / 100))
    const hpRise = maxHp - this.maxHp
    if (hpRise !== 0) {
      this.maxHp = maxHp
      this.hp = hpRise > 0 ? this.hp + hpRise : Math.min(this.hp, maxHp)
    }

    if (base.armor.max > 0) {
      const maxArmor = Math.round(base.armor.max * (1 + effect.armorPct / 100))
      const armorRise = maxArmor - this.maxArmor
      if (armorRise !== 0) {
        this.maxArmor = maxArmor
        this.armor = armorRise > 0 ? this.armor + armorRise : Math.min(this.armor, maxArmor)
      }
    }

    const speed = Math.round(base.speed * effect.speedPct / 10) / 10
    if (speed !== this._gearSpeed) {
      this.maxVelocity += speed - this._gearSpeed
      this._gearSpeed = speed
    }

    this._gearEffect = effect
  }

  setLevel (value: number): void {
    this.level = value
    this.hp = this.maxHP()
    this.loot = 0
  }

  /**
   * `aimCell` is the absolute cell the player aimed at, or undefined for no aim
   * (decision #21). Each skill decides what an aim means to it.
   *
   * The index comes off the wire, so anything that is not a whole number in
   * range is ignored: `skills[-1]` or `skills[1.5]` is undefined and calling
   * `execute` on it threw inside a socket handler.
   *
   * The index is a slot of this player's kit (decision #48 step 4): 0-3, the
   * client's Q W E R, in `hello.skills` order. An empty slot, and 4-7 from a
   * client from before loadouts, run nothing.
   */
  tryExecuteSkill (index: number, aimCell?: Vector): void {
    if (this.skills === undefined) return
    if (!Number.isInteger(index) || index < 0 || index >= LOADOUT_SIZE) return
    const skill = this.skills[index]
    if (skill === null || skill === undefined) return

    skill.execute(aimCell)
  }

  /** The slot holding skill `id` (a mirrored id, `utils/skills.ts`), or -1. */
  slotOf (id: number): number {
    if (id === 0) return -1
    return this.skillIds.indexOf(id)
  }

  onCollideWithPlayer (target: GameObject): void {

  }

  onKill (value: GameObject): void {
    super.onKill(value)

    // The run's count, on the wire as `kills` (21). Every credited kill, mob
    // or player, as the redis `kills` stat counts them.
    this.kills++
    // Split by victim for the run's XP (decision #48 step 3, progress/run.ts).
    countKill(this, value)

    // Never `void`: see Multiplayer.STATS_LOG. A rejected stats write is an
    // unhandled rejection, and that ends the process. An offline account
    // (decision #48) writes no stats, like a bot.
    if (this.bot === undefined && !Multiplayer.isOffline(this)) this.updateKillStats(value).catch(Multiplayer.logStatsFailure)
  }

  async updateKillStats (value: GameObject): Promise<void> {
    const stats = new Stats()

    stats.kills = 1

    // By archetype, into today's redis keys (see Archetype.killStats).
    if (value instanceof Unit && value.archetype !== undefined) {
      for (const key of value.archetype.killStats) stats[key] = 1
    }

    // Taken before the first await: after it, whichever world is current (or
    // none) is not this player's (worlds-per-process).
    const redis = Multiplayer.Instance.redis
    for (const key in stats) {
      if (stats[key] > 0) {
        await redis.hincrby(`stats-${this.playerId}`, key, stats[key])
      }
    }
  }

  destroy (): void {
    super.destroy()
  }

  exit (): void {
    this.dirtyFields = new Set(['id'])  // not new Set('id'), which yields {'i','d'}
    this.extracted = true
    Multiplayer.Instance.destroy(this)
    this.exited = true

    // Exit bypasses GameObject.destroy, so cancel its pending work here too
    // (a Defend in progress), before scheduling the free.
    Timers.cancelOwner(this)

    // we need this time out because server sends out all data asynchronously,
    // and a new objectmight take an id of a destroyed object,
    // before clients were notified about it.
    // our server loop is 16ms, thin of a cleaner way to do this.
    Timers.schedule(1000, () => {
      GameObject.FreedIDs.push(this.id)
    })
  }

  // Display names ========

  /** Longest name kept, in code points (not UTF-16 units, so no pair is split). */
  static NAME_MAX = 16

  /**
   * Longest raw name looked at, in UTF-16 units. The rest is dropped before
   * any other step, so a megabyte name costs the NFKC pass and the regexes no
   * more than this does (bound-player-id, 2026-09-25). The client's field
   * stops at 16 units; 256 leaves room for padding and stripped characters,
   * and every name within it sanitises exactly as it did without the cut.
   */
  static NAME_RAW_MAX = 256

  /** The first NAME_RAW_MAX units of `raw`, without ending on half a surrogate pair. */
  static precut (raw: string): string {
    if (raw.length <= Player.NAME_RAW_MAX) return raw
    const end = Player.NAME_RAW_MAX
    const code = raw.charCodeAt(end - 1)
    return raw.slice(0, code >= 0xD800 && code <= 0xDBFF ? end - 1 : end)
  }

  /**
   * Taken by the client's own label: every client draws "YOU" over its own
   * robot, so a remote player called YOU would pass for the viewer.
   */
  static RESERVED_NAMES = ['YOU']

  /**
   * Letters that render as nothing. They are ordinary letters (Lo/So), so the
   * category strip below keeps them, and a name made of them looks empty.
   */
  private static readonly _BLANK_LETTERS = /[\u115F\u1160\u3164\uFFA0\u2800]/gu

  /**
   * Characters that are never kept, by category:
   * - Cc control (NUL would end the name early on the wire: it is NUL-terminated),
   * - Cf format, which is every zero-width character (U+200B-U+200D, U+2060,
   *   U+FEFF), every bidi control (U+200E/F, U+202A-U+202E, U+2066-U+2069) and
   *   the tag characters - the ones that let one name disguise itself as another
   *   or reverse the text drawn after it,
   * - Co private use, Cn unassigned, Cs lone surrogates,
   * - Zl/Zp line and paragraph separators.
   */
  private static readonly _INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/gu

  /**
   * Markup-significant characters. Nothing renders names as HTML today (pixi
   * draws them as text), but the leaderboard is about to show them and a name
   * is the one string on the wire a stranger chose.
   */
  private static readonly _MARKUP = /[<>&"'`]/g

  /**
   * The display name a player gets: their own name made safe to show, or, when
   * nothing usable is left, a callsign derived from their id.
   *
   * In order: NFKC first, so compatibility forms are folded before anything is
   * tested (full-width U+FF1C becomes <, and is then stripped; full-width
   * letters become plain ones); tabs and line breaks turned into spaces; the
   * strips above; combining marks capped at two in a row, so a name cannot
   * stack into a tall smear over other players; whitespace collapsed to single
   * spaces and trimmed; cut to NAME_MAX code points and trimmed again, since
   * the cut can end on a space. A reserved name then counts as no name.
   *
   * What it does not do: catch look-alikes across scripts (Cyrillic U+0430 for
   * Latin "a"). Stripping ZWJ also breaks joined emoji into their parts.
   */
  static sanitiseName (raw: unknown): string {
    if (typeof raw !== 'string') return ''
    let name = Player.precut(raw).normalize('NFKC')
    // Line breaks and tabs separate words; the control strip would glue them.
    name = name.replace(/[\t\n\v\f\r\u2028\u2029]/g, ' ')
    name = name.replace(Player._INVISIBLE, '')
    name = name.replace(Player._BLANK_LETTERS, '')
    name = name.replace(Player._MARKUP, '')
    // Again: a strip can bring together a letter and a mark that compose, and
    // without this a second pass over the result would change it.
    name = name.normalize('NFKC')
    name = name.replace(/(\p{M}{2})\p{M}+/gu, '$1')
    name = name.replace(/[\s\p{Z}]+/gu, ' ').trim()
    name = Array.from(name).slice(0, Player.NAME_MAX).join('').trim()
    if (Player.RESERVED_NAMES.includes(name.toUpperCase())) return ''
    // Profanity (decision #46): the whole name goes, and `displayName` gives
    // the player their callsign. Catches leetspeak, look-alikes, stretched and
    // spaced-out words; misses letters split by dots, and takes "Penistone"
    // and "pussycat" (measured 2026-10-02).
    if (Player.PROFANITY.hasMatch(name)) return ''
    return name
  }

  /** obscenity's English set; built once. */
  static readonly PROFANITY = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers })

  /** `sanitiseName`, falling back to the id's callsign when nothing is left. */
  static displayName (raw: unknown, playerId: string): string {
    const name = Player.sanitiseName(raw)
    return name !== '' ? name : Player.callsign(playerId)
  }

  static CALLSIGNS = [
    'NOVA', 'ROOK', 'VOLT', 'ECHO', 'FLUX', 'GRIT', 'HAWK', 'JINX',
    'KITE', 'LYNX', 'MOTH', 'ONYX', 'PIKE', 'QUILL', 'RUST', 'SABLE',
    'TALON', 'UMBRA', 'VIPER', 'WREN', 'ZINC', 'BOLT', 'COG', 'DRIFT',
    'EMBER', 'FANG', 'GEAR', 'HEX', 'IRON', 'JOLT', 'KNOX', 'LUMEN'
  ]

  /**
   * A name for a player who gave none: a word and a number, e.g. `ROOK-42`,
   * both taken from a 32-bit FNV-1a hash of the id. Deterministic, so the same
   * id always gets the same callsign - and the id is kept in the client's
   * localStorage, so a reconnect or a new run keeps it too. 32 words x 90
   * numbers is 2,880 callsigns; two players sharing one is possible and only
   * cosmetic, since nothing identifies a player by name.
   */
  static callsign (playerId: string): string {
    let hash = 0x811c9dc5
    const id = String(playerId)
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    const word = Player.CALLSIGNS[hash % Player.CALLSIGNS.length]
    const number = 10 + Math.floor(hash / Player.CALLSIGNS.length) % 90
    return `${word}-${number}`
  }
}
