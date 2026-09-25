import { Unit } from './unit'
import { GameObject, ObjectType } from './gameobject'
import { Vector } from '../utils/vector'
import { type Skill } from '../skills/skill'
import { type Archetype, ARCHETYPES, buildSkills } from '../archetypes/archetypes'
import World from './world'
import Multiplayer from '../network/multiplayer'
import Timers from './timers'
import { INVENTORY_SLOTS } from '../utils/items'
import { type Item } from '../archetypes/archetypes'
import { itemForSlot, useItem } from '../items/use'

export class Stats {
  kills?: number
  mobKills?: number
  bossKills?: number
  games?: number
  lootCollected?: number
  lifeTime?: number
}
export default class Player extends Unit {
  // Always set, by Unit's constructor; narrowed from Unit's optional one.
  declare archetype: Archetype

  skills: Skill[]
  createdAt: number
  exited: boolean
  playerId: string

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
   * Every player is a peep until `robot-type-on-join` lets them choose.
   *
   * `name` is what the player typed, unsanitised: it is cleaned here, before
   * `Multiplayer.create` serialises it into everyone's create record, and an
   * empty or unusable one becomes the id's callsign. `playerId` stays the
   * identity - stats are keyed by it, never by the name.
   */
  constructor (x: number, y: number, tag: number, playerId: string, archetype: Archetype = ARCHETYPES.peep, name?: unknown) {
    super(ObjectType.Player, x, y, 0, tag, archetype)
    this.playerId = playerId
    this.name = Player.displayName(name, playerId)

    this.setLevel(archetype.level ?? 1)

    // Order is the wire contract: the client sends the index of the slot it
    // pressed, and `tryExecuteSkill` indexes straight into this array. Every
    // robot's skills are PLAYER_SKILLS, which is in the client's order.
    this.skills = buildSkills(this, archetype)

    this.createdAt = Date.now()

    // The owner's own record only. Its create for everyone else stays as it was.
    this.allFieldsOwn.add('inventory')

    Multiplayer.Instance.create(this)
  }

  update (dt: number): void {
    super.update(dt)

    // Something in this tick's own update (a breath's area) can kill it. A
    // corpse picks nothing up and heals nothing: what it carries is dropped by
    // the next sweep (World.update).
    if (this.destroyed) return

    this.applyHeal(dt)

    for (let i = 0; i < World.CONSUMABLES.length; i++) {
      const obj = World.CONSUMABLES[i]
      if (obj.tag !== this.tag) { continue }
      const reach = this.archetype.pickupReach ?? obj.radius + this.radius
      const sqr = obj.position.sub(this.position).getSquareMagnitude()
      if (sqr < reach * reach) {
        // Banks it, and nothing else. It used to heal by the same amount too;
        // healing is the medkit's job now (decision #5).
        this.addLoot(obj.loot)
        obj.destroy()
        World.CONSUMABLES.splice(i, 1)
        break
      }
    }

    // One item a tick, like loot. A full stack leaves the pickup where it is.
    for (let i = 0; i < World.ITEMS.length; i++) {
      const obj = World.ITEMS[i]
      if (obj.tag !== this.tag || obj.destroyed) continue
      const reach = this.archetype.pickupReach ?? obj.radius + this.radius
      if (obj.position.sub(this.position).getSquareMagnitude() >= reach * reach) continue
      if (!this.addItem(obj.kind)) continue
      obj.destroy()
      World.ITEMS.splice(i, 1)
      break
    }

    for (const mob of World.MOBS) {
      if (mob === this) { continue }

      if (mob.tag !== this.tag) { continue }

      const sumWidth = mob.radius + this.radius
      const delta = mob.position.sub(this.position)
      const sqr = delta.getSquareMagnitude()
      if (sqr < sumWidth * sumWidth) {
        const magnitude = Math.sqrt(sqr)

        this.position = new Vector(
          mob.position.x - sumWidth * delta.x / magnitude,
          mob.position.y - sumWidth * delta.y / magnitude)
      }
    }
  }

  addLoot (value: number): void {
    this.loot += value
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
   */
  tryExecuteSkill (index: number, aimCell?: Vector): void {
    if (this.skills === undefined) return
    if (!Number.isInteger(index) || index < 0 || index >= this.skills.length) return

    this.skills[index].execute(aimCell)
  }

  onCollideWithPlayer (target: GameObject): void {

  }

  onKill (value: GameObject): void {
    super.onKill(value)

    // Never `void`: see Multiplayer.STATS_LOG. A rejected stats write is an
    // unhandled rejection, and that ends the process.
    this.updateKillStats(value).catch(Multiplayer.logStatsFailure)
  }

  async updateKillStats (value: GameObject): Promise<void> {
    const stats = new Stats()

    stats.kills = 1

    // By archetype, into today's redis keys (see Archetype.killStats).
    if (value instanceof Unit && value.archetype !== undefined) {
      for (const key of value.archetype.killStats) stats[key] = 1
    }

    console.log('stats', stats)
    for (const key in stats) {
      if (stats[key] > 0) {
        await Multiplayer.Instance.redis.hincrby(`stats-${this.playerId}`, key, stats[key])
      }
    }
  }

  destroy (): void {
    super.destroy()
  }

  exit (): void {
    this.dirtyFields = new Set(['id'])  // not new Set('id'), which yields {'i','d'}
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
    return name
  }

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
