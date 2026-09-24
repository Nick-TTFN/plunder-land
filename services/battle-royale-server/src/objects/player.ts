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

  /** Every player is a peep until `robot-type-on-join` lets them choose. */
  constructor (x: number, y: number, tag: number, playerId: string, archetype: Archetype = ARCHETYPES.peep) {
    super(ObjectType.Player, x, y, 0, tag, archetype)
    this.playerId = playerId
    this.name = playerId

    this.setLevel(archetype.level ?? 1)

    // Order is the wire contract: the client sends the index of the slot it
    // pressed, and `tryExecuteSkill` indexes straight into this array. Every
    // robot's skills are PLAYER_SKILLS, which is in the client's order.
    this.skills = buildSkills(this, archetype)

    this.createdAt = Date.now()

    Multiplayer.Instance.create(this)
  }

  setGear (data: { damage: number, armor: number, speed: number }): void {
    this.weapon = data.damage
    this.armor = data.armor
    this.maxVelocity = 180 + data.speed * 10
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
}
