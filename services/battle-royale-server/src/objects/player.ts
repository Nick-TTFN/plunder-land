import { Unit } from './unit'
import { Dash } from '../skills/dash'
import { RangedAttack } from '../skills/rangedattack'
import { Defend } from '../skills/defend'
import { StoneWall } from '../skills/stonewall'
import { ThrowFireball } from '../skills/throwfireball'
import { Throwicicle } from '../skills/throwicicle'
import { IceBreath } from '../skills/icebreath'
import { GameObject, ObjectType } from './gameobject'
import { Vector } from '../utils/vector'
import Mob from './mob'
import Boss from './boss'
import { MeleeAttack } from '../skills/meleeattack'
import { type Skill } from '../skills/skill'
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
  /**
   * Body radius, pinned rather than derived from HP (it was 2 * sqrt(maxHP),
   * 14.1 at 50 HP and 20 at 100). A bigger body widens pickup reach past the
   * 39-unit step where it starts sweeping three rows of cells, moves the
   * fireball spawn point and widens the ranged hit. Per-robot values belong to
   * `unit-archetypes`; keep it under Hex.SIZE / 2 so a unit fits beside a rock.
   */
  static BODY_RADIUS = 14

  skills: Skill[]
  createdAt: number
  exited: boolean
  playerId: string

  constructor (x: number, y: number, tag: number, playerId: string) {
    super(ObjectType.Player, x, y, 0, tag)
    this.playerId = playerId
    this.name = playerId
    this.maxVelocity = 140
    this.loot = 0

    this.setLevel(1)

    // Order is the wire contract: the client sends the index of the slot it
    // pressed, and `tryExecuteSkill` indexes straight into this array. The
    // client's own skill list must stay in exactly this order.
    this.skills = [
      new Dash(this),
      new MeleeAttack(this),
      new RangedAttack(this),
      new Defend(this),
      new StoneWall(this),
      new ThrowFireball(this),
      new Throwicicle(this),
      new IceBreath(this)
    ]

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
      const sumWidth = obj.radius + this.radius
      const sqr = obj.position.sub(this.position).getSquareMagnitude()
      if (sqr < sumWidth * sumWidth) {
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
    this.radius = Player.BODY_RADIUS
    this.loot = 0
  }

  tryExecuteSkill (index: number): void {
    if (this.skills === undefined || this.skills.length <= index) { return }

    this.skills[index].execute()
  }

  onCollideWithPlayer (target: GameObject): void {

  }

  onKill (value: GameObject): void {
    super.onKill(value)

    void this.updateKillStats(value)
  }

  async updateKillStats (value: GameObject): Promise<void> {
    const stats = new Stats()

    stats.kills = 1

    if (value instanceof Boss) { stats.bossKills = 1 }

    if (value instanceof Mob) { stats.mobKills = 1 }

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
