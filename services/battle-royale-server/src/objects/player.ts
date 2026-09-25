import { Unit } from './unit'
import { GameObject, ObjectType } from './gameobject'
import { Vector } from '../utils/vector'
import { type Skill } from '../skills/skill'
import { type Archetype, ARCHETYPES, buildSkills } from '../archetypes/archetypes'
import World from './world'
import Multiplayer from '../network/multiplayer'
import Timers from './timers'

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

    Multiplayer.Instance.create(this)
  }

  update (dt: number): void {
    super.update(dt)

    for (let i = 0; i < World.CONSUMABLES.length; i++) {
      const obj = World.CONSUMABLES[i]
      if (obj.tag !== this.tag) { continue }
      const reach = this.archetype.pickupReach ?? obj.radius + this.radius
      const sqr = obj.position.sub(this.position).getSquareMagnitude()
      if (sqr < reach * reach) {
        // Bank it and heal for it. Splitting these into two pickup types is a
        // later decision; for now one consumable does both.
        this.addLoot(obj.loot)
        this.hp += (obj.loot)
        if (this.hp > this.maxHP()) { this.hp = this.maxHP() }
        obj.destroy()
        World.CONSUMABLES.splice(i, 1)
        break
      }
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
    let name = raw.normalize('NFKC')
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
