import type Player from '../objects/player'
import { type Item, type ItemUse } from '../archetypes/archetypes'
import { ObjectType } from '../objects/gameobject'
import Obstacle from '../objects/obstacle'
import World from '../objects/world'
import Timers from '../objects/timers'
import Multiplayer from '../network/multiplayer'
import GuardPosition from '../ai/guardposition'
import { Skill } from '../skills/skill'
import { Hex } from '../utils/hex'
import { type Vector } from '../utils/vector'

type BombUse = Extract<ItemUse, { kind: 'bomb' }>

/**
 * Effect record types (`Multiplayer.effectAt`), after the fireball's 5 and the
 * icicle's 6. Both are aimed at the bomb's cell; the client draws the disc from
 * that cell and the item's `rings` (utils/items.ts).
 */
export const BOMB_FUSE_EFFECT = 7
export const BOMB_BLAST_EFFECT = 8
/** How long the client shows the blast, in ms. Looks only. */
const BLAST_SHOW_MS = 500

/**
 * The cell a bomb lands on. Aimed: the aimed cell, if it is on the map and at
 * most `aimRange` cells from the thrower's cell **as the server has it**; an aim
 * further out is refused (undefined), not clamped. Not aimed, or aimed at the
 * thrower's own cell: `aimRange` cells straight out along `facing`, stopping at
 * the map edge - the rule every aimed skill follows (decision #21).
 */
export function bombCell (thrower: Player, item: Item, aimCell?: Vector): Vector | undefined {
  const range = item.aimRange ?? 0
  const own = thrower.cell

  if (Skill.isAimed(thrower, aimCell)) {
    if (!Hex.onMap(aimCell.x, aimCell.y, World.mapSize)) return undefined
    if (Hex.distance(own, aimCell) > range) return undefined
    return aimCell
  }

  const direction = World.FACING_INDEX(thrower.facing)
  let cell = own
  for (let i = 0; i < range; i++) {
    const next = Hex.neighbour(cell, direction)
    if (!Hex.onMap(next.x, next.y, World.mapSize)) break
    cell = next
  }
  return cell
}

/**
 * Throw a bomb (balance pass section 1 "Items"). It lands at once on a cell
 * centre (`bombCell`) and everyone nearby is shown the doomed cells for the
 * whole fuse. False, and nothing is thrown, if the aim is out of range.
 *
 * **The fuse has no owner, on purpose: a thrown bomb goes off whatever happens
 * to its thrower.** Everyone has been shown the telegraph, and a fireball in
 * flight already outlives its caster the same way (its timer belongs to the
 * projectile). Owned by the thrower, a death or an exit would cancel it and
 * the cells would have lied.
 */
export function throwBomb (thrower: Player, item: Item, use: BombUse, aimCell?: Vector): boolean {
  const cell = bombCell(thrower, item, aimCell)
  if (cell === undefined) return false

  const tag = thrower.tag
  Multiplayer.Instance.effectAt(BOMB_FUSE_EFFECT, thrower.id, use.fuseMs, cell, tag)
  Timers.schedule(use.fuseMs, () => { detonate(thrower, item, use, cell, tag) })
  return true
}

/**
 * The blast: `use.damage` to every player and mob standing on the disc of
 * `item.rings` rings around `cell`, the thrower included (N3), no falloff; and
 * every StoneWall stone on the disc destroyed. Rocks, portals and exits stay.
 *
 * A mob that survives is provoked by the thrower (N1), which `provoke` ignores
 * once the thrower is dead or gone. A kill is credited to the thrower, as a
 * fireball's is, except the thrower's own death.
 */
export function detonate (thrower: Player, item: Item, use: BombUse, cell: Vector, tag: number): void {
  Multiplayer.Instance.effectAt(BOMB_BLAST_EFFECT, thrower.id, BLAST_SHOW_MS, cell, tag)

  for (const unit of World.FIND_IN_CELLS(cell, item.rings, tag, ObjectType.Player | ObjectType.Mob)) {
    // A corpse is still in the lists until the next sweep; `hit` refuses it too.
    if (unit.destroyed) continue
    if (unit.hit(use.damage)) {
      if (unit !== thrower) thrower.onKill(unit)
    } else {
      GuardPosition.provoke(unit, thrower)
    }
  }

  // By cell (`World.BLOCKED` names each cell's blocker), not a scan of OBSTACLES. Only a timed
  // Obstacle is a stone (World.isRock); destroying it releases its cell and
  // cancels its own expiry timer, which is owned by the stone. Collected first,
  // because destroying one edits BLOCKED.
  const stones: Obstacle[] = []
  World.forKeysWithin(cell, item.rings, (key) => {
    const obstacle = World.BLOCKED.get(tag)?.get(key)
    if (!(obstacle instanceof Obstacle) || World.isRock(obstacle) || obstacle.destroyed) return
    stones.push(obstacle)
  })
  for (const stone of stones) {
    stone.destroy()
    World.removeObstacle(stone)
  }
}
