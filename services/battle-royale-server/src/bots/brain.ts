import type { IAIRoutine } from '../ai/airoutine'
import type Player from '../objects/player'
import World from '../objects/world'
import { ObjectType, type GameObject } from '../objects/gameobject'
import type { Unit } from '../objects/unit'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * A bot's play (decision #47): a Player with no connection, driven through the
 * same entry points a human's input reaches (`setWaypoints`, `tryExecuteSkill`,
 * `tryUseItem`), never by moving it directly. Attached as an AI routine, so
 * `Unit.update` runs it at the start of every tick.
 *
 * It thinks once per `reactionMs` of its layer and, in order: heals when hurt;
 * fights a player in reach, or a mob on top of it; heads out (to the nearest
 * exit) once loaded, late, badly hurt or asked to leave; loots what it can see;
 * otherwise wanders, now and then taking a portal down. Beatable and ramping by
 * layer (#47): slower and less accurate on 01, closer to a human on 02-03.
 */

/** Per layer, top (01) first. Provisional numbers. */
export const BOT_SKILL = [
  { reactionMs: 650, aimMiss: 0.45, engageRings: 5, descend: 0.25 },
  { reactionMs: 450, aimMiss: 0.25, engageRings: 6, descend: 0.15 },
  { reactionMs: 300, aimMiss: 0.12, engageRings: 6, descend: 0 }
]

/** Skill slots (archetypes.ts `PLAYER_SKILLS`, a wire contract) and item slots (utils/items.ts). */
const MELEE = 1
const RANGED = 2
const DEFEND = 3
const FIREBALL = 5
const ICICLE = 6
const MEDKIT = 0

/** How close another bot (or a mob) has to be before a bot fights it. */
const BOT_SCUFFLE_RINGS = 2
const LOOT_SIGHT = 7
const WANDER_MIN = 4
const WANDER_MAX = 9

export default class BotBrain implements IAIRoutine {
  /** Set by the fill when a human takes this bot's place: head out and extract. */
  leaving = false
  /** Loot it carries out at, and when it gives up and goes anyway. */
  readonly lootGoal: number
  readonly deadline: number
  private nextThinkAt = 0
  /** The cell its current route was asked for, so an unchanged order isn't searched again. */
  private target: Vector | undefined

  constructor (readonly owner: Player, now: number = Date.now(), private readonly random: () => number = Math.random) {
    // Runs of a few minutes, like a player's (the GTM's 5-10): time decides,
    // not loot. Natural loot refills every tick, so a bot that always walks to
    // the nearest pickup carried 400-1200 within 20-100 s (measured
    // 2026-10-02); a 60-200 goal churned bots through the world every 30 s.
    // Provisional (Nick/Dez): a bot this loaded tops the leaderboard.
    this.lootGoal = 1500 + Math.floor(random() * 2500)
    this.deadline = now + (180 + random() * 300) * 1000
  }

  update (): void {
    const now = Date.now()
    if (now < this.nextThinkAt) return
    const me = this.owner
    if (me.destroyed || me.exited) return
    const layer = Math.max(0, World.TAGS.indexOf(me.tag))
    const skill = BOT_SKILL[Math.min(layer, BOT_SKILL.length - 1)]
    // A little jitter, so bots that spawned together don't act in lockstep.
    this.nextThinkAt = now + skill.reactionMs * (0.8 + this.random() * 0.4)
    this.think(now, skill)
  }

  private think (now: number, skill: typeof BOT_SKILL[number]): void {
    const me = this.owner
    const cell = me.cell
    const health = me.maxHp > 0 ? me.hp / me.maxHp : 1

    if (health < 0.5 && (me.inventory[MEDKIT] ?? 0) > 0) me.tryUseItem(MEDKIT)

    const out = this.leaving || me.loot >= this.lootGoal || now >= this.deadline ||
      (health < 0.3 && (me.inventory[MEDKIT] ?? 0) === 0)

    const enemy = this.enemy(cell, skill.engageRings)
    if (enemy !== undefined) {
      const distance = Hex.distance(cell, enemy.cell)
      // On the way out, only what is close enough to stop it.
      if (!out || distance <= 2) {
        this.fight(enemy, distance, skill, health)
        return
      }
    }

    if (out) {
      const exit = this.nearestGate(cell, ObjectType.Exit, () => true)
      // On the exit's cell the channel runs by itself; standing still is all it takes.
      if (exit !== undefined && !(exit.x === cell.x && exit.y === cell.y)) this.go(exit)
      else if (exit !== undefined) { me.stop(); this.target = exit }
      return
    }

    const loot = this.nearestPickup(cell)
    if (loot !== undefined) {
      this.go(loot)
      return
    }

    if (me.path.length > 0) return // still walking somewhere
    const layer = World.TAGS.indexOf(me.tag)
    if (this.random() < skill.descend && layer < World.TAGS.length - 1) {
      const deeper = World.TAGS[layer + 1]
      const portal = this.nearestGate(cell, ObjectType.Portal, (gate) => (gate as { to?: number }).to === deeper)
      if (portal !== undefined) {
        this.go(portal)
        return
      }
    }
    this.wander(cell)
  }

  /**
   * The nearest live human in reach; else another bot or a mob right on top of
   * it. Bots that hunted each other at full reach mostly killed each other
   * (two thirds of their runs ended in a death, some seconds after spawning),
   * and the fill kept replacing them: churn, not company.
   */
  private enemy (cell: Vector, rings: number): Unit | undefined {
    const me = this.owner
    const live = (u: Unit): boolean => u !== me && !u.destroyed && !(u as Player).exited
    const human = World.NEAREST_IN_CELLS(cell, rings, me.tag, ObjectType.Player, (u) => live(u) && (u as Player).bot === undefined)
    if (human !== undefined) return human
    return World.NEAREST_IN_CELLS(cell, BOT_SCUFFLE_RINGS, me.tag, ObjectType.Player | ObjectType.Mob, live)
  }

  private fight (enemy: Unit, distance: number, skill: typeof BOT_SKILL[number], health: number): void {
    const me = this.owner
    const aim = this.aimAt(enemy.cell, skill.aimMiss)
    if (distance <= 1 && health < 0.5) me.tryExecuteSkill(DEFEND)
    if (distance <= 2) me.tryExecuteSkill(MELEE)
    if (distance <= 6) me.tryExecuteSkill(RANGED, aim)
    const layer = World.TAGS.indexOf(me.tag)
    if (layer >= 1 && distance >= 3 && this.random() < 0.3) me.tryExecuteSkill(this.random() < 0.5 ? FIREBALL : ICICLE, aim)
    // Close in on a player to shooting range; hold against a mob.
    if (enemy.type === ObjectType.Player && distance > 4) this.go(enemy.cell)
  }

  /** The enemy's cell, or a neighbour of it `miss` of the time. */
  private aimAt (cell: Vector, miss: number): Vector {
    if (this.random() >= miss) return cell
    return Hex.neighbour(cell, Math.floor(this.random() * 6))
  }

  /** The nearest pickup it can see: loot, or an item it has room for. */
  private nearestPickup (cell: Vector): Vector | undefined {
    const me = this.owner
    let best: GameObject | undefined
    let bestDistance = Infinity
    World.forKeysWithin(cell, LOOT_SIGHT, (key, distance) => {
      if (distance >= bestDistance) return
      for (const obj of World.PICKUPS.at(me.tag, key)) {
        if (obj.destroyed) continue
        if (obj.type !== ObjectType.Consumable) {
          const kind = (obj as unknown as { kind: { slot: number, maxStack: number } }).kind
          if ((me.inventory[kind.slot] ?? 0) >= kind.maxStack) continue
        }
        best = obj
        bestDistance = distance
        return
      }
    })
    return best === undefined ? undefined : Hex.toCell(best.position)
  }

  /** The nearest gate of `type` on its layer that `accept` takes, by rings. */
  private nearestGate (cell: Vector, type: number, accept: (gate: GameObject) => boolean): Vector | undefined {
    let best: Vector | undefined
    let bestDistance = Infinity
    for (const gates of World.GATES.buckets(this.owner.tag).values()) {
      for (const gate of gates) {
        if (gate.type !== type || !accept(gate)) continue
        const at = Hex.toCell(gate.position)
        const distance = Hex.distance(cell, at)
        if (distance < bestDistance) {
          best = at
          bestDistance = distance
        }
      }
    }
    return best
  }

  private wander (cell: Vector): void {
    for (let attempt = 0; attempt < 6; attempt++) {
      const reach = WANDER_MIN + Math.floor(this.random() * (WANDER_MAX - WANDER_MIN + 1))
      const direction = Math.floor(this.random() * 6)
      let at = cell
      for (let i = 0; i < reach; i++) at = Hex.neighbour(at, direction)
      if (!Hex.onMap(at.x, at.y, World.mapSize) || this.owner.blocks(at.x, at.y)) continue
      this.go(at)
      if (this.owner.path.length > 0) return
    }
  }

  /** Route to `cell` as a human's click would, unless that is already the order. */
  private go (cell: Vector): void {
    const me = this.owner
    if (this.target !== undefined && this.target.x === cell.x && this.target.y === cell.y && me.path.length > 0) return
    this.target = new Vector(cell.x, cell.y)
    me.setWaypoints([this.target])
  }
}
