import Consumable from './consumable'
import Player from './player'
import Obstacle from './obstacle'
import { Vector } from '../utils/vector'
import { Random } from '../utils/random'
import Portal from './portal'
import { type GameObject, ObjectType } from './gameobject'
import Mob from './mob'
import Boss from './boss'
import { type Unit } from './unit'
import type Area from '../area/area'
import Exit from './exit'

export default class World {
  static TAGS = [-1, 0]
  static mapSize: number
  static OBSTACLES: GameObject[] = []
  static CONSUMABLES: Consumable[] = []
  static PLAYERS: Player[] = []
  static MOBS: Unit[] = []
  static AREA_EFFECT: Area[] = []

  static config = {
    damage: 10,
    defend: 0,
    fire: 15,
    hp: 50,
    melee: 20,
    ranged: 20
  }

  constructor (size: number) {
    World.mapSize = size

    for (const tag of World.TAGS) {
      for (let i = 0; i < 10; i++) {
        const pos = this.getUnobstructedPosition(40, tag)
        const to = -1 - tag // -1->0, 0->-1
        World.OBSTACLES.push(new Portal(pos.x, pos.y, to, tag))
      }
      for (let i = 0; i < 4; i++) {
        const pos = this.getUnobstructedPosition(40, tag)
        World.OBSTACLES.push(new Exit(pos.x, pos.y, tag))
      }
    }
  }

  static createPlayer (playerId: string): Player {
    const player = new Player(
      Random.RangeInt(0, World.mapSize),
      Random.RangeInt(0, World.mapSize),
      World.TAGS[Random.RangeInt(0, World.TAGS.length)],
      playerId
    )
    World.PLAYERS.push(player)
    return player
  }

  update (dt: number): void {
    for (let i = World.PLAYERS.length - 1; i >= 0; i--) {
      const player = World.PLAYERS[i]
      if (player.destroyed) {
        this.createLootFrom(player)
        World.PLAYERS.splice(i, 1)
        continue
      }
      if (player.exited) {
        World.PLAYERS.splice(i, 1)
        continue
      }
      player.update(dt)
    }

    for (const area of World.AREA_EFFECT) {
      area.update(dt)
    }

    for (let i = World.MOBS.length - 1; i >= 0; i--) {
      const mob = World.MOBS[i]
      if (mob.destroyed) {
        this.createLootFrom(mob)
        World.MOBS.splice(i, 1)
        continue
      }
      mob.update(dt)
    }

    for (const obj of World.OBSTACLES) {
      if (obj.type === ObjectType.Throwable) obj.update(dt)
    }

    while (World.OBSTACLES.length < 300) {
      const tag = World.TAGS[Random.RangeInt(0, 2)]
      const pos = this.getUnobstructedPosition(40, tag)
      // -1 because we dont have obstacles in the air yet
      World.OBSTACLES.push(new Obstacle(pos.x, pos.y, tag))
    }

    if (World.CONSUMABLES.length < 300) {
      const tag = World.TAGS[Random.RangeInt(0, World.TAGS.length)]
      const pos = this.getUnobstructedPosition(40, tag)
      World.CONSUMABLES.push(new Consumable(pos.x, pos.y, tag))
    }

    // fill the map with NPC's
    if (World.MOBS.length < 50) {
      const tag = World.TAGS[Random.RangeInt(0, World.TAGS.length)]
      const pos = this.getUnobstructedPosition(40, tag)
      World.MOBS.push(new Mob(pos.x, pos.y, tag))
    }

    // fill the map with crazy bosses
    if (World.MOBS.length < 10) {
      const tag = World.TAGS[Random.RangeInt(0, World.TAGS.length)]
      const pos = this.getUnobstructedPosition(40, tag)
      World.MOBS.push(new Boss(pos.x, pos.y, tag))
    }
  }

  createLootFrom (value) {
    const dropTier = Math.max(50, Math.floor(value.loot / 5))
    let lootLeft = value.loot

    while (lootLeft > 0) {
      const newDropValue = Math.min(
        lootLeft,
        Random.RangeInt(0.5 * dropTier, 1.5 * dropTier)
      )
      lootLeft -= newDropValue

      World.CONSUMABLES.push(
        new Consumable(
          value.position.x + Random.RangeInt(-100, 100),
          value.position.y + Random.RangeInt(-100, 100),
          value.tag
        )
      )
    }
  }

  getUnobstructedPosition (buffer: number, tag: number) {
    let x: number
    let y: number
    let collides = false
    do {
      collides = false
      x = Random.RangeInt(0, World.mapSize)
      y = Random.RangeInt(0, World.mapSize)

      for (const o of World.OBSTACLES) {
        if (o.tag === tag && o.position.withinBounds(x, y, o.radius + buffer)) {
          collides = true
          break
        }
      }
    } while (collides)
    return new Vector(x, y)
  }

  static FIND_NEAREST_FN (
    owner: GameObject,
    maxAngle: number,
    targets: GameObject[]
  ): GameObject | undefined {
    let nearest = Number.MAX_SAFE_INTEGER
    let result: GameObject | undefined
    for (const player of targets) {
      if (player === owner) continue

      if (player.tag !== owner.tag) continue

      if (maxAngle) {
        const angle = owner.direction.getAngleTo(
          player.position.sub(owner.position).getAngle()
        )
        if (maxAngle < Math.abs(angle)) continue
      }

      if (result != null && Random.Chance(0.2))
      // 20% of going somewhere not closest
      { return result }

      const dpos = player.position.sub(owner.position)
      const sqDistance = dpos.getSquareMagnitude()
      if (dpos.getSquareMagnitude() < nearest) {
        nearest = sqDistance
        result = player
      }
    }
    return result
  }

  static FIND_AROUND (
    x: number,
    y: number,
    tag: number,
    radius: number,
    typeMask: number
  ) {
    const sqRadius = radius * radius
    const result = new Array<Unit>()
    for (const units of (World.PLAYERS as Unit[]).concat(World.MOBS)) {
      if (units.tag !== tag) continue

      if ((units.type & typeMask) === 0) continue

      const dx = units.position.x - x
      const dy = units.position.y - y
      const sqDistance = dx * dx + dy * dy

      if (sqDistance < sqRadius) {
        result.push(units)
      }
    }
    return result
  }

  static FIND_BETWEEN_POINTS (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    tag: number,
    typeMask: number
  ) {
    const result = new Array<Unit>()

    const sqPointDistance = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)

    let minx = 0
    let maxx = 0

    let miny = 0
    let maxy = 0

    if (x1 <= x2) {
      minx = x1
      maxx = x2
    } else {
      minx = x2
      maxx = x1
    }

    if (y1 <= y2) {
      miny = y1
      maxy = y2
    } else {
      miny = y2
      maxy = y1
    }

    for (const candidate of (World.PLAYERS as Unit[]).concat(World.MOBS)) {
      if (candidate.tag !== tag) continue

      if ((candidate.type & typeMask) === 0) continue

      if (candidate.position.x + candidate.radius < minx) continue

      if (candidate.position.x - candidate.radius > maxx) continue

      if (candidate.position.y + candidate.radius < miny) continue

      if (candidate.position.y - candidate.radius > maxy) continue

      const sqRadius = candidate.radius * candidate.radius

      const triangleArea =
        (x2 - x1) * (y1 - candidate.position.y) -
        (y2 - y1) * (x1 - candidate.position.x)
      const sqDistance = (triangleArea * triangleArea) / sqPointDistance

      if (sqDistance < sqRadius) {
        result.push(candidate)
      }
    }
    return result
  }
}
