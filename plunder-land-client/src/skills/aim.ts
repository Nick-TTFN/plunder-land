import { type IPointData } from 'pixi.js'
import { Game } from '../game'
import { Session } from '../net/session'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'
import { skillById } from '../utils/skills'
import { RANGED_RANGE_CELLS } from '../vfx/cells'
import { AutoAim, bombCell, type Cell, rangeCellsOf, skillCell, type TargetView } from './autoaim'

/**
 * Where a press aims (decision #58): the shared auto-aim target
 * (`skills/autoaim.ts`), else the movement direction. Mouse and touch aim are
 * gone; a tap or a key casts at once. A press on the world never picks the
 * target, enemy or ground: it is a move order (#59 reverses #58 addendum 2's
 * tap-to-target; do not put it back). `Game.updateAim` feeds this each frame
 * with what the client holds; the press paths (`Skill.execute`,
 * `GearSlot.invoke`, `Inventory.use`) ask it for the cell to send.
 */
export class Aim {
  private static readonly auto = new AutoAim()
  /** This frame's target as last picked, or undefined for none. */
  private static _target: TargetView | undefined

  /** A new run (`Game.start`): no target. */
  static reset (): void {
    Aim.auto.reset()
    Aim._target = undefined
  }

  /** The own robot's cell, predicted (`Game.LOCAL`). */
  private static own (): Cell {
    return Hex.toCell(new Vector(Game.LOCAL.x, Game.LOCAL.y))
  }

  private static isWall (q: number, r: number): boolean {
    const tag = Game.LOCAL.tag
    return tag !== undefined && Game.WALLS.get(tag)?.has(Hex.key(q, r)) === true
  }

  /** Pick this frame's target from `views`; undefined for none (or no own robot). */
  static update (views: readonly TargetView[]): TargetView | undefined {
    if (Game.PLAYER === undefined) {
      Aim.reset()
      return undefined
    }
    Aim._target = Aim.auto.update(Aim.own(), Game.LOCAL.tag, views, Aim.isWall)
    return Aim._target
  }

  /** The current target, as last picked by `update`. */
  static get target (): TargetView | undefined {
    return Aim._target
  }

  /**
   * The cell an aimed skill press sends: the target's cell, else the cell
   * its reach along the movement direction (`noTargetCell`). `skillId` is
   * the mirrored skill id; one this build can't place gets the ranged reach.
   * Only for skills that aim (`Skill.aims`). Undefined (the bare slot, along
   * the server's `facing`) off the map.
   */
  static skillCell (skillId: number | undefined): Vector | undefined {
    if (Game.PLAYER === undefined) return undefined
    const range = rangeCellsOf(skillById(skillId)?.key, Game.PLAYER.archetype?.rangedCells) ?? RANGED_RANGE_CELLS
    return Aim.checked(skillCell(Aim.own(), Aim._target?.cell, Game.LOCAL.facingX, Game.LOCAL.facingY, range, Session.mapSize))
  }

  /** The cell a bomb (an item reaching `aimRange`) is thrown at (`autoaim.ts` `bombCell`). */
  static bombCell (aimRange: number): Vector | undefined {
    if (Game.PLAYER === undefined) return undefined
    return Aim.checked(bombCell(Aim.own(), Aim._target?.cell, Game.LOCAL.facingX, Game.LOCAL.facingY, aimRange, Session.mapSize))
  }

  /** `cellAt`'s map and own-cell rules on a picked cell. */
  private static checked (cell: Cell | undefined): Vector | undefined {
    return cell === undefined ? undefined : Aim.cellAt(Hex.toPosition(new Vector(cell.x, cell.y)))
  }

  /**
   * The aim cell for a world point, or undefined for "no aim": a cell off the
   * map, or the player's own cell. The server treats no aim as "fire along
   * facing", and it applies the own-cell rule again against its own position.
   */
  static cellAt (world: IPointData): Vector | undefined {
    if (Game.PLAYER === undefined) return undefined
    const cell = Hex.toCell(new Vector(world.x, world.y))
    if (!Hex.onMap(cell.x, cell.y, Session.mapSize)) return undefined

    const own = Aim.own()
    if (own.x === cell.x && own.y === cell.y) return undefined

    return cell
  }

  /**
   * The `skill` message: `[uint8 slot][int16 q][int16 r]`, big-endian (the
   * DataView default, and what the server reads), with (q, r) the absolute cell.
   * Without an aim it is the bare slot number, the message's original form,
   * which the server still reads as "no aim".
   */
  static message (slot: number, cell: Vector | undefined): number | ArrayBuffer {
    if (cell === undefined) return slot
    const buf = new ArrayBuffer(5)
    const view = new DataView(buf)
    view.setUint8(0, slot)
    view.setInt16(1, cell.x)
    view.setInt16(3, cell.y)
    return buf
  }
}
